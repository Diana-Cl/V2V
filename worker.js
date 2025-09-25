// worker.js

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

function generateCorsHeaders(requestOrigin) {
    if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
        return {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version',
            'Vary': 'Origin',
        };
    }
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
}

function jsonResponse(data, status = 200, corsHeaders) {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders } });
}

function textResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

function yamlResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'application/x-yaml; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

function generateClashYaml(configs, uuid) {
    // This function needs to be completed with your actual logic
    // Placeholder implementation to show the structure
    const proxies = configs.map(url => ({
        name: `v2v-${url.split('://')[0]}-${Math.random().toString(36).substring(2, 7)}`,
        type: url.split('://')[0],
        server: "example.com",
        port: 443,
        uuid: "your-uuid-here"
    }));
    const payload = {
        proxies: proxies,
        "proxy-groups": [{
            name: "v2v-auto",
            type: "url-test",
            url: "http://www.gstatic.com/generate_204",
            interval: 300,
            proxies: proxies.map(p => p.name)
        }],
        rules: ["MATCH,v2v-auto"]
    };
    return YAML.dump(payload);
}

function generateSingboxJson(configs, uuid) {
    // This function needs to be completed with your actual logic
    // Placeholder implementation
    const outbounds = configs.map(url => ({
        tag: `v2v-${url.split('://')[0]}-${Math.random().toString(36).substring(2, 7)}`,
        type: url.split('://')[0],
        server: "example.com",
        port: 443
    }));
    return JSON.stringify({ outbounds: outbounds, router: { rules: [] } }, null, 2);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port, tls, sni } = await request.json();
                if (!host || !port) return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                try {
                    const startTime = Date.now();
                    const socket = connect({ hostname: host, port: parseInt(port) });
                    if (tls) {
                        const tlsSocket = await socket.startTls({ servername: sni || host });
                        await tlsSocket.close();
                    } else {
                        const writer = socket.writable.getWriter();
                        await writer.close();
                    }
                    return jsonResponse({ latency: Date.now() - startTime, status: 'Live' }, 200, corsHeaders);
                } catch (e) {
                    return jsonResponse({ latency: null, status: 'Dead', error: e.message }, 200, corsHeaders);
                }
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) return jsonResponse({ error: '`configs` array is required.' }, 400, corsHeaders);
                const userUuid = clientUuid || uuidv4();
                await env.v2v_kv.put(`sub:${userUuid}`, JSON.stringify(configs), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                return jsonResponse({ uuid: userUuid, subscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                const storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                if (!storedData) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                if (format === 'raw') return textResponse(btoa(storedData.join('\n')), 200, `v2v-${uuid}.txt`, corsHeaders);
                if (format === 'clash') {
                    const content = generateClashYaml(storedData, uuid);
                    return content ? yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders) : textResponse('Failed to generate Clash config.', 500, null, corsHeaders);
                }
                if (format === 'singbox') {
                    const content = generateSingboxJson(storedData, uuid);
                    return content ? jsonResponse(JSON.parse(content), 200, corsHeaders) : textResponse('Failed to generate Sing-box config.', 500, null, corsHeaders);
                }
            }
            
            return textResponse('v2v Worker is running. Use /ping, /create-personal-sub, or /sub/{format}/{uuid} endpoints.', 200, null, corsHeaders);
        } catch (err) {
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};

