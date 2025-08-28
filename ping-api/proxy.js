```javascript
// File: ping-api/proxy.js
const net = require('net');

module.exports = (req, res) => {
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

    const { host, port } = req.body;
    if (!host || !port) {
        return res.status(400).json({ message: 'Host and port are required' });
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ message: 'Invalid port number' });
    }

    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(10000);

    socket.on('connect', () => {
        const ping = Date.now() - startTime;
        socket.destroy();
        res.status(200).json({ host, port: portNum, ping });
    });

    socket.on('error', (err) => {
        socket.destroy();
        res.status(200).json({ host, port: portNum, ping: 9999, error: err.message });
    });

    socket.on('timeout', () => {
        socket.destroy();
        res.status(200).json({ host, port: portNum, ping: 9999, error: 'Connection timeout' });
    });

    socket.connect(portNum, host);
};
```