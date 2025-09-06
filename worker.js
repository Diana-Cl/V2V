function parseConfig(config) {
    try {
        if (config.startsWith('vmess://')) {
            const decoded = atob(config.replace("vmess://", ""));
            const data = JSON.parse(decoded);
            return { hostname: data.add, port: data.port };
        }
        const url = new URL(config);
        return { hostname: url.hostname, port: url.port };
    } catch (e) {
        return { hostname: null, port: null };
    }
}

async function testTcpConnection(config) {
    const { hostname, port } = parseConfig(config);
    if (!hostname || !port) return null;
    try {
        const startTime = Date.now();
        const socket = await connect({ hostname, port });
        const latency = Date.now() - startTime;
        await socket.close();
        return latency;
    } catch (e) {
        return null;
    }
}

export default {
    async fetch(request) {
        const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
        if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        try {
            const { configs } = await request.json();
            if (!Array.isArray(configs)) return new Response('Invalid body', { status: 400 });
            const results = await Promise.allSettled(configs.map(testTcpConnection));
            const finalPings = results.map((r, i) => ({ config: configs[i], ping: r.status === 'fulfilled' ? r.value : null }));
            return new Response(JSON.stringify(finalPings), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e) {
            return new Response('Error: ' + e.message, { status: 500 });
        }
    },
};
