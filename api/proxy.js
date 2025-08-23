import net from 'net';

export default function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests are allowed' });
    }

    const { host, port } = req.body;

    if (!host || !port) {
        return res.status(400).json({ message: 'Host and port are required' });
    }

    const startTime = new Date();
    const socket = new net.Socket();

    socket.setTimeout(4000);

    socket.on('connect', () => {
        const endTime = new Date();
        const ping = endTime - startTime;
        socket.destroy();
        res.status(200).json({ host, port, ping });
    });

    socket.on('error', (err) => {
        socket.destroy();
        res.status(200).json({ host, port, ping: 9999, error: err.message });
    });

    socket.on('timeout', () => {
        socket.destroy();
        res.status(200).json({ host, port, ping: 9999, error: 'Timeout' });
    });

    socket.connect(port, host);
}
