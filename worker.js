/**
 * V2V Project - Final Production Worker v33.0 (Professional Refactor)
 * Implements the 3-stage testing architecture and robust Clash generation.
 */

// --- CONFIGURATION ---
const SUBSCRIPTION_TTL = 48 * 60 * 60; // 48 hours for personal subs
const READY_SUB_COUNT = 30;
const DATA_MIRRORS = [
    'https://v2v-vercel.vercel.app/all_live_configs.json',
    'https://smbcryp.github.io/V2V/all_live_configs.json',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
];
const MAX_NAME_LENGTH = 40;

// --- HEADERS ---
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain;charset=utf-8' };
const YAML_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/yaml;charset=utf-8' };
const NO_CACHE_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };


export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        try {
            // New: Baseline Ping Test Endpoint
            if (url.pathname === '/api/ping-test') {
                return new Response('OK', { headers: NO_CACHE_HEADERS });
            }
            if (url.pathname === '/api/ping' && request.method === 'POST') {
                return await handlePingRequest(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return await handleSubscribeRequest(request, env);
            }
            // Correctly handles /sub/public/clash/xray
            const publicSubMatch = url.pathname.match(/^\/sub\/public\/(clash\/)?(xray|singbox)$/);
            if (publicSubMatch && request.method === 'GET') {
                const isClash = !!publicSubMatch[1];
                const core = publicSubMatch[2];
                return await handleGetPublicSubscription(core, isClash);
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
            const errorResponse = { error: true, message: e.message || 'Internal Server Error' };
            return new Response(JSON.stringify(errorResponse), { status: 500, headers: JSON_HEADERS });
        }
    }
};

// --- HANDLERS (Unchanged handlers are kept for brevity) ---
async function handlePingRequest(request) {
    try {
        const { configs } = await request.json();
        if (!Array.isArray(configs)) throw new Error('Request body must be an array of configs.');
        const results = await Promise.all(configs.map(testTcpLatency));
        return new Response(JSON.stringify(results), { headers: JSON_HEADERS });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers: JSON_HEADERS });
    }
}
async function handleSubscribeRequest(request, env) {
    try {
        if (!env.V2V_KV) throw new Error('KV Namespace not configured.');
        const { configs } = await request.json();
        if (!Array.isArray(configs) || configs.length === 0) throw new Error("'configs' must be a non-empty array.");
        const subUuid = crypto.randomUUID();
        await env.V2V_KV.put(`sub:${subUuid}`, JSON.stringify(configs), { expirationTtl: SUBSCRIPTION_TTL });
        const subscription_url = `${new URL(request.url).origin}/sub/${subUuid}`;
        return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: JSON_HEADERS });
    } catch (e) {
        return new Response(JSON.stringify({ error: `Failed to create subscription: ${e.message}` }), { status: 500, headers: JSON_HEADERS });
    }
}
async function handleGetPublicSubscription(core, isClash) {
    try {
        const liveData = await fetchFromMirrors();
        const coreConfigs = liveData[core] || {};
        const allFlatConfigs = Object.values(coreConfigs).flat();
        const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);
        if (topConfigs.length === 0) return new Response(`No public configs found for core: ${core}`, { status: 404, headers: TEXT_HEADERS });
        
        if (isClash) {
            const clashYaml = await generateClashYaml(topConfigs);
            if (!clashYaml) throw new Error('Could not generate Clash config for public sub.');
            const headers = new Headers(YAML_HEADERS);
            headers.set('Content-Disposition', 'attachment; filename="v2v_clash.yml"');
            return new Response(clashYaml, { headers });
        } else {
            return new Response(safeBtoa(topConfigs.join('\n')), { headers: TEXT_HEADERS });
        }
    } catch(e) {
        return new Response(`Error fetching public subscription: ${e.message}`, { status: 502, headers: TEXT_HEADERS });
    }
}
async function handleGetPersonalSubscription(uuid, isClash, env) {
    try {
        if (!env.V2V_KV) throw new Error('KV Namespace is not configured.');
        const [kvData, liveData] = await Promise.all([ env.V2V_KV.get(`sub:${uuid}`), fetchFromMirrors() ]);
        if (!kvData) return new Response('Error: Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
        
        let userConfigs = JSON.parse(kvData);
        const allLiveConfigs = new Set([...Object.values(liveData.xray || {}).flat(), ...Object.values(liveData.singbox || {}).flat()]);
        const userConfigsSet = new Set(userConfigs);
        let healedConfigs = userConfigs.filter(cfg => allLiveConfigs.has(cfg));
        const deadCount = userConfigs.length - healedConfigs.length;
        if (deadCount > 0) {
            const replacements = [...allLiveConfigs].filter(cfg => !userConfigsSet.has(cfg));
            healedConfigs.push(...replacements.slice(0, deadCount));
        }
        if (healedConfigs.length === 0 && allLiveConfigs.size > 0) healedConfigs = [...allLiveConfigs].slice(0, 10);
        
        await env.V2V_KV.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
        
        if (isClash) {
            const clashYaml = await generateClashYaml(healedConfigs);
            if (!clashYaml) throw new Error('Could not generate Clash config.');
            return new Response(clashYaml, { headers: YAML_HEADERS });
        } else {
            return new Response(safeBtoa(healedConfigs.join('\n')), { headers: TEXT_HEADERS });
        }
    } catch(e) {
         return new Response(`Error fetching personal subscription: ${e.message}`, { status: 500, headers: TEXT_HEADERS });
    }
}

// --- HELPERS ---
function safeBtoa(str) { try { return btoa(unescape(encodeURIComponent(str))); } catch (e) { return btoa("Error: Could not encode content."); } }
async function fetchFromMirrors() { return Promise.any(DATA_MIRRORS.map(url => fetch(`${url}?t=${Date.now()}`).then(r => r.ok ? r.json() : Promise.reject(`Fetch failed: ${url}`)))); }
function parseHostAndPort(configStr) { try { if (configStr.startsWith('vmess://')) { const d = JSON.parse(atob(configStr.substring(8))); return { hostname: d.add, port: parseInt(d.port) }; } const url = new URL(configStr); return { hostname: url.hostname, port: parseInt(url.port) }; } catch { return { hostname: null, port: null }; } }
async function testTcpLatency(configStr) {
    const { hostname, port } = parseHostAndPort(configStr);
    if (!hostname || !port) return { config: configStr, ping: null };
    try {
        const startTime = Date.now();
        const socket = connect({ hostname, port }); // Cloudflare Workers connect API
        await socket.opened;
        const latency = Date.now() - startTime;
        await socket.close();
        return { config: configStr, ping: latency };
    } catch (err) {
        return { config: configStr, ping: null };
    }
}
async function generateProxyName(configStr) { try { const url = new URL(configStr); let name = decodeURIComponent(url.hash.substring(1) || ""); if (!name) { const server_id = `${url.hostname}:${url.port}`; const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(server_id)); name = `Config-${Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6)}`; } name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim(); if (name.length > MAX_NAME_LENGTH) name = name.substring(0, MAX_NAME_LENGTH) + '...'; return `V2V | ${name}`; } catch { return 'V2V | Unnamed Config'; } }
async function parseProxyForClash(configStr) { try { const name = await generateProxyName(configStr); const base = { name, 'skip-cert-verify': true }; const proto = configStr.split('://')[0]; if (proto === 'vmess') { const d = JSON.parse(atob(configStr.substring(8))); const p = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host }; if (d.net === 'ws') p['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }}; return p; } const url = new URL(configStr), params = new URLSearchParams(url.search); if (proto === 'vless') { const p = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')}; if (params.get('type') === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }}; return p; } if (proto === 'trojan') return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') }; if (proto === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; } } catch { return null; } return null; }

