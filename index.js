Document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 8000; 
    
    // 1. Load Balancing: Array of 4 Active-Active Worker Endpoints (v2v project)
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    let workerIndex = 0;
    const getNextWorkerUrl = () => {
        const url = WORKER_URLS[workerIndex];
        workerIndex = (workerIndex + 1) % WORKER_URLS.length; // Round Robin
        return url;
    };
    
    // Batching Configuration
    const PING_BATCH_SIZE = 50; 
    
    // --- DOM Elements ---
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');
    let userUuid = localStorage.getItem('v2v_user_uuid') || null;

    // --- Helper Functions ---
    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    /**
     * @description کپی کردن متن و نمایش QR Code (قابلیت استفاده برای تک کانفیگ)
     * @param {string} text متنی که باید کپی و به QR تبدیل شود
     * @param {string} successMessage پیام موفقیت
     * @param {boolean} openQr آیا مودال QR نمایش داده شود
     */
    window.copyToClipboardAndShowQr = async (text, successMessage = 'کپی شد!', openQr = false) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
            if (openQr) {
                window.openQrModal(text);
            }
        } catch (err) { showToast('خطا در کپی کردن!', true); }
    };

    // تابع قدیمی برای سازگاری با کدهای موجود که فقط کپی می‌کنند
    window.copyToClipboard = window.copyToClipboardAndShowQr;


    window.openQrModal = (text) => {
        if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; }
        qrContainer.innerHTML = '';
        // تنظیمات برای کیفیت بالا (Level H و اندازه مناسب)
        new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H });
        qrModal.style.display = 'flex';
    };

    // --- Core Logic ---
    let allLiveConfigsData = null;

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { signal: AbortSignal.timeout(8000) });
            if (!configResponse.ok) throw new Error(`Status ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { signal: AbortSignal.timeout(3000) });
                if (versionResponse.ok) cacheVersion = await versionResponse.text();
            } catch (error) {}

            statusBar.textContent = `آخرین بروزرسانی: ${new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}`;
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast('خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.', true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.</div>`;
        }
    };
    
    // ✅ تابع renderCore با حذف بخش Base64/Raw و اضافه کردن دکمه "کپی انتخابی"
    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ</button>`;
        const copySelectedButton = `<button class="action-btn-wide copy-selected-btn" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;
        
        // **حذف کامل بخش Base64/Raw و اصلاح دکمه‌های سابسکریپشن**
        let contentHtml = runPingButton + `
            ${copySelectedButton} 
            
            ${actionGroupTitle('لینک اشتراک YAML (Clash/Stash) [${coreName}]')}
            <div class="action-box">
                <span class="action-box-label">اشتراک YAML (کلش)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'download')">انتخابی (دانلود)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'qr')">همه (QR)</button> 
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'download')">همه (دانلود)</button>
                </div>
            </div>

            ${actionGroupTitle('لینک اشتراک JSON (Sing-box) [${coreName}]')}
            <div class="action-box">
                <span class="action-box-label">اشتراک JSON (سینگ‌باکس)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'download')">انتخابی (دانلود)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'qr')">همه (QR)</button> 
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'download')">همه (دانلود)</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            if (configs.length === 0) continue; 
            
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1)
                .replace('ss', 'Shadowsocks')
                .replace('hy2', 'Hysteria2')
                .replace('ssr', 'ShadowsocksR')
                .replace('naive', 'NaiveProxy');
            
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <div class="action-box-buttons">
                             <button class="action-btn-small copy-all-btn" onclick="window.copyProtocolConfigs('${coreName}', '${protocol}')">کپی همه</button>
                             <button class="action-btn-small qr-all-btn" onclick="window.showProtocolConfigsQr('${coreName}', '${protocol}')">QR همه</button>
                             <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                        </div>
                    </div>
                    <ul class="config-list">
                        ${configs.map((cfg, index) => {
                            // Configs in all_live_configs.json are stored as: [URL, Latency]
                            const configUrl = Array.isArray(cfg) ? cfg[0] : cfg;
                            const configLatency = Array.isArray(cfg) ? cfg[1] : '0';
                            return `
                                <li class="config-item" data-url="${configUrl}" data-ping="${configLatency}">
                                    <input type="checkbox" class="config-checkbox" id="${coreName}-${protocol}-${index}">
                                    <div class="config-details">
                                        <label for="${coreName}-${protocol}-${index}" class="server">${configUrl}</label>
                                    </div>
                                    <div class="ping-result-container">
                                        <span class="ping-result" style="color: grey;">${configLatency === '0' ? '---' : configLatency + 'ms'}</span>
                                    </div>
                                    <button class="copy-qr-btn" onclick="window.copyToClipboardAndShowQr('${configUrl}', 'کانفیگ کپی شد!', true)">کپی+QR</button>
                                </li>
                            `;
                        }).join('')}
                    </ul>
                </div>
            `;
        }

        wrapper.innerHTML = contentHtml;
        
        // ✅ منطق جدید باز و بسته کردن لیست کانفیگ‌ها 
        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Ignore clicks on buttons inside the header
                if (e.target.closest('.action-box-buttons')) return; 
                header.closest('.protocol-group').classList.toggle('open');
            });
        });
    };
    
    /**
     * @description کپی کردن کانفیگ‌های انتخابی کاربر.
     */
    window.copySelectedConfigs = (coreName) => {
        const selector = `#${coreName}-section .config-item input.config-checkbox:checked`;
        const configs = Array.from(document.querySelectorAll(selector)).map(el => el.closest('.config-item').dataset.url);
        
        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را برای کپی انتخاب کنید.', true);
            return;
        }

        // کپی کردن همه کانفیگ‌های انتخابی با جداکننده خط جدید
        window.copyToClipboardAndShowQr(configs.join('\n'), `تعداد ${configs.length} کانفیگ انتخابی کپی شدند!`, false);
    };

    /**
     * @description کپی کردن همه کانفیگ‌های یک پروتکل.
     */
    window.copyProtocolConfigs = (coreName, protocol) => {
        const selector = `#${coreName}-section .protocol-group[data-protocol="${protocol}"] .config-item`;
        const configs = Array.from(document.querySelectorAll(selector)).map(el => el.dataset.url);
        if (configs.length === 0) {
            showToast(`کانفیگی برای پروتکل ${protocol.toUpperCase()} یافت نشد.`, true);
            return;
        }
        // کپی کردن همه کانفیگ‌ها با جداکننده خط جدید
        window.copyToClipboardAndShowQr(configs.join('\n'), `همه کانفیگ‌های ${protocol.toUpperCase()} کپی شدند!`, false);
    };

    /**
     * @description نمایش QR Code برای همه کانفیگ‌های یک پروتکل.
     */
    window.showProtocolConfigsQr = (coreName, protocol) => {
        const selector = `#${coreName}-section .protocol-group[data-protocol="${protocol}"] .config-item`;
        const configs = Array.from(document.querySelectorAll(selector)).map(el => el.dataset.url);
        if (configs.length === 0) {
            showToast(`کانفیگی برای پروتکل ${protocol.toUpperCase()} یافت نشد.`, true);
            return;
        }
        // نمایش QR Code برای همه کانفیگ‌ها (جدا شده با خط جدید)
        window.openQrModal(configs.join('\n'));
    };

    const parseConfigForPing = (configUrl) => { /* ... (Same as before) ... */ 
        try {
            const urlObj = new URL(configUrl);
            const protocol = urlObj.protocol.replace(':', '');
            const params = new URLSearchParams(urlObj.search);
            let host = urlObj.hostname;
            let port = parseInt(urlObj.port);
            let tls = params.get('security') === 'tls';
            let sni = params.get('sni') || urlObj.hostname;
            
            if (protocol === 'vmess') {
                const decodedData = JSON.parse(atob(configUrl.replace('vmess://', '')));
                host = decodedData.add;
                port = parseInt(decodedData.port);
                tls = decodedData.tls === 'tls';
                sni = decodedData.sni || decodedData.host || decodedData.add;
            } else if (protocol === 'trojan') {
                tls = true;
            }
            
            return { host, port, tls, sni };
        } catch(e) {
            return null;
        }
    };

    window.runPingTest = async (coreName) => {
        const wrapper = getEl(coreName === 'xray' ? 'xray-content-wrapper' : 'singbox-content-wrapper');
        const pingButton = getEl(`ping-${coreName}-btn`);
        pingButton.disabled = true;
        const loader = `<span class="loader-small"></span>`;
        pingButton.innerHTML = `${loader} درحال تست پینگ... ( ${PING_BATCH_SIZE} تایی)`;
        
        const allConfigs = Array.from(wrapper.querySelectorAll('.config-item'));
        const totalConfigs = allConfigs.length;
        let processedCount = 0;
        
        for (let i = 0; i < totalConfigs; i += PING_BATCH_SIZE) {
            const batch = allConfigs.slice(i, i + PING_BATCH_SIZE);
            const promises = batch.map(configElement => testSingleConfig(configElement, totalConfigs));
            
            await Promise.allSettled(promises);
            processedCount += batch.length;
            pingButton.innerHTML = `${loader} درحال تست پینگ... (${processedCount}/${totalConfigs})`;
        }
        
        // --- Sorting and Re-rendering Logic (Same as before) ---
        const sortedConfigs = allConfigs.sort((a, b) => parseInt(a.dataset.ping) - parseInt(b.dataset.ping));
        wrapper.querySelectorAll('.config-list').forEach(ul => ul.innerHTML = '');
        const grouped = {};
        sortedConfigs.forEach(el => {
            const protocol = el.dataset.url.split('://')[0].replace('hysteria2', 'hy2').replace('shadowsocks', 'ss');
            if (!grouped[protocol]) grouped[protocol] = [];
            grouped[protocol].push(el);
        });

        for (const protocol in grouped) {
            const ul = wrapper.querySelector(`.protocol-group[data-protocol="${protocol}"] .config-list`);
            if (ul) grouped[protocol].forEach(el => ul.appendChild(el));
        }

        pingButton.disabled = false;
        pingButton.innerHTML = 'تست پینگ';
        showToast('تست پینگ به پایان رسید.');
    };

    const testSingleConfig = async (configElement) => {
        const url = configElement.dataset.url;
        const pingResultEl = configElement.querySelector('.ping-result');
        const pingInfo = parseConfigForPing(url);
        
        if (!pingInfo) {
            pingResultEl.textContent = 'خطا';
            pingResultEl.style.color = 'red';
            return;
        }
        
        const workerUrl = getNextWorkerUrl();

        try {
            const response = await fetch(`${workerUrl}/ping`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pingInfo),
                signal: AbortSignal.timeout(PING_TIMEOUT)
            });
            const result = await response.json();
            
            if (response.ok && result.status === 'Live' && result.latency > 0 && result.latency < 99999) {
                const ping = result.latency;
                pingResultEl.textContent = `${ping}ms`;
                if (ping < 200) pingResultEl.style.color = 'var(--ping-good)';
                else if (ping < 500) pingResultEl.style.color = 'var(--ping-medium)';
                else pingResultEl.style.color = 'var(--ping-bad)';
                configElement.dataset.ping = ping;
            } else {
                pingResultEl.textContent = 'خطا';
                pingResultEl.style.color = 'red';
                configElement.dataset.ping = '99999';
            }
        } catch (err) {
            pingResultEl.textContent = 'خطا';
            pingResultEl.style.color = 'red';
            configElement.dataset.ping = '99999';
        }
    };
    
    // ✅ تابع generateSubscriptionUrl: حذف Base64/Raw و فقط مدیریت URLهای v2v
    window.generateSubscriptionUrl = async (coreName, type, client, method) => {
        const configs = (type === 'all')
            ? Array.from(document.querySelectorAll(`#${coreName}-section .config-item`)).map(el => el.dataset.url)
            : Array.from(document.querySelectorAll(`#${coreName}-section .config-item input.config-checkbox:checked`)).map(el => el.closest('.config-item').dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }

        const workerUrl = getNextWorkerUrl();

        try {
            const response = await fetch(`${workerUrl}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs, uuid: userUuid, core: coreName }), 
            });
            if (!response.ok) throw new Error('خطا در ایجاد لینک اشتراک.');
            const result = await response.json();
            userUuid = result.uuid;
            localStorage.setItem('v2v_user_uuid', userUuid);

            let url = '';
            // URLهای کوتاه با امضای v2v خروجی داده می‌شوند
            if (client === 'clash') url = result.clashSubscriptionUrl;
            else if (client === 'singbox') url = result.singboxSubscriptionUrl;
            
            if (method === 'copy') window.copyToClipboardAndShowQr(url);
            else if (method === 'qr') openQrModal(url); 
            else if (method === 'download') { 
                window.open(url, '_blank');
            }
        } catch (err) {
            showToast(err.message || 'خطا در ایجاد لینک اشتراک', true);
        }
    };
    
    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
