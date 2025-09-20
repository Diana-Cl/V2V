// ✅ (1) Install `uuid` and `js-yaml` packages: `npm install uuid js-yaml`
// ✅ (2) Ensure `nodejs_compat` is enabled in `wrangler.toml`:
//    compatibility_date = "2024-03-20"
//    compatibility_flags = ["nodejs_compat"]

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets'; // ✅ برای تست پینگ TCP از سمت ورکر

// --- Configuration Constants ---
const ALL_LIVE_CONFIGS_KEY = 'all_live_configs.json';
const CACHE_VERSION_KEY = 'cache_version.txt';
const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 30; // 30 days for personal subscription UUIDs
const FRONTEND_DOMAIN = 'https://smbcryp.github.io'; // ✅ تغییر داده شد به آدرس دقیق فرانت‌اند شما

// --- CORS Headers ---
const corsHeaders = {
    'Access-Control-Allow-Origin': FRONTEND_DOMAIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version',
    'Access-Control-Max-Age': '86400',
};

// --- Helper Functions ---

function handleOptions(request) {
    const requestOrigin = request.headers.get('Origin');
    if (FRONTEND_DOMAIN.split(',').indexOf(requestOrigin) === -1) {
        return new Response(null, { status: 403, statusText: 'Forbidden' });
    }
    return new Response(null, { headers: corsHeaders });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

function textResponse(text, status = 200, filename = null) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders };
    if (filename) {
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    return new Response(text, { status, headers });
}

/**
 * Generates a Clash Meta YAML subscription file.
 * This function is now more robust to prevent duplicate names and parse errors.
 * @param {string[]} configs - Array of config URLs.
 * @returns {string|null} - The YAML string or null if no compatible proxies.
 */
function generateClashYaml(configs) {
    const proxies = [];
    const usedNames = new Set(); // ✅ برای جلوگیری از نام‌های تکراری

    for (const configUrl of configs) {
        try {
            let proxy;
            const urlParsed = new URL(configUrl);
            const scheme = urlParsed.protocol.replace(':', '').toLowerCase();

            // Function to generate a unique name
            const getUniqueName = (baseName) => {
                let name = baseName;
                let counter = 1;
                while (usedNames.has(name)) {
                    name = `${baseName}-${counter++}`;
                }
                usedNames.add(name);
                return name;
            };

            if (scheme === 'vmess') {
                const decodedVmess = JSON.parse(atob(configUrl.substring(8)));
                proxy = {
                    name: getUniqueName(decodedVmess.ps || `vmess-${decodedVmess.add}`),
                    type: 'vmess', server: decodedVmess.add, port: parseInt(decodedVmess.port),
                    uuid: decodedVmess.id, alterId: parseInt(decodedVmess.aid || 0),
                    cipher: decodedVmess.scy || 'auto', tls: decodedVmess.tls === 'tls',
                };
                if (decodedVmess.net === 'ws') {
                    proxy.network = 'ws';
                    proxy['ws-opts'] = { path: decodedVmess.path || '/', headers: { Host: decodedVmess.host || decodedVmess.add }};
                }
            } else if (scheme === 'vless') {
                const params = new URLSearchParams(urlParsed.search);
                proxy = {
                    name: getUniqueName(decodeURIComponent(urlParsed.hash.substring(1)) || `vless-${urlParsed.hostname}`),
                    type: 'vless', server: urlParsed.hostname, port: parseInt(urlParsed.port),
                    uuid: urlParsed.username, tls: params.get('security') === 'tls',
                    servername: params.get('sni') || urlParsed.hostname,
                };
                if (params.get('type') === 'ws') {
                    proxy.network = 'ws';
                    proxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || urlParsed.hostname }};
                }
            } else if (scheme === 'trojan') {
                 const params = new URLSearchParams(urlParsed.search);
                proxy = {
                    name: getUniqueName(decodeURIComponent(urlParsed.hash.substring(1)) || `trojan-${urlParsed.hostname}`),
                    type: 'trojan', server: urlParsed.hostname, port: parseInt(urlParsed.port),
                    password: urlParsed.password, // Trojan requires a password
                    sni: params.get('sni') || urlParsed.hostname,
                };
            }
            // Add other protocols if needed for Clash

            if (proxy) {
                proxies.push(proxy);
            }

        } catch (e) {
            console.error(`[Clash Gen] Skipping faulty config: ${configUrl.substring(0, 50)}...`, e.message);
            continue; // ✅ از کانفیگ‌های معیوب رد شو
        }
    }

    if (proxies.length === 0) return null;

    const proxyNames = proxies.map(p => p.name);
    const yamlConfig = {
        'mixed-port': 7890,
        'allow-lan': true,
        'mode': 'rule',
        'log-level': 'info',
        proxies: proxies,
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['AUTO', ...proxyNames] },
            { name: 'AUTO', type: 'url-test', proxies: proxyNames, url: 'http://www.gstatic.com/generate_204', interval: 300 },
        ],
        rules: ['MATCH,PROXY'],
    };
    return YAML.dump(yamlConfig, { skipInvalid: true, sortKeys: false });
}


