const net = require('net');

function parseConfig(configStr) {
    try {
        if (configStr.startsWith('vmess://')) {
            const jsonStr = Buffer.from(configStr.substring(8), 'base64').toString('utf-8');
            const decoded = JSON.parse(jsonStr);
            return { host: decoded.add, port: parseInt(decoded.port, 10) };
        }
        
        if (configStr.startsWith('vless://') || configStr.startsWith('trojan://') || configStr.startsWith('ss://')) {
            const url = new URL(configStr);
            if (url.hostname && url.port) {
                return { host: url.hostname, port: parseInt(url.port, 10) };
            }
        }
        
        if (configStr.includes(':') && !configStr.startsWith('http')) {
            const [host, port] = configStr.split(':');
            if (host && port && !isNaN(port)) {
                return { host: host.trim(), port: parseInt(port, 10) };
            }
        }
        
        return null;
    } catch (e) {
        console.error(`Failed to parse config: ${configStr.substring(0, 30)}...`);
        return null;
    }
}

function getTcpPing(host, port, timeout) {
    return new Promise((resolve, reject) => {
        const startTime = process.hrtime.bigint();
        const socket = new net.Socket();

        socket.setTimeout(timeout);

        socket.on('connect', () => {
            const endTime = process.hrtime.bigint();
            const latency = Math.round(Number(endTime - startTime) / 1e6);
            socket.destroy();
            resolve(latency);
        });

        socket.on('error', (err) => {
            socket.destroy();
            reject(err);
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error(`Timeout after ${timeout}ms`));
        });

        socket.connect(port, host);
    });
}

async function pingWithRetries(host, port) {
    const retries = 3;
    const timeout = 8000;
    const interval = 500;

    for (let i = 0; i < retries; i++) {
        try {
            const latency = await getTcpPing(host, port, timeout);
            return latency;
        } catch (error) {
            if (i === retries - 1) {
                throw error;
            }
            await new Promise(res => setTimeout(res, interval));
        }
    }
}

function isValidHostPort(host, port) {
    if (!host || typeof host !== 'string' || host.trim() === '') {
        return false;
    }
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
        return false;
    }
    return true;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false,
            message: 'Only POST requests allowed',
            ping: 9999 
        });
    }

    let body;
    try {
        body = req.body || {};
        if (typeof body === 'string') {
            body = JSON.parse(body);
        }
    } catch (e) {
        return res.status(400).json({
            success: false,
            message: 'Invalid JSON',
            ping: 9999
        });
    }

    let host, port;

    if (body.config && typeof body.config === 'string') {
        const serverInfo = parseConfig(body.config);
        if (serverInfo) {
            host = serverInfo.host;
            port = serverInfo.port;
        }
    } else if (body.host && body.port) {
        host = body.host;
        port = parseInt(body.port, 10);
    }

    if (!isValidHostPort(host, port)) {
        return res.status(400).json({
            success: false,
            ping: 9999,
            message: 'Invalid host or port'
        });
    }

    try {
        const latency = await pingWithRetries(host, port);
        
        res.status(200).json({ 
            success: true,
            ping: latency,
            host: host,
            port: port
        });
    } catch (error) {
        res.status(200).json({ 
            success: false,
            ping: 9999, 
            host: host,
            port: port,
            error: error.message
        });
    }
};