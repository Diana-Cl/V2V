document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const PUBLIC_SUB_UUID = "00000000-v2v-public-sub-000000000000";

    // ✅ اصلاح کلیدی ۱: مسیر نسبی به عنوان اولین و اصلی‌ترین منبع
    // این کار استقلال هر آینه را تضمین می‌کند. بقیه آدرس‌ها به عنوان پشتیبان عمل می‌کنند.
    const DATA_MIRRORS = [
        './all_live_configs.json',
        'https://v2v-vercel.vercel.app/all_live_configs.json',
        'https://smbcryp.github.io/V2V/all_live_configs.json',
        'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
    ];
    const CACHE_URLS = [
        './cache_version.txt',
        'https://v2v-vercel.vercel.app/cache_version.txt',
        'https://smbcryp.github.io/V2V/cache_version.txt',
        'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/cache_version.txt'
    ];
    const STATIC_CLASH_SUB_URL = './clash_subscription.yml';
    
    const FETCH_TIMEOUT = 3500; // تایم‌اوت بهینه‌سازی شده

    // --- DOM & STATE ---
    // (بدون تغییر)
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    let allConfigs = { xray: [], singbox: [] };

    // --- HELPERS & FETCH LOGIC ---
    // (استفاده از کد هوشمندانه شما برای failover)
    const fetchWithTimeout = async (url, timeout = FETCH_TIMEOUT) => { /* ... (کد شما بدون تغییر) ... */ };

    async function fetchRace(urls, isJson = true) {
        const controllers = urls.map(() => new AbortController());
        
        const promises = urls.map((url, i) => 
            fetch(`${url}?t=${Date.now()}`, { signal: controllers[i].signal, cache: 'no-store' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                // وقتی اولین پاسخ موفق دریافت شد، بقیه را لغو کن
                controllers.forEach((c, j) => { if (i !== j) c.abort(); });
                return isJson ? response.json() : response.text();
            })
        );
        
        try {
            return await Promise.any(promises);
        } catch (aggregateError) {
            throw new Error("تمام منابع در دسترس نیستند.");
        }
    }

    // --- RENDER FUNCTIONS ---
    function renderCore(core, configs) { /* ... (کد شما بدون تغییر) ... */ }

    // --- INITIALIZATION ---
    (async () => {
        try {
            statusBar.textContent = 'در حال دریافت آخرین بروزرسانی...';
            const versionText = await fetchRace(CACHE_URLS, false);
            statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(versionText.split('\n')[0].trim())}`;
        } catch (e) {
            statusBar.textContent = 'عدم امکان دریافت زمان بروزرسانی.';
        }
        
        try {
            allConfigs = await fetchRace(DATA_MIRRORS, true);
            renderCore('xray', allConfigs.xray || []);
            renderCore('singbox', allConfigs.singbox || []);
        } catch (error) {
            statusBar.textContent = 'خطا در بارگذاری کانفیگ‌ها.';
            const errorMsg = `<div class="alert">خطا: ${error.message}</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- GLOBAL API ---
    window.v2v = {
        // ... (توابع دیگر شما مانند runAdvancedPingTest, createSubscription و ... با همان منطق fallback هوشمندانه باقی می‌مانند)
        
        // ✅ اصلاح کلیدی ۲: تابع "اشتراک آماده" برای ساخت یک لینک واقعی و پویا
        copyReadySubscription: (core, type, action) => {
            const subTypePath = type === 'clash' ? 'clash/' : '';
            // این تابع حالا یک URL واقعی می‌سازد که همیشه آپدیت می‌شود
            const finalUrl = `${API_ENDPOINT}/${core}/${subTypePath}${PUBLIC_SUB_UUID}`;

            if (action === 'copy') {
                navigator.clipboard.writeText(finalUrl);
                showToast(`لینک اشتراک آماده کپی شد.`);
            } else if (action === 'qr') {
                v2v.showQrCode(finalUrl);
            }
        },
        
        // ✅ اصلاح کلیدی ۳: تابع کپی لینک کلش برای کار با آدرس نسبی
        copyStaticClashSub: (action) => {
            const absoluteUrl = new URL(STATIC_CLASH_SUB_URL, window.location.href).href;
            if (action === 'copy') {
                navigator.clipboard.writeText(absoluteUrl);
                showToast('لینک Clash کپی شد');
            } else if (action === 'qr') {
                v2v.showQrCode(absoluteUrl);
            }
        },
        // سایر توابع window.v2v که شما نوشتید...
    };
});