// New: Fully robust YAML generator, replacing the old error-prone version.
function safeYamlStringify(value) { return JSON.stringify(String(value)); }
async function generateClashYaml(configs) {
    const proxies = (await Promise.all(configs.map(parseProxyForClash))).filter(p => p !== null);
    if (proxies.length === 0) return null;
    const proxyNames = proxies.map(p => p.name);
    
    let yamlString = "proxies:\n";
    for (const p of proxies) {
        yamlString += `  - name: ${safeYamlStringify(p.name)}\n`;
        yamlString += `    type: ${p.type}\n`;
        yamlString += `    server: ${safeYamlStringify(p.server)}\n`;
        yamlString += `    port: ${p.port}\n`;
        if (p.uuid) yamlString += `    uuid: ${p.uuid}\n`;
        if (p.password) yamlString += `    password: ${safeYamlStringify(p.password)}\n`;
        if (p.alterId !== undefined) yamlString += `    alterId: ${p.alterId}\n`;
        if (p.cipher) yamlString += `    cipher: ${p.cipher}\n`;
        if (p.tls !== undefined) yamlString += `    tls: ${p.tls}\n`;
        if (p.servername) yamlString += `    servername: ${safeYamlStringify(p.servername)}\n`;
        if (p.network) yamlString += `    network: ${p.network}\n`;
        if (p['skip-cert-verify'] !== undefined) yamlString += `    skip-cert-verify: ${p['skip-cert-verify']}\n`;
        if (p['ws-opts']) {
            yamlString += `    ws-opts:\n`;
            yamlString += `      path: ${safeYamlStringify(p['ws-opts'].path)}\n`;
            if (p['ws-opts'].headers && p['ws-opts'].headers.Host) {
                 yamlString += `      headers:\n`;
                 yamlString += `        Host: ${safeYamlStringify(p['ws-opts'].headers.Host)}\n`;
            }
        }
    }
    
    yamlString += "proxy-groups:\n";
    yamlString += `  - name: V2V-Auto\n    type: url-test\n    url: http://www.gstatic.com/generate_204\n    interval: 300\n    proxies:\n`;
    proxyNames.forEach(name => { yamlString += `      - ${safeYamlStringify(name)}\n`; });
    
    yamlString += `  - name: V2V-Select\n    type: select\n    proxies:\n      - V2V-Auto\n`;
    proxyNames.forEach(name => { yamlString += `      - ${safeYamlStringify(name)}\n`; });

    yamlString += "rules:\n  - 'MATCH,V2V-Select'\n";
    return yamlString;
}
