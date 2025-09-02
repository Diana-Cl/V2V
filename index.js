/**
 * V2V Cloudflare Worker - Fixed Version
 * @version 3.0.0 - تصحیح کامل مشکلات
 */

// ثوابت پیکربندی
const PRIMARY_ORIGIN = 'https://raw.githubusercontent.com/SMBCRYP/V2V/main';
const CACHE_TTL = 300; // 5 دقیقه
const DOWNLOAD_TEST_FILE = '/dl-test.bin';
const MAX_PING_THRESHOLD = 5000;
const RATE_LIMIT_INTERVAL = 60000; // 1 دقیقه
const MAX_REQUESTS_PER_INTERVAL = 100;

// UUID mapping برای subscription paths - باید دقیقا با scraper همخوان باشد
const SUBSCRIPTION_UUIDS = {
    'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7': 'xray_top20',
    'f7e8d9c0-b1a2-4567-8901-234567890abc': 'xray_all',
    '9876543a-bcde-4f01-2345-6789abcdef01': 'singbox_top20',
    '12345678-9abc-4def-0123-456789abcdef': 'singbox_all'
};

// Rate limiting storage - در production از KV استفاده کنید
const rateLimitMap = new Map();

// CORS headers استاندارد
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'false'
};

// Rate limiting function بهبود یافته
function checkRateLimit(ip) {
    const now = Date.now();
    const key = ip || 'unknown';
    const windowStart = now - RATE_LIMIT_INTERVAL;
    
    // پاک کردن entries قدیمی
    for (const [k, v] of rateLimitMap.entries()) {
        if (v.timestamp < windowStart) {
            rateLimitMap.delete(k);
        }
    }
    
    if (!rateLimitMap.has(key)) {
        rateLimitMap.set(key, { count: 1, timestamp: now });
        return false; // مجاز
    }
    
    const current = rateLimitMap.get(key);
    if (current.timestamp < windowStart) {
        // Window جدید شروع شده
        rateLimitMap.set(key, { count: 1, timestamp: now });
        return false;
    }
    
    if (current.count >= MAX_REQUESTS_PER_INTERVAL) {
        return true; // Rate limited
    }
    
    current.count++;
    return false;
}

// تابع کمکی برای ایجاد response با CORS
function createResponse(body, options = {}) {
    const {
        status = 200,
        headers = {},
        contentType = 'application/json'
    } = options;
    
    const responseHeaders = {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        ...headers
    };
    
    return new Response(body, {
        status,
        headers: responseHeaders
    });
}

// تابع کمکی برای ایجاد error response
function createErrorResponse(message, status = 500, ping = 9999) {
    return createResponse(
        JSON.stringify({ 
            error: message, 
            ping, 
            timestamp: new Date().toISOString() 
        }),
        { status }
    );
}

// تابع کمکی برای log کردن request
function logRequest(request, ip, additionalInfo = '') {
    const url = new URL(request.url);
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    console.log(`${request.method} ${url.pathname} - IP: ${ip} - UA: ${userAgent.substring(0, 100)} ${additionalInfo}`);
}

// تابع validation برای config string
function validateConfigString(configStr) {
    if (!configStr || typeof configStr !== 'string') {
        return { valid: false, error: 'Config must be a non-empty string' };
    }
    
    // بررسی طول
    if (configStr.length > 2000) {
        return { valid: false, error: 'Config too long (max 2000 chars)' };
    }
    
    if (configStr.length < 10) {
        return { valid: false, error: 'Config too short (min 10 chars)' };
    }
    
    // بررسی characters مضر
    const harmfulChars = ['<', '>', '&', '"', "'"];
    for (const char of harmfulChars) {
        if (configStr.includes(char)) {
            return { valid: false, error: `Config contains harmful character: ${char}` };
        }
    }
    
    // بررسی prefix معتبر
    const validPrefixes = ['vmess://', 'vless://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://'];
    const hasValidPrefix = validPrefixes.some(prefix => configStr.startsWith(prefix));
    
    if (!hasValidPrefix) {
        return { valid: false, error: 'Unsupported protocol' };
    }
    
    return { valid: true };
}

