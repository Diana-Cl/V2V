import { connect } from 'cloudflare:sockets';

// --- CONFIGURATION ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours
const READY_SUB_COUNT = 30;
const DATA_MIRRORS = [
    'https://v2v-vercel.vercel.app/all_live_configs.json',
    'https://smbcryp.github.io/V2V/all_live_configs.json',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
];
const MAX_NAME_LENGTH = 40;

// --- HEADERS ---
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

// --- MAIN FETCH HANDLER ---
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
        const url = new URL(request.url);

        try {
            if (url.pathname === '/tcp-bridge') {
                const upgradeHeader = request.headers.get('Upgrade');
                if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
                    return new Response('Expected WebSocket upgrade', { status: 426 });
                }
                return tcpBridge(request);
            }

            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return handleSubscribeRequest(request, env);
            }

            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(clash\/)?(xray|singbox)$/);
            if (publicSubMatch) {
                const core = publicSubMatch[2];
                const isClash = !!publicSubMatch[1];
                return handleGetPublicSubscription(core, isClash, env);
            }

            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const uuid = personalSubMatch[2];
                const isClash = !!personalSubMatch[1];
                return handleGetPersonalSubscription(uuid, isClash, env);
            }

            return new Response('V2V API Worker is operational.', { headers: CORS_HEADERS });
        } catch (error) {
            console.error('Worker Error:', error.stack);
            return new Response(error.message || 'Internal Server Error', { status: 500, headers: CORS_HEADERS });
        }
    }
};

// --- TCP BRIDGE LOGIC ---
async function tcpBridge(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener('message', async (event) => {
        try {
            const { host, port } = JSON.parse(event.data);
            if (!host || !port) return server.send(JSON.stringify({ error: 'Invalid host or port' }));
            
            const startTime = Date.now();
            const socket = connect({ hostname: host, port });
            await socket.opened;
            const latency = Date.now() - startTime;
            
            server.send(JSON.stringify({ host, port, latency, status: 'success' }));
            await socket.close();
        } catch (e) {
            server.send(JSON.stringify({ error: e.message || "Connection failed", status: 'failure' }));
        }
    });
    return new Response(null, { status: 101, webSocket: client });
}

// --- SUBSCRIPTION LOGIC ---
async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not configured.', { status: 500 });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) return new Response("'configs' must be a non-empty array.", { status: 400 });
    const subUuid = crypto.randomUUID();
    await env.V2V_KV.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    const subscription_url = `${new URL(request.url).origin}/sub/${subUuid}`;
    return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPublicSubscription(core, isClash, env) {
    const liveData = await fetchFromMirrors();
    const coreConfigs = liveData[core] || {};
    const allFlatConfigs = Object.values(coreConfigs).flat();
    const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);
    if (topConfigs.length === 0) return new Response(`No public configs found for core: ${core}`, { status: 404 });
    return generateSubscriptionResponse(topConfigs, isClash, env);
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not configured.', { status: 500 });
    const [kvData, liveData] = await Promise.all([ env.V2V_KV.get(`sub:${uuid}`), fetchFromMirrors() ]);
    if (!kvData) return new Response('Subscription not found or has expired.', { status: 404 });
    
    let userConfigs = JSON.parse(kvData);
    const allLiveConfigs = new Set(Object.values(liveData.xray || {}).flat().concat(Object.values(liveData.singbox || {}).flat()));
    
    let healedConfigs = userConfigs.filter(cfg => allLiveConfigs.has(cfg));
    const deadCount = userConfigs.length - healedConfigs.length;
    if (deadCount > 0) {
        const userConfigsSet = new Set(userConfigs);
        const replacements = [...allLiveConfigs].filter(cfg => !userConfigsSet.has(cfg));
        healedConfigs.push(...replacements.slice(0, deadCount));
    }
    if (healedConfigs.length === 0 && allLiveConfigs.size > 0) {
        healedConfigs = [...allLiveConfigs].slice(0, Math.min(10, allLiveConfigs.size));
    }
    
    await env.V2V_KV.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
    return generateSubscriptionResponse(healedConfigs, isClash, env);
}

async function generateSubscriptionResponse(configs, isClash) {
    if (isClash) {
        const clashYaml = await generateClashYaml(configs);
        if (!clashYaml) throw new Error('Could not generate Clash config.');
        const headers = new Headers(YAML_HEADERS);
        headers.set('Content-Disposition', 'attachment; filename="v2v_clash.yaml"');
        return new Response(clashYaml, { headers });
    } else {
        return new Response(btoa(unescape(encodeURIComponent(configs.join('\n')))), { headers: TEXT_HEADERS });
    }
}

