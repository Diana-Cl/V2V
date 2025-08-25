import net from 'net';

/**
 * Handles the TCP ping request.
 * This serverless function is designed to be called by the scraper and the frontend.
 */
export default function handler(req, res) {
    // Set CORS and Cache-Control headers for security and reliability
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow requests from any origin
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

    // Validate input
    if (!host || !port || typeof port !== 'number') {
        return res.status(400).json({ message: 'A valid host and port number are required' });
    }

    const startTime = new Date();
    const socket = new net.Socket();

    // Set a timeout for the connection attempt
    socket.setTimeout(5000); // 5 seconds

    socket.on('connect', () => {
        const endTime = new Date();
        const ping = endTime - startTime;
        socket.destroy();

        // === FIX: Handle unrealistic pings (like 0ms) as errors ===
        // A ping below 5ms is highly unlikely and usually indicates an error.
        if (ping < 5) {
            res.status(200).json({ host, port, ping: 9998, error: `Unrealistic ping detected: ${ping}ms` });
        } else {
            res.status(200).json({ host, port, ping });
        }
    });

    socket.on('error', (err) => {
        socket.destroy();
        // Still return 200 OK so the scraper can process it as a 'failed' ping
        res.status(200).json({ host, port, ping: 9999, error: err.message });
    });

    socket.on('timeout', () => {
        socket.destroy();
        // Still return 200 OK for timeouts
        res.status(200).json({ host, port, ping: 9999, error: 'Connection Timeout' });
    });

    // Initiate the connection
    socket.connect(port, host);
}
