import { connect } from 'cloudflare:sockets';

// --- configuration ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours
const READY_SUB_COUNT = 30; // Count of top configs for public subscription
// const DATA_MIRRORS = [ // Removed: Will now fetch from KV
//     'https://v2v-vercel.vercel.app/all_live_configs.json',
//     'https://smbcryp.github.io/v2v/all_live_configs.json',
//     'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
// ];
const KV_LIVE_CONFIGS_KEY = 'all_live_configs'; // Key name in KV for live configs
const MAX_NAME_LENGTH = 40;

// --- headers ---
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };

// --- main fetch handler ---
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
        const url = new URL(request.url);

        try {
            // New endpoint for TCP probing via HTTP POST
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
                // Per user request, disable public-ready clash subscription
                if (isClash) return new Response('Public Clash subscription is disabled.', { status: 404 });
                return handleGetPublicSubscription(core, isClash, env);
            }

            // Existing personal subscription by KV UUID
            const personalSubMatch = url.pathname.match(/^\/sub\/(clash\/)?([0-9a-f-]+)$/);
            if (personalSubMatch) {
                const uuid = personalSubMatch[2];
                const isClash = !!personalSubMatch[1];
                return handleGetPersonalSubscription(uuid, isClash, env);
            }
            
            // New endpoint for fetching all live configs (for index.js to load)
            // This now reads directly from KV
            if (url.pathname === '/all_live_configs.json') {
                const liveConfigs = await getLiveConfigsFromKV(env);
                if (!liveConfigs) {
                    return new Response(JSON.stringify({ error: "Live configs not found in KV." }), { status: 404, headers: JSON_HEADERS });
                }
                return new Response(JSON.stringify(liveConfigs, null, 2), { headers: JSON_HEADERS });
            }

            return new Response('V2V API Worker is operational.', { headers: CORS_HEADERS });
        } catch (error) {
            console.error('Worker error:', error.stack);
            return new Response(error.message || 'Internal Server Error', { status: 500, headers: CORS_HEADERS });
        }
    }
};

// --- TCP Probe Logic (Replaces tcpBridge) ---
async function handleTcpProbe(request) {
    let socket = null;
    try {
        const { host, port, tls } = await request.json(); // Expecting { host, port, tls: boolean }
        if (!host || !port) {
            return new Response(JSON.stringify({ error: 'Invalid host or port' }), { status: 400, headers: JSON_HEADERS });
        }

        const startTime = Date.now();
        
        // Connect to the target socket
        socket = connect({ hostname: host, port: port }, { allowHalfOpen: false });

        let connectedSocket = socket;
        if (tls) {
            const startTlsPromise = connectedSocket.startTls({ hostname: host });
            // Add a timeout for TLS handshake
            const tlsTimeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('TLS Handshake Timeout')), 3000)
            );
            await Promise.race([startTlsPromise, tlsTimeout]);
        }
        
        // Await socket readiness (connection established)
        await connectedSocket.opened;

        const latency = Date.now() - startTime;

        // Perform a small write/read to ensure the connection is truly active
        const writer = connectedSocket.writable.getWriter();
        await writer.write(new Uint8Array([0x00])); // Send a single byte
        writer.releaseLock();

        // Attempt a small read to ensure server is responsive (non-blocking)
        const reader = connectedSocket.readable.getReader();
        const readPromise = reader.read();
        const readTimeout = new Promise(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 500)); // Wait 500ms for a response
        await Promise.race([readPromise, readTimeout]);
        reader.releaseLock();
        
        return new Response(JSON.stringify({ latency }), { headers: JSON_HEADERS });

    } catch (e) {
        console.error(`TCP probe failed for ${JSON.stringify(await request.json().catch(() => ({})), null, 2)}. Error:`, e.message); // Log incoming payload too
        return new Response(JSON.stringify({ error: e.message || 'Connection failed' }), { status: 502, headers: JSON_HEADERS });
    } finally {
        if (socket) {
            try {
                await socket.close();
            } catch (e) {
                // console.warn("Failed to close socket gracefully:", e.message);
            }
        }
    }
}


