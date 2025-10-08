import { connect } from 'cloudflare:sockets';

const TTL_SUBSCRIPTION = 60 * 60 * 24 * 365;

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
            'Content-Disposition': 'attachment; filename="config.yaml"',
            ...corsHeaders 
        } 
    });
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
            name: decoded.ps || `vmess-${decoded.add.substring(0,8)}`
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
            name: decodeURIComponent(urlObj.hash.substring(1)) || `vless-${urlObj.hostname.substring(0,8)}`
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
            name: decodeURIComponent(urlObj.hash.substring(1)) || `trojan-${urlObj.hostname.substring(0,8)}`
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
            name: decodeURIComponent(urlObj.hash.substring(1)) || `ss-${urlObj.hostname.substring(0,8)}`
        };
    } catch { return null; }
}

function parseTuicConfig(config) {
    try {
        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port) return null;
        const params = new URLSearchParams(urlObj.search);
        
        const uuid = urlObj.username || params.get('uuid') || '';
        const password = params.get('password') || '';
        
        if (!uuid && !password) return null;
        
        return {
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            uuid: uuid,
            password: password,
            congestion_control: params.get('congestion_control') || 'bbr',
            alpn: params.get('alpn') || 'h3',
            sni: params.get('sni') || urlObj.hostname,
            name: decodeURIComponent(urlObj.hash.substring(1)) || `tuic-${urlObj.hostname.substring(0,8)}`
        };
    } catch { return null; }
}

function parseHy2Config(config) {
    try {
        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;
        const params = new URLSearchParams(urlObj.search);
        return {
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            password: urlObj.username,
            sni: params.get('sni') || urlObj.hostname,
            name: decodeURIComponent(urlObj.hash.substring(1)) || `hy2-${urlObj.hostname.substring(0,8)}`
        };
    } catch { return null; }
}

function generateClashYAML(configs) {
    const proxies = [];
    const seen = new Set();
    
    for (const config of configs) {
        try {
            let proxy = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                
                const key = `vmess-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                
                const key = `vless-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                    if (p.flow) proxy.flow = p.flow;
                }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;
                
                const key = `trojan-${p.server}-${p.port}-${p.password}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                
                const key = `ss-${p.server}-${p.port}-${p.password}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
            // TUIC و Hy2 در Clash پشتیبانی نمی‌شن
            
            if (proxy) proxies.push(proxy);
        } catch (e) {
            continue;
        }
    }
    
    if (proxies.length === 0) return null;
    
    const names = proxies.map(p => p.name);
    
    let yaml = 'proxies:\n';
    for (const proxy of proxies) {
        yaml += `  - name: "${proxy.name}"\n`;
        yaml += `    type: ${proxy.type}\n`;
        yaml += `    server: ${proxy.server}\n`;
        yaml += `    port: ${proxy.port}\n`;
        
        if (proxy.type === 'vmess') {
            yaml += `    uuid: ${proxy.uuid}\n`;
            yaml += `    alterId: ${proxy.alterId}\n`;
            yaml += `    cipher: ${proxy.cipher}\n`;
            yaml += `    udp: true\n`;
            if (proxy.network) {
                yaml += `    network: ${proxy.network}\n`;
                if (proxy['ws-opts']) {
                    yaml += `    ws-opts:\n`;
                    yaml += `      path: ${proxy['ws-opts'].path}\n`;
                    yaml += `      headers:\n`;
                    yaml += `        Host: ${proxy['ws-opts'].headers.Host}\n`;
                }
            }
            if (proxy.tls) {
                yaml += `    tls: true\n`;
                yaml += `    servername: ${proxy.servername}\n`;
            }
            yaml += `    skip-cert-verify: true\n`;
        } else if (proxy.type === 'vless') {
            yaml += `    uuid: ${proxy.uuid}\n`;
            yaml += `    udp: true\n`;
            if (proxy.network) {
                yaml += `    network: ${proxy.network}\n`;
                if (proxy['ws-opts']) {
                    yaml += `    ws-opts:\n`;
                    yaml += `      path: ${proxy['ws-opts'].path}\n`;
                    yaml += `      headers:\n`;
                    yaml += `        Host: ${proxy['ws-opts'].headers.Host}\n`;
                }
            }
            if (proxy.tls) {
                yaml += `    tls: true\n`;
                yaml += `    servername: ${proxy.servername}\n`;
                if (proxy.flow) yaml += `    flow: ${proxy.flow}\n`;
            }
            yaml += `    skip-cert-verify: true\n`;
        } else if (proxy.type === 'trojan') {
            yaml += `    password: ${proxy.password}\n`;
            yaml += `    udp: true\n`;
            yaml += `    sni: ${proxy.sni}\n`;
            yaml += `    skip-cert-verify: true\n`;
        } else if (proxy.type === 'ss') {
            yaml += `    cipher: ${proxy.cipher}\n`;
            yaml += `    password: ${proxy.password}\n`;
            yaml += `    udp: true\n`;
        }
    }
    
    yaml += '\nproxy-groups:\n';
    yaml += `  - name: "Auto"\n`;
    yaml += `    type: url-test\n`;
    yaml += `    proxies:\n`;
    for (const name of names) {
        yaml += `      - "${name}"\n`;
    }
    yaml += `    url: http://www.gstatic.com/generate_204\n`;
    yaml += `    interval: 300\n`;
    
    yaml += `  - name: "Select"\n`;
    yaml += `    type: select\n`;
    yaml += `    proxies:\n`;
    yaml += `      - "Auto"\n`;
    for (const name of names) {
        yaml += `      - "${name}"\n`;
    }
    
    yaml += '\nrules:\n';
    yaml += '  - DOMAIN-SUFFIX,local,DIRECT\n';
    yaml += '  - IP-CIDR,127.0.0.0/8,DIRECT\n';
    yaml += '  - IP-CIDR,10.0.0.0/8,DIRECT\n';
    yaml += '  - IP-CIDR,172.16.0.0/12,DIRECT\n';
    yaml += '  - IP-CIDR,192.168.0.0/16,DIRECT\n';
    yaml += '  - GEOIP,IR,DIRECT\n';
    yaml += '  - MATCH,Select\n';
    
    return yaml;
}