// تابع پارس VMess config
function parseVmessConfig(configStr) {
    try {
        const encoded = configStr.replace('vmess://', '');
        const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4);
        const vmessData = JSON.parse(atob(padded));
        
        const host = vmessData.add;
        const port = parseInt(vmessData.port) || 443;
        const isTls = vmessData.tls === 'tls';
        const sni = vmessData.sni || host;
        
        if (!host || !port || port < 1 || port > 65535) {
            throw new Error('Invalid host or port in VMess config');
        }
        
        return { host, port, isTls, sni };
    } catch (error) {
        throw new Error(`VMess parse failed: ${error.message}`);
    }
}

// تابع پارس URL-based configs
function parseUrlBasedConfig(configStr) {
    try {
        const url = new URL(configStr);
        const host = url.hostname;
        const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);
        const params = new URLSearchParams(url.search);
        const isTls = params.get('security') === 'tls' || url.protocol === 'trojan:' || port === 443;
        const sni = params.get('sni') || host;
        
        if (!host || !port || port < 1 || port > 65535) {
            throw new Error('Invalid host or port in URL config');
        }
        
        return { host, port, isTls, sni };
    } catch (error) {
        throw new Error(`URL parse failed: ${error.message}`);
    }
}

// تابع اصلی تست پینگ کانفیگ - بهبود یافته
async function testConfigPing(configStr) {
    console.log(`Starting ping test for config: ${configStr.substring(0, 50)}...`);
    
    // Validation اولیه
    const validation = validateConfigString(configStr);
    if (!validation.valid) {
        console.warn(`Config validation failed: ${validation.error}`);
        return { ping: 9999, error: validation.error };
    }
    
    let host, port, sni, isTls = false;
    
    try {
        // Parse کانفیگ بر اساس نوع
        if (configStr.startsWith('vmess://')) {
            ({ host, port, isTls, sni } = parseVmessConfig(configStr));
        } else {
            ({ host, port, isTls, sni } = parseUrlBasedConfig(configStr));
        }
        
        console.log(`Parsed config: ${host}:${port} (TLS: ${isTls})`);
        
    } catch (error) {
        console.error(`Config parse error: ${error.message}`);
        return { ping: 9999, error: `Parse failed: ${error.message}` };
    }
    
    // تست اتصال با چندین روش
    const startTime = Date.now();
    
    try {
        // روش 1: تست HTTPS برای TLS configs
        if (isTls) {
            const httpsResult = await testHttpsConnection(host, port, sni);
            if (httpsResult.success) {
                const ping = Math.min(Date.now() - startTime, MAX_PING_THRESHOLD);
                console.log(`HTTPS test successful: ${ping}ms for ${host}:${port}`);
                return { ping };
            }
            console.log(`HTTPS test failed: ${httpsResult.error}`);
        }
        
        // روش 2: تست HTTP برای non-TLS configs
        if (!isTls) {
            const httpResult = await testHttpConnection(host, port);
            if (httpResult.success) {
                const ping = Math.min(Date.now() - startTime, MAX_PING_THRESHOLD);
                console.log(`HTTP test successful: ${ping}ms for ${host}:${port}`);
                return { ping };
            }
            console.log(`HTTP test failed: ${httpResult.error}`);
        }
        
        // روش 3: تست DNS resolution به عنوان fallback
        const dnsResult = await testDnsResolution(host);
        if (dnsResult.success) {
            const ping = Math.min(Date.now() - startTime + 200, MAX_PING_THRESHOLD); // +200ms penalty
            console.log(`DNS fallback successful: ${ping}ms for ${host}`);
            return { ping };
        }
        
        // اگر همه روش‌ها fail شدند
        console.warn(`All connection tests failed for ${host}:${port}`);
        return { ping: 9999, error: 'All connection methods failed' };
        
    } catch (error) {
        console.error(`Ping test error: ${error.message}`);
        return { ping: 9999, error: `Test execution failed: ${error.message}` };
    }
}

