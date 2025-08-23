import { Server } from 'node:net';

// Configuration
const PING_TIMEOUT = 2000; // 2 seconds
const ALLOWED_PORTS = [
  80, 443, 8080, 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096
];

export default async function handler(request, response) {
  // Allow CORS for all origins
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(204).send('');
  }
  
  if (request.method !== 'POST') {
      return response.status(405).json({ error: 'Method Not Allowed' });
  }

  let host, port;
  try {
    const body = request.body;
    host = body.host;
    port = parseInt(body.port, 10);

    if (!host || !port) {
      return response.status(400).json({ error: 'Missing "host" or "port" in request body.' });
    }

    if (!ALLOWED_PORTS.includes(port)) {
      return response.status(403).json({ error: 'Port not allowed.' });
    }

  } catch (e) {
    return response.status(400).json({ error: 'Invalid JSON body.' });
  }

  const socket = new Server();
  const startTime = process.hrtime.bigint();

  const connectPromise = new Promise((resolve, reject) => {
    socket.once('error', (err) => reject(err));
    
    socket.connect({ host, port }, () => {
      const endTime = process.hrtime.bigint();
      const latency = Math.round(Number(endTime - startTime) / 1_000_000); // Convert nanoseconds to milliseconds
      socket.end();
      resolve({ ping: latency });
    });
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timeout'));
      socket.destroy(); // Ensure socket is destroyed on timeout
    }, PING_TIMEOUT);
  });

  try {
    const result = await Promise.race([connectPromise, timeoutPromise]);
    return response.status(200).json(result);
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
}
