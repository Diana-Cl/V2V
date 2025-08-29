// File: /api/sub.js

const CLOUDFLARE_WORKER_URL = 'https://rapid-scene-1da6.mbrgh87.workers.dev/all_live_configs.json';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    try {
        // در Node.js 18+ fetch built-in است
        const originResponse = await fetch(CLOUDFLARE_WORKER_URL);

        if (!originResponse.ok) {
            return res.status(originResponse.status).json({
                message: `Worker error: ${originResponse.status}`
            });
        }

        const fileContent = await originResponse.text();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(fileContent);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(502).json({ 
            message: 'Bad Gateway: Worker unreachable' 
        });
    }
};