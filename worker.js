/**
 * V2V Project - Final Production Worker
 * Handles:
 * - Advanced TCP latency testing (/api/ping)
 * - Self-healing subscription creation & retrieval (/api/subscribe, /sub/:uuid)
 * - Clash generation for subscriptions
 * - Force-downloads for static subscription files
 */

// --- CONFIGURATION ---
const REQUESTS_TIMEOUT = 4000;
const SUBSCRIPTION_TTL = 48 * 60 * 60;

// --- CORS HEADERS ---
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        try {
            if (url.pathname.endsWith('/clash_subscription.yml')) {
                // <<< !!! توجه: آدرس کامل و خام فایل کلش در گیت‌هاب یا هر میرور دیگر را اینجا قرار دهید !!! >>>
                const originUrl = 'https://raw.githubusercontent.com/smbcryp/V2V/main/clash_subscription.yml';

                const response = await fetch(originUrl, { headers: { 'User-Agent': 'V2V-Worker-Fetcher' }});
                if (!response.ok) {
                    return new Response('Static Clash file not found at origin.', { status: 404 });
                }
                const newHeaders = new Headers(response.headers);
                newHeaders.set('Content-Disposition', 'attachment; filename="v2v_clash.yml"');
                newHeaders.set('Content-Type', 'text/yaml;charset=utf-8');
                newHeaders.set('Cache-Control', 'no-cache');

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: newHeaders
                });
            }

            if (url.pathname === '/api/ping' && request.method === 'POST') {
                return await handlePingRequest(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return await handleSubscribeRequest(request, env);
            }
            const subMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (subMatch && request.method === 'GET') {
                const isClash = !!subMatch[1];
                const uuid = subMatch[2];
                return await handleGetSubscription(uuid, isClash, env);
            }
            
            return new Response('V2V API Worker is operational.', { headers: CORS_HEADERS });

        } catch (e) {
            console.error("Worker Error:", e);
            return new Response(JSON.stringify({ error: e.message || 'Internal Server Error' }), { status: 500, headers: JSON_HEADERS });
        }
    }
};

// --- HANDLERS (No changes from your provided file) ---
async function handlePingRequest(request) {
    const { configs } = await request.json();
    if (!Array.isArray(configs)) {
        return new Response(JSON.stringify({ error: 'Request body must be an array of configs.' }), { status: 400, headers: JSON_HEADERS });
    }
    const results = await Promise.all(configs.map(testTcpLatency));
    return new Response(JSON.stringify(results), { headers: JSON_HEADERS });
}

async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not configured.', { status: 503 });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) {
        return new Response(JSON.stringify({ error: "'configs' must be a non-empty array." }), { status: 400, headers: JSON_HEADERS });
    }
    const subUuid = crypto.randomUUID();
    await env.V2V_KV.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    const subscription_url = `${new URL(request.url).origin}/sub/${subUuid}`;
    return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('Error: KV Namespace is not configured.', { status: 503 });
    const kvData = await env.V2V_KV.get(`sub:${uuid}`);
    if (!kvData) {
        return new Response('Error: Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
    }
    const configs = JSON.parse(kvData);
    if (isClash) {
        const clashYaml = generateClashYaml(configs);
        if (!clashYaml) return new Response('Could not generate Clash config from provided subscriptions.', { status: 500 });
        return new Response(clashYaml, { headers: YAML_HEADERS });
    } else {
        return new Response(configs.join('\n'), { headers: TEXT_HEADERS });
    }
}

// --- PING & PARSING HELPERS (No changes from your provided file) ---
async function testTcpLatency(configStr) {
    const { hostname, port } = parseHostAndPort(configStr);
    if (!hostname || !port) {
        return { config: configStr, ping: null };
    }
    try {
        const startTime = Date.now();
        const socket = connect({ hostname, port, allowHalfOpen: false });
        await socket.opened;
        const latency = Date.now() - startTime;
        await socket.close();
        return { config: configStr, ping: latency };
    } catch (err) {
        return { config: configStr, ping: null };
    }
}

function parseHostAndPort(configStr) {
    try {
        if (configStr.startsWith('vmess://')) {
            const data = JSON.parse(atob(configStr.substring(8)));
            return { hostname: data.add, port: parseInt(data.port) };
        }
        const url = new URL(configStr);
        return { hostname: url.hostname, port: parseInt(url.port) };
    } catch {
        return { hostname: null, port: null };
    }
}

// --- CLASH GENERATION HELPERS (No changes from your provided file) ---
function generateClashYaml(configs) {
    const proxies = configs.map(parseProxyForClash).filter(p => p !== null);
    if (proxies.length === 0) return null;
    const proxyNames = proxies.map(p => p.name);
    const clashConfig = {
        'proxies': proxies,
        'proxy-groups': [
            { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 },
            { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] }
        ],
        'rules': ['MATCH,V2V-Select']
    };
    // Basic YAML serialization for workers
    let yamlString = "proxies:\n";
    proxies.forEach(p => {
        yamlString += `  - { ` + Object.entries(p).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ') + ` }\n`;
    });
    yamlString += "proxy-groups:\n";
    clashConfig['proxy-groups'].forEach(g => {
        yamlString += `  - { name: ${JSON.stringify(g.name)}, type: ${g.type}, proxies: [${g.proxies.map(p => JSON.stringify(p)).join(', ')}], url: '${g.url}', interval: ${g.interval} }\n`;
    });
    yamlString += "rules:\n  - MATCH,V2V-Select\n";
    return yamlString;
}

function parseProxyForClash(configStr) {
    try {
        const original_name = decodeURIComponent(configStr.split('#').pop() || "Config");
        let sanitized_name = original_name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
        if (sanitized_name.length > MAX_NAME_LENGTH) {
            sanitized_name = sanitized_name.substring(0, MAX_NAME_LENGTH) + '...';
        }
        const final_name = `V2V | ${sanitized_name || 'Config'}`;
        
        const base = { name: final_name, 'skip-cert-verify': true };
        const protocol = configStr.split('://')[0];

        if (protocol === 'vmess') {
            const d = JSON.parse(atob(configStr.substring(8)));
            const vmessProxy = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') vmessProxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
            return vmessProxy;
        }
        const url = new URL(configStr), params = new URLSearchParams(url.search);
        if (protocol === 'vless') {
             const vlessProxy = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
             if (params.get('type') === 'ws') vlessProxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }};
             return vlessProxy;
        }
        if (protocol === 'trojan') return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
        if (protocol === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; }
    } catch { return null; }
    return null;
}