// --- Subscription Logic ---
async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response('KV namespace not configured.', { status: 500 });
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0) return new Response("'configs' must be a non-empty array.", { status: 400 });
    const subUUID = crypto.randomUUID();
    await env.V2V_KV.put(`sub:${subUUID}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
    const origin = new URL(request.url).origin;
    // The subscription_url here points to the worker's handler for personal subscriptions
    const subscriptionUrl = `${origin}/sub/${subUUID}`; // Standard subscription
    const clashSubscriptionUrl = `${origin}/sub/clash/${subUUID}`; // Clash specific subscription
    return new Response(JSON.stringify({ subscription_url: subscriptionUrl, clash_subscription_url: clashSubscriptionUrl, uuid: subUUID }), { status: 201, headers: JSON_HEADERS });
}

async function handleGetPublicSubscription(core, isClash, env) {
    const liveData = await getLiveConfigsFromKV(env); // Changed to KV
    if (!liveData) return new Response("Live configs not available.", { status: 500 });

    const coreConfigs = liveData[core] || {};
    const allFlatConfigs = Object.values(coreConfigs).flat();
    const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);
    if (topConfigs.length === 0) return new Response(`No public configs found for core: ${core}`, { status: 404 });
    return generateSubscriptionResponse(topConfigs, isClash);
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    if (!env.V2V_KV) return new Response('KV namespace not configured.', { status: 500 });
    const [kvData, liveData] = await Promise.all([ env.V2V_KV.get(`sub:${uuid}`), getLiveConfigsFromKV(env) ]); // Changed to KV
    if (!kvData) return new Response('Subscription not found or has expired.', { status: 404 });
    if (!liveData) return new Response("Live configs not available.", { status: 500 });
    
    let userConfigs = JSON.parse(kvData);
    const allLiveConfigs = new Set(Object.values(liveData.xray || {}).flat().concat(Object.values(liveData.singbox || {}).flat()));
    
    // Healing logic - ensuring user configs are still live
    let healedConfigs = userConfigs.filter(cfg => allLiveConfigs.has(cfg));
    const deadCount = userConfigs.length - healedConfigs.length;
    if (deadCount > 0) {
        const userConfigsSet = new Set(userConfigs);
        const replacements = [...allLiveConfigs].filter(cfg => !userConfigsSet.has(cfg));
        healedConfigs.push(...replacements.slice(0, deadCount));
    }
    // If all user configs are dead, or initial set was empty, provide some live ones
    if (healedConfigs.length === 0 && allLiveConfigs.size > 0) {
        healedConfigs = [...allLiveConfigs].slice(0, Math.min(10, allLiveConfigs.size));
    }
    
    await env.V2V_KV.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
    return generateSubscriptionResponse(healedConfigs, isClash);
}

async function generateSubscriptionResponse(configs, isClash) {
    if (isClash) {
        const clashYaml = await generateClashYaml(configs);
        if (!clashYaml) throw new Error('Could not generate Clash config.');
        const headers = new Headers(YAML_HEADERS);
        headers.set('Content-Disposition', 'attachment; filename="v2v_clash.yaml"');
        return new Response(clashYaml, { headers });
    } else {
        // *** IMPORTANT: Removed Base64 encoding as per requirement ***
        return new Response(configs.join('\n'), { headers: TEXT_HEADERS });
    }
}

// --- Helpers & YAML Generation (Moved from scraper.py to worker.js for Clash generation) ---

// NEW: Function to get live configs from KV
async function getLiveConfigsFromKV(env) {
    try {
        if (!env.V2V_KV) throw new Error("KV namespace not configured for live configs.");
        const configsJson = await env.V2V_KV.get(KV_LIVE_CONFIGS_KEY, 'text');
        if (!configsJson) return null;
        return JSON.parse(configsJson);
    } catch (error) {
        console.error("Failed to read live configs from KV:", error);
        throw new Error("Could not retrieve live configs from KV.");
    }
}


async function generateProxyName(configStr, server, port) {
    try {
        const url = new URL(configStr);
        let name = decodeURIComponent(url.hash.substring(1) || "");
        if (!name) {
            name = `config-${server.slice(0, 8)}...`;
        }
        // Remove unicode emojis and trim
        name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim().substring(0, MAX_NAME_LENGTH);
        const uniqueHashBuffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(`${server}:${port}`));
        const uniqueHash = Array.from(new Uint8Array(uniqueHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 4);
        return `V2V | ${name} | ${uniqueHash}`;
    } catch (e) {
        // console.error("Error generating proxy name:", e); // For debugging
        return `V2V | Unnamed Config`;
    }
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
    } catch (e) {
        // console.error("Error parsing proxy for Clash:", e); // For debugging
        return null;
    }
    return null;
}

// This utility function is useful for ensuring strings in YAML are correctly quoted
function safeYamlStringify(value) {
    if (typeof value === 'string') {
        // If string contains special YAML characters, newlines, or is empty, quote it
        if (value.includes(': ') || value.includes('\n') || value.includes('"') || value.includes("'") || value.startsWith(' ') || value.endsWith(' ') || value === '' || value.match(/^[\d.]+$/)) {
            // Use JSON.stringify to handle escapes and quoting
            return JSON.stringify(value);
        }
    }
    return String(value); // Convert other types to string and return
}


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
        const orderedKeys = ['type', 'server', 'port', 'uuid', 'password', 'alterId', 'cipher', 'tls', 'network', 'servername', 'skip-cert-verify', 'ws-opts', 'udp']; // Added 'udp' for completeness
        orderedKeys.forEach(key => {
            // Exclude undefined, null, and alterId = 0
            if (p[key] === undefined || p[key] === null || (key === 'alterId' && p[key] === 0)) return;
            const value = p[key];
            if (key === 'ws-opts' && typeof value === 'object') {
                yamlString += `    ws-opts:\n`;
                if (value.path !== undefined) yamlString += `      path: ${safeYamlStringify(value.path)}\n`;
                if (value.headers && value.headers.Host !== undefined) yamlString += `      headers:\n        Host: ${safeYamlStringify(value.headers.Host)}\n`; // Corrected 'host' to 'Host' for Clash
            } else if (typeof value !== 'object') {
                yamlString += `    ${key}: ${safeYamlStringify(value)}\n`;
            }
        });
    });
    
    yamlString += "\nproxy-groups:\n";
    yamlString += `  - name: V2V-Auto\n    type: url-test\n    proxies:\n${proxyNames.map(name => `      - ${safeYamlStringify(name)}`).join('\n')}\n    url: 'http://www.gstatic.com/generate_204'\n    interval: 300\n`;
    yamlString += `  - name: V2V-Select\n    type: select\n    proxies:\n      - V2V-Auto\n${proxyNames.map(name => `      - ${safeYamlStringify(name)}`).join('\n')}\n`;
    yamlString += "\nrules:\n  - 'MATCH,V2V-Select'\n";
    return yamlString;
}