// --- Main Request Handler ---

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return handleOptions(request);
        }

        try {
            // Endpoint 1: /configs - Get all live configs
            if (url.pathname === '/configs') {
                const allConfigs = await env.v2v_kv.get(ALL_LIVE_CONFIGS_KEY, { type: 'json' });
                const cacheVersion = await env.v2v_kv.get(CACHE_VERSION_KEY);
                if (!allConfigs) return jsonResponse({ error: 'Configs data not found.' }, 404);
                const response = jsonResponse(allConfigs);
                if (cacheVersion) response.headers.set('X-Cache-Version', cacheVersion);
                return response;
            }

            // ✅ Endpoint 2: /tcp-probe - For frontend ping tests of TCP-based configs
            if (url.pathname === '/tcp-probe' && request.method === 'POST') {
                const { host, port } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid host or port' }, 400);

                let socket;
                try {
                    const startTime = Date.now();
                    socket = connect({ hostname: host, port }, { allowHalfOpen: false });
                    await socket.opened;
                    const latency = Date.now() - startTime;
                    return jsonResponse({ latency });
                } catch (e) {
                    return jsonResponse({ latency: null, error: e.message });
                } finally {
                    if (socket) await socket.close().catch(() => {});
                }
            }

            // Endpoint 3: /create-personal-sub - Create a new personal subscription
            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!configs || !Array.isArray(configs) || configs.length === 0) {
                    return jsonResponse({ error: 'Invalid request payload. `configs` array is required.' }, 400);
                }

                const userUuid = clientUuid || uuidv4();
                const subKey = `sub:${userUuid}`;

                await env.v2v_kv.put(subKey, JSON.stringify({ configs }), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });

                return jsonResponse({
                    uuid: userUuid,
                    subscriptionUrl: `${url.origin}/sub/${userUuid}`,
                    clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`,
                });
            }

            // Endpoint 4: /sub/:uuid - Serve raw personal subscriptions (URL format with UUID)
            const subMatch = url.pathname.match(/^\/sub\/(?!clash\/)([^/]+)/);
            if (subMatch) {
                const uuid = subMatch[1];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404);
                return textResponse(btoa(storedData.configs.join('\n')), 200, `v2v-${uuid}.txt`);
            }

            // Endpoint 5: /sub/clash/:uuid - Serve personal Clash subscriptions (URL format with UUID)
            const clashSubMatch = url.pathname.match(/^\/sub\/clash\/([^/]+)/);
            if (clashSubMatch) {
                const uuid = clashSubMatch[1];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404);

                const clashYamlContent = generateClashYaml(storedData.configs);
                if (!clashYamlContent) return textResponse('Failed to generate Clash YAML (no compatible configs).', 500);

                return textResponse(clashYamlContent, 200, `v2v-clash-${uuid}.yaml`);
            }

            // Default route
            return textResponse('v2v Worker is running.');

        } catch (err) {
            console.error(err);
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500);
        }
    },
};
