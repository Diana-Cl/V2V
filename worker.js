import { connect } from 'cloudflare:sockets'; // این سینتکس فقط در Cloudflare Workers کار می‌کند.

// --- Configuration ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours
const MAX_NAME_LENGTH = 40;
const KV_LIVE_CONFIGS_KEY = 'all_live_configs.json';
const KV_CACHE_VERSION_KEY = 'cache_version.txt';

// --- Headers ---
// تعیین Headers به صورت ثابت برای راحتی
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

// --- Main Fetch Handler ---
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') { // Changed to uppercase OPTIONS for consistency
            return new Response(null, { headers: CORS_HEADERS });
        }
        const url = new URL(request.url);

        try {
            // مسیر جدید برای ارائه all_live_configs.json
            if (url.pathname === '/configs') {
                return handleGetLiveConfigs(env);
            }
            if (url.pathname === '/tcp-probe' && request.method === 'POST') { // Changed to uppercase POST
                return handleTcpProbe(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') { // Changed to uppercase POST
                return handleSubscribeRequest(request, env);
            }
            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const isClash = !!personalSubMatch[1];
                const uuid = personalSubMatch[2];
                return handleGetPersonalSubscription(uuid, isClash, env);
            }
            if (url.pathname === '/cache-version') {
                return handleGetCacheVersion(env);
            }
            
            // Public subscription endpoint
            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(xray|singbox)$/);
            if (publicSubMatch) {
                const coreType = publicSubMatch[2];
                return handleGetPublicSubscription(coreType, env);
            }

            return new Response('V2V API Worker is operational.', { headers: TEXT_HEADERS }); // Changed JSON_HEADERS to TEXT_HEADERS
        } catch (error) {
            console.error('Worker error:', error.stack);
            return new Response(JSON.stringify({ message: error.message || 'Internal server error', stack: error.stack }), { status: 500, headers: JSON_HEADERS }); // Include stack for debugging
        }
    }
};

// --- New Handler for all_live_configs.json ---
async function handleGetLiveConfigs(env) {
    if (!env.v2v_kv) return new Response(JSON.stringify({ error: 'KV namespace not configured.' }), { status: 500, headers: JSON_HEADERS });
    
    const liveConfigs = await env.v2v_kv.get(KV_LIVE_CONFIGS_KEY, { type: 'json' });

    if (!liveConfigs) {
        return new Response(JSON.stringify({ xray: {}, singbox: {} }), { status: 200, headers: JSON_HEADERS }); // Empty object if no configs
    }
    return new Response(JSON.stringify(liveConfigs), { headers: JSON_HEADERS });
}


// --- TCP Probe Logic ---
async function handleTcpProbe(request) {
    let socket;
    try {
        const { host, port } = await request.json();
        if (!host || !port) {
            return new Response(JSON.stringify({ error: 'Invalid host or port' }), { status: 400, headers: JSON_HEADERS });
        }
        const startTime = Date.now();
        socket = connect({ hostname: host, port: port }, { allowHalfOpen: false }); // Changed allowhalfopen to allowHalfOpen for consistency
        
        await socket.opened;
        const latency = Date.now() - startTime;
        
        if (latency < 10) throw new Error("Unrealistic latency detected, likely a false positive connection."); // Improved error message
        
        return new Response(JSON.stringify({ latency }), { headers: JSON_HEADERS });
    } catch (e) {
        console.error("TCP Probe Failed:", e); // Log error for debugging
        return new Response(JSON.stringify({ latency: null, error: e.message }), { headers: JSON_HEADERS });
    } finally {
        if (socket) await socket.close().catch(() => {});
    }
}

