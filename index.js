/**
 * Welcome to your V2V Cloudflare Worker!
 *
 * This script acts as a smart, fast, and reliable reverse proxy for your config files.
 *
 * Main Features:
 * 1.  Intelligent Caching: It caches your main config files on Cloudflare's edge network.
 * 2.  Automatic Fallback: If the primary data source is down, it fetches from the secondary source.
 * 3.  CORS Handling: It adds the necessary headers for secure access.
 * 4.  Ping Endpoint: Provides a fast endpoint for client-side latency tests.
 *
 * - @version 2.0.0
 * - @author V2V Project with Gemini
 */

// --- CONFIGURATION ---
const PRIMARY_ORIGIN = 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.com';
const SECONDARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';
const CACHE_TTL = 300; // 5 دقیقه

const ALLOWED_PATHS = [
    '/all_live_configs.json',
    '/clash_subscription.yaml',
    '/cache_version.txt'
];
// --- END CONFIGURATION ---


export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const cache = caches.default;

        // --- START: بخش جدید برای تست پینگ ---
        // این بخش درخواست‌های ارسال شده به آدرس /ping را مدیریت می‌کند
        if (pathname === '/ping') {
            // برای تست پینگ، فقط یک پاسخ سریع و خالی با وضعیت OK برمی‌گردانیم
            // این همان "زنگ در" است که مرورگر کاربر زمان پاسخ آن را اندازه می‌گیرد
            return new Response('OK', {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store', // پاسخ پینگ هرگز نباید کش شود
                },
            });
        }
        // --- END: بخش جدید برای تست پینگ ---

        // اگر درخواست برای فایل‌های مجاز بود، منطق قبلی را اجرا کن
        if (ALLOWED_PATHS.includes(pathname)) {
            const cacheKey = new Request(url.toString(), request);

            // ۱. تلاش برای خواندن از کش
            let response = await cache.match(cacheKey);
            if (response) {
                const newHeaders = new Headers(response.headers);
                newHeaders.set('Access-Control-Allow-Origin', '*');
                newHeaders.set('X-V2V-Cache-Status', 'HIT');
                return new Response(response.body, {
                    status: response.status,
                    headers: newHeaders,
                });
            }

            // ۲. اگر در کش نبود، تلاش برای دریافت از منابع اصلی
            try {
                response = await fetch(`${PRIMARY_ORIGIN}${pathname}`);
                if (!response.ok) throw new Error('Primary origin failed');
            } catch (error) {
                response = await fetch(`${SECONDARY_ORIGIN}${pathname}`);
            }

            // ۳. پردازش پاسخ و ذخیره در کش
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
                return new Response(response.body, {
                    status: response.status,
                    headers: newHeaders
                });
            }
        }

        // اگر درخواست برای هیچکدام از مسیرهای مجاز نبود
        return new Response('File not handled by this worker.', {
            status: 404,
            headers: { 'Access-Control-Allow-Origin': '*' },
        });
    }
};
