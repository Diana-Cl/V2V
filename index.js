document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    // Use relative path for static files to ensure mirror independence
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 5000;
    
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

    const copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) { showToast('خطا در کپی کردن!', true); }
    };

    const openQrModal = (text) => {
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

        const runPingButton = `<button class="test-button" onclick="runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;

        let contentHtml = runPingButton + `
            ${actionGroupTitle('دریافت کانفیگ')}
            <div class="action-box">
                <span class="action-box-label">لینک تک‌کانفیگ</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'base64', 'copy')">کپی</button>
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'base64', 'qr')">QR</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'sub', 'copy')">کپی</button>
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'sub', 'qr')">QR</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            if (configs.length === 0) continue;
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1);
            contentHtml += `
                <div class="protocol-group">
                    <div class="protocol-header">
                        ${protocolName} (${configs.length})
                        <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                    </div>
                    <ul class="config-list">
                        ${configs.map(cfg => `
                            <li class="config-item" data-url="${cfg[0]}" data-ping="${cfg[1] || '0'}">
                                <input type="checkbox" class="config-checkbox" checked>
                                <div class="config-details">
                                    <span class="server">${cfg[0]}</span>
                                </div>
                                <div class="ping-result-container">
                                    <span class="ping-result" style="color: grey;">${cfg[1] || '---'}ms</span>
                                </div>
                                <button class="copy-btn" onclick="window.copyToClipboard('${cfg[0]}', 'کانفیگ کپی شد!')">کپی</button>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }

        wrapper.innerHTML = contentHtml;
        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', () => {
                header.parentElement.classList.toggle('open');
            });
        });
    };

    const parseConfigForPing = (configUrl) => {
        try {
            if (configUrl.startsWith('vmess://')) {
                const data = JSON.parse(atob(configUrl.substring(8)));
                return { host: data.add, port: parseInt(data.port), tls: data.tls === 'tls', sni: data.sni || data.host };
            }
            const url = new URL(configUrl);
            const params = new URLSearchParams(url.search);
            const scheme = url.protocol.replace(':', '');
            const tls = (params.get('security') === 'tls' || scheme === 'trojan' || ['hy2', 'hysteria2', 'tuic'].includes(scheme) || params.get('tls') === '1');
            const sni = params.get('sni') || url.hostname;
            return { host: url.hostname, port: parseInt(url.port), tls, sni };
        } catch { return null; }
    };

    window.runPingTest = async (coreName) => {
        const wrapper = getEl(coreName === 'xray' ? 'xray-content-wrapper' : 'singbox-content-wrapper');
        const pingButton = getEl(`ping-${coreName}-btn`);
        pingButton.disabled = true;
        const loader = `<span class="loader-small"></span>`;
        pingButton.innerHTML = `${loader} درحال تست پینگ...`;
        
        const allConfigs = Array.from(wrapper.querySelectorAll('.config-item'));
        
        const testSingleConfig = async (configElement) => {
            const url = configElement.dataset.url;
            const pingResultEl = configElement.querySelector('.ping-result');
            const pingInfo = parseConfigForPing(url);
            
            if (!pingInfo) {
                pingResultEl.textContent = 'خطا';
                pingResultEl.style.color = 'red';
                return;
            }

            try {
                // Here we still call a Worker, but only for the ping test, which is a specific task.
                // The main config fetching is now local. This is a deliberate design choice.
                const workerUrl = `https://v2v-proxy.mbrgh87.workers.dev/ping?host=${pingInfo.host}&port=${pingInfo.port}&tls=${pingInfo.tls}`;
                const response = await fetch(workerUrl, { signal: AbortSignal.timeout(PING_TIMEOUT) });
                const result = await response.json();
                
                if (result.status === 'ok') {
                    pingResultEl.textContent = `${result.ping}ms`;
                    if (result.ping < 200) pingResultEl.style.color = 'var(--ping-good)';
                    else if (result.ping < 500) pingResultEl.style.color = 'var(--ping-medium)';
                    else pingResultEl.style.color = 'var(--ping-bad)';
                    configElement.dataset.ping = result.ping;
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

        const promises = allConfigs.map(testSingleConfig);
        await Promise.allSettled(promises);
        
        // Sort configs after ping test
        const sortedConfigs = allConfigs.sort((a, b) => parseInt(a.dataset.ping) - parseInt(b.dataset.ping));
        const ul = wrapper.querySelector('.config-list');
        sortedConfigs.forEach(el => ul.appendChild(el));

        pingButton.disabled = false;
        pingButton.innerHTML = 'تست پینگ';
        showToast('تست پینگ به پایان رسید.');
    };

    window.createPersonalSubscription = async (coreName, format, method = 'copy') => {
        const configs = Array.from(document.querySelectorAll(`#${coreName}-section .config-item`))
                            .filter(el => el.querySelector('.config-checkbox').checked)
                            .map(el => el.dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }

        let content = '';
        if (format === 'base64') {
            content = btoa(unescape(encodeURIComponent(configs.join('\n'))));
        } else if (format === 'sub') {
            const workerUrl = `https://v2v-proxy.mbrgh87.workers.dev/sub?core=${coreName}&uuid=${userUuid || 'none'}`;
            try {
                const response = await fetch(workerUrl, {
                    method: 'POST',
                    body: JSON.stringify(configs),
                    headers: { 'Content-Type': 'application/json' },
                });
                if (!response.ok) throw new Error('خطا در ایجاد لینک اشتراک.');
                content = await response.text();
            } catch (err) {
                showToast(err.message, true);
                return;
            }
        }
        
        if (method === 'copy') {
            copyToClipboard(content);
        } else if (method === 'qr') {
            openQrModal(content);
        }
    };

    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
