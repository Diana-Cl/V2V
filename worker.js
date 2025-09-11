import { connect } from 'cloudflare:sockets';

/**
 * V2V Project - Final Production Worker
 * Handles:
 * - Advanced TCP latency testing (/api/ping)
 * - Self-healing subscription creation & retrieval for both Standard (UUID) and Clash Meta.
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }
        
        if (url.pathname === '/api/ping' && request.method === 'POST') {
            return handlePingRequest(request);
        }
        
        if (url.pathname === '/api/subscribe' && request.method === 'POST') {
            return handleSubscribeRequest(request, env);
        }
        
        const subMatch = url.pathname.match(/^\/sub\/((clash)\/)?([0-9a-f-]+)$/);
        if (subMatch && request.method === 'GET') {
            const isClash = !!subMatch[2];
            const uuid = subMatch[3];
            return handleGetSubscription(uuid, isClash, env);
        }

        if (url.pathname === '/') {
             return new Response('V2V API Worker is operational.', { headers: corsHeaders() });
        }

        return new Response('Not Found.', { status: 404, headers: corsHeaders() });
    }
};

// --- HANDLERS ---

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

async function handleSubscribeRequest(request, env) {
    if (!env.V2V_KV) return new Response(JSON.stringify({ error: 'KV Namespace not configured.' }), { status: 503, headers: jsonCorsHeaders() });

    try {
        const { configs } = await request.json();
        if (!Array.isArray(configs) || configs.length === 0) {
            throw new Error("'configs' must be a non-empty array.");
        }

        const subUuid = crypto.randomUUID();
        const key = `sub:${subUuid}`;
        
        await env.V2V_KV.put(key, JSON.stringify({ configs }), { expirationTtl: 30 * 24 * 60 * 60 });
        
        const hostUrl = new URL(request.url).origin;
        const subscription_url = `${hostUrl}/sub/${subUuid}`;
        
        return new Response(JSON.stringify({ subscription_url, uuid: subUuid }), { status: 201, headers: jsonCorsHeaders() });

    } catch (e) {
        return new Response(JSON.stringify({ error: 'Failed to create subscription: ' + e.message }), { status: 400, headers: jsonCorsHeaders() });
    }
}

async function handleGetSubscription(uuid, isClashRequest, env) {
    if (!env.V2V_KV) return new Response('Error: KV Namespace is not configured.', { status: 503, headers: textCorsHeaders() });
    
    const userSubDataJson = await env.V2V_KV.get(`sub:${uuid}`);
    if (!userSubDataJson) {
        return new Response('Error: Subscription not found.', { status: 404, headers: textCorsHeaders() });
    }
    const { configs: userConfigs } = JSON.parse(userSubDataJson);
    const userConfigsSet = new Set(userConfigs);

    const liveConfigsSet = await _fetchLiveConfigs(env);
    if (!liveConfigsSet) {
        return new Response('Error: Could not retrieve live server list.', { status: 502, headers: textCorsHeaders() });
    }

    let healedConfigs = userConfigs.filter(cfg => liveConfigsSet.has(cfg));
    const deadCount = userConfigs.length - healedConfigs.length;

    if (deadCount > 0) {
        const replacementPool = isClashRequest ? 
            [...liveConfigsSet].filter(cfg => !userConfigsSet.has(cfg) && isXrayProtocol(cfg)) :
            [...liveConfigsSet].filter(cfg => !userConfigsSet.has(cfg));
            
        healedConfigs.push(...replacementPool.slice(0, deadCount));
    }
    
    if (healedConfigs.length === 0) {
        const fallbackPool = isClashRequest ? [...liveConfigsSet].filter(isXrayProtocol) : [...liveConfigsSet];
        healedConfigs = fallbackPool.slice(0, userConfigs.length || 30);
        if (healedConfigs.length === 0) {
           return new Response('Error: No valid configurations could be found after healing.', { status: 500, headers: textCorsHeaders() });
        }
    }

    if (isClashRequest) {
        const clashYaml = generateClashYaml(healedConfigs);
        return new Response(clashYaml, { headers: yamlCorsHeaders() });
    } else {
        const responseBody = healedConfigs.join('\n');
        return new Response(responseBody, { headers: textCorsHeaders() });
    }
}


// --- HELPERS & PARSERS ---

async function _fetchLiveConfigs(env) {
    const urls = [env.PRIMARY_CONFIGS_URL, env.FALLBACK_CONFIGS_URL];
    for (const url of urls) {
        if (!url) continue;
        try {
            const request = new Request(url, { cf: { cacheTtl: 600 } });
            const response = await fetch(request, { signal: AbortSignal.timeout(4000) });
            if (!response.ok) continue;
            const data = await response.json();
            const allLive = [...(data.xray || []), ...(data.singbox || [])];
            if (allLive.length > 0) return new Set(allLive);
        } catch (e) {
            console.error(`Failed to fetch from ${url}:`, e.message);
        }
    }
    return null;
}

async function testTcpLatency(configStr) {
    const { hostname, port } = parseConnectionDetails(configStr);
    if (!hostname || !port) {
        return { config: configStr, ping: null, error: 'Invalid config format' };
    }
    try {
        const startTime = Date.now();
        const socket = connect({ hostname, port });
        const writer = socket.writable.getWriter();
        await writer.write(new Uint8Array(0));
        await writer.close();
        return { config: configStr, ping: Date.now() - startTime };
    } catch (err) {
        return { config: configStr, ping: null, error: err.message };
    }
}

function parseConnectionDetails(configStr) {
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

function isXrayProtocol(configStr) {
    const xrayProtocols = ['vless', 'vmess', 'trojan', 'ss'];
    try {
        const protocol = configStr.split('://')[0];
        return xrayProtocols.includes(protocol);
    } catch {
        return false;
    }
}

function generateClashYaml(configs) {
    const proxies = [];
    const uniqueCheck = new Set();
    
    configs.forEach(config => {
        try {
            const parsed = parseProxyForClash(config);
            if (parsed) {
                const key = `${parsed.server}:${parsed.port}:${parsed.name}`;
                if (!uniqueCheck.has(key)) {
                    proxies.push(parsed);
                    uniqueCheck.add(key);
                }
            }
        } catch {}
    });

    if (proxies.length === 0) return "# No compatible proxies found.";

    const proxyNames = proxies.map(p => `      - "${p.name}"`).join('\n');
    let proxyDefs = "proxies:\n";
    proxies.forEach(p => {
        proxyDefs += `  - name: "${p.name}"\n`;
        for (const [key, value] of Object.entries(p)) {
            if (key !== 'name' && value !== undefined && value !== null && value !== '') {
                 if (typeof value === 'object') {
                    proxyDefs += `    ${key}:\n`;
                    for (const [k, v] of Object.entries(value)) {
                         proxyDefs += `      ${k}: "${v}"\n`;
                    }
                } else {
                    proxyDefs += `    ${key}: ${JSON.stringify(value)}\n`;
                }
            }
        }
    });

    return `${proxyDefs}
proxy-groups:
  - name: "V2V-Auto"
    type: url-test
    proxies:
${proxyNames.replace(/- "/g, '- ').replace(/"/g, '')}
    url: '[http://www.gstatic.com/generate_204](http://www.gstatic.com/generate_204)'
    interval: 300
  - name: "V2V-Select"
    type: select
    proxies:
      - "V2V-Auto"
${proxyNames.replace(/- "/g, '- ').replace(/"/g, '')}
rules:
  - MATCH,V2V-Select
`;
}


function parseProxyForClash(configStr) {
    try {
        let name = decodeURIComponent(configStr.split('#').pop() || `V2V-${Date.now().toString().slice(-4)}`);
        name = name.replace(/[:"']/g, '').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/gu, '').trim();
        
        const base = { name, 'skip-cert-verify': true };
        const protocol = configStr.split('://')[0];

        if (protocol === 'vmess') {
            const d = JSON.parse(atob(configStr.substring(8)));
            const proxy = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
            if (d.net === 'ws') proxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add } };
            return proxy;
        }
        
        const url = new URL(configStr);
        const params = new URLSearchParams(url.search);

        if (protocol === 'vless') {
             const proxy = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni') };
             if (params.get('type') === 'ws') proxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname } };
             return proxy;
        }

        if (protocol === 'trojan') {
            if(!url.username) return null;
            return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
        }

        if (protocol === 'ss') {
            const [cipher, password] = atob(url.username).split(':');
            return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher, password };
        }
    } catch { return null; }
    return null;
}

const corsHeaders = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Cache-Control' });
const jsonCorsHeaders = () => ({ ...corsHeaders(), 'Content-Type': 'application/json' });
const textCorsHeaders = () => ({ ...corsHeaders(), 'Content-Type': 'text/plain;charset=utf-8' });
const yamlCorsHeaders = () => ({ ...corsHeaders(), 'Content-Type': 'text/yaml;charset=utf-8', 'Content-Disposition': 'attachment; filename="v2v_clash.yml"' });


