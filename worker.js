/**
 * V2V Project - Final Production Worker v32.0
 * Handles:
 * - Advanced TCP latency testing (/api/ping)
 * - Personal subscription creation & retrieval (crash-proof, self-healing)
 * - Public subscription retrieval (dynamic)
 * - Dynamic generation of all Clash subscriptions
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
                return await handleGetPublicSubscription('xray', true);
            }
            if (url.pathname === '/api/ping' && request.method === 'POST') {
                return await handlePingRequest(request);
            }
            if (url.pathname === '/api/subscribe' && request.method === 'POST') {
                return await handleSubscribeRequest(request, env);
            }
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

// --- HANDLERS ---
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

        if (topConfigs.length === 0) {
            return new Response(`No public configs found for core: ${core}`, { status: 404, headers: TEXT_HEADERS });
        }
        
        if (isClash) {
            const clashYaml = await generateClashYaml(topConfigs);
            if (!clashYaml) throw new Error('Could not generate Clash config for public sub.');
            const headers = new Headers(YAML_HEADERS);
            headers.set('Content-Disposition', 'attachment; filename="v2v_clash.yml"');
            return new Response(clashYaml, { headers });
        } else {
            const base64Content = safeBtoa(topConfigs.join('\n'));
            return new Response(base64Content, { headers: TEXT_HEADERS });
        }
    } catch(e) {
        return new Response(`Error fetching public subscription: ${e.message}`, { status: 502, headers: TEXT_HEADERS });
    }
}

async function handleGetPersonalSubscription(uuid, isClash, env) {
    try {
        if (!env.V2V_KV) throw new Error('KV Namespace is not configured.');
        
        const [kvData, liveData] = await Promise.all([
            env.V2V_KV.get(`sub:${uuid}`),
            fetchFromMirrors()
        ]);

        if (!kvData) {
            return new Response('Error: Subscription not found or has expired.', { status: 404, headers: TEXT_HEADERS });
        }

        let userConfigs = JSON.parse(kvData);
        const allLiveConfigs = new Set([...Object.values(liveData.xray || {}).flat(), ...Object.values(liveData.singbox || {}).flat()]);

        const userConfigsSet = new Set(userConfigs);
        let healedConfigs = userConfigs.filter(cfg => allLiveConfigs.has(cfg));
        const deadCount = userConfigs.length - healedConfigs.length;

        if (deadCount > 0) {
            const replacements = [...allLiveConfigs].filter(cfg => !userConfigsSet.has(cfg));
            healedConfigs.push(...replacements.slice(0, deadCount));
        }
        if (healedConfigs.length === 0 && allLiveConfigs.size > 0) {
             healedConfigs = [...allLiveConfigs].slice(0, 10);
        }
        
        await env.V2V_KV.put(`sub:${uuid}`, JSON.stringify(healedConfigs), { expirationTtl: SUBSCRIPTION_TTL });
        
        if (isClash) {
            const clashYaml = await generateClashYaml(healedConfigs);
            if (!clashYaml) throw new Error('Could not generate Clash config from healed subscription.');
            return new Response(clashYaml, { headers: YAML_HEADERS });
        } else {
            const base64Content = safeBtoa(healedConfigs.join('\n'));
            return new Response(base64Content, { headers: TEXT_HEADERS });
        }
    } catch(e) {
         return new Response(`Error fetching personal subscription: ${e.message}`, { status: 500, headers: TEXT_HEADERS });
    }
}

// --- HELPERS ---
function safeBtoa(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {
        return btoa("Error: Could not encode content.");
    }
}

async function fetchFromMirrors() {
    // This is a more robust Promise.any implementation for workers
    const promises = DATA_MIRRORS.map(url =>
        fetch(`${url}?t=${Date.now()}`).then(response => {
            if (!response.ok) throw new Error(`Failed to fetch ${url}`);
            return response.json();
        }).catch(error => {
            console.error(error);
            return Promise.reject(error);
        })
    );
    return Promise.any(promises);
}

async function testTcpLatency(configStr) {
    const { hostname, port } = parseHostAndPort(configStr);
    if (!hostname || !port) return { config: configStr, ping: null };
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

async function generateProxyName(configStr) {
    try {
        const url = new URL(configStr);
        const original_name = decodeURIComponent(url.hash.substring(1) || "");
        let sanitized_name = original_name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
        
        if (!sanitized_name) {
             const server_id = `${url.hostname}:${url.port}`;
             const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(server_id));
             const hash = Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6);
             sanitized_name = `Config-${hash}`;
        }
        if (sanitized_name.length > MAX_NAME_LENGTH) {
            sanitized_name = sanitized_name.substring(0, MAX_NAME_LENGTH) + '...';
        }
        return `V2V | ${sanitized_name}`;
    } catch { 
        return 'V2V | Unnamed Config';
    }
}

async function generateClashYaml(configs) {
    const proxyPromises = configs.map(parseProxyForClash);
    const proxies = (await Promise.all(proxyPromises)).filter(p => p !== null);
    if (proxies.length === 0) return null;

    const proxyNames = proxies.map(p => p.name);
    const clashConfig = {
        'proxies': proxies,
        'proxy-groups': [
            { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 },
            { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] }
        ],
        'rules': ['MATCH,V2V-Select']
    };
    // Basic but functional YAML serialization. A library would be better for full spec compliance.
    let yamlString = "proxies:\n";
    for (const p of proxies) {
        yamlString += `  - {name: ${JSON.stringify(p.name)}, type: ${p.type}, server: ${JSON.stringify(p.server)}, port: ${p.port}, `;
        const details = [];
        for (const key in p) {
            if (!['name', 'type', 'server', 'port'].includes(key)) {
                if (typeof p[key] === 'object' && p[key] !== null) {
                    const subDetails = Object.entries(p[key]).map(([sk, sv]) => `${sk}: ${JSON.stringify(sv)}`).join(', ');
                    details.push(`${key}: {${subDetails}}`);
                } else {
                    details.push(`${key}: ${JSON.stringify(p[key])}`);
                }
            }
        }
        yamlString += details.join(', ') + '}\n';
    }
    yamlString += "proxy-groups:\n";
    clashConfig['proxy-groups'].forEach(g => {
        yamlString += `  - {name: ${JSON.stringify(g.name)}, type: ${g.type}, proxies: [${g.proxies.map(p => JSON.stringify(p)).join(', ')}], url: '${g.url}', interval: ${g.interval}}\n`;
    });
    yamlString += "rules:\n  - 'MATCH,V2V-Select'\n";
    return yamlString;
}

async function parseProxyForClash(configStr) {
   try {
        const final_name = await generateProxyName(configStr);
        const base = { name: final_name, 'skip-cert-verify': true };
        const protocol = configStr.split('://')[0];

        if (protocol === 'vmess') {
            const d = JSON.parse(atob(configStr.substring(8)));
            const vmessProxy = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') vmessProxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
            return vmessProxy;
        }
        const url = new URL(configStr), params = new URLSearchParams(url.search);
        if (protocol === 'vless') {
             const vlessProxy = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
             if (params.get('type') === 'ws') vlessProxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }};
             return vlessProxy;
        }
        if (protocol === 'trojan') return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
        if (protocol === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; }
    } catch { return null; }
    return null;
}
