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
            'Access-Control-Max-Age': '86400',
        };
    }
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
}

function jsonResponse(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

function textResponse(text, contentType, corsHeaders, filename = null) {
    const headers = {
        'Content-Type': `${contentType}; charset=utf-8`,
        ...corsHeaders
    };
    if (filename) {
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    return new Response(text, { status: 200, headers });
}

// تولید UUID منحصر به فرد برای tag
function generateUniqueTag(protocol, server, index) {
    const hash = `${server}${index}`.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
    }, 0);
    return `V2V-${protocol}-${Math.abs(hash).toString(36).substring(0, 6)}`;
}

function safeBase64Decode(str) {
    try {
        return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
        return null;
    }
}

function parseVmessConfig(config) {
    try {
        if (!config || !config.startsWith('vmess://')) return null;

        const vmessData = config.replace('vmess://', '').trim();
        const decoded = safeBase64Decode(vmessData);
        if (!decoded) return null;

        const json = JSON.parse(decoded);
        if (!json.add || !json.port || !json.id) return null;

        return {
            server: String(json.add).trim(),
            port: parseInt(json.port),
            uuid: String(json.id).trim(),
            alterId: parseInt(json.aid) || 0,
            cipher: json.scy || 'auto',
            network: json.net || 'tcp',
            tls: json.tls === 'tls',
            sni: json.sni || json.host || json.add,
            path: json.path || '/',
            host: json.host || json.add,
            name: (json.ps || `VMess-${json.add}`).substring(0, 30)
        };
    } catch {
        return null;
    }
}

function parseVlessConfig(config) {
    try {
        if (!config || !config.startsWith('vless://')) return null;

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
            name: (decodeURIComponent(urlObj.hash.substring(1)) || `VLESS-${urlObj.hostname}`).substring(0, 30)
        };
    } catch {
        return null;
    }
}

function parseTrojanConfig(config) {
    try {
        if (!config || !config.startsWith('trojan://')) return null;

        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;

        const params = new URLSearchParams(urlObj.search);

        return {
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            password: urlObj.username,
            sni: params.get('sni') || urlObj.hostname,
            name: (decodeURIComponent(urlObj.hash.substring(1)) || `Trojan-${urlObj.hostname}`).substring(0, 30)
        };
    } catch {
        return null;
    }
}

function parseSsConfig(config) {
    try {
        if (!config || !config.startsWith('ss://')) return null;

        const urlObj = new URL(config);
        if (!urlObj.hostname || !urlObj.port || !urlObj.username) return null;

        const decoded = safeBase64Decode(urlObj.username);
        if (!decoded || !decoded.includes(':')) return null;

        const colonIndex = decoded.indexOf(':');
        const method = decoded.substring(0, colonIndex);
        const password = decoded.substring(colonIndex + 1);

        if (!method || !password) return null;

        return {
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            method: method,
            password: password,
            name: (decodeURIComponent(urlObj.hash.substring(1)) || `SS-${urlObj.hostname}`).substring(0, 30)
        };
    } catch {
        return null;
    }
}

