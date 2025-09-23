// worker.js

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets';

const ALL_LIVE_CONFIGS_KEY = 'all_live_configs.json';
const CACHE_VERSION_KEY = 'cache_version.txt';
const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
];

function generateCorsHeaders(requestOrigin) {
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
        return {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version',
            'Vary': 'Origin',
        };
    }
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] }; // Fallback to primary
}

function handleOptions(request) {
    const origin = request.headers.get('Origin');
    return new Response(null, { headers: generateCorsHeaders(origin) });
}

function jsonResponse(data, status = 200, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
    });
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

function generateClashYaml(configs) {
    const proxies = [];
    const usedNames = new Set();
    const getUniqueName = (baseName) => {
        let name = baseName.replace(/ /g, '_').replace(/[^\w-]/g, '');
        let counter = 1;
        while (usedNames.has(name)) name = `${baseName}-${counter++}`;
        usedNames.add(name);
        return name;
    };

    for (const configUrl of configs) {
        try {
            const url = new URL(configUrl);
            const scheme = url.protocol.replace(':', '');
            let proxy;
            if (scheme === 'vmess') {
                const decoded = JSON.parse(atob(configUrl.substring(8)));
                proxy = { name: getUniqueName(decoded.ps || decoded.add), type: 'vmess', server: decoded.add, port: parseInt(decoded.port), uuid: decoded.id, alterId: parseInt(decoded.aid || 0), cipher: decoded.scy || 'auto', tls: decoded.tls === 'tls', servername: decoded.sni || decoded.host };
                if (decoded.net === 'ws') proxy['ws-opts'] = { path: decoded.path || '/', headers: { Host: decoded.host || decoded.add }};
            } else if (scheme === 'vless') {
                const params = new URLSearchParams(url.search);
                proxy = { name: getUniqueName(decodeURIComponent(url.hash.substring(1)) || url.hostname), type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', servername: params.get('sni') || url.hostname, flow: params.get('flow') || '' };
                if (params.get('type') === 'ws') proxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }};
            } else if (scheme === 'trojan') {
                proxy = { name: getUniqueName(decodeURIComponent(url.hash.substring(1)) || url.hostname), type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.password, sni: new URLSearchParams(url.search).get('sni') || url.hostname };
            } else if (scheme === 'ss') {
                proxy = { name: getUniqueName(decodeURIComponent(url.hash.substring(1)) || url.hostname), type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: url.username, password: url.password };
            }
            if (proxy) proxies.push(proxy);
        } catch (e) { console.error(`[Clash Gen] Skipping faulty config: ${configUrl.substring(0, 30)}...`); }
    }
    if (proxies.length === 0) return null;
    const proxyNames = proxies.map(p => p.name);
    return YAML.dump({ 'mixed-port': 7890, 'allow-lan': true, mode: 'rule', 'log-level': 'info', proxies: proxies, 'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['AUTO', ...proxyNames] }, { name: 'AUTO', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 }], rules: ['MATCH,PROXY'] }, { skipInvalid: true, sortKeys: false });
}

function generateSingboxJson(configs) {
    const outbounds = [];
    for (const configUrl of configs) {
        try {
            const url = new URL(configUrl);
            const scheme = url.protocol.replace(':', '');
            const tag = decodeURIComponent(url.hash.substring(1)) || url.hostname;
            let outbound;
            if (scheme === 'vmess') {
                const d = JSON.parse(atob(configUrl.substring(8)));
                outbound = { type: 'vmess', tag, server: d.add, server_port: parseInt(d.port), uuid: d.id, security: d.scy || 'auto', alter_id: parseInt(d.aid || 0) };
                if (d.tls === 'tls') outbound.tls = { enabled: true, server_name: d.sni || d.host };
                if (d.net === 'ws') outbound.transport = { type: 'ws', path: d.path || '/', headers: { Host: d.host || d.add }};
            } else if (scheme === 'vless') {
                const p = new URLSearchParams(url.search);
                outbound = { type: 'vless', tag, server: url.hostname, server_port: parseInt(url.port), uuid: url.username, flow: p.get('flow') || '' };
                if (p.get('security') === 'tls') outbound.tls = { enabled: true, server_name: p.get('sni') || url.hostname };
                if (p.get('type') === 'ws') outbound.transport = { type: 'ws', path: p.get('path') || '/', headers: { Host: p.get('host') || url.hostname }};
            } else if (scheme === 'trojan') {
                outbound = { type: 'trojan', tag, server: url.hostname, server_port: parseInt(url.port), password: url.password, tls: { enabled: true, server_name: new URLSearchParams(url.search).get('sni') || url.hostname }};
            } else if (scheme === 'ss') {
                outbound = { type: 'shadowsocks', tag, server: url.hostname, server_port: parseInt(url.port), method: url.username, password: url.password };
            } else if (['hy2', 'hysteria2'].includes(scheme)) {
                outbound = { type: 'hysteria2', tag, server: url.hostname, server_port: parseInt(url.port), password: url.password, tls: { enabled: true, server_name: new URLSearchParams(url.search).get('sni') || url.hostname }};
            } else if (scheme === 'tuic') {
                outbound = { type: 'tuic', tag, server: url.hostname, server_port: parseInt(url.port), uuid: url.username, password: url.password };
            }
            if (outbound) outbounds.push(outbound);
        } catch (e) { console.error(`[Sing-box Gen] Skipping faulty config: ${configUrl.substring(0, 30)}...`); }
    }
    if (outbounds.length === 0) return null;
    return JSON.stringify({ "log": { "level": "info" }, "inbounds": [{ "type": "mixed", "listen": "127.0.0.1", "listen_port": 2080 }], "outbounds": [{ "type": "selector", "tag": "proxy", "outbounds": outbounds.map(o => o.tag) }, ...outbounds] }, null, 2);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            if (url.pathname === '/configs') {
                const allConfigs = await env.v2v_kv.get(ALL_LIVE_CONFIGS_KEY, { type: 'json' });
                const cacheVersion = await env.v2v_kv.get(CACHE_VERSION_KEY);
                if (!allConfigs) return jsonResponse({ error: 'Configs data not found.' }, 404, corsHeaders);
                const response = jsonResponse(allConfigs, 200, corsHeaders);
                if (cacheVersion) response.headers.set('X-Cache-Version', cacheVersion);
                return response;
            }

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
                        await writer.write(new Uint8Array([0]));
                        await writer.close();
                    }
                    const latency = Date.now() - startTime;
                    return jsonResponse({ latency, status: 'Live' }, 200, corsHeaders);
                } catch (e) {
                    return jsonResponse({ latency: null, status: 'Dead', error: e.message }, 200, corsHeaders);
                }
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) return jsonResponse({ error: '`configs` array is required.' }, 400, corsHeaders);
                const userUuid = clientUuid || uuidv4();
                const subKey = `sub:${userUuid}`;
                await env.v2v_kv.put(subKey, JSON.stringify(configs), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                return jsonResponse({ uuid: userUuid, subscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                if (format === 'raw') return textResponse(btoa(storedData.join('\n')), 200, `v2v-${uuid}.txt`, corsHeaders);
                if (format === 'clash') {
                    const clashContent = generateClashYaml(storedData);
                    if (!clashContent) return textResponse('Failed to generate Clash config.', 500, null, corsHeaders);
                    return yamlResponse(clashContent, 200, `v2v-clash-${uuid}.yaml`, corsHeaders);
                }
                if (format === 'singbox') {
                    const singboxContent = generateSingboxJson(storedData);
                    if (!singboxContent) return textResponse('Failed to generate Sing-box config.', 500, null, corsHeaders);
                    return jsonResponse(JSON.parse(singboxContent), 200, corsHeaders);
                }
            }
            
            const rawSubMatch = url.pathname.match(/^\/sub\/([^/]+)/);
            if (rawSubMatch && !['clash', 'singbox', 'raw'].includes(rawSubMatch[1])) {
                return Response.redirect(`${url.origin}/sub/raw/${rawSubMatch[1]}`, 301);
            }

            return textResponse('v2v Worker is running.', 200, null, corsHeaders);
        } catch (err) {
            console.error(err.stack);
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};
