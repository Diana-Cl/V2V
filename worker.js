import { connect } from 'cloudflare:sockets';

// --- configuration ---
const subscription_ttl = 48 * 60 * 60; // 48 hours
const ready_sub_count = 30;
const data_mirrors = [
    'https://v2v-vercel.vercel.app/all_live_configs.json',
    'https://smbcryp.github.io/v2v/all_live_configs.json',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
];
const max_name_length = 40;

// --- headers ---
const cors_headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'get, post, options', 'access-control-allow-headers': 'content-type' };
const json_headers = { ...cors_headers, 'content-type': 'application/json' };
const text_headers = { ...cors_headers, 'content-type': 'text/plain;charset=utf-8' };
const yaml_headers = { ...cors_headers, 'content-type': 'text/yaml;charset=utf-8' };

// --- main fetch handler ---
export default {
    async fetch(request, env) {
        if (request.method === 'options') return new Response(null, { headers: cors_headers });
        const url = new URL(request.url);

        try {
            // New HTTP POST endpoint for TCP probing
            if (url.pathname === '/tcp-probe' && request.method === 'POST') {
                return handleTcpProbe(request);
            }

            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return handleSubscribeRequest(request, env);
            }

            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(clash\/)?(xray|singbox)$/);
            if (publicSubMatch) {
                const core = publicSubMatch[2];
                const isClash = !!publicSubMatch[1];
                // per user request, disable public-ready clash subscription
                if (isClash) return new Response('public clash subscription is disabled.', { status: 404 });
                return handleGetPublicSubscription(core, isClash, env);
            }

            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const uuid = personalSubMatch[2];
                const isClash = !!personalSubMatch[1];
                return handleGetPersonalSubscription(uuid, isClash, env);
            }

            return new Response('v2v api worker is operational.', { headers: cors_headers });
        } catch (error) {
            console.error('Worker error:', error.stack);
            return new Response(error.message || 'Internal Server Error', { status: 500, headers: cors_headers });
        }
    }
};

// --- tcp probe logic (renamed and refactored from tcpBridge) ---
async function handleTcpProbe(request) {
    const timeout_ms = 5000; // Match frontend timeout for consistency
    try {
        const { host, port } = await request.json();
        if (!host || !port) {
            return new Response(JSON.stringify({ error: 'Invalid host or port' }), { status: 400, headers: json_headers });
        }

        const start = Date.now();
        let socket;
        try {
            socket = connect({ hostname: host, port: port }, { allowHalfOpen: false });
            
            // Wait for the socket to establish connection, with a timeout
            const timeoutPromise = new Promise((resolve, reject) => 
                setTimeout(() => reject(new Error('Connection timed out')), timeout_ms)
            );
            
            await Promise.race([socket.opened, timeoutPromise]);
            
            const latency = Date.now() - start;
            
            // Optionally send a small probe if necessary for specific protocols,
            // but for basic connectivity check, just establishing connection is often enough.
            // For true protocol-level check, more complex handshake is needed.
            // For now, only checking basic TCP connect.
            
            // Close socket quickly after successful connection to not hold resources
            try { await socket.close(); } catch {} 

            return new Response(JSON.stringify({ latency: latency }), { headers: json_headers });

        } catch (e) {
            // Ensure socket is closed on error
            if (socket) {
                try { await socket.close(); } catch {}
            }
            // console.error(`TCP Probe Error for ${host}:${port}:`, e.message); // for debugging
            return new Response(JSON.stringify({ latency: null }), { headers: json_headers });
        }

    } catch (e) {
        console.error('handleTcpProbe Request Error:', e.stack);
        return new Response(JSON.stringify({ error: 'Bad Request Body' }), { status: 400, headers: json_headers });
    }
}


// --- subscription logic ---
async function handleSubscribeRequest(request, env) {
    if (!env.v2v_kv) return new Response('KV Namespace not configured.', { status: 500 });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) return new Response("'configs' must be a non-empty array.", { status: 400 });
    const subUuid = crypto.randomUUID();
    await env.v2v_kv.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: subscription_ttl });
    const origin = new URL(request.url).origin;
    const subscription_url = `${origin}/sub/${subUuid}`;
    return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: json_headers });
}

async function handleGetPublicSubscription(core, isClash, env) {
    const liveData = await fetchFromMirrors(); // This will be changed later per roadmap
    const coreConfigs = liveData[core] || {};
    const allFlatConfigs = Object.values(coreConfigs).flat();
    const topConfigs = allFlatConfigs.slice(0, ready_sub_count);
    if (topConfigs.length === 0) return new Response(`No public configs found for core: ${core}`, { status: 404 });
    return generateSubscriptionResponse(topConfigs, isClash);
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    if (!env.v2v_kv) return new Response('KV Namespace not configured.', { status: 500 });
    const [kvData, liveData] = await Promise.all([ env.v2v_kv.get(`sub:${uuid}`), fetchFromMirrors() ]); // This will be changed later
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
    
    await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: subscription_ttl });
    return generateSubscriptionResponse(healedConfigs, isClash);
}