function generateClashYAML(configs) {
    const proxies = [];
    const seen = new Set();

    for (let i = 0; i < configs.length; i++) {
        const config = configs[i];
        try {
            let proxy = null;
            let uniqueKey = null;

            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;

                uniqueKey = `vmess-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(uniqueKey)) continue;

                const name = generateUniqueTag('vmess', p.server, i);

                proxy = {
                    name: name,
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
                    proxy['ws-opts'] = {
                        path: p.path,
                        headers: { Host: p.host }
                    };
                }
                if (p.tls) {
                    proxy.tls = true;
                    proxy.servername = p.sni;
                }
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;

                uniqueKey = `vless-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(uniqueKey)) continue;

                const name = generateUniqueTag('vless', p.server, i);

                proxy = {
                    name: name,
                    type: 'vless',
                    server: p.server,
                    port: p.port,
                    uuid: p.uuid,
                    udp: true,
                    'skip-cert-verify': true
                };

                if (p.network === 'ws') {
                    proxy.network = 'ws';
                    proxy['ws-opts'] = {
                        path: p.path,
                        headers: { Host: p.host }
                    };
                }
                if (p.tls) {
                    proxy.tls = true;
                    proxy.servername = p.sni;
                    if (p.flow) proxy.flow = p.flow;
                }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;

                uniqueKey = `trojan-${p.server}-${p.port}-${p.password}`;
                if (seen.has(uniqueKey)) continue;

                const name = generateUniqueTag('trojan', p.server, i);

                proxy = {
                    name: name,
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

                uniqueKey = `ss-${p.server}-${p.port}-${p.method}`;
                if (seen.has(uniqueKey)) continue;

                const name = generateUniqueTag('ss', p.server, i);

                proxy = {
                    name: name,
                    type: 'ss',
                    server: p.server,
                    port: p.port,
                    cipher: p.method,
                    password: p.password,
                    udp: true
                };
            }

            if (proxy && uniqueKey) {
                seen.add(uniqueKey);
                proxies.push(proxy);
            }
        } catch (err) {
            console.error('Proxy parse error:', err);
        }
    }

    if (proxies.length === 0) {
        return 'proxies: []';
    }

    const names = proxies.map(p => p.name);

    // تولید YAML دستی (بدون کتابخانه)
    let yaml = 'proxies:\n';

    for (const proxy of proxies) {
        yaml += `  - name: ${proxy.name}\n`;
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
    yaml += '  - name: V2V-Auto\n';
    yaml += '    type: url-test\n';
    yaml += '    proxies:\n';
    for (const name of names) {
        yaml += `      - ${name}\n`;
    }
    yaml += '    url: http://www.gstatic.com/generate_204\n';
    yaml += '    interval: 300\n\n';

    yaml += '  - name: V2V-Select\n';
    yaml += '    type: select\n';
    yaml += '    proxies:\n';
    yaml += '      - V2V-Auto\n';
    for (const name of names) {
        yaml += `      - ${name}\n`;
    }

    yaml += '\nrules:\n';
    yaml += '  - GEOIP,IR,DIRECT\n';
    yaml += '  - MATCH,V2V-Select\n';

    return yaml;
}

