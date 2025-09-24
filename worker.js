// worker.js (Final Version - No /configs endpoint)

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets'; // Ensure this is correctly imported for ping

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.pages.dev', // Add Cloudflare Pages if used for static hosting
    // Add other frontend domains like Arvan if needed
];

function generateCorsHeaders(requestOrigin) {
    if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
        return {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version', // X-Cache-Version might not be strictly needed here anymore, but harmless
            'Vary': 'Origin',
        };
    }
    // Fallback if origin is not in allowed list or not present
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] }; 
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

// Helper to correctly parse URL query parameters
class URLSearchParams {
    constructor(searchString) {
        this._params = new Map();
        if (searchString) {
            searchString.substring(1).split('&').forEach(pair => {
                const parts = pair.split('=');
                if (parts.length === 2) {
                    this._params.set(decodeURIComponent(parts[0]), decodeURIComponent(parts[1]));
                }
            });
        }
    }
    get(key) {
        return this._params.get(key);
    }
}


function generateClashYaml(configs) {
    const proxies = [];
    const usedNames = new Set();
    const getUniqueName = (baseName) => {
        let name = baseName.replace(/[^\w-]/g, ' ').trim();
        if (name.length > 50) name = name.substring(0, 50); // Truncate long names
        let counter = 1;
        let finalName = name;
        while (usedNames.has(finalName)) {
            finalName = `${name}-${counter++}`;
            if (finalName.length > 60) finalName = `${name.substring(0, 50)}-${counter}`; // Ensure even counter doesn't make it too long
        }
        usedNames.add(finalName);
        return finalName;
    };

    for (const configUrl of configs) {
        try {
            const url = new URL(configUrl);
            const scheme = url.protocol.replace(':', '');
            let proxy;

            // Common properties for all protocols
            const commonProps = {
                name: getUniqueName(decodeURIComponent(url.hash.substring(1)) || url.hostname),
                server: url.hostname,
                port: parseInt(url.port),
            };

            // Parse URL parameters for common TLS/WS settings
            const p = new URLSearchParams(url.search);
            const tlsEnabled = p.get('security') === 'tls';
            const sniValue = p.get('sni') || url.hostname;
            const wsEnabled = p.get('type') === 'ws';
            const wsPath = p.get('path') || '/';
            const wsHeadersHost = p.get('host') || url.hostname;


            if (scheme === 'vmess') {
                const d = JSON.parse(atob(configUrl.substring(8)));
                // Update commonProps for vmess if ps or add exist
                commonProps.name = getUniqueName(d.ps || d.add);
                commonProps.server = d.add;
                commonProps.port = parseInt(d.port);

                proxy = { 
                    ...commonProps,
                    type: 'vmess', 
                    uuid: d.id, 
                    alterId: parseInt(d.aid || 0), 
                    cipher: d.scy || 'auto', 
                    tls: d.tls === 'tls', 
                    servername: d.sni || d.host 
                };
                if (d.net === 'ws') proxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
            } else if (scheme === 'vless') {
                proxy = { 
                    ...commonProps,
                    type: 'vless', 
                    uuid: url.username, 
                    tls: tlsEnabled, 
                    servername: sniValue, 
                    flow: p.get('flow') || '' 
                };
                if (wsEnabled) proxy['ws-opts'] = { path: wsPath, headers: { Host: wsHeadersHost }};
            } else if (scheme === 'trojan') {
                proxy = { 
                    ...commonProps,
                    type: 'trojan', 
                    password: url.password, 
                    sni: sniValue 
                };
            } else if (scheme === 'ss') {
                // ShadowSocks configs usually have encoding in username/password
                const [method, password] = atob(url.username).split(':');
                proxy = { 
                    ...commonProps,
                    type: 'ss', 
                    cipher: method, 
                    password: password 
                };
            } else if (['hy2', 'hysteria2'].includes(scheme)) {
                // Clash does not natively support Hysteria2. Requires a plugin or external provider.
                // For now, we'll skip or add a placeholder if a generic proxy type is desired.
                // Or you might use 'external-proxy-provider' in Clash.
                // For simplicity, we'll skip adding them directly as 'type: hy2' won't work.
                console.warn(`[Clash Gen] Skipping Hysteria2 config (not directly supported): ${configUrl}`);
                continue; 
            } else if (scheme === 'tuic') {
                // Clash does not natively support TUIC.
                console.warn(`[Clash Gen] Skipping TUIC config (not directly supported): ${configUrl}`);
                continue;
            }

            if (proxy) proxies.push(proxy);
        } catch (e) { console.error(`[Clash Gen] Error processing config ${configUrl.substring(0, 50)}...: ${e.message}`); }
    }
    if (proxies.length === 0) return null;
    const proxyNames = proxies.map(p => p.name);
    // Basic Clash config with AUTO and PROXY groups
    return YAML.dump({ 
        'mixed-port': 7890, 
        'allow-lan': true, 
        mode: 'rule', 
        'log-level': 'info', 
        proxies, 
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['AUTO', ...proxyNames] }, 
            { name: 'AUTO', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 }
        ], 
        rules: ['MATCH,PROXY'] 
    }, { skipInvalid: true, sortKeys: false });
}