function generateSingboxJSON(configs) {
    const outbounds = [];
    const seen = new Set();
    
    for (const config of configs) {
        try {
            let outbound = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                
                const key = `vmess-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                
                const key = `vless-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                
                const key = `trojan-${p.server}-${p.port}-${p.password}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
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
                
                const key = `ss-${p.server}-${p.port}-${p.password}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
                outbound = { 
                    tag: p.name, 
                    type: 'shadowsocks', 
                    server: p.server, 
                    server_port: p.port, 
                    method: p.method, 
                    password: p.password 
                };
            } else if (config.startsWith('tuic://')) {
                const p = parseTuicConfig(config);
                if (!p) continue;
                
                const key = `tuic-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
                outbound = {
                    tag: p.name,
                    type: 'tuic',
                    server: p.server,
                    server_port: p.port,
                    uuid: p.uuid,
                    password: p.password,
                    congestion_control: p.congestion_control,
                    tls: {
                        enabled: true,
                        server_name: p.sni,
                        insecure: true,
                        alpn: [p.alpn]
                    }
                };
            } else if (config.startsWith('hysteria2://') || config.startsWith('hy2://')) {
                const p = parseHy2Config(config);
                if (!p) continue;
                
                const key = `hy2-${p.server}-${p.port}-${p.password}`;
                if (seen.has(key)) continue;
                seen.add(key);
                
                outbound = {
                    tag: p.name,
                    type: 'hysteria2',
                    server: p.server,
                    server_port: p.port,
                    password: p.password,
                    tls: {
                        enabled: true,
                        server_name: p.sni,
                        insecure: true
                    }
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
                tag: "Auto", 
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

async function testConnection(host, port) {
    try {
        const startTime = Date.now();
        const socket = connect({ hostname: host, port: parseInt(port) });
        
        await Promise.race([
            socket.opened,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);
        
        const latency = Date.now() - startTime;
        
        try { await socket.close(); } catch {}
        
        return { latency: latency > 0 && latency < 2000 ? latency : null, status: 'Live' };
    } catch (error) {
        return { latency: null, status: 'Dead' };
    }
}

function generateShortId() {
    return Math.random().toString(36).substring(2, 10);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid parameters' }, 400, corsHeaders);
                const result = await testConnection(host, port);
                return jsonResponse(result, 200, corsHeaders);
            }
            
            if (url.pathname === '/create-sub' && request.method === 'POST') {
                const { configs, format } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0 || !format) {
                    return jsonResponse({ error: 'Invalid request' }, 400, corsHeaders);
                }
                
                const shortId = generateShortId();
                
                await env.v2v_kv.put(
                    `sub:${shortId}`, 
                    JSON.stringify({ configs, format, created: Date.now() }), 
                    { expirationTtl: TTL_SUBSCRIPTION }
                );
                
                return jsonResponse({ success: true, id: shortId }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(clash|singbox)\/([a-z0-9]{8})$/);
            if (subMatch) {
                const format = subMatch[1];
                const shortId = subMatch[2];
                
                const storedData = await env.v2v_kv.get(`sub:${shortId}`, { type: 'json' });
                if (!storedData || !storedData.configs) {
                    return new Response('Not found', { status: 404, headers: corsHeaders });
                }
                
                await env.v2v_kv.put(
                    `sub:${shortId}`, 
                    JSON.stringify(storedData), 
                    { expirationTtl: TTL_SUBSCRIPTION }
                );
                
                const { configs } = storedData;
                
                if (format === 'clash') {
                    const content = generateClashYAML(configs);
                    if (!content) return new Response('No valid configs', { status: 500, headers: corsHeaders });
                    return yamlResponse(content, corsHeaders);
                }
                
                if (format === 'singbox') {
                    const content = generateSingboxJSON(configs);
                    if (!content) return new Response('No valid configs', { status: 500, headers: corsHeaders });
                    return jsonResponse(JSON.parse(content), 200, corsHeaders);
                }
            }
            
            return new Response('V2V Worker', { status: 200, headers: corsHeaders });
            
        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ error: 'Internal error', details: err.message }, 500, corsHeaders);
        }
    },
};