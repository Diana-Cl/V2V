import { connect } from 'cloudflare:sockets';

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }
        const url = new URL(request.url);

        if (url.pathname === '/tcp-bridge') {
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }
            return tcpBridge(request);
        }
        
        // Your other API endpoints like subscription handling can remain here
        // For simplicity, they are omitted in this snippet but should be kept in your final code.

        return new Response('V2V API Worker is operational.', { headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' } });
    },
};

async function tcpBridge(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const closeOrErrorHandler = () => {
        // Optional: Add cleanup logic if needed
    };

    server.addEventListener('message', async (event) => {
        try {
            const { host, port } = JSON.parse(event.data);
            if (typeof host !== 'string' || typeof port !== 'number' || port < 1 || port > 65535) {
                server.send(JSON.stringify({ error: 'Invalid host or port provided' }));
                return;
            }

            const startTime = Date.now();
            const socket = connect({ hostname: host, port: port });
            
            await socket.opened;
            const latency = Date.now() - startTime;
            
            server.send(JSON.stringify({ host, port, latency, status: 'success' }));
            
            await socket.close();

        } catch (e) {
            server.send(JSON.stringify({ error: e.message || 'Connection failed', status: 'failure' }));
        }
    });

    server.addEventListener('close', closeOrErrorHandler);
    server.addEventListener('error', closeOrErrorHandler);

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