async function generateSubscriptionResponse(configs, isClash) {
    if (isClash) {
        const clashYaml = await generateClashYaml(configs);
        if (!clashYaml) throw new Error('Could not generate Clash config.');
        const headers = new Headers(yaml_headers);
        headers.set('Content-Disposition', 'attachment; filename="v2v_clash.yaml"');
        return new Response(clashYaml, { headers });
    } else {
        // PER ROADMAP: Remove Base64 for standard subscription links
        return new Response(configs.join('\n'), { headers: text_headers });
    }
}

// --- helpers & yaml generation ---
async function fetchFromMirrors() { 
    return Promise.any(data_mirrors.map(url => 
        fetch(`${url}?t=${Date.now()}`).then(r => r.ok ? r.json() : Promise.reject(`Fetch failed for ${url}`))
    )); 
}

async function generateProxyName(configStr, server, port) {
    try {
        const url = new URL(configStr);
        let name = decodeURIComponent(url.hash.substring(1) || "");
        if (!name) {
            name = `config-${server.slice(0,8)}...`;
        }
        name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim().substring(0, max_name_length);
        const uniqueHashBuffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(`${server}:${port}`));
        const uniqueHash = Array.from(new Uint8Array(uniqueHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 4);
        return `v2v | ${name} | ${uniqueHash}`;
    } catch { return `v2v | unnamed config`; }
}

async function parseProxyForClash(configStr) {
    try {
        if (configStr.startsWith('vmess://')) {
            const d = JSON.parse(atob(configStr.substring(8)));
            const vmessServer = d.add;
            const vmessPort = parseInt(d.port);
            const name = await generateProxyName(configStr, vmessServer, vmessPort);
            const p = { name, 'skip-cert-verify': true, type: 'vmess', server: vmessServer, port: vmessPort, uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { host: d.host || d.add }};
            return p;
        }
        const url = new URL(configStr);
        const server = url.hostname;
        const port = parseInt(url.port);
        const name = await generateProxyName(configStr, server, port);
        const base = { name, 'skip-cert-verify': true };
        const proto = url.protocol.replace(':', '');
        const params = new URLSearchParams(url.search);

        if (proto === 'vless') {
            const p = { ...base, type: 'vless', server, port, uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
            if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { host: params.get('host') || server }};
            return p;
        }
        if (proto === 'trojan') return { ...base, type: 'trojan', server, port, password: url.username, sni: params.get('sni') };
        if (proto === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server, port, cipher: c, password: p }; }
    } catch { return null; }
    return null;
}

// Note: js-yaml library is heavy for a Worker. 
// A custom lightweight YAML stringifier is used as per existing implementation.
function safeYamlStringify(value) { return JSON.stringify(String(value)); }

async function generateClashYaml(configs) {
    const proxies = (await Promise.all(configs.map(parseProxyForClash))).filter(p => p);
    if (proxies.length === 0) return null;

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
            if (p[key] === undefined || p[key] === null || (key === 'alterId' && p[key] === 0)) return;
            const value = p[key];
            if (key === 'ws-opts' && typeof value === 'object') {
                yamlString += `    ws-opts:\n`;
                if (value.path) yamlString += `      path: ${safeYamlStringify(value.path)}\n`;
                if (value.headers?.host) yamlString += `      headers:\n        host: ${safeYamlStringify(value.headers.host)}\n`;
            } else if (typeof value !== 'object') {
                yamlString += `    ${key}: ${typeof value === 'string' ? safeYamlStringify(value) : value}\n`;
            }
        });
    });
    
    yamlString += "\nproxy-groups:\n";
    yamlString += `  - name: v2v-auto\n    type: url-test\n    proxies:\n${proxyNames.map(name => `      - ${safeYamlStringify(name)}`).join('\n')}\n    url: 'http://www.gstatic.com/generate_204'\n    interval: 300\n`;
    yamlString += `  - name: v2v-select\n    type: select\n    proxies:\n      - v2v-auto\n${proxyNames.map(name => `      - ${safeYamlStringify(name)}`).join('\n')}\n`;
    yamlString += "\nrules:\n  - 'MATCH,v2v-select'\n"; // Changed 'match' to 'MATCH' for consistency
    return yamlString;
}
