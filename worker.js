// V2V Worker - Final Merged Version
// Combines personal subscriptions, public subscriptions, Clash generation, and fault-tolerance.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const PUBLIC_SUB_UUID = "00000000-v2v-public-sub-000000000000";
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours

// --- HELPERS (Your robust functions) ---
function generateUUID() { /* ... (Your function) ... */ }
function encodeBase64(str) { /* ... (Your function) ... */ }
function decodeBase64(str) { /* ... (Your function) ... */ }
function isValidConfig(config) { /* ... (Your function) ... */ }

// --- CLASH GENERATION (Your robust functions) ---
function parseConfigForClash(configStr) { /* ... (Your function) ... */ }
function generateClashYaml(configs) { /* ... (Your function) ... */ }

// --- NEW: FAULT-TOLERANT MIRROR FETCHER ---
async function fetchFromMirrors(env) {
    if (!env.DATA_MIRRORS) {
        throw new Error("DATA_MIRRORS secret not configured in Cloudflare Worker.");
    }
    const mirrors = JSON.parse(env.DATA_MIRRORS);
    const promises = mirrors.map(url =>
        fetch(`${url}?t=${Date.now()}`).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
    );
    try {
        return await Promise.any(promises);
    } catch (e) {
        throw new Error("All data mirrors are currently unavailable.");
    }
}

// --- MAIN REQUEST HANDLER ---
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;

        if (method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        try {
            // POST /subscribe - Create PERSONAL subscription
            if (method === 'POST' && url.pathname === '/subscribe') {
                const { configs } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) {
                    return new Response(JSON.stringify({ error: 'No valid configs provided' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
                }
                const uuid = generateUUID();
                await env.V2V_KV.put(uuid, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
                const baseUrl = url.origin;
                return new Response(JSON.stringify({ subscription_url: `${baseUrl}/sub/${uuid}` }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
            }

            // GET /sub/... - Get subscription data
            if (method === 'GET' && url.pathname.startsWith('/sub/')) {
                const pathParts = url.pathname.split('/');
                const isClash = pathParts.includes('clash');
                const uuid = pathParts[pathParts.length - 1];

                let outputConfigs;
                
                // NEW: Check for PUBLIC subscription UUID
                if (uuid === PUBLIC_SUB_UUID) {
                    const core = pathParts.includes('singbox') ? 'singbox' : 'xray';
                    const liveData = await fetchFromMirrors(env);
                    outputConfigs = liveData[core] || [];
                } else {
                    // Handle PERSONAL subscription from KV
                    const kvData = await env.V2V_KV.get(uuid);
                    if (!kvData) return new Response('Subscription not found or expired', { status: 404, headers: CORS_HEADERS });
                    outputConfigs = JSON.parse(kvData);
                }

                if (outputConfigs.length === 0) {
                    return new Response('No configs found for this subscription.', { status: 404, headers: CORS_HEADERS });
                }

                if (isClash) {
                    const clashYaml = generateClashYaml(outputConfigs);
                    return new Response(clashYaml, { headers: { ...CORS_HEADERS, 'Content-Type': 'text/yaml' } });
                } else {
                    return new Response(encodeBase64(outputConfigs.join('\n')), { headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
                }
            }
            
            return new Response('V2V API Worker is running.', { status: 200, headers: CORS_HEADERS });

        } catch (error) {
            return new Response(JSON.stringify({ error: 'Internal Server Error', message: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
    },
};


