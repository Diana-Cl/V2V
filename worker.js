import { connect } from 'cloudflare:sockets';

const TTL_SUBSCRIPTION = 60 * 60 * 24 * 120;

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
            'Access-Control-Allow-Headers': 'Content-Type',
            'Vary': 'Origin',
        };
    }
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
}

function jsonResponse(data, status, corsHeaders) { 
    return new Response(JSON.stringify(data), { 
        status, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
}

function yamlResponse(text, corsHeaders) { 
    return new Response(text, { 
        status: 200,
        headers: { 
            'Content-Type': 'application/x-yaml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="v2v-clash.yaml"',
            ...corsHeaders 
        } 
    });
}

function toYAML(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    let yaml = '';
    
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined) continue;
        
        if (Array.isArray(value)) {
            yaml += `${spaces}${key}:\n`;
            value.forEach(item => {
                if (typeof item === 'object') {
                    yaml += `${spaces}- \n${toYAML(item, indent + 1).split('\n').map(line => line ? `${spaces}  ${line}` : '').join('\n')}\n`;
                } else {
                    yaml += `${spaces}- ${item}\n`;
                }
            });
        } else if (typeof value === 'object') {
            yaml += `${spaces}${key}:\n${toYAML(value, indent + 1)}`;
        } else if (typeof value === 'boolean') {
            yaml += `${spaces}${key}: ${value}\n`;
        } else if (typeof value === 'number') {
            yaml += `${spaces}${key}: ${value}\n`;
        } else {
            yaml += `${spaces}${key}: ${value}\n`;
        }
    }
    return yaml;
}

function parseVmessConfig(config) {
    try {
        const vmessData = config.replace('vmess://', '');
        const decoded = JSON.parse(atob(vmessData));
        if (!decoded.add || !decoded.port || !decoded.id) return null;
        return {
            server: decoded.add, 
            port: parseInt(decoded.port), 
            uuid: decoded.id,
            alterId: parseInt(decoded.aid) || 0, 
            cipher: decoded.scy || 'auto',
            network: decoded.net || 'tcp', 
            tls: decoded.tls === 'tls',
            sni: decoded.sni || decoded.host || decoded.add, 
            path: decoded.path || '/',
            host: decoded.host || decoded.add, 
            name: decoded.ps || `v2v-vmess-${decoded.add.substring(0,10)}`
        };
    } catch { return null; }
}

function parseVlessConfig(config) {
    try {
        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;
        const params = new URLSearchParams(urlObj.search);
        return {
            server: urlObj.hostname, 
            port: parseInt(urlObj.port), 
            uuid: urlObj.username,
            network: params.get('type') || 'tcp', 
            tls: params.get('security') === 'tls',
            sni: params.get('sni') || urlObj.hostname, 
            path: params.get('path') || '/',
            host: params.get('host') || urlObj.hostname, 
            flow: params.get('flow') || '',
            name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-vless-${urlObj.hostname.substring(0,10)}`
        };
    } catch { return null; }
}

function parseTrojanConfig(config) {
    try {
        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;
        const params = new URLSearchParams(urlObj.search);
        return {
            server: urlObj.hostname, 
            port: parseInt(urlObj.port), 
            password: urlObj.username,
            sni: params.get('sni') || urlObj.hostname,
            name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-trojan-${urlObj.hostname.substring(0,10)}`
        };
    } catch { return null; }
}

