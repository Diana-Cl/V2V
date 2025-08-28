const net = require('net');
const http = require('http');

// این تابع پینگ را انجام می‌دهد
function checkPing(host, port, callback) {
    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(10000);

    socket.on('connect', () => {
        const ping = Date.now() - startTime;
        socket.destroy();
        callback(null, { host, port, ping });
    });
    socket.on('error', (err) => {
        socket.destroy();
        callback(err, { host, port, ping: 9999, error: err.message });
    });
    socket.on('timeout', () => {
        socket.destroy();
        callback(new Error('Timeout'), { host, port, ping: 9999, error: 'Connection timeout' });
    });
    socket.connect(port, host);
}

// این بخش سرور را می‌سازد و به درخواست‌ها پاسخ می‌دهد
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const { host, port } = JSON.parse(body);
                if (!host || !port) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Host and port are required' }));
                    return;
                }
                checkPing(host, port, (err, result) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'Invalid JSON body' }));
            }
        });
    } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Only POST requests are allowed' }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ping server listening on port ${PORT}`);
});
