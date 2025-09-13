document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const PUBLIC_SUB_UUID = "00000000-v2v-public-sub-000000000000";
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
    const FETCH_TIMEOUT = 5000;
    const READY_SUB_COUNT = 50;

    // --- DOM & STATE ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigsData = {};

    // --- HELPERS ---
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
        toast.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    };

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
        const promises = urls.map(url => fetchWithTimeout(url));
        try {
            return await Promise.any(promises);
        } catch (aggregateError) {
            console.error("All fetch attempts failed:", aggregateError.errors);
            throw new Error("تمام منابع در دسترس نیستند.");
        }
    }

    // --- RENDER FUNCTION ---
    function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        
        const allFlatConfigs = Object.values(groupedConfigs).flat();

        if (allFlatConfigs.length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`;
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

        // ✅ اصلاح نهایی: رندر کردن بر اساس ساختار جدید (گروه‌بندی شده)
        for (const protocol in groupedConfigs) {
            const configs = groupedConfigs[protocol];
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            let itemsHTML = '';
            configs.forEach(config => {
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
                    <span>${protocol.toUpperCase()} (${configs.length})</span>
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
            statusBar.textContent = 'عدم امکان دریافت زمان بروزرسانی.';
        }
        
        try {
            allConfigsData = await fetchWithFailover(DATA_MIRRORS, true);
            if (typeof allConfigsData !== 'object' || !allConfigsData.xray || !allConfigsData.singbox) {
                throw new Error("فرمت داده دریافت شده نامعتبر است.");
            }
            renderCore('xray', allConfigsData.xray);
            renderCore('singbox', allConfigsData.singbox);
        } catch (error) {
            console.error("خطا در بارگذاری کانفیگ‌ها:", error);
            const errorMsg = `<div class="alert">خطا در بارگذاری: ${error.message}</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
            statusBar.textContent = 'خطا در بارگذاری کانفیگ‌ها';
        }
    })();

    // --- GLOBAL API ---
    window.v2v = {
        showToast,
        getStaticClashUrl: () => new URL(STATIC_CLASH_SUB_URL, window.location.href).href,
        copyStaticClashSub: (action) => {
            const url = v2v.getStaticClashUrl();
            if (action === 'copy') { navigator.clipboard.writeText(url); showToast('لینک Clash کپی شد'); }
            else if (action === 'qr') { v2v.showQrCode(url); }
        },
        copyReadySubscription: (core, type, action) => {
            const coreData = allConfigsData[core];
            if (!coreData) return showToast("داده‌ای برای این هسته یافت نشد.", true);
            
            const allFlatConfigs = Object.values(coreData).flat();
            if (allFlatConfigs.length === 0) return showToast("کانفیگی برای ساخت اشتراک یافت نشد.", true);
            
            const configsForSub = allFlatConfigs.slice(0, READY_SUB_COUNT);
            
            // For now, we fall back to direct data URI as public subscription via worker needs more setup
            const content = configsForSub.join('\n');
            const directUrl = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(content)))}`;

            if (action === 'copy') { navigator.clipboard.writeText(directUrl); showToast('لینک اشتراک آماده کپی شد.'); }
            else if (action === 'qr') { v2v.showQrCode(directUrl); }
        },
        createSubscription: async (core, type, action) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selectedConfigs.length === 0) return showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            
            try {
                const res = await fetch(`${API_ENDPOINT}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
                if (!res.ok) throw new Error(`Server responded with ${res.status}`);
                const data = await res.json();
                
                let finalUrl = data.subscription_url;
                if (type === 'clash' && data.clash_url) {
                    finalUrl = data.clash_url;
                }

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
        showQrCode: (text) => {
            if (!window.QRCode) return showToast('کتابخانه QR در حال بارگذاری است...', true);
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
            qrModal.style.display = 'flex';
        },
        // Placeholder for ping logic
        runAdvancedPingTest: (core) => { showToast('این قابلیت به زودی اضافه خواهد شد.'); },
        generateClashFile: () => { showToast('این قابلیت به زودی اضافه خواهد شد.');}
    };
    qrModal.onclick = (e) => {
        if (e.target === qrModal) qrModal.style.display = 'none';
    };
});


