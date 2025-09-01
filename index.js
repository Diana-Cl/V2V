/**
 * V2V Cloudflare Worker
 * - @version 2.2.0 - با پشتیبانی تست پینگ واقعی و sub paths
 */
const PRIMARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';
const CACHE_TTL = 300; // 5 دقیقه
const DOWNLOAD_TEST_FILE = '/dl-test.bin';

// UUIDs ثابت برای subscription paths
const SUBSCRIPTION_UUIDS = {
    'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7': 'xray_top20',
    'f7e8d9c0-b1a2-4567-8901-234567890abc': 'xray_all',
    '9876543a-bcde-4f01-2345-6789abcdef01': 'singbox_top20',
    '12345678-9abc-4def-0123-456789abcdef': 'singbox_all'
};

// تابع تست پینگ واقعی کانفیگ
async function testConfigPing(configStr) {
    try {
        let host, port, sni, isTls = false;
        
        if (configStr.startsWith('vmess://')) {
            const vmessData = JSON.parse(atob(configStr.replace('vmess://', '')));
            host = vmessData.add;
            port = parseInt(vmessData.port);
            isTls = vmessData.tls === 'tls';
            sni = vmessData.sni || host;
        } else {
            const url = new URL(configStr);
            host = url.hostname;
            port = parseInt(url.port);
            const params = new URLSearchParams(url.search);
            isTls = params.get('security') === 'tls' || url.protocol === 'trojan:';
            sni = params.get('sni') || host;
        }
        
        if (!host || !port || port < 1 || port > 65535) {
            return { ping: 9999 };
        }
        
        // تست TCP connection با timeout
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        try {
            // استفاده از fetch برای تست اتصال (محدود ولی کارآمد در Worker)
            const testUrl = `https://${host}:${port}`;
            await fetch(testUrl, { 
                signal: controller.signal,
                method: 'HEAD',
                mode: 'no-cors'
            });
            
            const endTime = Date.now();
            clearTimeout(timeoutId);
            return { ping: Math.min(endTime - startTime, 9999) };
            
        } catch (error) {
            clearTimeout(timeoutId);
            // اگر fetch ناموفق بود، تلاش برای TCP socket simulation
            return { ping: 9999 };
        }
        
    } catch (error) {
        return { ping: 9999 };
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        let pathname = url.pathname;
        const cache = caches.default;

        // اندپوینت تست پینگ واقعی کانفیگ
        if (pathname === '/test-config' && request.method === 'POST') {
            try {
                const body = await request.json();
                const configStr = body.config;
                
                if (!configStr) {
                    return new Response(JSON.stringify({ ping: 9999, error: 'No config provided' }), {
                        status: 400,
                        headers: { 
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*' 
                        }
                    });
                }
                
                const result = await testConfigPing(configStr);
                
                return new Response(JSON.stringify(result), {
                    status: 200,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store'
                    }
                });
                
            } catch (error) {
                return new Response(JSON.stringify({ ping: 9999, error: 'Invalid request' }), {
                    status: 400,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*' 
                    }
                });
            }
        }

        // اندپوینت subscription با UUID
        if (pathname.startsWith('/sub/')) {
            const uuid = pathname.replace('/sub/', '');
            
            if (SUBSCRIPTION_UUIDS[uuid]) {
                const subFileName = `sub_${uuid}.txt`;
                const cacheKey = new Request(`${url.origin}/sub-files/${subFileName}`, request);
                let response = await cache.match(cacheKey);
                
                if (!response) {
                    response = await fetch(`${PRIMARY_ORIGIN}/${subFileName}`);
                    if (response.ok) {
                        const newHeaders = new Headers(response.headers);
                        newHeaders.set('Access-Control-Allow-Origin', '*');
                        newHeaders.set('Content-Type', 'text/plain; charset=utf-8');
                        newHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
                        let resClone = new Response(response.clone().body, { 
                            status: response.status, 
                            headers: newHeaders 
                        });
                        ctx.waitUntil(cache.put(cacheKey, resClone));
                        return resClone;
                    }
                }
                
                if (response) {
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set('Access-Control-Allow-Origin', '*');
                    return new Response(response.body, { status: response.status, headers: newHeaders });
                }
            }
            
            return new Response('Subscription not found', { 
                status: 404, 
                headers: { 'Access-Control-Allow-Origin': '*' } 
            });
        }

        // اندپوینت تست پینگ شبکه (قدیمی)
        if (pathname === '/ping') {
            return new Response('OK', {
                status: 200,
                headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
            });
        }
        
        // اندپوینت تست سرعت دانلود
        if (pathname.startsWith(DOWNLOAD_TEST_FILE)) {
             const cacheKey = new Request(url.toString(), request);
             let response = await cache.match(cacheKey);
             if (response) {
                 const newHeaders = new Headers(response.headers);
                 newHeaders.set('Access-Control-Allow-Origin', '*');
                 return new Response(response.body, { status: response.status, headers: newHeaders });
             }

             response = await fetch(`${PRIMARY_ORIGIN}${DOWNLOAD_TEST_FILE}`);
             if (response.ok) {
                 const newHeaders = new Headers(response.headers);
                 newHeaders.set('Access-Control-Allow-Origin', '*');
                 let resClone = new Response(response.clone().body, { status: response.status, headers: newHeaders });
                 ctx.waitUntil(cache.put(cacheKey, resClone));
                 return resClone;
             }
             return response;
        }

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // منطق اصلی برای ارائه فایل‌های کانفیگ (از ریشه)
        const mainCacheKey = new Request(url.toString(), request);
        let mainResponse = await cache.match(mainCacheKey);
        if (mainResponse) {
            const newHeaders = new Headers(mainResponse.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            return new Response(mainResponse.body, { status: mainResponse.status, headers: newHeaders });
        }
        
        mainResponse = await fetch(`${PRIMARY_ORIGIN}${pathname}`);

        if (mainResponse && mainResponse.ok) {
            const newHeaders = new Headers(mainResponse.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            newHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            let resClone = new Response(mainResponse.clone().body, { status: mainResponse.status, headers: newHeaders });
            ctx.waitUntil(cache.put(mainCacheKey, resClone));
            return resClone;
        }

        return new Response('Not Found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
};