function generateSingboxJson(configs) {
    const outbounds = [];
    for (const configUrl of configs) {
        try {
            const url = new URL(configUrl);
            const scheme = url.protocol.replace(':', '');
            const tag = decodeURIComponent(url.hash.substring(1)) || url.hostname;
            let outbound;

            // Parse URL parameters for common TLS/WS settings
            const p = new URLSearchParams(url.search);
            const tlsEnabled = p.get('security') === 'tls';
            const sniValue = p.get('sni') || url.hostname;
            const wsEnabled = p.get('type') === 'ws';
            const wsPath = p.get('path') || '/';
            const wsHeadersHost = p.get('host') || url.hostname;
            const fingerprint = p.get('fp') || 'chrome'; // Default for TLS fingerprint
            const alpn = (p.get('alpn') || 'h2,http/1.1').split(',').map(s => s.trim()); // Default ALPN

            // Common TLS settings
            const tlsSettings = tlsEnabled ? { enabled: true, server_name: sniValue, fingerprint: fingerprint, alpns: alpn } : undefined;

            if (scheme === 'vmess') {
                const d = JSON.parse(atob(configUrl.substring(8)));
                const vmessTls = d.tls === 'tls' ? { enabled: true, server_name: d.sni || d.host, fingerprint: fingerprint, alpns: alpn } : undefined;
                outbound = { 
                    type: 'vmess', tag, server: d.add, server_port: parseInt(d.port), 
                    uuid: d.id, security: d.scy || 'auto', alter_id: parseInt(d.aid || 0),
                    tls: vmessTls
                };
                if (d.net === 'ws') outbound.transport = { type: 'ws', path: d.path || '/', headers: { Host: d.host || d.add }};
            } else if (scheme === 'vless') {
                outbound = { 
                    type: 'vless', tag, server: url.hostname, server_port: parseInt(url.port), 
                    uuid: url.username, flow: p.get('flow') || '',
                    tls: tlsSettings
                };
                if (wsEnabled) outbound.transport = { type: 'ws', path: wsPath, headers: { Host: wsHeadersHost }};
            } else if (scheme === 'trojan') {
                outbound = { 
                    type: 'trojan', tag, server: url.hostname, server_port: parseInt(url.port), 
                    password: url.password, 
                    tls: tlsSettings 
                };
            } else if (scheme === 'ss') {
                const [method, password] = atob(url.username).split(':');
                outbound = { type: 'shadowsocks', tag, server: url.hostname, server_port: parseInt(url.port), method: method, password: password };
            } else if (['hy2', 'hysteria2'].includes(scheme)) {
                outbound = { 
                    type: 'hysteria2', tag, server: url.hostname, server_port: parseInt(url.port), 
                    password: url.password, 
                    tls: tlsSettings 
                };
                // Hysteria2 specific params
                const hy2_obfs = p.get('obfs');
                if (hy2_obfs) outbound.obfs = hy2_obfs;
            } else if (scheme === 'tuic') {
                outbound = { 
                    type: 'tuic', tag, server: url.hostname, server_port: parseInt(url.port), 
                    uuid: url.username, password: url.password, 
                    tls: tlsSettings,
                    version: p.get('version') ? parseInt(p.get('version')) : 5, // Default TUIC v5
                    congestion_control: p.get('congestion_control') || 'bbr',
                    zero_rtt_handshake: p.get('zero_rtt_handshake') === '1',
                    network: p.get('network') || 'udp',
                    udp_relay_mode: p.get('udp_relay_mode') || 'native',
                    disable_sni: p.get('disable_sni') === '1',
                };
            }
            if (outbound) outbounds.push(outbound);
        } catch (e) { console.error(`[Sing-box Gen] Error processing config ${configUrl.substring(0, 50)}...: ${e.message}`); }
    }
    if (outbounds.length === 0) return null;
    return JSON.stringify({ 
        "log": { "level": "info" }, 
        "inbounds": [{ "type": "mixed", "listen": "127.0.0.1", "listen_port": 2080 }], 
        "outbounds": [{ "type": "selector", "tag": "proxy", "outbounds": outbounds.map(o => o.tag), "default": outbounds[0]?.tag || '' }, ...outbounds]}, null, 2);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            // *** REMOVED /configs ENDPOINT ***
            // All configs will be fetched from static hosts directly by the frontend.
            // This worker is now only for ping and personal subscriptions.

            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port, tls, sni } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                
                try {
                    const startTime = Date.now();
                    const socket = connect({ hostname: host, port: parseInt(port) });
                    if (tls) {
                        const tlsSocket = await socket.startTls({ servername: sni || host });
                        await tlsSocket.close(); // Close the TLS socket
                    } else {
                        // For non-TLS, just establishing connection and immediately closing is enough for latency
                        const writer = socket.writable.getWriter();
                        await writer.close(); 
                    }
                    return jsonResponse({ latency: Date.now() - startTime, status: 'Live' }, 200, corsHeaders);
                } catch (e) {
                    console.error(`Ping error for ${host}:${port}: ${e.message}`);
                    return jsonResponse({ latency: null, status: 'Dead', error: e.message }, 200, corsHeaders);
                }
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) return jsonResponse({ error: '`configs` array is required.' }, 400, corsHeaders);
                const userUuid = clientUuid || uuidv4();
                await env.v2v_kv.put(`sub:${userUuid}`, JSON.stringify(configs), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                return jsonResponse({ 
                    uuid: userUuid, 
                    subscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, 
                    clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, 
                    singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` 
                }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                
                // Refresh TTL if accessed
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });

                if (format === 'raw') {
                    // Raw links are base64 encoded for better compatibility
                    return textResponse(btoa(storedData.join('\n')), 200, `v2v-${uuid}.txt`, corsHeaders);
                }
                if (format === 'clash') {
                    const content = generateClashYaml(storedData);
                    return content ? yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders) : textResponse('Failed to generate Clash config (no supported configs).', 500, null, corsHeaders);
                }
                if (format === 'singbox') {
                    const content = generateSingboxJson(storedData);
                    // Sing-box JSON should be directly returned, not JSON.parse then jsonResponse
                    return content ? jsonResponse(JSON.parse(content), 200, corsHeaders) : textResponse('Failed to generate Sing-box config (no supported configs).', 500, null, corsHeaders);
                }
            }
            
            // Default response for unmatched paths
            return textResponse('v2v Worker is running. Use /ping, /create-personal-sub, or /sub/{format}/{uuid} endpoints.', 200, null, corsHeaders);
        } catch (err) {
            console.error(err.stack);
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};
