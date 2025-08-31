/**
 * V2V Cloudflare Worker
 * - @version 2.1.0
 */
const PRIMARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main'; // تغییر به ریشه برای دسترسی به فایل تست
const CACHE_TTL = 300; // 5 دقیقه

// فایل کوچک برای تست سرعت دانلود (باید در ریشه ریپازیتوری شما وجود داشته باشد)
const DOWNLOAD_TEST_FILE = '/dl-test.bin'; 

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        let pathname = url.pathname;
        const cache = caches.default;

        // اندپوینت تست پینگ و جیتر
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
             if (response) return response;

             response = await fetch(`${PRIMARY_ORIGIN}${DOWNLOAD_TEST_FILE}`);
             if (response.ok) {
                 const newHeaders = new Headers(response.headers);
                 newHeaders.set('Access-Control-Allow-Origin', '*');
                 let resClone = new Response(response.clone().body, { status: response.status, headers: newHeaders });
                 ctx.waitUntil(cache.put(cacheKey, resClone));
             }
             return response;
        }

        // منطق اصلی برای ارائه فایل‌های کانفیگ (حالا از ریشه)
        const cacheKey = new Request(url.toString(), request);
        let response = await cache.match(cacheKey);
        if (response) {
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            return new Response(response.body, { status: response.status, headers: newHeaders });
        }

        // حذف شد: فایل‌های کانفیگ و ورژن حالا مستقیماً در ریشه قرار دارند
        // if (pathname.startsWith('/all_live_configs_') || pathname === '/cache_version.txt') {
        //     pathname = `/configs${pathname}`;
        // }
        
        response = await fetch(`${PRIMARY_ORIGIN}${pathname}`);

        if (response && response.ok) {
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            newHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            let resClone = new Response(response.clone().body, { status: response.status, headers: newHeaders });
            ctx.waitUntil(cache.put(cacheKey, resClone));
            return response;
        }

        return new Response('Not Found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
};