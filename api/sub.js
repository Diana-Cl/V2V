// File: /api/sub.js

/**
 * این تابع به عنوان یک پروکسی هوشمند عمل می‌کند.
 * به جای خواندن یک فایل محلی قدیمی، این تابع درخواست را مستقیماً به
 * Cloudflare Worker شما ارسال کرده و همیشه جدیدترین نسخه از کانفیگ‌ها را
 * به کاربر تحویل می‌دهد.
 */

// آدرس کامل و نهایی ورکر کلادفلر شما
const CLOUDFLARE_WORKER_URL = 'https://rapid-scene-1da6.mbrgh87.workers.dev/all_live_configs.json';

export default async function handler(req, res) {
    // تنظیم هدرهای لازم برای دسترسی از دامنه‌های مختلف (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // پاسخ به درخواست‌های pre-flight از طرف مرورگر
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    // این اندپوینت فقط به درخواست‌های GET پاسخ می‌دهد
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    try {
        // ۱. دریافت محتوای زنده از Cloudflare Worker
        const originResponse = await fetch(CLOUDFLARE_WORKER_URL);

        // ۲. بررسی موفقیت‌آمیز بودن پاسخ از Worker
        if (!originResponse.ok) {
            // اگر Worker خطا بدهد، همان خطا را به کاربر منتقل می‌کنیم
            return res.status(originResponse.status).json({
                message: `Could not fetch from origin worker. Status: ${originResponse.status}`
            });
        }

        // ۳. ارسال محتوای دریافت شده به کاربر
        const fileContent = await originResponse.text();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(fileContent);

    } catch (error) {
        console.error('Error proxying subscription request:', error);
        // در صورت بروز خطای شبکه در ارتباط با Worker
        res.status(502).json({ message: 'Bad Gateway: The origin worker is unreachable.' });
    }
}
