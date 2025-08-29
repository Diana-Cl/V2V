/**
 * Welcome to your V2V Cloudflare Worker!
 *
 * This script acts as a smart, fast, and reliable reverse proxy for your config files.
 *
 * Main Features:
 * 1.  Intelligent Caching: It caches your main config files on Cloudflare's edge network,
 * making them load almost instantly for users worldwide.
 * 2.  Automatic Fallback: If the primary data source (ArvanCloud) is down or slow,
 * it automatically fetches from the secondary source (GitHub), ensuring your
 * service is always online.
 * 3.  CORS Handling: It adds the necessary headers so that your website can securely
 * access the files from any domain.
 *
 * - @version 1.0.0
 * - @author V2V Project with Gemini
 */

// --- CONFIGURATION ---
// آدرس منابع اصلی شما برای دریافت فایل‌ها
const PRIMARY_ORIGIN = 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.com';
const SECONDARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';

// مدت زمانی که فایل‌ها در کش کلادفلر باقی می‌مانند (به ثانیه)
// 300 ثانیه = 5 دقیقه
const CACHE_TTL = 300;

// لیست فایل‌هایی که توسط این Worker مدیریت می‌شوند
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

        if (!ALLOWED_PATHS.includes(pathname)) {
            return new Response('File not handled by this worker.', {
                status: 404
            });
        }

        const cacheKey = new Request(url.toString(), request);

        // ۱. تلاش برای خواندن از کش
        let response = await cache.match(cacheKey);
        if (response) {
            console.log(`Cache HIT for: ${pathname}`);
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            newHeaders.set('X-V2V-Cache-Status', 'HIT');
            return new Response(response.body, {
                status: response.status,
                headers: newHeaders,
            });
        }
        console.log(`Cache MISS for: ${pathname}`);

        // ۲. اگر در کش نبود، تلاش برای دریافت از منابع اصلی با سیستم پشتیبان
        try {
            console.log(`Fetching from PRIMARY origin: ${pathname}`);
            response = await fetch(`${PRIMARY_ORIGIN}${pathname}`);
            if (!response.ok) {
                throw new Error(`Primary origin failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error(`Primary origin fetch failed: ${error.message}. Trying secondary...`);
            response = await fetch(`${SECONDARY_ORIGIN}${pathname}`);
        }

        // ۳. پردازش پاسخ و ذخیره در کش برای دفعات بعدی
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

        // اگر هیچ‌کدام از منابع پاسخگو نبودند
        return new Response('Could not fetch content from any origin.', {
            status: 502
        });
    }
};
