const net = require('net');

// Helper function to parse config URL
function parseConfig(config) {
    try {
        const url = new URL(config);
        return { hostname: url.hostname, port: url.port };
    } catch (e) {
        const parts = config.split('@');
        if (parts.length > 1) {
            const hostPort = parts[1].split('#')[0].split('?')[0];
            const [hostname, port] = hostPort.split(':');
            return { hostname, port };
        }
        return { hostname: null, port: null };
    }
}

// Helper function for TCP ping
function testTcpConnection(config) {
    return new Promise((resolve) => {
        const { hostname, port } = parseConfig(config);
        if (!hostname || !port) {
            resolve({ config, ping: null });
            return;
        }

        const socket = new net.Socket();
        const startTime = Date.now();

        socket.setTimeout(2500); // 2.5 second timeout for connection

        socket.on('connect', () => {
            const latency = Date.now() - startTime;
            socket.destroy();
            resolve({ config, ping: latency });
        });

        socket.on('error', () => {
            socket.destroy();
            resolve({ config, ping: null });
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({ config, ping: null });
        });

        socket.connect(port, hostname);
    });
}

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const { configs } = req.body;
        if (!Array.isArray(configs)) {
            return res.status(400).json({ error: 'Invalid request: "configs" must be an array.' });
        }

        const pingPromises = configs.map(config => testTcpConnection(config));
        const finalPings = await Promise.all(pingPromises);

        res.status(200).json(finalPings);

    } catch (e) {
        res.status(500).json({ error: 'Error processing request.' });
    }
}
