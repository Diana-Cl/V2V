// --- CONFIGURATION ---
// آدرس فایل داده‌های زنده که روی یکی از آینه‌های استاتیک شما قرار دارد
const LIVE_CONFIGS_URL = "https://smbcryp.github.io/v2v/all_live_configs.json"; 

// --- HELPERS ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- PING LOGIC (for non-WebSocket configs) ---
function parseConfigForPing(config) {
    try {
        if (config.startsWith('vmess://')) {
            const decoded = atob(config.replace("vmess://", ""));
            const data = JSON.parse(decoded);
            return { hostname: data.add, port: parseInt(data.port) };
        }
        const url = new URL(config);
        return { hostname: url.hostname, port: parseInt(url.port) };
    } catch (e) {
        return { hostname: null, port: null };
    }
}

async function testTcpConnection(config) {
    const { hostname, port } = parseConfigForPing(config);
    if (!hostname || !port) return null;
    try {
        // connect() API requires `nodejs_compat` flag in wrangler.toml
        const socket = connect({ hostname, port, tls: { allowHalfClose: true } }); 
        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();
        writer.releaseLock();
        reader.releaseLock();
        await socket.close();
        return 1; // Returns 1 instead of latency as a simple success indicator from backend
    } catch (e) {
        return null;
    }
}

async function handlePingRequest(request) {
    try {
        const { configs } = await request.json();
        if (!Array.isArray(configs)) return new Response('Invalid body', { status: 400 });
        
        const results = await Promise.allSettled(configs.map(testTcpConnection));
        
        const finalPings = results.map((r, i) => ({
            config: configs[i],
            ping: r.status === 'fulfilled' ? r.value : null
        }));
        
        return new Response(JSON.stringify(finalPings), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response('Error processing ping request: ' + e.message, { status: 500, headers: corsHeaders });
    }
}


// --- SUBSCRIPTION LOGIC ---
async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) {
        return new Response('KV Namespace not configured.', { status: 500, headers: corsHeaders });
    }
    try {
        const { configs, type = 'standard' } = await request.json();
        if (!Array.isArray(configs) || configs.length === 0) {
            return new Response('Invalid request: "configs" must be a non-empty array.', { status: 400, headers: corsHeaders });
        }
        const subId = generateUUID();
        const key = `sub:${subId}`;
        
        await env.V2V_KV.put(key, JSON.stringify(configs), { expirationTtl: 2592000 });
        
        const workerUrl = new URL(request.url).origin;
        const subscription_url = `${workerUrl}/${type === 'clash' ? 'clash/' : ''}${subId}`;
        
        return new Response(JSON.stringify({ subscription_url, uuid: subId }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch(e) {
        return new Response('Error creating subscription: ' + e.message, { status: 500, headers: corsHeaders });
    }
}

async function handleGetSubscription(request, env) {
    const url = new URL(request.url);
    const pathParts = url.pathname.substring(1).split('/');
    const subId = pathParts[pathParts.length - 1];
    const subType = pathParts.includes('clash') ? 'clash' : 'standard';

    if (!env.V2V_KV) { return new Response('KV Namespace not configured.', { status: 500 }); }
    
    const key = `sub:${subId}`;
    const userConfigsJson = await env.V2V_KV.get(key);
    if (!userConfigsJson) { return new Response('Subscription not found.', { status: 404 }); }
    
    const userConfigs = JSON.parse(userConfigsJson);
    let healedConfigs = [...userConfigs];

    try {
        const res = await fetch(LIVE_CONFIGS_URL, { headers: { 'User-Agent': 'V2V-Worker/1.0' } });
        if (res.ok) {
            const liveData = await res.json();
            const liveConfigsSet = new Set((liveData.xray || []).map(c => c.config));
            
            const userConfigsSet = new Set(userConfigs);
            healedConfigs = userConfigs.filter(c => liveConfigsSet.has(c));
            const deadCount = userConfigs.length - healedConfigs.length;

            if (deadCount > 0) {
                const replacements = Array.from(liveConfigsSet).filter(c => !userConfigsSet.has(c));
                healedConfigs.push(...replacements.slice(0, deadCount));
            }
        }
    } catch (e) { console.error("Subscription healing failed, using original configs:", e); }

    if (healedConfigs.length === 0) { return new Response("No valid configs found for this subscription.", { status: 500 }); }

    const output = healedConfigs.join('\n');
    if (subType === 'clash') {
        // For Clash, we send the healed configs back as plain text.
        // The client-side `index.js` is responsible for generating the final YAML file.
        return new Response(output, { headers: { ...corsHeaders, 'Content-Type': 'text/plain;charset=utf-8' } });
    } else {
        // For standard subscriptions, we send the base64 encoded string.
        return new Response(btoa(output), { headers: { ...corsHeaders, 'Content-Type': 'text/plain;charset=utf-8' } });
    }
}

// --- MAIN ROUTER ---
export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        
        const url = new URL(request.url);
        
        if (url.pathname === '/ping') {
            return handlePingRequest(request);
        }
        
        if (url.pathname === '/subscribe') {
            return handleSubscribeRequest(request, env);
        }
        
        // This regex now matches a UUID or "clash/UUID"
        if (/^(clash\/)?[a-f0-9-]{36}$/.test(url.pathname.substring(1))) {
             return handleGetSubscription(request, env);
        }

        return new Response('V2V API Worker', { status: 200, headers: corsHeaders });
    },
};