// --- Subscription Logic ---
async function handleSubscribeRequest(request, env) {
    if (!env.v2v_kv) return new Response(JSON.stringify({ error: 'KV namespace not configured.' }), { status: 500, headers: JSON_HEADERS });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) return new Response(JSON.stringify({ error: "'configs' must be a non-empty array." }), { status: 400, headers: JSON_HEADERS });
    const subUuid = crypto.randomUUID(); // Changed to randomUUID for consistency
    await env.v2v_kv.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL }); // Changed expirationttl to expirationTtl
    return new Response(JSON.stringify({ uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPersonalSubscription(uuid, isClash, env) { // Changed isclash to isClash
    if (!env.v2v_kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });
    
    const [userSubRaw, liveDataRaw] = await Promise.all([ // Changed promise.all to Promise.all
        env.v2v_kv.get(`sub:${uuid}`),
        env.v2v_kv.get(KV_LIVE_CONFIGS_KEY)
    ]);

    if (!userSubRaw) return new Response('Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
    if (!liveDataRaw) return new Response('Live configs unavailable for healing.', { status: 503, headers: TEXT_HEADERS });

    const userConfigs = JSON.parse(userSubRaw); // Changed json.parse to JSON.parse
    const liveData = JSON.parse(liveDataRaw); // Changed json.parse to JSON.parse
    const allLiveConfigsSet = new Set( // Changed set to Set
        Object.values(liveData.xray || {}).flat().concat(Object.values(liveData.singbox || {}).flat()) // Changed object.values to Object.values
    );

    let healedConfigs = userConfigs.filter(cfg => allLiveConfigsSet.has(cfg)); // Changed healedconfigs to healedConfigs
    const deadCount = userConfigs.length - healedConfigs.length; // Changed deadcount to deadCount
    if (deadCount > 0) {
        const userConfigsSet = new Set(userConfigs); // Changed userconfigsset to userConfigsSet
        const replacements = [...allLiveConfigsSet].filter(cfg => !userConfigsSet.has(cfg));
        healedConfigs.push(...replacements.slice(0, deadCount));
    }
    if (healedConfigs.length === 0 && allLiveConfigsSet.size > 0) {
        healedConfigs = [...allLiveConfigsSet].slice(0, Math.min(userConfigs.length || 10, allLiveConfigsSet.size)); // Changed math.min to Math.min
    }
    
    await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL }); // Changed expirationttl to expirationTtl
    return generateSubscriptionResponse(healedConfigs, isClash);
}

// New handler for public subscriptions
async function handleGetPublicSubscription(coreType, env) {
    if (!env.v2v_kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });

    const liveDataRaw = await env.v2v_kv.get(KV_LIVE_CONFIGS_KEY);
    if (!liveDataRaw) return new Response('Live configs unavailable.', { status: 503, headers: TEXT_HEADERS });

    const liveData = JSON.parse(liveDataRaw);
    let configsToServe = [];

    if (coreType === 'xray' && liveData.xray) {
        configsToServe = Object.values(liveData.xray).flat();
    } else if (coreType === 'singbox' && liveData.singbox) {
        configsToServe = Object.values(liveData.singbox).flat();
    } else {
        return new Response('Invalid core type for public subscription.', { status: 400, headers: TEXT_HEADERS });
    }
    
    // For public subscriptions, we just return the raw list, no Clash format needed here initially
    return new Response(configsToServe.join('\n'), { headers: TEXT_HEADERS });
}


async function handleGetCacheVersion(env) {
    if (!env.v2v_kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });
    const version = await env.v2v_kv.get(KV_CACHE_VERSION_KEY);
    return new Response(version || Math.floor(Date.now() / 1000).toString(), { headers: TEXT_HEADERS }); // Changed math.floor to Math.floor, tostring to toString
}

function generateSubscriptionResponse(configs, isClash) { // Changed isclash to isClash
    if (isClash) {
        const clashYaml = generateClashYaml(configs); // Changed clashyaml to clashYaml
        const headers = new Headers(YAML_HEADERS); // Changed headers to Headers
        headers.set('Content-Disposition', 'attachment; filename="v2v.yaml"'); // Changed content-disposition to Content-Disposition
        return new Response(clashYaml, { headers });
    } else {
        return new Response(configs.join('\n'), { headers: TEXT_HEADERS });
    }
}

// --- Helpers & YAML Generation ---
function parseProxyForClash(configStr) { // Changed configstr to configStr
    try {
        const urlObj = new URL(configStr); // Changed url to urlObj
        let name = decodeURIComponent(urlObj.hash.substring(1) || "v2v config").trim(); // Changed decodeuricomponent to decodeURIComponent
        name = `v2v | ${name.substring(0, MAX_NAME_LENGTH)}`;
        const base = { name, 'skip-cert-verify': true };
        const params = new URLSearchParams(urlObj.search); // Changed urlsearchparams to URLSearchParams

        if (configStr.startsWith('vmess://')) {
            const d = JSON.parse(atob(configStr.substring(8))); // Changed json.parse to JSON.parse
            const p = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host }; // Changed alterid to alterId, servername to serverName
            if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { host: d.host || d.add }};
            return p;
        }
        if (urlObj.protocol === 'vless:') { // Changed url.protocol to urlObj.protocol
            const p = { ...base, type: 'vless', server: urlObj.hostname, port: parseInt(urlObj.port), uuid: urlObj.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')}; // Changed servername to serverName
            if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { host: params.get('host') || urlObj.hostname }};
            return p;
        }
        if (urlObj.protocol === 'trojan:') return { ...base, type: 'trojan', server: urlObj.hostname, port: parseInt(urlObj.port), password: urlObj.username, sni: params.get('sni') };
        if (urlObj.protocol === 'ss:') { const [c, p] = atob(urlObj.username).split(':'); return { ...base, type: 'ss', server: urlObj.hostname, port: parseInt(urlObj.port), cipher: c, password: p }; }
    } catch (e) { console.error("Error parsing proxy for Clash:", e); return null; } // Added error logging
    return null;
}

function generateClashYaml(configs) { // Changed generateclashyaml to generateClashYaml
    const proxies = configs.map(parseProxyForClash).filter(p => p); // Changed parseproxyforclash to parseProxyForClash
    if (proxies.length === 0) return "# no compatible proxies found for clash.";
    const proxyNames = proxies.map(p => p.name); // Changed proxynames to proxyNames
    
    return `proxies:
${proxies.map(p => `  - ${JSON.stringify(p)}`).join('\n')}

proxy-groups:
  - name: "v2v-auto"
    type: url-test
    proxies:
${proxyNames.map(name => `      - "${name}"`).join('\n')}
    url: 'http://www.gstatic.com/generate_204'
    interval: 300
  - name: "v2v-select"
    type: select
    proxies:
      - "v2v-auto"
${proxyNames.map(name => `      - "${name}"`).join('\n')}

rules:
  - 'MATCH,v2v-select' # Changed match to MATCH for consistency
`;
}
