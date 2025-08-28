// File: /api/proxy.js

import net from 'net';

/**
 * Parses various config URI formats to extract host and port.
 * @param {string} configStr The configuration string (vless://, vmess://, etc.)
 * @returns {{host: string, port: number} | null}
 */
function parseConfig(configStr) {
    try {
        // Handle vmess:// which is Base64 encoded JSON
        if (configStr.startsWith('vmess://')) {
            const jsonStr = Buffer.from(configStr.substring(8), 'base64').toString('utf-8');
            const decoded = JSON.parse(jsonStr);
            return { host: decoded.add, port: parseInt(decoded.port, 10) };
        }
        
        // Handle URL-based formats like vless, trojan, ss
        const url = new URL(configStr);
        if (url.hostname && url.port) {
            return { host: url.hostname, port: parseInt(url.port, 10) };
        }
        return null;
    } catch (e) {
        console.error(`Failed to parse config: ${configStr.substring(0, 30)}...`);
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
function getTcpPing(host, port, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const startTime = process.hrtime.bigint();
        const socket = new net.Socket();

        socket.setTimeout(timeout);

        socket.on('connect', () => {
            const endTime = process.hrtime.bigint();
            // Convert nanoseconds to milliseconds
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
            reject(new Error('Connection timed out'));
        });

        socket.connect(port, host);
    });
}

// Main serverless function handler
export default async function handler(req, res) {
    // Set CORS and Cache-Control headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests are allowed' });
    }

    const { config } = req.body;

    if (!config || typeof config !== 'string') {
        return res.status(400).json({ message: 'Config string is required.' });
    }

    const serverInfo = parseConfig(config);

    if (!serverInfo || !serverInfo.host || !serverInfo.port) {
        return res.status(400).json({ 
            ping: 9999, 
            error: 'Could not parse host/port from config' 
        });
    }

    try {
        const latency = await getTcpPing(serverInfo.host, serverInfo.port);
        res.status(200).json({ ping: latency });
    } catch (error) {
        res.status(200).json({ 
            ping: 9999, 
            error: error.message 
        });
    }
}
