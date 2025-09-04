/**
 * V2V Cloudflare Worker - v3.0
 * Features:
 * 1. Caching Reverse Proxy for main config files.
 * 2. Automatic Fallback from primary (S3) to secondary (GitHub) source.
 * 3. Dynamic Subscription Generator for personalized, updateable links.
 * 4. Ping Endpoint for client-side latency tests.
 */

const PRIMARY_ORIGIN = 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.com';
const SECONDARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';
const CACHE_TTL = 300; // 5 minutes

const ALLOWED_PATHS = [
    '/all_live_configs.json',
    '/clash_subscription.yaml',
    '/cache_version.txt'
];

async function handleStaticAssets(request, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);

    let response = await cache.match(cacheKey);
    if (response) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('X-V2V-Cache-Status', 'HIT');
        return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    try {
        response = await fetch(`${PRIMARY_ORIGIN}${pathname}`);
        if (!response.ok) throw new Error('Primary origin failed');
    } catch (error) {
        console.error("Primary origin failed, falling back to secondary:", error.message);
        response = await fetch(`${SECONDARY_ORIGIN}${pathname}`);
    }

    if (response && response.ok) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
        newHeaders.set('X-V2V-Cache-Status', 'MISS');
        
        const responseToCache = new Response(response.clone().body, {
            status: response.status,
            headers: newHeaders,
        });
        ctx.waitUntil(cache.put(cacheKey, responseToCache));

        return new Response(response.body, { status: response.status, headers: newHeaders });
    }
    
    return new Response('Asset not found at any origin.', { status: 404 });
}

async function handleDynamicSubscription(request) {
    const url = new URL(request.url);
    const configsParam = url.searchParams.get('configs');

    if (!configsParam) {
        return new Response('"configs" parameter is missing.', { status: 400 });
    }

    try {
        let base64 = configsParam.replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - base64.length % 4) % 4);
        const decodedContent = atob(base64 + padding);
        const finalSubscription = btoa(decodedContent);

        return new Response(finalSubscription, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            },
        });
    } catch (e) {
        return new Response('Invalid Base64URL data in "configs" parameter.', { status: 400 });
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }
        
        if (pathname === '/ping') {
            return new Response('OK', {
                status: 200,
                headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
            });
        }

        if (pathname === '/sub') {
            return handleDynamicSubscription(request);
        }

        if (ALLOWED_PATHS.includes(pathname)) {
            return handleStaticAssets(request, ctx);
        }

        return new Response('Not Found.', {
            status: 404,
            headers: { 'Access-Control-Allow-Origin': '*' },
        });
    }
};
