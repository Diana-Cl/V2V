import net from 'net';

/**
 * Handles the TCP ping request.
 * This serverless function is designed to be called by the scraper and the frontend.
 */
export default function handler(req, res) {
    // Set CORS and Cache-Control headers for security and reliability
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Handle pre-flight requests for CORS
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    // Ensure only POST requests are processed
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests are allowed' });
    }

    const { host, port } = req.body;

    // Improved validation - accept both string and number ports
    if (!host || !port) {
        return res.status(400).json({ message: 'Both host and port are required' });
    }

    // Convert port to number and validate
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ message: 'Port must be a valid number between 1-65535' });
    }

    // Validate host format (basic check)
    if (typeof host !== 'string' || host.trim().length === 0) {
        return res.status(400).json({ message: 'Host must be a valid string' });
    }

    const cleanHost = host.trim();
    const startTime = Date.now();
    const socket = new net.Socket();

    // Increase timeout for better compatibility
    socket.setTimeout(10000); // 10 seconds

    socket.on('connect', () => {
        const endTime = Date.now();
        const ping = endTime - startTime;
        socket.destroy();

        // Return the ping result - remove the unrealistic ping check as it can be valid for local servers
        res.status(200).json({ host: cleanHost, port: portNum, ping });
    });

    socket.on('error', (err) => {
        socket.destroy();
        // Return high ping value for failed connections
        res.status(200).json({ 
            host: cleanHost, 
            port: portNum, 
            ping: 9999, 
            error: err.message 
        });
    });

    socket.on('timeout', () => {
        socket.destroy();
        // Return high ping value for timeouts
        res.status(200).json({ 
            host: cleanHost, 
            port: portNum, 
            ping: 9999, 
            error: 'Connection timeout' 
        });
    });

    // Add connection error handling
    try {
        socket.connect(portNum, cleanHost);
    } catch (err) {
        socket.destroy();
        res.status(200).json({ 
            host: cleanHost, 
            port: portNum, 
            ping: 9999, 
            error: `Connection failed: ${err.message}` 
        });
    }
}