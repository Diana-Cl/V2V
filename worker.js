/**
 * V2V Project - Final Production Worker v31.0
 * Handles:
 * - Advanced TCP latency testing (/api/ping)
 * - Personal subscription creation & retrieval (/api/subscribe, /sub/:uuid)
 * - Public subscription retrieval (/sub/public/:core)
 * - Force-downloads for static subscription files
 */

// --- CONFIGURATION ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours for personal subs
const READY_SUB_COUNT = 30;
const STATIC_CLASH_URL = 'https://raw.githubusercontent.com/smbcryp/V2V/main/clash_subscription.yml'; // Raw URL for direct fetching
const DATA_MIRRORS = [ // Add your public mirrors here
    'https://v2v-vercel.vercel.app/all_live_configs.json',
    'https://smbcryp.github.io/V2V/all_live_configs.json',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
];

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
                return await handleStaticClashDownload();
            }
            if (url.pathname === '/api/ping' && request.method === 'POST') {
                return await handlePingRequest(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return await handleSubscribeRequest(request, env);
            }
            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(xray|singbox)$/);
            if (publicSubMatch && request.method === 'GET') {
                const core = publicSubMatch[1];
                return await handleGetPublicSubscription(core);
            }
            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch && request.method === 'GET') {
                const isClash = !!personalSubMatch[1];
                const uuid = personalSubMatch[2];
                return await handleGetPersonalSubscription(uuid, isClash, env);
            }
            
            return new Response('V2V API Worker is operational.', { headers: CORS_HEADERS });

        } catch (e) {
            console.error("Worker Error:", e);
            return new Response(JSON.stringify({ error: e.message || 'Internal Server Error' }), { status: 500, headers: JSON_HEADERS });
        }
    }
};

// --- HANDLERS ---
async function handleStaticClashDownload() {
    const response = await fetch(STATIC_CLASH_URL, { headers: { 'User-Agent': 'V2V-Worker-Fetcher' }});
    if (!response.ok) {
        return new Response('Static Clash file not found at origin.', { status: 404, headers: TEXT_HEADERS });
    }
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Disposition', 'attachment; filename="v2v_clash.yml"');
    newHeaders.set('Content-Type', 'text/yaml;charset=utf-8');
    newHeaders.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: 200, headers: newHeaders });
}

async function handlePingRequest(request) {
    const { configs } = await request.json();
    if (!Array.isArray(configs)) {
        return new Response(JSON.stringify({ error: 'Request body must be an array of configs.' }), { status: 400, headers: JSON_HEADERS });
    }
    const results = await Promise.all(configs.map(testTcpLatency));
    return new Response(JSON.stringify(results), { headers: JSON_HEADERS });
}

async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not configured.', { status: 503, headers: JSON_HEADERS });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) {
        return new Response(JSON.stringify({ error: "'configs' must be a non-empty array." }), { status: 400, headers: JSON_HEADERS });
    }
    const subUuid = crypto.randomUUID();
    await env.V2V_KV.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    const subscription_url = `${new URL(request.url).origin}/sub/${subUuid}`;
    return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPublicSubscription(core) {
    const liveData = await fetchFromMirrors();
    const coreConfigs = liveData[core] || {};
    const allFlatConfigs = Object.values(coreConfigs).flat();
    const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);

    if (topConfigs.length === 0) {
        return new Response(`No public configs found for core: ${core}`, { status: 404, headers: TEXT_HEADERS });
    }
    // Encode to Base64 for client compatibility
    const base64Content = btoa(topConfigs.join('\n'));
    return new Response(base64Content, { headers: TEXT_HEADERS });
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('Error: KV Namespace is not configured.', { status: 503, headers: TEXT_HEADERS });
    const kvData = await env.V2V_KV.get(`sub:${uuid}`);
    if (!kvData) {
        return new Response('Error: Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
    }
    const configs = JSON.parse(kvData);
    if (isClash) {
        const clashYaml = generateClashYaml(configs); // Note: This helper needs to be robust
        if (!clashYaml) return new Response('Could not generate Clash config from subscriptions.', { status: 500, headers: TEXT_HEADERS });
        return new Response(clashYaml, { headers: YAML_HEADERS });
    } else {
        const base64Content = btoa(configs.join('\n'));
        return new Response(base64Content, { headers: TEXT_HEADERS });
    }
}

// --- HELPERS ---
async function fetchFromMirrors() {
    const promises = DATA_MIRRORS.map(url => fetch(`${url}?t=${Date.now()}`).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }));
    try {
        return await Promise.any(promises);
    } catch (e) {
        throw new Error("All data mirrors are currently unavailable.");
    }
}

async function testTcpLatency(configStr) {
    const { hostname, port } = parseHostAndPort(configStr);
    if (!hostname || !port) {
        return { config: configStr, ping: null };
    }
    try {
        const startTime = Date.now();
        const socket = connect({ hostname, port });
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

// A full JS implementation of Clash generation is needed for personal subscriptions.
// This is a complex task. The version below is a placeholder.
// The robust version is in index.js for client-side generation.
function generateClashYaml(configs) {
    return "proxies: [] # Server-side generation for personal subs is not fully implemented.";
}
