document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const PUBLIC_SUB_UUID = "00000000-v2v-public-sub-000000000000";

    // ✅ معماری نهایی: مسیر نسبی به عنوان اولین منبع برای استقلال کامل
    const DATA_MIRRORS = [
        './all_live_configs.json', // منبع اصلی و محلی هر سایت
        'https://v2v-vercel.vercel.app/all_live_configs.json',
        'https://smbcryp.github.io/V2V/all_live_configs.json',
        'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json'
    ];
    const CACHE_URLS = [
        './cache_version.txt', // منبع اصلی و محلی هر سایت
        'https://v2v-vercel.vercel.app/cache_version.txt',
        'https://smbcryp.github.io/V2V/cache_version.txt',
        'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/cache_version.txt'
    ];
    // ✅ این مسیر هم نسبی شد تا هر سایت فایل کلش خودش را ارائه دهد
    const STATIC_CLASH_SUB_URL = './clash_subscription.yml';

    const PING_TIMEOUT = 3000;
    const READY_SUB_COUNT = 50; // افزایش تعداد کانفیگ‌های اشتراک آماده
    const FETCH_TIMEOUT = 5000;

    // --- DOM ELEMENTS & STATE ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: [], singbox: [] };

    // --- HELPERS (توابع هوشمندانه شما) ---
    const toShamsi = (timestamp) => {
        if (!timestamp || isNaN(timestamp)) return 'N/A';
        try {
            const date = new Date(parseInt(timestamp, 10) * 1000);
            return date.toLocaleString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch { return 'Invalid Date'; }
    };

    const parseConfigName = (configStr) => {
        try {
            if (configStr.includes('#')) return decodeURIComponent(configStr.split('#')[1] || 'Unnamed');
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.replace('vmess://', '')));
                return data.ps || data.add || 'Unnamed';
            }
            return new URL(configStr).hostname || 'Unnamed';
        } catch { return 'Unnamed Config'; }
    };
    
    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.className = 'toast show';
        if (isError) toast.classList.add('error');
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    };

    // --- IMPROVED FAILOVER MECHANISM (منطق failover پیشرفته شما) ---
    async function fetchWithFailover(urls, isJson = true) {
        const fetchWithTimeout = async (url) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
            try {
                const response = await fetch(`${url}?t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return isJson ? response.json() : response.text();
            } finally {
                clearTimeout(timeoutId);
            }
        };

        // استفاده از Promise.any برای پیدا کردن اولین پاسخ موفق
        const promises = urls.map(url => fetchWithTimeout(url));
        try {
            return await Promise.any(promises);
        } catch (aggregateError) {
            console.error("All fetch attempts failed:", aggregateError.errors);
            throw new Error("تمام منابع در دسترس نیستند.");
        }
    }

    // --- RENDER FUNCTIONS (تابع رندر شما) ---
    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';

        if (!configs || configs.length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی یافت نشد.</div>`;
            return;
        }

        const isXray = core === 'xray';
        let actionsHTML = `
            <button class="test-button" id="${core}-test-btn" onclick="v2v.runAdvancedPingTest('${core}')">
                <span id="${core}-test-btn-text">🚀 تست پیشرفته کانفیگ‌ها</span>
            </button>
            <div class="action-group-title">اشتراک آماده (بر اساس ${READY_SUB_COUNT} کانفیگ برتر)</div>
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک Standard</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.copyReadySubscription('${core}', 'standard', 'copy')">کپی</button>
                    <button class="action-btn-small" onclick="v2v.copyReadySubscription('${core}', 'standard', 'qr')">QR</button>
                </div>
            </div>
            ${isXray ? `
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک Clash Meta</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.open(v2v.getStaticClashUrl(), '_blank')">دانلود</button>
                    <button class="action-btn-small" onclick="v2v.copyStaticClashSub('copy')">کپی URL</button>
                    <button class="action-btn-small" onclick="v2v.copyStaticClashSub('qr')">QR</button>
                </div>
            </div>` : ''}
            <div class="action-group-title">اشتراک شخصی (کانفیگ‌های انتخابی شما)</div>
            <div class="action-box">
                <span class="action-box-label">ساخت لینک UUID از موارد انتخابی</span>
                <div class="action-box-buttons">
                     <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'standard', 'copy')">کپی لینک</button>
                     <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'standard', 'qr')">QR Code</button>
                </div>
            </div>
             ${isXray ? `
            <div class="action-box">
                <span class="action-box-label">ساخت لینک Clash از موارد انتخابی</span>
                 <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'clash', 'copy')">کپی لینک</button>
                    <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'clash', 'qr')">QR Code</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">دانلود فایل Clash از موارد انتخابی</span>
                 <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.generateClashFile('${core}')">دانلود فایل</button>
                </div>
            </div>` : ''}
        `;
        wrapper.innerHTML = actionsHTML;

        const grouped = configs.reduce((acc, config) => {
            const protocol = config.match(/^(\w+):\/\//)?.[1]?.toLowerCase() || 'unknown';
            if (!acc[protocol]) acc[protocol] = [];
            acc[protocol].push(config);
        }, {});

        for (const protocol in grouped) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            let itemsHTML = '';
            grouped[protocol].forEach(config => {
                const name = parseConfigName(config);
                const safeConfig = config.replace(/'/g, "&apos;");
                itemsHTML += `
                    <li class="config-item" data-config='${safeConfig}'>
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details"><span class="server">${name}</span><span class="ping-result"></span></div>
                        <button class="copy-btn" onclick="navigator.clipboard.writeText('${safeConfig}'); v2v.showToast('کانفیگ کپی شد!');">کپی</button>
                    </li>`;
            });
            pGroupEl.innerHTML = `
                <div class="protocol-header" onclick="this.parentElement.classList.toggle('open')">
                    <span>${protocol.toUpperCase()} (${grouped[protocol].length})</span>
                    <span class="toggle-icon">▼</span>
                </div>
                <ul class="config-list">${itemsHTML}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    }

    // --- INITIALIZATION ---
    (async () => {
        try {
            statusBar.textContent = 'در حال دریافت آخرین بروزرسانی...';
            const versionText = await fetchWithFailover(CACHE_URLS, false);
            statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(versionText.split('\n')[0].trim())}`;
        } catch (e) {
            console.warn('Could not load cache version:', e.message);
            statusBar.textContent = 'عدم امکان دریافت زمان بروزرسانی.';
        }
        
        try {
            allConfigs = await fetchWithFailover(DATA_MIRRORS, true);
            renderCore('xray', allConfigs.xray || []);
            renderCore('singbox', allConfigs.singbox || []);
        } catch (error) {
            console.error("خطا در بارگذاری کانفیگ‌ها:", error);
            const errorMsg = `<div class="alert">خطا در بارگذاری: ${error.message}</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
            statusBar.textContent = 'خطا در بارگذاری کانفیگ‌ها';
        }
    })();

    // --- GLOBAL API (تلفیق نهایی) ---
    window.v2v = {
        showToast,
        
        runAdvancedPingTest: async (core) => { /* (منطق تست پینگ شما بدون تغییر) */ },
        testWebSocket: async (config, item, timeout) => { /* (منطق تست پینگ شما بدون تغییر) */ },

        createSubscription: async (core, type, action) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selectedConfigs.length === 0) return showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            
            try {
                const res = await fetch(`${API_ENDPOINT}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
                if (!res.ok) throw new Error(`Server responded with ${res.status}`);
                const data = await res.json();
                
                const subTypePath = type === 'clash' ? 'clash/' : '';
                // اطمینان از عدم وجود اسلش اضافه
                const finalUrl = `${data.subscription_url.replace(/\/$/, '')}/${subTypePath}`;
                
                if (action === 'copy') { navigator.clipboard.writeText(finalUrl); showToast('لینک اشتراک شخصی کپی شد.'); } 
                else if (action === 'qr') { v2v.showQrCode(finalUrl); }

            } catch (error) {
                console.warn('Subscription API failed, creating fallback link:', error);
                showToast('API در دسترس نیست، لینک پشتیبان ساخته شد.', true);
                const content = selectedConfigs.join('\n');
                const directUrl = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(content)))}`;
                if (action === 'copy') { navigator.clipboard.writeText(directUrl); } 
                else if (action === 'qr') { v2v.showQrCode(directUrl); }
            }
        },

        // ✅ اصلاح نهایی: این تابع حالا یک اشتراک واقعی و پویا می‌سازد
        copyReadySubscription: (core, type, action) => {
            const subTypePath = type === 'clash' ? 'clash/' : '';
            const corePath = core === 'singbox' ? 'singbox/' : 'xray/';
            const finalUrl = `${API_ENDPOINT}/sub/${corePath}${subTypePath}${PUBLIC_SUB_UUID}`;
            
            if (action === 'copy') {
                navigator.clipboard.writeText(finalUrl);
                showToast('لینک اشتراک آماده کپی شد.');
            } else if (action === 'qr') {
                v2v.showQrCode(finalUrl);
            }
        },
        
        getStaticClashUrl: () => new URL(STATIC_CLASH_SUB_URL, window.location.href).href,

        copyStaticClashSub: (action) => {
            const absoluteUrl = v2v.getStaticClashUrl();
            if (action === 'copy') {
                navigator.clipboard.writeText(absoluteUrl);
                showToast('لینک Clash کپی شد');
            } else if (action === 'qr') {
                v2v.showQrCode(absoluteUrl);
            }
        },

        generateClashFile: (core) => { /* (کد شما بدون تغییر) */ },
        generateClashYaml: (configs) => { /* (کد شما بدون تغییر) */ },
        parseProxyForClash: (config) => { /* (کد شما بدون تغییر) */ },
        
        showQrCode: (text) => {
            if (!window.QRCode) return showToast('کتابخانه QR در حال بارگذاری است...', true);
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
            qrModal.style.display = 'flex';
        }
    };

    // بستن مودال QR
    qrModal.onclick = (e) => {
        if (e.target === qrModal) {
            qrModal.style.display = 'none';
        }
    };
});