// تست اتصال HTTPS
async function testHttpsConnection(host, port, sni) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const testUrl = `https://${host}${port !== 443 ? `:${port}` : ''}`;
        
        const response = await fetch(testUrl, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'manual',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'V2V-Worker/3.0',
                'Cache-Control': 'no-cache'
            }
        });
        
        clearTimeout(timeoutId);
        
        // هر response که timeout نشده موفق محسوب می‌شود
        // حتی 404 یا 500 نشان‌دهنده اتصال موفق است
        console.log(`HTTPS response: ${response.status} for ${testUrl}`);
        return { success: true, status: response.status };
        
    } catch (error) {
        console.log(`HTTPS test failed for ${host}:${port} - ${error.name}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// تست اتصال HTTP
async function testHttpConnection(host, port) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const testUrl = `http://${host}${port !== 80 ? `:${port}` : ''}`;
        
        const response = await fetch(testUrl, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'manual',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'V2V-Worker/3.0',
                'Cache-Control': 'no-cache'
            }
        });
        
        clearTimeout(timeoutId);
        
        console.log(`HTTP response: ${response.status} for ${testUrl}`);
        return { success: true, status: response.status };
        
    } catch (error) {
        console.log(`HTTP test failed for ${host}:${port} - ${error.name}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// تست DNS resolution
async function testDnsResolution(host) {
    try {
        const dnsUrl = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`;
        
        const response = await fetch(dnsUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'V2V-Worker/3.0'
            }
        });
        
        if (!response.ok) {
            return { success: false, error: `DNS API error: ${response.status}` };
        }
        
        const dnsData = await response.json();
        
        if (dnsData.Answer && dnsData.Answer.length > 0) {
            console.log(`DNS resolution successful for ${host}: ${dnsData.Answer.length} records`);
            return { success: true, records: dnsData.Answer.length };
        } else {
            return { success: false, error: 'No DNS records found' };
        }
        
    } catch (error) {
        console.log(`DNS test failed for ${host}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// تابع کمکی برای serve کردن فایل از GitHub
async function serveFromGitHub(requestedPath, customHeaders = {}, ctx) {
    const githubUrl = `${PRIMARY_ORIGIN}${requestedPath}`;
    
    // بررسی cache
    const cache = caches.default;
    const cacheKey = new Request(githubUrl, { method: 'GET' });
    
    let response = await cache.match(cacheKey);
    if (response) {
        console.log(`Cache hit: ${requestedPath}`);
        const newHeaders = new Headers(response.headers);
        
        // اضافه کردن CORS headers
        Object.entries(CORS_HEADERS).forEach(([key, value]) => {
            newHeaders.set(key, value);
        });
        
        // اضافه کردن custom headers
        Object.entries(customHeaders).forEach(([key, value]) => {
            newHeaders.set(key, value);
        });
        
        return new Response(response.body, {
            status: response.status,
            headers: newHeaders
        });
    }

    // Fetch از GitHub
    try {
        console.log(`Fetching from GitHub: ${githubUrl}`);
        
        response = await fetch(githubUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'V2V-Worker/3.0',
                'Cache-Control': 'no-cache',
                'Accept': '*/*'
            },
            cf: {
                cacheTtl: CACHE_TTL,
                cacheEverything: true
            }
        });
        
        if (response.ok) {
            const responseHeaders = new Headers();
            
            // کپی headers مهم از response اصلی
            for (const [key, value] of response.headers.entries()) {
                if (['content-type', 'content-length', 'last-modified', 'etag'].includes(key.toLowerCase())) {
                    responseHeaders.set(key, value);
                }
            }
            
            // اضافه کردن CORS headers
            Object.entries(CORS_HEADERS).forEach(([key, value]) => {
                responseHeaders.set(key, value);
            });
            
            // اضافه کردن custom headers
            Object.entries(customHeaders).forEach(([key, value]) => {
                responseHeaders.set(key, value);
            });
            
            // تنظیم cache headers
            responseHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            responseHeaders.set('X-Served-By', 'V2V-Worker/3.0');
            
            const responseToReturn = new Response(response.body, {
                status: response.status,
                headers: responseHeaders
            });
            
            // Cache async
            if (ctx) {
                ctx.waitUntil(cache.put(cacheKey, responseToReturn.clone()));
            }
            
            console.log(`Successfully served: ${requestedPath}`);
            return responseToReturn;
            
        } else {
            console.error(`GitHub fetch failed: HTTP ${response.status} for ${requestedPath}`);
            return createErrorResponse(`File not found: ${requestedPath}`, 404);
        }
        
    } catch (error) {
        console.error(`GitHub fetch error for ${requestedPath}: ${error.message}`);
        return createErrorResponse(`Server error fetching file: ${error.message}`, 500);
    }
}

// Handler اصلی Worker
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        
        // استخراج IP address
        const ip = request.headers.get('CF-Connecting-IP') ||
                   request.headers.get('X-Forwarded-For') ||
                   request.headers.get('X-Real-IP') ||
                   'unknown';
        
        // Log request
        logRequest(request, ip);
        
        // CORS preflight handling
        if (request.method === 'OPTIONS') {
            return createResponse(null, {
                status: 200,
                headers: { 'Content-Length': '0' }
            });
        }
        
        // Rate limiting check
        if (checkRateLimit(ip)) {
            console.warn(`Rate limit exceeded for IP: ${ip}`);
            return createErrorResponse('Rate limit exceeded. Please try again later.', 429);
        }
        
        try {
            // اندپوینت تست پینگ کانفیگ
            if (pathname === '/test-config' && request.method === 'POST') {
                return await handleConfigTest(request, ip);
            }
            
            // اندپوینت subscription با UUID
            if (pathname.startsWith('/sub/')) {
                return await handleSubscription(pathname, ctx);
            }
            
            // اندپوینت‌های فایل‌های داده
            if (pathname.startsWith('/all_live_configs_')) {
                return await serveFromGitHub(`/configs${pathname}`, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Disposition': `attachment; filename="${pathname.substring(1)}"`
                }, ctx);
            }
            
            if (pathname === '/cache_version.txt') {
                return await serveFromGitHub('/configs/cache_version.txt', {
                    'Content-Type': 'text/plain; charset=utf-8'
                }, ctx);
            }
            
            if (pathname === '/clash_subscription.yaml') {
                return await serveFromGitHub('/configs/clash_subscription.yaml', {
                    'Content-Type': 'application/x-yaml; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="clash_subscription.yaml"'
                }, ctx);
            }
            
            // اندپوینت تست شبکه
            if (pathname === '/ping') {
                return createResponse('OK', {
                    headers: { 
                        'Cache-Control': 'no-store',
                        'Content-Type': 'text/plain'
                    }
                });
            }
            
            // اندپوینت تست سرعت دانلود
            if (pathname === '/dl-test.bin') {
                return await serveFromGitHub('/configs/dl-test.bin', {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': 'attachment; filename="dl-test.bin"'
                }, ctx);
            }
            
            // اندپوینت health check
            if (pathname === '/health') {
                return createResponse(JSON.stringify({
                    status: 'healthy',
                    version: '3.0.0',
                    timestamp: new Date().toISOString(),
                    worker: 'V2V-Cloudflare',
                    rate_limit_entries: rateLimitMap.size
                }));
            }
            
            // سرو فایل‌های استاتیک
            return await handleStaticFiles(pathname, ctx);
            
        } catch (error) {
            console.error(`Worker error for ${pathname}: ${error.message}`);
            return createErrorResponse(`Internal server error: ${error.message}`, 500);
        }
    }
};

هنوز مشکل داره