// --- HELPERS & YAML GENERATION ---
async function fetchFromMirrors() { return Promise.any(DATA_MIRRORS.map(url => fetch(`${url}?t=${Date.now()}`).then(r => r.ok ? r.json() : Promise.reject(`Fetch failed for ${url}`)))); }

async function generateProxyName(configStr, server, port) {
    try {
        const url = new URL(configStr);
        let name = decodeURIComponent(url.hash.substring(1) || "");
        if (!name) {
            const server_id = `${server}:${port}`;
            const buffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(server_id));
            const hash = Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6);
            name = `Config-${hash}`;
        }
        name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim().substring(0, MAX_NAME_LENGTH);
        const finalHash = (await crypto.subtle.digest('MD5', new TextEncoder().encode(`${server}:${port}`))).toString().substring(0,4);
        return `V2V | ${name} | ${finalHash}`;
    } catch { return `V2V | Unnamed Config`; }
}

async function parseProxyForClash(configStr) {
    try {
        const url = new URL(configStr);
        const server = url.hostname;
        const port = parseInt(url.port);
        const name = await generateProxyName(configStr, server, port);
        const base = { name, 'skip-cert-verify': true };
        const proto = url.protocol.replace(':', '');
        const params = new URLSearchParams(url.search);

        if (proto === 'vmess') {
            const d = JSON.parse(atob(configStr.substring(8)));
            const vmessServer = d.add || server;
            const vmessPort = parseInt(d.port) || port;
            const vmessName = await generateProxyName(configStr, vmessServer, vmessPort);
            const p = { ...base, name: vmessName, type: 'vmess', server: vmessServer, port: vmessPort, uuid: d.id, alterId: parseInt(d.aid), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
            return p;
        }
        if (proto === 'vless') {
            const p = { ...base, type: 'vless', server, port, uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
            if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || server }};
            return p;
        }
        if (proto === 'trojan') return { ...base, type: 'trojan', server, port, password: url.username, sni: params.get('sni') };
        if (proto === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server, port, cipher: c, password: p }; }
    } catch { return null; }
    return null;
}

function safeYamlStringify(value) { return JSON.stringify(String(value)); }

async function generateClashYaml(configs) {
    const proxies = (await Promise.all(configs.map(parseProxyForClash))).filter(p => p);
    if (proxies.length === 0) return null;

    // Use a Map with a server:port key to ensure uniqueness of servers, then get the final proxies
    const uniqueServerProxies = new Map();
    for (const proxy of proxies) {
        const key = `${proxy.server}:${proxy.port}`;
        if (!uniqueServerProxies.has(key)) {
            uniqueServerProxies.set(key, proxy);
        }
    }
    const finalProxies = Array.from(uniqueServerProxies.values());
    const proxyNames = finalProxies.map(p => p.name);
    
    let yamlString = "proxies:\n";
    finalProxies.forEach(p => {
        yamlString += `  - name: ${safeYamlStringify(p.name)}\n`;
        const orderedKeys = ['type', 'server', 'port', 'uuid', 'password', 'alterId', 'cipher', 'tls', 'network', 'servername', 'skip-cert-verify', 'ws-opts'];
        orderedKeys.forEach(key => {
            if (p[key] === undefined || p[key] === null) return;
            const value = p[key];
            if (key === 'ws-opts' && typeof value === 'object') {
                yamlString += `    ws-opts:\n`;
                if (value.path) yamlString += `      path: ${safeYamlStringify(value.path)}\n`;
                if (value.headers?.Host) yamlString += `      headers:\n        Host: ${safeYamlStringify(value.headers.Host)}\n`;
            } else if (typeof value !== 'object') {
                yamlString += `    ${key}: ${typeof value === 'string' ? safeYamlStringify(value) : value}\n`;
            }
        });
    });
    
    yamlString += "proxy-groups:\n";
    yamlString += `  - {name: V2V-Auto, type: url-test, proxies: [${proxyNames.map(safeYamlStringify).join(', ')}], url: 'http://www.gstatic.com/generate_204', interval: 300}\n`;
    yamlString += `  - {name: V2V-Select, type: select, proxies: [V2V-Auto, ${proxyNames.map(safeYamlStringify).join(', ')}]}\n`;
    yamlString += "rules:\n  - 'MATCH,V2V-Select'\n";
    return yamlString;
}
