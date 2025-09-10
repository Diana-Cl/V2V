/**
 * V2V Project - Final Production Worker
 * Handles:
 * - Advanced TCP latency testing (/api/ping)
 * - Self-healing subscription creation & retrieval (/api/subscribe, /sub/:uuid)
 *
 * This worker is designed to be robust, fast, and error-proof.
 */

// --- CONFIGURATION ---
// These should be set as Environment Variables in the Cloudflare dashboard for security.
// To set them, go to your Worker -> Settings -> Variables.
// const PRIMARY_CONFIGS_URL = "https://your-primary-source.com/all_live_configs.json";
// const FALLBACK_CONFIGS_URL = "https://your-fallback-source.com/all_live_configs.json";
const REQUESTS_TIMEOUT = 5000; // 5 seconds for fetching live configs

export default {
    async fetch(request, env) {
        // Use a router to handle different paths
        const url = new URL(request.url);
        
        // Handle CORS preflight requests for all routes
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }
        
        // API Endpoint: Ping testing
        if (url.pathname === '/api/ping' && request.method === 'POST') {
            return handlePingRequest(request);
        }
        
        // API Endpoint: Subscription creation
        if (url.pathname === '/api/subscribe' && request.method === 'POST') {
            return handleSubscribeRequest(request, env);
        }
        
        // API Endpoint: Subscription retrieval (Standard & Clash)
        const subMatch = url.pathname.match(/^\/sub\/((clash)\/)?([0-9a-f-]+)$/);
        if (subMatch && request.method === 'GET') {
            const isClash = !!subMatch[2];
            const uuid = subMatch[3];
            return handleGetSubscription(uuid, isClash, env);
        }

        // Root path response
        if (url.pathname === '/') {
             return new Response('V2V API Worker is operational.', { headers: corsHeaders() });
        }

        // 404 for all other routes
        return new Response('Not Found.', { status: 404 });
    }
};

// --- HANDLER: PING TESTING ---
async function handlePingRequest(request) {
    try {
        const { configs } = await request.json();
        if (!Array.isArray(configs)) throw new Error('Request body must be an array.');
        
        const results = await Promise.all(configs.map(testTcpLatency));
        return new Response(JSON.stringify(results), { headers: jsonCorsHeaders() });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid request: ' + e.message }), { status: 400, headers: jsonCorsHeaders() });
    }
}

// --- HANDLER: SUBSCRIPTION CREATION ---
async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response('KV Namespace not configured.', { status: 503 });

    try {
        const { configs } = await request.json();
        if (!Array.isArray(configs) || configs.length === 0) {
            throw new Error("'configs' must be a non-empty array.");
        }

        const subUuid = crypto.randomUUID();
        const key = `sub:${subUuid}`;
        
        await env.V2V_KV.put(key, JSON.stringify(configs), { expirationTtl: 30 * 24 * 60 * 60 }); // 30-day expiry
        
        const hostUrl = new URL(request.url).origin;
        const subscription_url = `${hostUrl}/sub/${subUuid}`;
        
        return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: jsonCorsHeaders() });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Failed to create subscription: ' + e.message }), { status: 400, headers: jsonCorsHeaders() });
    }
}

// --- HANDLER: SUBSCRIPTION RETRIEVAL & HEALING ---
async function handleGetSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('Error: KV Namespace is not configured.', { status: 503, headers: textCorsHeaders() });
    
    // 1. Fetch user's saved configs
    const userConfigsJson = await env.V2V_KV.get(`sub:${uuid}`);
    if (!userConfigsJson) {
        return new Response('Error: Subscription not found.', { status: 404, headers: textCorsHeaders() });
    }
    const userConfigs = JSON.parse(userConfigsJson);
    const userConfigsSet = new Set(userConfigs);

    // 2. Fetch live configs with failover
    const liveConfigsSet = await _fetchLiveConfigs(env);
    if (!liveConfigsSet) {
        // If all sources fail, we can't heal. Return an error instead of empty/broken list.
        return new Response('Error: Could not retrieve live server list to heal subscription.', { status: 502, headers: textCorsHeaders() });
    }

    // 3. Heal the list
    let healedConfigs = userConfigs.filter(cfg => liveConfigsSet.has(cfg));
    const deadCount = userConfigs.length - healedConfigs.length;

    if (deadCount > 0) {
        const replacements = [...liveConfigsSet].filter(cfg => !userConfigsSet.has(cfg));
        healedConfigs.push(...replacements.slice(0, deadCount));
    }
    
    // 4. Final validation: NEVER return an empty list
    if (healedConfigs.length === 0) {
        // If after healing the list is empty, it means user's list was completely dead
        // and there were no new configs to replace them with. Return error.
        return new Response('Error: No valid configurations could be found for this subscription after healing.', { status: 500, headers: textCorsHeaders() });
    }

    // 5. Return as plain text
    const responseBody = healedConfigs.join('\n');
    return new Response(responseBody, { headers: textCorsHeaders() });
}


// --- HELPERS ---
async function _fetchLiveConfigs(env) {
    // Environment variables are more secure than hardcoded constants
    const urls = [env.PRIMARY_CONFIGS_URL, env.FALLBACK_CONFIGS_URL];
    for (const url of urls) {
        if (!url) continue;
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(REQUESTS_TIMEOUT) });
            if (!response.ok) continue;
            const data = await response.json();
            // Assuming the structure is { xray: ["config1", "config2"], singbox: [...] }
            // We combine all configs for the healing pool
            const allLive = [...(data.xray || []), ...(data.singbox || [])];
            if (allLive.length > 0) return new Set(allLive);
        } catch (e) {
            console.error(`Failed to fetch from ${url}:`, e.message);
        }
    }
    return null; // Return null if all sources fail
}

async function testTcpLatency(configStr) {
    const { hostname, port } = parseConfig(configStr);
    if (!hostname || !port) {
        return { config: configStr, ping: null, error: 'Invalid config format' };
    }
    try {
        const startTime = Date.now();
        const socket = connect({ hostname, port });
        const writer = socket.writable.getWriter();
        await writer.ready;
        const latency = Date.now() - startTime;
        writer.releaseLock();
        await socket.close();
        return { config: configStr, ping: latency };
    } catch (err) {
        return { config: configStr, ping: null, error: err.message };
    }
}

function parseConfig(configStr) {
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

const corsHeaders = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
const jsonCorsHeaders = () => ({ ...corsHeaders(), 'Content-Type': 'application/json' });
const textCorsHeaders = () => ({ ...corsHeaders(), 'Content-Type': 'text/plain;charset=utf-8' });
