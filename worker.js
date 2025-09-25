// worker.js

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

function generateCorsHeaders(requestOrigin) {
    if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
        return {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version',
            'Vary': 'Origin',
        };
    }
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
}

function jsonResponse(data, status = 200, corsHeaders) {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders } });
}

function textResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

function yamlResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'application/x-yaml; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

function parseConfigUrl(url) {
    try {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol.replace(':', '');
        const params = new URLSearchParams(urlObj.search);
        let config = {
            protocol,
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            name: decodeURIComponent(urlObj.hash.substring(1) || urlObj.hostname)
        };
        
        if (protocol === 'vmess') {
            const decodedData = JSON.parse(atob(urlObj.hostname + urlObj.pathname.replace(/^\/+/, '')));
            config.server = decodedData.add;
            config.port = parseInt(decodedData.port);
            config.uuid = decodedData.id;
            config.alterId = decodedData.aid;
            config.cipher = 'auto';
            config.network = decodedData.net;
            if (decodedData.net === 'ws') {
                config.wsPath = decodedData.path;
                config.wsHeaders = { Host: decodedData.host || decodedData.add };
            }
            if (decodedData.tls === 'tls') {
                config.tls = true;
                config.sni = decodedData.sni || decodedData.host;
            }
        } else if (protocol === 'vless') {
            config.uuid = urlObj.username;
            config.encryption = params.get('encryption') || 'none';
            config.flow = params.get('flow');
            config.network = params.get('type') || 'tcp';
            if (config.network === 'ws') {
                config.wsPath = params.get('path');
                config.wsHeaders = { Host: params.get('host') || urlObj.hostname };
            }
            if (params.get('security') === 'tls') {
                config.tls = true;
                config.sni = params.get('sni') || urlObj.hostname;
            }
        } else if (protocol === 'trojan') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (protocol === 'ss' || protocol === 'shadowsocks') {
            const [method, password] = atob(urlObj.username).split(':');
            config.protocol = 'ss';
            config.cipher = method;
            config.password = password;
        } else if (protocol === 'hy2' || protocol === 'hysteria2') {
            config.protocol = 'hysteria2';
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (protocol === 'tuic') {
            config.protocol = 'tuic';
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        }
        return config;
    } catch (e) {
        console.error("Error parsing config URL:", e);
        return null;
    }
}

function generateClashYaml(configs) {
    const proxies = [];
    for (const url of configs) {
        const config = parseConfigUrl(url);
        if (!config) continue;
        
        let proxy = {
            name: config.name,
            server: config.server,
            port: config.port,
        };
        
        if (config.protocol === 'vmess') {
            Object.assign(proxy, {
                type: 'vmess', uuid: config.uuid, alterId: config.alterId, cipher: config.cipher
            });
            if (config.network === 'ws') Object.assign(proxy, { network: 'ws', 'ws-path': config.wsPath, 'ws-headers': config.wsHeaders });
            if (config.tls) Object.assign(proxy, { tls: true, sni: config.sni, 'skip-cert-verify': true });
        } else if (config.protocol === 'vless') {
            Object.assign(proxy, {
                type: 'vless', uuid: config.uuid, encryption: config.encryption || 'none', flow: config.flow || ''
            });
            if (config.network === 'ws') Object.assign(proxy, { network: 'ws', 'ws-path': config.wsPath, 'ws-headers': config.wsHeaders });
            if (config.tls) Object.assign(proxy, { tls: true, sni: config.sni, 'skip-cert-verify': true });
        } else if (config.protocol === 'trojan') {
            Object.assign(proxy, {
                type: 'trojan', password: config.password, tls: true, sni: config.sni, 'skip-cert-verify': true
            });
        } else if (config.protocol === 'ss') {
            Object.assign(proxy, {
                type: 'ss', cipher: config.cipher, password: config.password
            });
        }
        
        proxies.push(proxy);
    }
    
    if (proxies.length === 0) return null;
    
    const proxyNames = proxies.map(p => p.name);
    const proxyGroups = [{
        name: 'v2v-auto-select',
        type: 'url-test',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        proxies: proxyNames
    }];
    
    const payload = {
        proxies,
        'proxy-groups': proxyGroups,
        rules: ["MATCH,v2v-auto-select"]
    };
    return YAML.dump(payload);
}

function generateSingboxJson(configs) {
    const outbounds = [];
    for (const url of configs) {
        const config = parseConfigUrl(url);
        if (!config) continue;
        
        let outbound = {
            tag: config.name,
            type: config.protocol,
            server: config.server,
            server_port: config.port
        };
        
        if (config.protocol === 'vmess') {
            Object.assign(outbound, {
                uuid: config.uuid, alterId: config.alterId, security: config.cipher, network: config.network
            });
        } else if (config.protocol === 'vless') {
            Object.assign(outbound, {
                uuid: config.uuid, flow: config.flow, network: config.network
            });
        } else if (config.protocol === 'trojan') {
            Object.assign(outbound, { password: config.password });
        } else if (config.protocol === 'ss') {
            Object.assign(outbound, { method: config.cipher, password: config.password });
        } else if (config.protocol === 'hysteria2') {
            Object.assign(outbound, { password: config.password });
        } else if (config.protocol === 'tuic') {
            Object.assign(outbound, { password: config.password });
        }
        
        outbounds.push(outbound);
    }
    
    if (outbounds.length === 0) return null;
    
    const payload = {
        log: { disabled: true },
        dns: {
            "servers": [{"address": "8.8.8.8", "strategy": "prefer_ipv4"}],
            "rules": []
        },
        inbounds: [],
        outbounds: outbounds,
        route: { rules: [] }
    };
    return JSON.stringify(payload, null, 2);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port, tls, sni } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                try {
                    const startTime = Date.now();
                    const socket = connect({ hostname: host, port: parseInt(port) });
                    if (tls) {
                        const tlsSocket = await socket.startTls({ servername: sni || host });
                        await tlsSocket.close();
                    } else {
                        const writer = socket.writable.getWriter();
                        await writer.close();
                    }
                    return jsonResponse({ latency: Date.now() - startTime, status: 'Live' }, 200, corsHeaders);
                } catch (e) {
                    return jsonResponse({ latency: null, status: 'Dead', error: e.message }, 200, corsHeaders);
                }
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) return jsonResponse({ error: '`configs` array is required.' }, 400, corsHeaders);
                const userUuid = clientUuid || uuidv4();
                await env.v2v_kv.put(`sub:${userUuid}`, JSON.stringify(configs), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                return jsonResponse({ uuid: userUuid, subscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                
                if (format === 'raw') return textResponse(btoa(storedData.join('\n')), 200, `v2v-${uuid}.txt`, corsHeaders);
                if (format === 'clash') {
                    const content = generateClashYaml(storedData, uuid);
                    return content ? yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders) : textResponse('Failed to generate Clash config.', 500, null, corsHeaders);
                }
                if (format === 'singbox') {
                    const content = generateSingboxJson(storedData, uuid);
                    return content ? jsonResponse(JSON.parse(content), 200, corsHeaders) : textResponse('Failed to generate Sing-box config.', 500, null, corsHeaders);
                }
            }
            
            return textResponse('v2v Worker is running. Use /ping, /create-personal-sub, or /sub/{format}/{uuid} endpoints.', 200, null, corsHeaders);
        } catch (err) {
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};
