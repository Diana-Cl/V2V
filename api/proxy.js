// File: /api/proxy.js

import net from 'net';

/**
 * Parses various config URI formats to extract host and port.
 * @param {string} configStr The configuration string (vless://, vmess://, etc.)
 * @returns {{host: string, port: number} | null}
 */
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
        
        // Handle simple host:port format
        if (configStr.includes(':') && !configStr.startsWith('http')) {
            const [host, port] = configStr.split(':');
            if (host && port && !isNaN(port)) {
                return { host: host.trim(), port: parseInt(port, 10) };
            }
        }
        
        return null;
    } catch (e) {
        console.error(`Failed to parse config: ${configStr.substring(0, 30)}...`, e.message);
        return null;
    }
}

/**
 * Measures the latency of a TCP connection.
 * @param {string} host The server address.
 * @param {number} port The server port.
 * @param {number} timeout Timeout in milliseconds.
 * @returns {Promise<number>} The latency in milliseconds.
 */
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
            reject(new Error(`Connection error: ${err.message}`));
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error(`Connection timed out after ${timeout}ms`));
        });

        try {
            socket.connect(port, host);
        } catch (err) {
            socket.destroy();
            reject(new Error(`Invalid host or port: ${err.message}`));
        }
    });
}

/**
 * Tries to get a TCP ping multiple times for reliability.
 * @param {string} host The server address.
 * @param {number} port The server port.
 * @returns {Promise<number>} The latency in milliseconds.
 */
async function pingWithRetries(host, port) {
    const retries = 3;
    const timeout = 8000;
    const interval = 500;

    for (let i = 0; i < retries; i++) {
        try {
            const latency = await getTcpPing(host, port, timeout);
            return latency;
        } catch (error) {
            console.log(`Attempt ${i + 1}/${retries} failed for ${host}:${port}. Error: ${error.message}`);
            if (i === retries - 1) {
                throw error;
            }
            await new Promise(res => setTimeout(res, interval));
        }
    }
}

/**
 * Validates if host and port are valid
 * @param {string} host 
 * @param {number} port 
 * @returns {boolean}
 */
function isValidHostPort(host, port) {
    if (!host || typeof host !== 'string' || host.trim() === '') {
        return false;
    }
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
        return false;
    }
    return true;
}

// Main serverless function handler
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false,
            message: 'Only POST requests are allowed',
            ping: 9999 
        });
    }

    let body;
    try {
        body = req.body;
        if (typeof body === 'string') {
            body = JSON.parse(body);
        }
    } catch (e) {
        return res.status(400).json({
            success: false,
            message: 'Invalid JSON in request body',
            ping: 9999
        });
    }

    let host, port;

    // Parse from config string
    if (body.config && typeof body.config === 'string') {
        const serverInfo = parseConfig(body.config);
        if (serverInfo) {
            host = serverInfo.host;
            port = serverInfo.port;
        }
    }
    // Parse from direct host/port
    else if (body.host && body.port) {
        host = body.host;
        port = parseInt(body.port, 10);
    }

    // Validate input
    if (!isValidHostPort(host, port)) {
        return res.status(400).json({
            success: false,
            ping: 9999,
            message: 'Invalid input. Provide either a valid "config" string or valid "host" and "port" (1-65535).'
        });
    }

    try {
        console.log(`Testing connection to ${host}:${port}`);
        const latency = await pingWithRetries(host, port);
        
        res.status(200).json({ 
            success: true,
            ping: latency,
            host: host,
            port: port,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`Ping failed for ${host}:${port}:`, error.message);
        res.status(200).json({ 
            success: false,
            ping: 9999, 
            host: host,
            port: port,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}