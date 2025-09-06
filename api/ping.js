const net = require('net');

function parseConfig(config) {
    try {
        if (config.startsWith('vmess://')) {
            const b64 = config.replace("vmess://", "");
            const decoded = Buffer.from(b64, 'base64').toString('utf-8');
            const data = JSON.parse(decoded);
            return { hostname: data.add, port: data.port };
        }
        const url = new URL(config);
        return { hostname: url.hostname, port: url.port };
    } catch (e) {
        return { hostname: null, port: null };
    }
}

function testTcpConnection(config) {
    return new Promise((resolve) => {
        const { hostname, port } = parseConfig(config);
        if (!hostname || !port) return resolve({ config, ping: null });
        const socket = new net.Socket();
        socket.setTimeout(2500);
        const startTime = Date.now();
        socket.on('connect', () => {
            socket.destroy();
            resolve({ config, ping: Date.now() - startTime });
        });
        socket.on('error', () => { socket.destroy(); resolve({ config, ping: null }); });
        socket.on('timeout', () => { socket.destroy(); resolve({ config, ping: null }); });
        socket.connect(parseInt(port), hostname);
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    try {
        const { configs } = req.body;
        if (!Array.isArray(configs)) return res.status(400).json({ error: 'Invalid body' });
        const finalPings = await Promise.all(configs.map(testTcpConnection));
        res.status(200).json(finalPings);
    } catch (e) {
        res.status(500).json({ error: 'Error processing request.' });
    }
}
