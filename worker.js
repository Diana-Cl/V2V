import { connect } from 'cloudflare:sockets';

// --- CONFIGURATION ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours in seconds
const READY_SUB_COUNT = 30;
const MAX_NAME_LENGTH = 40;
const PROBE_TIMEOUT_MS = 5000;

// --- HEADERS ---
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, User-Agent' };
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json;charset=utf-8' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

// --- MAIN FETCH HANDLER ---
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }
        const url = new URL(request.url);

        try {
            if (url.pathname === '/tcp-probe' && request.method === 'POST') {
                return await handleTcpProbe(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return await handleSubscribeRequest(request, env);
            }
            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(xray|singbox)$/);
            if (publicSubMatch) {
                const core = publicSubMatch[1];
                return await handleGetPublicSubscription(core, false, env);
            }
            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const isClash = !!personalSubMatch[1];
                const uuid = personalSubMatch[2];
                return await handleGetPersonalSubscription(uuid, isClash, env);
            }
            if (url.pathname === '/cache-version') {
                return await handleGetCacheVersion(env);
            }
            return new Response('V2V API Worker is operational.', { headers: CORS_HEADERS });
        } catch (error) {
            console.error('Worker Error:', error.stack);
            return new Response(error.message || 'Internal Server Error', { status: 500, headers: JSON_HEADERS });
        }
    }
};

// --- TCP PROBE LOGIC ---
async function handleTcpProbe(request) {
    try {
        const { host, port } = await request.json();
        if (!host || !port) {
            return new Response(JSON.stringify({ error: 'Invalid host or port' }), { status: 400, headers: JSON_HEADERS });
        }
        const startTime = Date.now();
        const socket = connect({ hostname: host, port: port }, { allowHalfOpen: false });
        
        // Race connection against a timeout
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out')), PROBE_TIMEOUT_MS));
        await Promise.race([socket.opened, timeoutPromise]);
        
        const latency = Date.now() - startTime;
        await socket.close();
        return new Response(JSON.stringify({ latency }), { headers: JSON_HEADERS });
    } catch (e) {
        return new Response(JSON.stringify({ latency: null, error: e.message }), { headers: JSON_HEADERS });
    }
}

// --- SUBSCRIPTION LOGIC ---
async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response(JSON.stringify({ error: 'KV Namespace not configured.' }), { status: 500, headers: JSON_HEADERS });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) {
        return new Response(JSON.stringify({ error: "'configs' must be a non-empty array." }), { status: 400, headers: JSON_HEADERS });
    }
    const subUuid = crypto.randomUUID();
    await env.V2V_KV.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    return new Response(JSON.stringify({ uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPublicSubscription(core, isClash, env) {
    if (isClash) return new Response('Public Clash subscription is disabled.', { status: 403, headers: TEXT_HEADERS });
    if (!env.V2V_KV) return new Response('KV Namespace not available.', { status: 500, headers: TEXT_HEADERS });
    
    const liveDataRaw = await env.V2V_KV.get('all_live_configs.json');
    if (!liveDataRaw) return new Response('Live configs not found in KV.', { status: 404, headers: TEXT_HEADERS });
    
    const liveData = JSON.parse(liveDataRaw);
    const coreConfigs = liveData[core] || {};
    const allFlatConfigs = Object.values(coreConfigs).flat();
    const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);

    if (topConfigs.length === 0) return new Response(`No public configs available for core: ${core}`, { status: 404, headers: TEXT_HEADERS });
    
    return generateSubscriptionResponse(topConfigs, isClash);
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not available.', { status: 500, headers: TEXT_HEADERS });
    
    const [userSubRaw, liveDataRaw] = await Promise.all([
        env.V2V_KV.get(`sub:${uuid}`),
        env.V2V_KV.get('all_live_configs.json')
    ]);

    if (!userSubRaw) return new Response('Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
    if (!liveDataRaw) return new Response('Live configs unavailable for healing.', { status: 503, headers: TEXT_HEADERS });

    const userConfigs = JSON.parse(userSubRaw);
    const liveData = JSON.parse(liveDataRaw);
    const allLiveConfigsSet = new Set(
        Object.values(liveData.xray || {}).flat().concat(Object.values(liveData.singbox || {}).flat())
    );

    let healedConfigs = userConfigs.filter(cfg => allLiveConfigsSet.has(cfg));
    const deadCount = userConfigs.length - healedConfigs.length;

    if (deadCount > 0) {
        const userConfigsSet = new Set(userConfigs);
        const replacements = [...allLiveConfigsSet].filter(cfg => !userConfigsSet.has(cfg));
        healedConfigs.push(...replacements.slice(0, deadCount));
    }
    if (healedConfigs.length === 0 && allLiveConfigsSet.size > 0) {
        healedConfigs = [...allLiveConfigsSet].slice(0, Math.min(userConfigs.length || 10, allLiveConfigsSet.size));
    }
    
    await env.V2V_KV.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
    return generateSubscriptionResponse(healedConfigs, isClash);
}

async function handleGetCacheVersion(env) {
    if (!env.V2V_KV) return new Response('KV Namespace not available.', { status: 500, headers: TEXT_HEADERS });
    const version = await env.V2V_KV.get('cache_version.txt');
    return new Response(version || Date.now() / 1000, { headers: TEXT_HEADERS });
}

function generateSubscriptionResponse(configs, isClash) {
    if (isClash) {
        const clashYaml = generateClashYaml(configs);
        const headers = new Headers(YAML_HEADERS);
        headers.set('Content-Disposition', 'attachment; filename="v2v.yaml"');
        return new Response(clashYaml, { headers });
    } else {
        return new Response(configs.join('\n'), { headers: TEXT_HEADERS });
    }
}

// --- HELPERS & YAML GENERATION ---
function parseProxyForClash(configStr) {
    try {
        const url = new URL(configStr);
        let name = decodeURIComponent(url.hash.substring(1) || "V2V Config").trim().substring(0, MAX_NAME_LENGTH);
        const base = { name, 'skip-cert-verify': true };
        const params = new URLSearchParams(url.search);

        if (configStr.startsWith('vmess://')) {
            const d = JSON.parse(atob(configStr.substring(8)));
            const p = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
            return p;
        }
        if (url.protocol === 'vless:') {
            const p = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
            if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }};
            return p;
        }
        if (url.protocol === 'trojan:') return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
        if (url.protocol === 'ss:') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; }
    } catch { return null; }
    return null;
}

function generateClashYaml(configs) {
    const proxies = configs.map(parseProxyForClash).filter(p => p);
    if (proxies.length === 0) return "# No compatible proxies found for Clash.";
    const proxyNames = proxies.map(p => p.name);
    
    return `proxies:
${proxies.map(p => `  - ${JSON.stringify(p)}`).join('\n')}

proxy-groups:
  - name: "V2V-Auto"
    type: url-test
    proxies:
${proxyNames.map(name => `      - "${name}"`).join('\n')}
    url: 'http://www.gstatic.com/generate_204'
    interval: 300
  - name: "V2V-Select"
    type: select
    proxies:
      - "V2V-Auto"
${proxyNames.map(name => `      - "${name}"`).join('\n')}

rules:
  - 'MATCH,V2V-Select'
`;
}
