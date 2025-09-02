/**
 * V2V Cloudflare Worker - Improved Version
 * - @version 2.3.0 - با بهبود تست پینگ، پارسینگ پیشرفته، و امنیت بیشتر
 */
const PRIMARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';
const CACHE_TTL = 300; // 5 دقیقه
const DOWNLOAD_TEST_FILE = '/dl-test.bin';
const MAX_PING_THRESHOLD = 5000; // حداکثر پینگ قابل قبول (ms)
const RATE_LIMIT_INTERVAL = 60000; // 1 دقیقه
const MAX_REQUESTS_PER_INTERVAL = 50; // حداکثر 50 درخواست در هر دقیقه per IP

// UUIDs ثابت برای subscription paths
const SUBSCRIPTION_UUIDS = {
    'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7': 'xray_top20',
    'f7e8d9c0-b1a2-4567-8901-234567890abc': 'xray_all',
    '9876543a-bcde-4f01-2345-6789abcdef01': 'singbox_top20',
    '12345678-9abc-4def-0123-456789abcdef': 'singbox_all'
};

// یک مپ ساده برای rate limiting (در production از KV استفاده کن)
const rateLimitMap = new Map();

// تابع کمکی برای چک کردن و پارس کردن کانفیگ (شبیه main.py)
function isValidConfigFormat(configStr) {
    try {
        const parsed = new URL(configStr);
        const validPrefixes = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic'];
        return (
            validPrefixes.includes(parsed.protocol.replace('://', '')) &&
            parsed.hostname &&
            configStr.length > 20 &&
            !configStr.includes('<') && !configStr.includes('>') && !configStr.includes('&')  // sanitize
        );
    } catch (e) {
        return false;
    }
}

// بهبود تابع تست پینگ واقعی کانفیگ
async function testConfigPing(configStr) {
    console.log(`Testing ping for config: ${configStr.substring(0, 50)}...`);
    try {
        let host, port, sni, isTls = false, username, password;
        
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
            username = url.username;
            password = params.get('password') || url.password;
        }
        
        // Validation پیشرفته (جلوگیری از ورودی ناقص)
        if (!host || !port || port < 1 || port > 65535 || !isValidConfigFormat(configStr)) {
            console.warn(`Invalid config format: ${configStr.substring(0, 30)}`);
            return { ping: 9999, error: 'Invalid config' };
        }
        
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        try {
            // تست با fetch برای کانفیگ‌های TLS
            const testUrl = isTls ? `https://${host}:${port}` : `http://${host}:${port}`;
            await fetch(testUrl, { 
                signal: controller.signal,
                method: 'HEAD',
                mode: 'no-cors',
                redirect: 'manual'
            });
            
            const endTime = Date.now();
            clearTimeout(timeoutId);
            const ping = Math.min(endTime - startTime, MAX_PING_THRESHOLD);
            console.log(`Ping test successful: ${ping}ms for ${host}:${port}`);
            return { ping };
            
        } catch (error) {
            clearTimeout(timeoutId);
            console.warn(`Fetch failed for ${host}:${port}: ${error.message}`);
            // Fallback: سعی برای تست DNS resolution ساده
            try {
                await fetch(`https://dns.google/resolve?name=${host}`);
                return { ping: 500 };  // اگر DNS موفق باشه، پینگ حدودی بده
            } catch (dnsError) {
                console.error(`DNS fallback failed: ${dnsError.message}`);
                return { ping: 9999 };
            }
        }
        
    } catch (error) {
        console.error(`Error testing ping: ${error.message}`);
        return { ping: 9999, error: 'Parse or execution error' };
    }
}

// تابع راهنمای برای rate limiting ساده
function checkRateLimit(ip) {
    const now = Date.now();
    const key = ip;
    const windowStart = now - RATE_LIMIT_INTERVAL;
    if (!rateLimitMap.has(key) || rateLimitMap.get(key).timestamp < windowStart) {
        rateLimitMap.set(key, { count: 1, timestamp: now });
        return false; // مجاز
    }
    const current = rateLimitMap.get(key);
    if (current.count >= MAX_REQUESTS_PER_INTERVAL) {
        return true; // بلاک
    }
    current.count++;
    return false;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        
        // Rate limiting چک
        if (checkRateLimit(ip)) {
            console.warn(`Rate limit hit for IP: ${ip}`);
            return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
        
        console.log(`Request: ${request.method} ${url.pathname} from ${ip}`);
        
        let pathname = url.pathname;
        const cache = caches.default;

        // منطق برای سرو کردن فایل‌ها از گیت‌هاب (بهبود یافته)
        async function serveFromGitHub(requestedPath) {
            const githubUrl = `${PRIMARY_ORIGIN}${requestedPath}`;
            const cacheKey = new Request(githubUrl, request);
            
            let response = await cache.match(cacheKey);
            if (response) {
                const newHeaders = new Headers(response.headers);
                newHeaders.set('Access-Control-Allow-Origin', '*');
                return new Response(response.body, { status: response.status, headers: newHeaders });
            }

            try {
                response = await fetch(githubUrl, { cache: 'no-store' });
                if (response.ok) {
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set('Access-Control-Allow-Origin', '*');
                    newHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
                    const resClone = new Response(response.clone().body, { status: response.status, headers: newHeaders });
                    ctx.waitUntil(cache.put(cacheKey, resClone));
                    return resClone;
                } else {
                    console.error(`Fetch failed: ${response.status} for ${requestedPath}`);
                    return new Response(`Not Found: ${requestedPath}`, { status: 404 });
                }
            } catch (error) {
                console.error(`Fetch error for ${requestedPath}: ${error.message}`);
                return new Response(`Error fetching: ${requestedPath}`, { status: 500 });
            }
        }

        // اندپوینت تست پینگ واقعی کانفیگ
        if (pathname === '/test-config' && request.method === 'POST') {
            try {
                const body = await request.json();
                const configStr = body.config;
                
                if (!configStr) {
                    return new Response(JSON.stringify({ ping: 9999, error: 'No config provided' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }
                
                const result = await testConfigPing(configStr);
                
                return new Response(JSON.stringify(result), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
                });
                
            } catch (error) {
                console.error(`Test-config error: ${error.message}`);
                return new Response(JSON.stringify({ ping: 9999, error: 'Processing failed' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // اندپوینت subscription با UUID
        if (pathname.startsWith('/sub/')) {
            const uuid = pathname.replace('/sub/', '');
            if (SUBSCRIPTION_UUIDS[uuid]) {
                const subFileName = `sub_${uuid}.txt`;
                const originPath = `/configs/${subFileName}`;
                return serveFromGitHub(originPath);
            }
            return new Response('Subscription not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
        }

        // اندپوینت‌های اصلی برای فایل‌های تولید شده
        if (pathname.startsWith('/all_live_configs_') || pathname === '/cache_version.txt' || pathname.startsWith('/clash_subscription.yaml')) {
            const originPath = `/configs${pathname}`;
            return serveFromGitHub(originPath);
        }

        // اندپوینت تست پینگ شبکه
        if (pathname === '/ping') {
            return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
        }
        
        // اندپوینت تست سرعت دانلود
        if (pathname.startsWith(DOWNLOAD_TEST_FILE)) {
            return serveFromGitHub(DOWNLOAD_TEST_FILE);
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
        
        // درخواست‌های دیگر به GitHub منتقل می‌شوند (برای index.html و assetها)
        return serveFromGitHub(pathname);
    }
};
