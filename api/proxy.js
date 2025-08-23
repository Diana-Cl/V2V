import net from 'node:net';

const PING_TIMEOUT = 2500; // 2.5 seconds timeout

// This is the core testing function, now corrected and promise-based.
function testConnection({ host, port }) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const startTime = process.hrtime.bigint();

        // Set a timeout for the entire operation
        const timeoutId = setTimeout(() => {
            socket.destroy();
            reject(new Error('Timeout'));
        }, PING_TIMEOUT);

        socket.on('error', (err) => {
            clearTimeout(timeoutId);
            socket.destroy();
            reject(err);
        });

        socket.connect({ host, port }, () => {
            clearTimeout(timeoutId);
            const endTime = process.hrtime.bigint();
            const latency = Math.round(Number(endTime - startTime) / 1_000_000);
            socket.end();
            resolve({ ping: latency });
        });
    });
}

// This is the main Vercel handler
export default async function handler(request, response) {
    // Set CORS headers for all responses
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
        return response.status(204).send('');
    }

    let target;
    // Check for debug mode first
    if (request.query.debug === 'true') {
        target = { host: '1.1.1.1', port: 443 };
    } else if (request.method === 'POST') {
        try {
            const body = request.body;
            if (!body.host || !body.port) {
                return response.status(400).json({ error: 'Missing "host" or "port".' });
            }
            target = body;
        } catch (e) {
            return response.status(400).json({ error: 'Invalid JSON body.' });
        }
    } else {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const result = await testConnection(target);
        return response.status(200).json(result);
    } catch (error) {
        return response.status(500).json({ error: error.message, ping: 9999 });
    }
}
