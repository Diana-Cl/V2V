export default {
  async fetch(request, env, ctx) {
    // Set CORS headers to allow requests from any origin
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Ensure the request method is POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    try {
      // Parse the JSON body to get the list of configs
      const { configs } = await request.json();
      if (!Array.isArray(configs)) {
        return new Response('Invalid request body: "configs" must be an array.', { status: 400, headers: corsHeaders });
      }

      // Create an array of promises to test all configs in parallel
      const pingPromises = configs.map(config => testTcpConnection(config));
      
      // Wait for all tests to complete, whether they succeed or fail
      const results = await Promise.allSettled(pingPromises);

      // Format the results into the required structure
      const finalPings = results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return { config: configs[index], ping: result.value };
        } else {
          // If a ping failed, return null for its value
          return { config: configs[index], ping: null };
        }
      });

      // Return the final results as a JSON string
      return new Response(JSON.stringify(finalPings), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (e) {
      // Handle any unexpected errors during processing
      return new Response('Error processing request: ' + e.message, { status: 500, headers: corsHeaders });
    }
  },
};

/**
 * Parses a config string to extract hostname and port, then measures TCP connection latency.
 * @param {string} config - The configuration string (e.g., vless://...).
 * @returns {Promise<number|null>} - The latency in milliseconds, or null if connection fails.
 */
async function testTcpConnection(config) {
  let hostname, port;

  // Robustly parse the hostname and port from various config formats
  try {
    const url = new URL(config);
    hostname = url.hostname;
    port = url.port;
  } catch (e) {
    // Fallback for non-standard URIs that can't be parsed by new URL()
    const parts = config.split('@');
    if (parts.length > 1) {
        const hostPort = parts[1].split('#')[0].split('?')[0];
        [hostname, port] = hostPort.split(':');
    } else {
        return null; // Cannot parse config
    }
  }

  if (!hostname || !port) return null;

  const startTime = Date.now();
  try {
    // `connect` is the Cloudflare Workers API for opening a raw TCP socket
    const socket = await connect({ hostname, port });
    const latency = Date.now() - startTime;
    
    // It's crucial to close the socket to release resources
    const writer = socket.writable.getWriter();
    await writer.close();
    
    return latency;
  } catch (e) {
    // This will catch connection timeouts, DNS errors, etc.
    return null;
  }
}
