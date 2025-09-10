/**
 * V2V Project - Advanced TCP Latency Testing Worker
 * This worker receives a list of configs and returns their TCP handshake latency.
 * It requires the `nodejs_compat` flag to be enabled in wrangler.toml.
 */

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }

        if (request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
        }

        try {
            const { configs } = await request.json();
            if (!Array.isArray(configs)) {
                return new Response('Request body must be an array of configs.', { status: 400, headers: corsHeaders() });
            }

            const results = await Promise.all(
                configs.map(config => testTcpLatency(config))
            );

            return new Response(JSON.stringify(results), {
                headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
            });

        } catch (e) {
            return new Response('Invalid JSON in request body.', { status: 400, headers: corsHeaders() });
        }
    }
};

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
        // Obfuscate detailed error messages for security
        const errorMessage = err.message.includes('ECONNREFUSED') ? 'Connection refused' : 'Connection failed';
        return { config: configStr, ping: null, error: errorMessage };
    }
}

function parseConfig(configStr) {
    try {
        if (configStr.startsWith('vmess://')) {
            const decoded = atob(configStr.replace("vmess://", ""));
            const data = JSON.parse(decoded);
            return { hostname: data.add, port: parseInt(data.port) };
        }
        const url = new URL(configStr); // Works for vless, trojan, ss
        return { hostname: url.hostname, port: parseInt(url.port) };
    } catch (e) {
        return { hostname: null, port: null };
    }
}

const corsHeaders = () => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
});
