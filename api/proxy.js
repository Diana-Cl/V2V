import { Server } from 'node:net';

const PING_TIMEOUT = 2000; // 2 seconds

export default async function handler(request, response) {
  // Allow CORS for all origins
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST', 'GET', 'OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(204).send('');
  }
  
  // --- START OF NEW DEBUGGING CODE ---
  // If a debug query is present, test a known-good host
  if (request.query.debug === 'true') {
      console.log('Running in debug mode...');
      return testConnection({ host: '1.1.1.1', port: 443 }, response);
  }
  // --- END OF NEW DEBUGGING CODE ---

  if (request.method !== 'POST') {
      return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = request.body;
    if (!body.host || !body.port) {
      return response.status(400).json({ error: 'Missing "host" or "port".' });
    }
    return testConnection(body, response);
  } catch (e) {
    return response.status(400).json({ error: 'Invalid JSON body.' });
  }
}

// Helper function to perform the connection test
function testConnection({ host, port }, response) {
  const socket = new Server();
  const startTime = process.hrtime.bigint();

  const cleanup = () => {
    if (!socket.destroyed) {
      socket.destroy();
    }
  };

  const connectPromise = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.connect({ host, port }, () => {
      const endTime = process.hrtime.bigint();
      const latency = Math.round(Number(endTime - startTime) / 1_000_000);
      resolve({ ping: latency });
    });
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), PING_TIMEOUT);
  });

  Promise.race([connectPromise, timeoutPromise])
    .then(result => {
      cleanup();
      return response.status(200).json(result);
    })
    .catch(error => {
      cleanup();
      return response.status(500).json({ error: error.message, ping: 9999 });
    });
}
