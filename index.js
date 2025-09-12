document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    
    // ✅ تغییر کلیدی ۱: آدرس‌ها به صورت نسبی تعریف شدند تا روی هر دامنه‌ای به درستی کار کنند
    const DATA_MIRRORS = [
        './all_live_configs.json', // منبع اصلی
        'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir/all_live_configs.json' // منبع پشتیبان: ابر آروان
    ];
    const CACHE_URL = './cache_version.txt';
    
    // ✅ تغییر کلیدی ۲: آدرس استاتیک کلش با حروف بزرگ (V2V) تصحیح شد
    const STATIC_CLASH_SUB_URL = 'https://smbcryp.github.io/V2V/clash_subscription.yml';

    const PING_TIMEOUT = 3000;
    const READY_SUB_COUNT = 30;

    // --- DOM ELEMENTS & STATE ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: [], singbox: [] };

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
            if (configStr.includes('#')) return decodeURIComponent(configStr.split('#')[1] || `Unnamed`);
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.replace('vmess://', '')));
                return data.ps || data.add;
            }
            return new URL(configStr).hostname;
        } catch { return 'Unnamed Config'; }
    };
    
    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.className = 'toast show';
        if (isError) toast.classList.add('error');
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    };

    // --- RENDER FUNCTIONS ---
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
                    <button class="action-btn-small" onclick="window.open(v2v.staticClashUrl, '_blank')">دانلود</button>
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

    async function fetchWithFailover(urls) {
        let lastError = null;
        for (const [index, url] of urls.entries()) {
            try {
                statusBar.textContent = `در حال تلاش برای اتصال به منبع شماره ${index + 1}...`;
                const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`Status ${response.status}`);
                const statusText = `با موفقیت از منبع شماره ${index + 1} بارگذاری شد.`;
                if (!statusBar.textContent.includes('آخرین بروزرسانی')) {
                    statusBar.textContent = statusText;
                }
                return await response.json();
            } catch (error) {
                console.warn(`Failed to fetch from ${url}:`, error);
                lastError = error;
            }
        }
        throw new Error('All data sources failed.', { cause: lastError });
    }

    (async () => {
        try {
            const verRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (verRes.ok) {
                const versionText = (await verRes.text()).split('\n')[0];
                statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(versionText.trim())}`;
            }
        } catch { /* Fail silently */ }
        
        try {
            allConfigs = await fetchWithFailover(DATA_MIRRORS);
            renderCore('xray', allConfigs.xray || []);
            renderCore('singbox', allConfigs.singbox || []);
        } catch (e) {
            console.error("Config load error from all mirrors:", e);
            const errorMsg = `<div class="alert">خطا: هیچکدام از منابع بارگذاری کانفیگ در دسترس نیستند.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
            statusBar.textContent = 'خطا در بارگذاری کانفیگ‌ها.';
        }
    })();

    // (بقیه توابع جاوا اسکریپت مانند runAdvancedPingTest, createSubscription و ... بدون تغییر باقی می‌مانند)
    window.v2v = {
        showToast,
        staticClashUrl: STATIC_CLASH_SUB_URL,
        runAdvancedPingTest: async (core) => { /* ... code ... */ },
        createSubscription: async (core, type, action) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selectedConfigs.length === 0) return showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            try {
                const res = await fetch(`${API_ENDPOINT}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
                if (!res.ok) throw new Error(`Server responded with ${res.status}`);
                const data = await res.json();
                let finalUrl = data.subscription_url;
                if (type === 'clash') finalUrl = finalUrl.replace('/sub/', '/sub/clash/');
                if (action === 'copy') { navigator.clipboard.writeText(finalUrl); showToast('لینک اشتراک شخصی شما کپی شد.'); } 
                else if (action === 'qr') { v2v.showQrCode(finalUrl); }
            } catch (e) { showToast('خطا در ساخت لینک اشتراک.', true); console.error('Subscription creation failed:', e); }
        },
        copyReadySubscription: (core, type, action) => {
            const topConfigs = (allConfigs[core] || []).slice(0, READY_SUB_COUNT);
            if (topConfigs.length === 0) return showToast('کانفیگی برای ساخت لینک یافت نشد.', true);
            const content = topConfigs.join('\n');
            const url = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(content)))}`;
            if(action === 'copy') { navigator.clipboard.writeText(url); showToast(`لینک اشتراک آماده کپی شد.`); }
            else if (action === 'qr') { v2v.showQrCode(url); }
        },
        copyStaticClashSub: (action) => {
             if(action === 'copy') { navigator.clipboard.writeText(STATIC_CLASH_SUB_URL); showToast(`لینک اشتراک آماده کلش کپی شد.`); }
             else if (action === 'qr') { v2v.showQrCode(STATIC_CLASH_SUB_URL); }
        },
        generateClashFile: (core) => { /* ... code ... */ },
        showQrCode: (text) => {
            if (!window.QRCode) return showToast('کتابخانه QR در حال بارگذاری است.', true);
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel : QRCode.CorrectLevel.M });
            qrModal.style.display = 'flex';
        }
    };
    qrModal.onclick = () => qrModal.style.display = 'none';
    // The rest of the functions (updateItemUI, testWebSocket, etc.) remain unchanged
    function updateItemUI(item, result) {
        item.dataset.finalScore = result.ping ?? 9999;
        const pingEl = item.querySelector('.ping-result');
        if (result.ping !== null) {
            let color = result.ping < 400 ? 'var(--ping-good)' : (result.ping < 1000 ? 'var(--ping-medium)' : 'var(--ping-bad)');
            pingEl.innerHTML = `[${result.source}] <strong style="color:${color};">${result.ping}ms</strong>`;
        } else {
            pingEl.textContent = `[${result.source}] ناموفق`;
        }
    }
    
    async function testWebSocket(config, item, timeout) { /* ... code ... */ }
    async function testTcpBatch(items, apiUrl) {
        if (items.length === 0) return;
        items.forEach(({ item }) => updateItemUI(item, { source: 'S', ping: null }));
        try {
            const res = await fetch(apiUrl + '/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: items.map(i => i.config) }) });
            if (!res.ok) throw new Error('API response not OK');
            const results = await res.json();
            const resultsMap = new Map(results.map(r => [r.config, r.ping]));
            items.forEach(({ config, item }) => updateItemUI(item, { source: 'S', ping: resultsMap.get(config) ?? null }));
        } catch (e) {
            console.error("Backend TCP test failed:", e);
            items.forEach(({ item }) => updateItemUI(item, { source: 'S', ping: null }));
        }
    }
    function generateClashYaml(configs) { /* ... code ... */ }
    function parseProxyForClash(configStr) { /* ... code ... */ }
});