function parseSsConfig(config) {
    try {
        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;
        const decoded = atob(urlObj.username);
        if (!decoded.includes(':')) return null;
        const [method, password] = decoded.split(':', 2);
        return {
            server: urlObj.hostname, 
            port: parseInt(urlObj.port), 
            method, 
            password,
            name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-ss-${urlObj.hostname.substring(0,10)}`
        };
    } catch { return null; }
}

function generateClashYAML(configs, coreName) {
    const proxies = [];
    
    for (const config of configs) {
        try {
            let proxy = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                proxy = { 
                    name: p.name, 
                    type: 'vmess', 
                    server: p.server, 
                    port: p.port, 
                    uuid: p.uuid, 
                    alterId: p.alterId, 
                    cipher: p.cipher, 
                    udp: true, 
                    'skip-cert-verify': true 
                };
                if (p.network === 'ws') { 
                    proxy.network = 'ws'; 
                    proxy['ws-opts'] = { path: p.path, headers: { Host: p.host } }; 
                }
                if (p.tls) { 
                    proxy.tls = true; 
                    proxy.servername = p.sni; 
                }
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;
                proxy = { 
                    name: p.name, 
                    type: 'vless', 
                    server: p.server, 
                    port: p.port, 
                    uuid: p.uuid, 
                    udp: true, 
                    'skip-cert-verify': true 
                };
                if (p.network === 'ws') { 
                    proxy.network = 'ws'; 
                    proxy['ws-opts'] = { path: p.path, headers: { Host: p.host } }; 
                }
                if (p.tls) { 
                    proxy.tls = true; 
                    proxy.servername = p.sni;
                }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;
                proxy = { 
                    name: p.name, 
                    type: 'trojan', 
                    server: p.server, 
                    port: p.port, 
                    password: p.password, 
                    udp: true, 
                    sni: p.sni, 
                    'skip-cert-verify': true 
                };
            } else if (config.startsWith('ss://')) {
                const p = parseSsConfig(config);
                if (!p) continue;
                proxy = { 
                    name: p.name, 
                    type: 'ss', 
                    server: p.server, 
                    port: p.port, 
                    cipher: p.method, 
                    password: p.password, 
                    udp: true 
                };
            }
            
            if (proxy) proxies.push(proxy);
        } catch (e) {
            continue;
        }
    }
    
    if (proxies.length === 0) return null;
    
    const names = proxies.map(p => p.name);
    const config = {
        proxies,
        'proxy-groups': [
            { 
                name: `V2V-${coreName}-Auto`, 
                type: 'url-test', 
                proxies: names, 
                url: 'http://www.gstatic.com/generate_204', 
                interval: 300 
            },
            { 
                name: `V2V-${coreName}-Select`, 
                type: 'select', 
                proxies: [`V2V-${coreName}-Auto`, ...names] 
            }
        ],
        rules: [
            'DOMAIN-SUFFIX,local,DIRECT', 
            'IP-CIDR,127.0.0.0/8,DIRECT', 
            'IP-CIDR,10.0.0.0/8,DIRECT', 
            'IP-CIDR,172.16.0.0/12,DIRECT', 
            'IP-CIDR,192.168.0.0/16,DIRECT', 
            'GEOIP,IR,DIRECT', 
            `MATCH,V2V-${coreName}-Select`
        ]
    };
    
    return toYAML(config);
}

function generateSingboxJSON(configs, coreName) {
    const outbounds = [];
    
    for (const config of configs) {
        try {
            let outbound = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                outbound = { 
                    tag: p.name, 
                    type: 'vmess', 
                    server: p.server, 
                    server_port: p.port, 
                    uuid: p.uuid, 
                    alter_id: p.alterId, 
                    security: p.cipher 
                };
                if (p.network === 'ws') {
                    outbound.transport = { type: 'ws', path: p.path, headers: { Host: p.host } };
                }
                if (p.tls) {
                    outbound.tls = { enabled: true, server_name: p.sni, insecure: true };
                }
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;
                outbound = { 
                    tag: p.name, 
                    type: 'vless', 
                    server: p.server, 
                    server_port: p.port, 
                    uuid: p.uuid
                };
                if (p.network === 'ws') {
                    outbound.transport = { type: 'ws', path: p.path, headers: { Host: p.host } };
                }
                if (p.tls) {
                    outbound.tls = { enabled: true, server_name: p.sni, insecure: true };
                    if (p.flow) outbound.flow = p.flow;
                }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;
                outbound = { 
                    tag: p.name, 
                    type: 'trojan', 
                    server: p.server, 
                    server_port: p.port, 
                    password: p.password, 
                    tls: { enabled: true, server_name: p.sni, insecure: true } 
                };
            } else if (config.startsWith('ss://')) {
                const p = parseSsConfig(config);
                if (!p) continue;
                outbound = { 
                    tag: p.name, 
                    type: 'shadowsocks', 
                    server: p.server, 
                    server_port: p.port, 
                    method: p.method, 
                    password: p.password 
                };
            }
            
            if (outbound) outbounds.push(outbound);
        } catch (e) {
            continue;
        }
    }
    
    if (outbounds.length === 0) return null;
    
    return JSON.stringify({
        log: { disabled: false, level: "info" },
        dns: { servers: [{ address: "8.8.8.8", strategy: "prefer_ipv4" }] },
        inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: 7890 }],
        outbounds: [
            { 
                tag: `V2V-${coreName}-Select`, 
                type: "urltest", 
                outbounds: outbounds.map(o => o.tag), 
                url: "http://www.gstatic.com/generate_204", 
                interval: "5m" 
            },
            ...outbounds,
            { tag: "direct", type: "direct" }
        ],
        route: { 
            rules: [
                { geoip: "ir", outbound: "direct" }, 
                { geoip: "private", outbound: "direct" }
            ], 
            auto_detect_interface: true 
        }
    }, null, 2);
}

async function testConnection(host, port, tls, sni) {
    const maxAttempts = 5;
    const latencies = [];
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const startTime = Date.now();
            const socketOptions = { hostname: host, port: parseInt(port) };
            if (tls) { 
                socketOptions.secureTransport = 'on'; 
                socketOptions.servername = sni || host;
                socketOptions.allowHalfOpen = false;
            }
            
            const socket = connect(socketOptions);
            
            await Promise.race([
                (async () => {
                    await socket.opened;
                    
                    const writer = socket.writable.getWriter();
                    const testData = new Uint8Array([0x16, 0x03, 0x01]);
                    await writer.write(testData);
                    writer.releaseLock();
                    
                    const reader = socket.readable.getReader();
                    await Promise.race([
                        reader.read(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Read timeout')), 3000))
                    ]);
                    reader.releaseLock();
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 8000))
            ]);
            
            const latency = Date.now() - startTime;
            
            try { await socket.close(); } catch {}
            
            if (latency > 0 && latency < 8000) {
                latencies.push(latency);
            }
            
            await new Promise(resolve => setTimeout(resolve, 150));
            
        } catch (error) {
            continue;
        }
    }
    
    if (latencies.length === 0) {
        return { latency: null, status: 'Dead' };
    }
    
    if (latencies.length < 3) {
        return { latency: null, status: 'Dead' };
    }
    
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b) / latencies.length);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const jitter = maxLatency - minLatency;
    
    if (jitter > 1000) {
        return { latency: null, status: 'Dead' };
    }
    
    return { 
        latency: avgLatency,
        status: 'Live'
    };
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
                if (!host || !port) return jsonResponse({ error: 'Invalid parameters' }, 400, corsHeaders);
                const result = await testConnection(host, port, tls, sni);
                return jsonResponse(result, 200, corsHeaders);
            }
            
            if (url.pathname === '/create-sub' && request.method === 'POST') {
                const { uuid, configs, core, format } = await request.json();
                if (!uuid || !Array.isArray(configs) || configs.length === 0 || !core || !format) {
                    return jsonResponse({ error: 'Invalid request' }, 400, corsHeaders);
                }
                
                await env.v2v_kv.put(
                    `sub:${uuid}`, 
                    JSON.stringify({ configs, core, format, created: Date.now() }), 
                    { expirationTtl: TTL_SUBSCRIPTION }
                );
                
                return jsonResponse({ success: true, uuid }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(clash|singbox)\/([a-f0-9\-]{36})$/);
            if (subMatch) {
                const format = subMatch[1];
                const uuid = subMatch[2];
                
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData || !storedData.configs) {
                    return new Response('Subscription not found or expired', { status: 404, headers: corsHeaders });
                }
                
                await env.v2v_kv.put(
                    `sub:${uuid}`, 
                    JSON.stringify(storedData), 
                    { expirationTtl: TTL_SUBSCRIPTION }
                );
                
                const { configs, core } = storedData;
                
                if (format === 'clash') {
                    const content = generateClashYAML(configs, core);
                    if (!content) return new Response('Failed to generate Clash config', { status: 500, headers: corsHeaders });
                    return yamlResponse(content, corsHeaders);
                }
                
                if (format === 'singbox') {
                    const content = generateSingboxJSON(configs, core);
                    if (!content) return new Response('Failed to generate Singbox config', { status: 500, headers: corsHeaders });
                    return jsonResponse(JSON.parse(content), 200, corsHeaders);
                }
            }
            
            return new Response('V2V Worker Active', { status: 200, headers: corsHeaders });
            
        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ error: 'Internal error', details: err.message }, 500, corsHeaders);
        }
    },
};