function generateSingboxJSON(configs) {
    const outbounds = [];
    const seen = new Set();

    for (let i = 0; i < configs.length; i++) {
        const config = configs[i];
        try {
            let outbound = null;
            let uniqueKey = null;

            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;

                uniqueKey = `vmess-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(uniqueKey)) continue;

                const tag = generateUniqueTag('vmess', p.server, i);

                outbound = {
                    tag: tag,
                    type: 'vmess',
                    server: p.server,
                    server_port: p.port,
                    uuid: p.uuid,
                    alter_id: p.alterId,
                    security: p.cipher
                };

                if (p.network === 'ws') {
                    outbound.transport = {
                        type: 'ws',
                        path: p.path,
                        headers: { Host: p.host }
                    };
                }
                if (p.tls) {
                    outbound.tls = {
                        enabled: true,
                        server_name: p.sni,
                        insecure: true
                    };
                }
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;

                uniqueKey = `vless-${p.server}-${p.port}-${p.uuid}`;
                if (seen.has(uniqueKey)) continue;

                const tag = generateUniqueTag('vless', p.server, i);

                outbound = {
                    tag: tag,
                    type: 'vless',
                    server: p.server,
                    server_port: p.port,
                    uuid: p.uuid
                };

                if (p.network === 'ws') {
                    outbound.transport = {
                        type: 'ws',
                        path: p.path,
                        headers: { Host: p.host }
                    };
                }
                if (p.tls) {
                    outbound.tls = {
                        enabled: true,
                        server_name: p.sni,
                        insecure: true
                    };
                    if (p.flow) outbound.flow = p.flow;
                }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;

                uniqueKey = `trojan-${p.server}-${p.port}-${p.password}`;
                if (seen.has(uniqueKey)) continue;

                const tag = generateUniqueTag('trojan', p.server, i);

                outbound = {
                    tag: tag,
                    type: 'trojan',
                    server: p.server,
                    server_port: p.port,
                    password: p.password,
                    tls: {
                        enabled: true,
                        server_name: p.sni,
                        insecure: true
                    }
                };
            } else if (config.startsWith('ss://')) {
                const p = parseSsConfig(config);
                if (!p) continue;

                uniqueKey = `ss-${p.server}-${p.port}-${p.method}`;
                if (seen.has(uniqueKey)) continue;

                const tag = generateUniqueTag('ss', p.server, i);

                outbound = {
                    tag: tag,
                    type: 'shadowsocks',
                    server: p.server,
                    server_port: p.port,
                    method: p.method,
                    password: p.password
                };
            }

            if (outbound && uniqueKey) {
                seen.add(uniqueKey);
                outbounds.push(outbound);
            }
        } catch (err) {
            console.error('Outbound parse error:', err);
        }
    }

    if (outbounds.length === 0) return null;

    return JSON.stringify({
        log: { level: 'info' },
        dns: {
            servers: [
                { tag: 'google', address: '8.8.8.8' },
                { tag: 'local', address: 'local', detour: 'direct' }
            ]
        },
        inbounds: [
            { type: 'mixed', listen: '127.0.0.1', listen_port: 7890 }
        ],
        outbounds: [
            {
                tag: 'V2V-Auto',
                type: 'urltest',
                outbounds: outbounds.map(o => o.tag),
                url: 'http://www.gstatic.com/generate_204',
                interval: '5m'
            },
            {
                tag: 'V2V-Select',
                type: 'selector',
                outbounds: ['V2V-Auto', ...outbounds.map(o => o.tag)]
            },
            ...outbounds,
            { tag: 'direct', type: 'direct' },
            { tag: 'block', type: 'block' }
        ],
        route: {
            rules: [
                { geoip: 'ir', outbound: 'direct' }
            ],
            final: 'V2V-Select'
        }
    }, null, 2);
}

async function testConnection(host, port) {
    try {
        const startTime = Date.now();
        const socket = connect({ hostname: host, port: parseInt(port) });

        await Promise.race([
            socket.opened,
            new Promise((_, reject) => setTimeout(() => reject(), 5000))
        ]);

        const latency = Date.now() - startTime;
        try { await socket.close(); } catch {}

        return { latency, status: 'Live' };
    } catch {
        return { latency: null, status: 'Dead' };
    }
}

function generateShortId() {
    return Array.from({ length: 8 }, () =>
        'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]
    ).join('');
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        try {
            if (url.pathname === '/' && request.method === 'GET') {
                return jsonResponse({
                    status: 'V2V Worker v6.0',
                    endpoints: ['/ping', '/create-sub', '/sub/{format}/{id}']
                }, 200, corsHeaders);
            }

            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port } = await request.json();
                if (!host || !port) {
                    return jsonResponse({ error: 'Missing host/port' }, 400, corsHeaders);
                }
                const result = await testConnection(host, port);
                return jsonResponse(result, 200, corsHeaders);
            }

            if (url.pathname === '/create-sub' && request.method === 'POST') {
                const { configs, format } = await request.json();

                if (!Array.isArray(configs) || configs.length === 0) {
                    return jsonResponse({ error: 'Invalid configs' }, 400, corsHeaders);
                }

                if (!['clash', 'singbox'].includes(format)) {
                    return jsonResponse({ error: 'Invalid format' }, 400, corsHeaders);
                }

                const shortId = generateShortId();

                await env.v2v_kv.put(
                    `sub:${shortId}`,
                    JSON.stringify({ configs, format, created: Date.now() }),
                    { expirationTtl: TTL_SUBSCRIPTION }
                );

                return jsonResponse({
                    success: true,
                    id: shortId,
                    url: `${url.origin}/sub/${format}/${shortId}`
                }, 200, corsHeaders);
            }

            const subMatch = url.pathname.match(/^\/sub\/(clash|singbox)\/([a-z0-9]{8})$/);
            if (subMatch && request.method === 'GET') {
                const format = subMatch[1];
                const shortId = subMatch[2];

                const storedData = await env.v2v_kv.get(`sub:${shortId}`, { type: 'json' });

                if (!storedData || !storedData.configs) {
                    return new Response('Not found', { status: 404, headers: corsHeaders });
                }

                const { configs } = storedData;

                if (format === 'clash') {
                    const content = generateClashYAML(configs);
                    return textResponse(content, 'text/yaml', corsHeaders, 'V2V-Clash.yaml');
                }

                if (format === 'singbox') {
                    const content = generateSingboxJSON(configs);
                    if (!content) {
                        return jsonResponse({ error: 'No valid configs' }, 500, corsHeaders);
                    }
                    return textResponse(content, 'application/json', corsHeaders, 'V2V-Singbox.json');
                }
            }

            return new Response('Not Found', { status: 404, headers: corsHeaders });

        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ error: err.message }, 500, corsHeaders);
        }
    },
};