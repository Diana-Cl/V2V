import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml'; 
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

// 1. تعریف پروتکل‌های پشتیبانی‌شده توسط هر هسته (جهت تضمین خروجی سالم)
const XRAY_PROTOCOLS = ['vless', 'vmess', 'trojan', 'ss'];
const SINGBOX_PROTOCOLS = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic', 'ssr', 'naive'];


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
    // ✅ افزودن Content-Disposition برای دانلود فایل YAML (مشکل ۵)
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`; 
    return new Response(text, { status, headers });
}

function parseConfigUrl(url) {
    // ... (logic remains the same to parse config URL details)
    try {
        const urlObj = new URL(url);
        let protocol = urlObj.protocol.replace(':', '');
        const params = new URLSearchParams(urlObj.search);
        
        let config = {
            protocol,
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            name: decodeURIComponent(urlObj.hash.substring(1) || urlObj.hostname)
        };
        
        if (protocol === 'shadowsocks') config.protocol = 'ss';
        if (protocol === 'hysteria2') config.protocol = 'hy2';
        if (protocol === 'shadowsocksr') config.protocol = 'ssr'; 
        if (protocol === 'naiveproxy') config.protocol = 'naive'; 

        if (config.protocol === 'vmess') {
            const path = urlObj.pathname.replace(/^\/+/, '');
            const netloc = urlObj.hostname;
            const full_base64 = netloc + path;

            try {
                const decodedData = JSON.parse(atob(full_base64));
                config.server = decodedData.add;
                config.port = parseInt(decodedData.port);
                config.uuid = decodedData.id;
                config.alterId = decodedData.aid;
                config.cipher = decodedData.scy || 'auto'; 
                config.network = decodedData.net;
                if (decodedData.net === 'ws') {
                    config.wsPath = decodedData.path;
                    config.wsHeaders = { Host: decodedData.host || decodedData.add };
                }
                if (decodedData.tls === 'tls') {
                    config.tls = true;
                    config.sni = decodedData.sni || decodedData.host || decodedData.add;
                }
            } catch (e) { return null; }
        } else if (config.protocol === 'vless') {
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
        } else if (config.protocol === 'trojan') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (config.protocol === 'ss') {
            try {
                const [method, password] = atob(urlObj.username).split(':');
                config.cipher = method;
                config.password = password;
            } catch (e) { return null; }
        } else if (config.protocol === 'hy2') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (config.protocol === 'tuic') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (config.protocol === 'ssr') { 
             config.cipher = params.get('obfs');
        } else if (config.protocol === 'naive') { 
             config.password = urlObj.username;
             config.tls = true;
             config.sni = urlObj.hostname;
        } else {
             return null;
        }

        return config;
    } catch (e) {
        return null;
    }
}

// 2. تابع تولید Clash YAML اصلاح شده
function generateClashYaml(configs, targetCore) {
    const proxies = [];
    // ✅ تضمین پروتکل: فیلتر بر اساس هسته
    const allowedProtocols = targetCore === 'singbox' ? SINGBOX_PROTOCOLS : XRAY_PROTOCOLS;

    for (const url of configs) {
        const config = parseConfigUrl(url);
        
        if (!config || !allowedProtocols.includes(config.protocol)) continue;
        // VLESS/SSR/Naive/Hy2/Tuic are generally not supported by standard Clash (Clash Meta only)
        if (['vless', 'ssr', 'naive', 'hy2', 'tuic'].includes(config.protocol)) continue;

        let proxy = {
            name: config.name, server: config.server, port: config.port,
        };
        
        if (config.protocol === 'vmess') {
            Object.assign(proxy, {
                type: 'vmess', uuid: config.uuid, alterId: config.alterId || 0, cipher: config.cipher || 'auto'
            });
            if (config.network === 'ws') Object.assign(proxy, { network: 'ws', 'ws-path': config.wsPath || '/', 'ws-headers': config.wsHeaders || {} });
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
        
        if (proxy.type) proxies.push(proxy);
    }
    
    if (proxies.length === 0) return null;
    
    const proxyNames = proxies.map(p => p.name);
    const proxyGroups = [{
        name: 'v2v-auto-select', type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, proxies: proxyNames
    }];
    
    proxyGroups.push({
        name: 'v2v-select', type: 'select', proxies: ['v2v-auto-select', ...proxyNames]
    });

    const payload = {
        proxies,
        'proxy-groups': proxyGroups,
        rules: ["MATCH,v2v-select"]
    };

    try {
        return YAML.safeDump(payload, { skipInvalid: true, flowLevel: -1 }); 
    } catch (e) {
        console.error("YAML Dump Error:", e.message);
        return null;
    }
}

// 4. تابع تولید Sing-box JSON اصلاح شده
function generateSingboxJson(configs, targetCore) {
    const outbounds = [];
    const allowedProtocols = targetCore === 'xray' ? XRAY_PROTOCOLS : SINGBOX_PROTOCOLS;

    for (const url of configs) {
        const config = parseConfigUrl(url);
        
        if (!config || !allowedProtocols.includes(config.protocol)) continue;
        // ✅ فیلتر VLESS برای هسته Sing-box برای تضمین خروجی بومی (مشکل ۴)
        if (config.protocol === 'vless' && targetCore === 'singbox') continue;

        let outbound = {
            tag: config.name, type: config.protocol, server: config.server, server_port: config.port
        };
        
        if (config.tls) {
            outbound.tls = { enabled: true, server_name: config.sni || config.server, insecure: true };
        }

        if (config.protocol === 'vmess') {
            Object.assign(outbound, {
                uuid: config.uuid, alter_id: config.alterId || 0, security: config.cipher || 'auto', network: config.network
            });
        } else if (config.protocol === 'vless') {
            Object.assign(outbound, { uuid: config.uuid, flow: config.flow, network: config.network });
        } else if (config.protocol === 'trojan') {
            Object.assign(outbound, { password: config.password });
        } else if (config.protocol === 'ss') {
            Object.assign(outbound, { method: config.cipher, password: config.password });
        } else if (config.protocol === 'hy2' || config.protocol === 'hysteria2') {
            Object.assign(outbound, { type: 'hysteria2', password: config.password });
        } else if (config.protocol === 'tuic') {
            Object.assign(outbound, { type: 'tuic', password: config.password });
        } else if (config.protocol === 'ssr') {
             Object.assign(outbound, { type: 'shadowsocksr' }); 
        } else if (config.protocol === 'naive') {
             Object.assign(outbound, { type: 'trojan', password: config.password }); 
        }
        
        if (outbound.type) outbounds.push(outbound);
    }
    
    if (outbounds.length === 0) return null;
    
    // Minimal Sing-box config structure
    const payload = {
        log: { disabled: true },
        dns: { "servers": [{"address": "8.8.8.8", "strategy": "prefer_ipv4"}], "rules": [] },
        inbounds: [],
        outbounds: [{ tag: 'select', type: 'urltest', outbounds: outbounds.map(o => o.tag) }, ...outbounds],
        route: { rules: [{ outbound: 'select', rule_set: [] }] }
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
                // ... (ping logic remains the same)
                const { host, port, tls, sni } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                try {
                    const startTime = Date.now();
                    const socket = connect({ hostname: host, port: parseInt(port) }, { secureTransport: tls ? 'on' : 'off', name: tls ? (sni || host) : undefined });
                    
                    const reader = socket.readable.getReader();
                    const writer = socket.writable.getWriter();
                    
                    if (tls) await writer.close(); 
                    
                    const result = await Promise.race([
                        reader.read().then(() => ({ latency: Date.now() - startTime, status: 'Live' })),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 7000))
                    ]);
                    
                    await socket.close();
                    
                    if (result.latency > 0 && result.latency < 99999) {
                        return jsonResponse(result, 200, corsHeaders);
                    } else {
                        return jsonResponse({ latency: null, status: 'Dead', error: "Invalid latency result." }, 200, corsHeaders);
                    }
                } catch (e) {
                    return jsonResponse({ latency: null, status: 'Dead', error: e.message }, 200, corsHeaders);
                }
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid, core: targetCore } = await request.json(); 
                if (!Array.isArray(configs) || configs.length === 0) return jsonResponse({ error: '`configs` array is required.' }, 400, corsHeaders);
                
                const validatedConfigs = configs.filter(c => parseConfigUrl(c) !== null);

                const userUuid = clientUuid || uuidv4();
                
                // ✅ استفاده از env.v2v_kv (مطابق با binding name)
                try {
                     await env.v2v_kv.put(`sub:${userUuid}`, JSON.stringify({ configs: validatedConfigs, core: targetCore }), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                } catch (e) {
                    return jsonResponse({ error: 'KV write error: ' + e.message }, 500, corsHeaders);
                }
                
                // ✅ خروجی URLهای کوتاه با امضای v2v (مشکل ۴)
                return jsonResponse({ 
                    uuid: userUuid, 
                    rawSubscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, 
                    clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, 
                    singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` 
                }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                
                let storedData;
                // ✅ استفاده از env.v2v_kv و رفع خطای JSON (مشکل ۷)
                try {
                    storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                } catch (e) {
                    return textResponse('KV read error: ' + e.message, 500, null, corsHeaders);
                }

                if (!storedData || !Array.isArray(storedData.configs)) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                
                // Re-up TTL
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                
                const configs = storedData.configs;
                const targetCore = storedData.core;
                
                if (format === 'raw') return textResponse(btoa(configs.join('\n')), 200, `v2v-raw-${uuid}.txt`, corsHeaders);
                if (format === 'clash') {
                    const content = generateClashYaml(configs, targetCore);
                    // ✅ تنظیم filename برای دانلود (مشکل ۵)
                    return content ? yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders) : textResponse('Failed to generate Clash config (YAML Error).', 500, null, corsHeaders);
                }
                if (format === 'singbox') {
                    const content = generateSingboxJson(configs, targetCore);
                    // ✅ تنظیم filename برای دانلود (مشکل ۵)
                    return content ? jsonResponse(JSON.parse(content), 200, `v2v-singbox-${uuid}.json`, corsHeaders) : textResponse('Failed to generate Sing-box config (JSON Error).', 500, null, corsHeaders);
                }
            }
            
            return textResponse('v2v Worker is running.', 200, null, corsHeaders);
        } catch (err) {
            console.error(err.message);
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};
