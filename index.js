document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 8000; // Increased to 8 seconds as per scraper.py config
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
    const PING_BATCH_SIZE = 50; // As per saved GITHUB_SEARCH_LIMIT guidance
    
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

    window.copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) { showToast('خطا در کپی کردن!', true); }
    };

    window.openQrModal = (text) => {
        if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; }
        qrContainer.innerHTML = '';
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

    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;
        const coreClient = coreName === 'xray' ? 'xray' : 'singbox';
        
        // 4. نهایی‌سازی ۸ حالت لینک اشتراک
        let contentHtml = runPingButton + `
            ${actionGroupTitle('لینک اشتراک Base64 (خام)')}
            <div class="action-box">
                <span class="action-box-label">اشتراک Base64</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'raw', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'raw', 'copy')">همه (کپی)</button>
                </div>
            </div>

            ${actionGroupTitle('لینک اشتراک YAML (قابل استفاده در Clash, Sing-box, Stash)')}
            <div class="action-box">
                <span class="action-box-label">اشتراک YAML (کلش)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'copy')">همه (کپی)</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">اشتراک JSON (سینگ‌باکس)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'copy')">همه (کپی)</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            // Skip protocols with no configs after scraper grouping
            if (configs.length === 0) continue; 
            
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1).replace('ss', 'Shadowsocks').replace('hy2', 'Hysteria2');
            
            // 2. افزودن دکمه "کپی همه" برای هر پروتکل
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <div class="action-box-buttons">
                             <button class="action-btn-small" onclick="window.copyProtocolConfigs('${coreName}', '${protocol}')">کپی همه</button>
                             <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                        </div>
                    </div>
                    <ul class="config-list">
                        ${configs.map((cfg, index) => `
                            <li class="config-item" data-url="${cfg[0]}" data-ping="${cfg[1] || '0'}">
                                <input type="checkbox" class="config-checkbox" id="${coreName}-${protocol}-${index}">
                                <div class="config-details">
                                    <label for="${coreName}-${protocol}-${index}" class="server">${cfg[0]}</label>
                                </div>
                                <div class="ping-result-container">
                                    <span class="ping-result" style="color: grey;">${cfg[1] || '---'}ms</span>
                                </div>
                                <button class="copy-btn" onclick="window.copyToClipboard('${cfg[0]}', 'کانفیگ کپی شد!')">کپی</button>
                                <button class="copy-btn" onclick="window.openQrModal('${cfg[0]}')">QR</button>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }

        wrapper.innerHTML = contentHtml;
        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            // Check if the header contains the button group, and if so, only toggle when clicking on the non-button area
            const toggleElement = header.querySelector('span'); 
            if(toggleElement) {
                toggleElement.addEventListener('click', () => {
                    header.closest('.protocol-group').classList.toggle('open');
                });
            } else { // Fallback for general header click
                header.addEventListener('click', (e) => {
                    // Prevent propagation if user clicks button inside header
                    if(e.target.tagName !== 'BUTTON' && e.target.closest('.action-box-buttons') === null) {
                        header.closest('.protocol-group').classList.toggle('open');
                    }
                });
            }
        });
    };

    window.copyProtocolConfigs = (coreName, protocol) => {
        const selector = `#${coreName}-section .protocol-group[data-protocol="${protocol}"] .config-item`;
        const configs = Array.from(document.querySelectorAll(selector)).map(el => el.dataset.url);
        if (configs.length === 0) {
            showToast(`کانفیگی برای پروتکل ${protocol.toUpperCase()} یافت نشد.`, true);
            return;
        }
        window.copyToClipboard(configs.join('\n'), `همه کانفیگ‌های ${protocol.toUpperCase()} کپی شدند!`);
    };

    const parseConfigForPing = (configUrl) => { /* ... (Same as before, used for client-side display) ... */ };

    window.runPingTest = async (coreName) => {
        const wrapper = getEl(coreName === 'xray' ? 'xray-content-wrapper' : 'singbox-content-wrapper');
        const pingButton = getEl(`ping-${coreName}-btn`);
        pingButton.disabled = true;
        const loader = `<span class="loader-small"></span>`;
        pingButton.innerHTML = `${loader} درحال تست پینگ... ( ${PING_BATCH_SIZE} تایی)`;
        
        const allConfigs = Array.from(wrapper.querySelectorAll('.config-item'));
        const totalConfigs = allConfigs.length;
        let processedCount = 0;
        
        // 1. اجرای تست پینگ به صورت دسته‌ای (Batching)
        for (let i = 0; i < totalConfigs; i += PING_BATCH_SIZE) {
            const batch = allConfigs.slice(i, i + PING_BATCH_SIZE);
            const promises = batch.map(configElement => testSingleConfig(configElement, totalConfigs));
            
            // Wait for the entire batch to finish before starting the next one
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

    const testSingleConfig = async (configElement, totalConfigs) => {
        const url = configElement.dataset.url;
        const pingResultEl = configElement.querySelector('.ping-result');
        const pingInfo = parseConfigForPing(url);
        
        if (!pingInfo) {
            pingResultEl.textContent = 'خطا';
            pingResultEl.style.color = 'red';
            return;
        }
        
        // Use Round Robin Worker URL
        const workerUrl = getNextWorkerUrl();

        try {
            const response = await fetch(`${workerUrl}/ping`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pingInfo),
                signal: AbortSignal.timeout(PING_TIMEOUT)
            });
            const result = await response.json();
            
            // 3. فیلترینگ نتایج نامعتبر/خطای کاذب (e.g., latency 0)
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

    // ... (copyConfigs remains the same, but now uses the updated UI structure) ...

    window.copyConfigs = (coreName, type) => {
        const configs = (type === 'all')
            ? Array.from(document.querySelectorAll(`#${coreName}-section .config-item`)).map(el => el.dataset.url)
            : Array.from(document.querySelectorAll(`#${coreName}-section .config-item input.config-checkbox:checked`)).map(el => el.closest('.config-item').dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }
        copyToClipboard(configs.join('\n'));
    };
    
    // Updated to use Round Robin Worker URL
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
                body: JSON.stringify({ configs, uuid: userUuid, core: coreName }), // Pass coreName for filtering
            });
            if (!response.ok) throw new Error('خطا در ایجاد لینک اشتراک.');
            const result = await response.json();
            userUuid = result.uuid;
            localStorage.setItem('v2v_user_uuid', userUuid);

            let url = '';
            if (client === 'clash') url = result.clashSubscriptionUrl;
            else if (client === 'singbox') url = result.singboxSubscriptionUrl;
            else if (client === 'raw') url = result.rawSubscriptionUrl;

            if (method === 'copy') copyToClipboard(url);
            else if (method === 'qr') openQrModal(url);
        } catch (err) {
            showToast(err.message, true);
        }
    };
    
    // Removed old generateClashFile as subscription links cover download and YAML generation

    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
