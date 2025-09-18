// This syntax is specific to Cloudflare Workers.
import { connect } from 'cloudflare:sockets';

// --- Configuration ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours in seconds
const MAX_NAME_LENGTH = 40;
const KV_LIVE_CONFIGS_KEY = 'all_live_configs.json';
const KV_CACHE_VERSION_KEY = 'cache_version.txt';

// --- Headers ---
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

// --- Main Fetch Handler ---
export default {
    async fetch(request, env) {
        // The KV binding in wrangler.toml is "V2V_KV", so we must use env.V2V_KV (case-sensitive).
        const kv = env.V2V_KV;

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);

        try {
            if (url.pathname === '/configs') {
                return handleGetLiveConfigs(kv);
            }
            if (url.pathname === '/tcp-probe' && request.method === 'POST') {
                return handleTcpProbe(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return handleSubscribeRequest(request, kv);
            }
            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const isClash = !!personalSubMatch[1];
                const uuid = personalSubMatch[2];
                return handleGetPersonalSubscription(uuid, isClash, kv);
            }
            if (url.pathname === '/cache-version') {
                return handleGetCacheVersion(kv);
            }
            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(xray|singbox)$/);
            if (publicSubMatch) {
                const coreType = publicSubMatch[1]; // Corrected index from 2 to 1
                return handleGetPublicSubscription(coreType, kv);
            }

            return new Response('V2V API Worker is operational.', { headers: TEXT_HEADERS });
        } catch (error) {
            console.error('Worker error:', error.stack);
            return new Response(JSON.stringify({ message: error.message || 'Internal server error', stack: error.stack }), { status: 500, headers: JSON_HEADERS });
        }
    }
};

// --- Handlers ---
async function handleGetLiveConfigs(kv) {
    if (!kv) return new Response(JSON.stringify({ error: 'KV namespace not configured.' }), { status: 500, headers: JSON_HEADERS });
    
    const liveConfigs = await kv.get(KV_LIVE_CONFIGS_KEY, { type: 'json' });

    if (!liveConfigs) {
        return new Response(JSON.stringify({ xray: {}, singbox: {} }), { status: 200, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify(liveConfigs), { headers: JSON_HEADERS });
}

async function handleTcpProbe(request) {
    let socket;
    try {
        const { host, port } = await request.json();
        if (!host || !port) {
            return new Response(JSON.stringify({ error: 'Invalid host or port' }), { status: 400, headers: JSON_HEADERS });
        }
        const startTime = Date.now();
        socket = connect({ hostname: host, port: port }, { allowHalfOpen: false });
        
        await socket.opened;
        const latency = Date.now() - startTime;
        
        if (latency < 10) throw new Error("Unrealistic latency, likely a false positive.");
        
        return new Response(JSON.stringify({ latency }), { headers: JSON_HEADERS });
    } catch (e) {
        console.error("TCP Probe Failed:", e);
        return new Response(JSON.stringify({ latency: null, error: e.message }), { headers: JSON_HEADERS });
    } finally {
        if (socket) await socket.close().catch(() => {});
    }
}

async function handleSubscribeRequest(request, kv) {
    if (!kv) return new Response(JSON.stringify({ error: 'KV namespace not configured.' }), { status: 500, headers: JSON_HEADERS });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) return new Response(JSON.stringify({ error: "'configs' must be a non-empty array." }), { status: 400, headers: JSON_HEADERS });
    const subUuid = crypto.randomUUID();
    await kv.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    return new Response(JSON.stringify({ uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPersonalSubscription(uuid, isClash, kv) {
    if (!kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });
    
    const [userSubRaw, liveDataRaw] = await Promise.all([
        kv.get(`sub:${uuid}`),
        kv.get(KV_LIVE_CONFIGS_KEY)
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
    
    await kv.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
    return generateSubscriptionResponse(healedConfigs, isClash);
}

async function handleGetPublicSubscription(coreType, kv) {
    if (!kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });

    const liveDataRaw = await kv.get(KV_LIVE_CONFIGS_KEY);
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
    
    return new Response(configsToServe.join('\n'), { headers: TEXT_HEADERS });
}

async function handleGetCacheVersion(kv) {
    if (!kv) return new Response('KV namespace not available.', { status: 500, headers: TEXT_HEADERS });
    const version = await kv.get(KV_CACHE_VERSION_KEY);
    return new Response(version || Math.floor(Date.now() / 1000).toString(), { headers: TEXT_HEADERS });
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

// --- Helpers & YAML Generation ---
function parseProxyForClash(configStr) {
    try {
        const urlObj = new URL(configStr);
        let name = decodeURIComponent(urlObj.hash.substring(1) || "v2v config").trim();
        name = `v2v | ${name.substring(0, MAX_NAME_LENGTH)}`;
        const base = { name, 'skip-cert-verify': true };
        const params = new URLSearchParams(urlObj.search);

        if (configStr.startsWith('vmess://')) {
            const d = JSON.parse(atob(configStr.substring(8)));
            const p = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { host: d.host || d.add }};
            return p;
        }
        if (urlObj.protocol === 'vless:') {
            const p = { ...base, type: 'vless', server: urlObj.hostname, port: parseInt(urlObj.port), uuid: urlObj.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
            if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { host: params.get('host') || urlObj.hostname }};
            return p;
        }
        if (urlObj.protocol === 'trojan:') return { ...base, type: 'trojan', server: urlObj.hostname, port: parseInt(urlObj.port), password: urlObj.username, sni: params.get('sni') };
        if (urlObj.protocol === 'ss:') { const [c, p] = atob(urlObj.username).split(':'); return { ...base, type: 'ss', server: urlObj.hostname, port: parseInt(urlObj.port), cipher: c, password: p }; }
    } catch (e) { console.error("Error parsing proxy for Clash:", configStr, e); return null; }
    return null;
}

function generateClashYaml(configs) {
    const proxies = configs.map(parseProxyForClash).filter(p => p);
    if (proxies.length === 0) return "# No compatible proxies found for Clash.";
    const proxyNames = proxies.map(p => p.name);
    
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
  - 'MATCH,v2v-select'
`;
}
