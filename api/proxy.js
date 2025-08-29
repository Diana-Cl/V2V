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
function getTcpPing(host, port, timeout) { // Timeout is now passed directly
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
            reject(new Error(`Connection timed out after ${timeout}ms`));
        });

        socket.connect(port, host);
    });
}

// --- UPGRADE: تابع جدید برای مدیریت تلاش‌های مجدد ---
/**
 * Tries to get a TCP ping multiple times for reliability.
 * @param {string} host The server address.
 * @param {number} port The server port.
 * @returns {Promise<number>} The latency in milliseconds.
 */
async function pingWithRetries(host, port) {
    const retries = 3; // تعداد کل تلاش‌ها
    const timeout = 8000; // ۸ ثانیه زمان انتظار برای هر تلاش
    const interval = 500; // ۵۰۰ میلی‌ثانیه فاصله بین هر تلاش ناموفق

    for (let i = 0; i < retries; i++) {
        try {
            // اگر موفقیت‌آمیز بود، نتیجه را برمی‌گرداند و از حلقه خارج می‌شود
            const latency = await getTcpPing(host, port, timeout);
            return latency;
        } catch (error) {
            console.log(`Attempt ${i + 1} failed for ${host}:${port}. Error: ${error.message}`);
            // اگر این آخرین تلاش بود، خطا را به بیرون پرتاب می‌کند
            if (i === retries - 1) {
                throw error;
            }
            // قبل از تلاش بعدی، کمی صبر می‌کند
            await new Promise(res => setTimeout(res, interval));
        }
    }
}

// Main serverless function handler
export default async function handler(req, res) {
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

    const body = req.body;
    let host, port;

    if (body.config && typeof body.config === 'string') {
        const serverInfo = parseConfig(body.config);
        if (serverInfo) {
            host = serverInfo.host;
            port = serverInfo.port;
        }
    } else if (body.host && typeof body.host === 'string' && body.port && typeof body.port === 'number') {
        host = body.host;
        port = body.port;
    }

    if (!host || !port) {
        return res.status(400).json({
            ping: 9999,
            error: 'Invalid input. Provide either a "config" string or "host" and "port".'
        });
    }

    try {
        // --- UPGRADE: استفاده از تابع جدید با قابلیت تلاش مجدد ---
        const latency = await pingWithRetries(host, port);
        res.status(200).json({ ping: latency });
    } catch (error) {
        res.status(200).json({ 
            ping: 9999, 
            error: error.message 
        });
    }
}

