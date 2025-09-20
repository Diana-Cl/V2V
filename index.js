document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const WORKER_URLS = [
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    const workerUrl = WORKER_URLS[Math.floor(Math.random() * WORKER_URLS.length)]; // Load balance on client side
    const PING_TIMEOUT = 5000; // 5 seconds for each ping test

    // --- DOM Elements ---
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');
    let userUuid = localStorage.getItem('v2v_user_uuid') || null;

    // --- Helper & Utility Functions ---
    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    const copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) {
            showToast('خطا در کپی کردن!', true);
            console.error('Clipboard copy failed:', err);
        }
    };

    const openQrModal = (text) => {
        if (!window.QRCode) {
            showToast('کتابخانه QR در حال بارگذاری است...', true);
            return;
        }
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256 });
        qrModal.style.display = 'flex';
    };

    // --- Core Logic: Fetching and Rendering ---
    const fetchAndRender = async () => {
        statusBar.textContent = 'در حال دریافت کانفیگ‌ها...';
        try {
            const response = await fetch(`${workerUrl}/configs`);
            if (!response.ok) throw new Error(`سرور با خطا پاسخ داد: ${response.status}`);
            const data = await response.json();
            const cacheVersion = response.headers.get('X-Cache-Version');
            statusBar.textContent = cacheVersion ? `آخرین بروزرسانی: ${new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR')}` : 'کانفیگ‌ها دریافت شدند.';
            renderCore('xray', data.xray, xrayWrapper);
            renderCore('singbox', data.singbox, singboxWrapper);
        } catch (error) {
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast(error.message, true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">${error.message}</div>`;
        }
    };

    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگی برای هسته ${coreName} یافت نشد.</div>`;
            return;
        }

        let html = `
            <button class="test-button" id="test-button-${coreName}" onclick="runPingTest('${coreName}')">
                <span class="test-button-text">🚀 تست پینگ همه کانفیگ‌ها</span>
            </button>
            <div class="action-group-title">ساخت اشتراک شخصی</div>
            <div class="action-box">
                <span class="action-box-label">لینک V2Ray/Sing-box</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'sub')">کپی URL</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">لینک Clash</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'clash', 'download')">دانلود</button>
                    <button class="action-btn-small" onclick="createPersonalSubscription('${coreName}', 'clash', 'copy')">کپی URL</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            html += `
                <div class="protocol-group" id="${coreName}-${protocol}-group">
                    <div class="protocol-header" onclick="this.parentElement.classList.toggle('open')">
                        <span>${protocol.toUpperCase()} (${configs.length})</span>
                        <span class="toggle-icon">▼</span>
                    </div>
                    <ul class="config-list">
                        ${configs.map(config => {
                            const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                            let name = 'v2v-config';
                            try { name = decodeURIComponent(new URL(config).hash.substring(1) || new URL(config).hostname); } catch {}
                            return `
                                <li class="config-item" data-config='${safeConfig}'>
                                    <input type="checkbox" class="config-checkbox">
                                    <div class="config-details">
                                        <span class="server">${name}</span>
                                    </div>
                                    <div class="ping-result-container"></div>
                                    <button class="copy-btn" onclick="copyToClipboard('${safeConfig}')">کپی</button>
                                    <button class="copy-btn" onclick="openQrModal('${safeConfig}')">QR</button>
                                </li>
                            `;
                        }).join('')}
                    </ul>
                </div>
            `;
        }
        wrapper.innerHTML = html;
    };

    // --- Ping Test Logic ---
    const parseConfigForPing = (configStr) => {
        try {
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.substring(8)));
                return { host: data.add, port: parseInt(data.port), transport: data.net || 'tcp' };
            }
            const url = new URL(configStr);
            const params = new URLSearchParams(url.search);
            const protocol = url.protocol.replace(':', '').toLowerCase();
            let transport = params.get('type') || 'tcp';
            if (['hysteria2', 'hy2', 'tuic'].includes(protocol)) transport = 'webtransport';
            return { host: url.hostname, port: parseInt(url.port), transport };
        } catch {
            return null;
        }
    };

    const testViaWorkerBridge = async (host, port) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT);
            const response = await fetch(`${workerUrl}/tcp-probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) return { latency: null };
            return await response.json();
        } catch {
            return { latency: null };
        }
    };

    const testViaWebTransport = async (host, port) => {
        if (typeof WebTransport === 'undefined') return { latency: null, error: 'Unsupported' };
        return new Promise(resolve => {
            let transport;
            const timeout = setTimeout(() => {
                if (transport?.state === 'connecting') transport.close();
                resolve({ latency: null });
            }, PING_TIMEOUT);

            try {
                const startTime = Date.now();
                transport = new WebTransport(`https://${host}:${port}`);
                transport.ready.then(() => {
                    clearTimeout(timeout);
                    transport.close();
                    resolve({ latency: Date.now() - startTime });
                }).catch(() => {
                    clearTimeout(timeout);
                    resolve({ latency: null });
                });
            } catch {
                clearTimeout(timeout);
                resolve({ latency: null });
            }
        });
    };

    window.runPingTest = async (coreName) => {
        const testButton = getEl(`test-button-${coreName}`);
        const buttonText = testButton.querySelector('.test-button-text');
        if (testButton.disabled) return;
        testButton.disabled = true;

        const allItems = Array.from(document.querySelectorAll(`#${coreName}-section .config-item`));
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            buttonText.innerHTML = `<span class="loader"></span> تست ${i + 1} از ${allItems.length}`;
            const configData = parseConfigForPing(item.dataset.config);
            const resultContainer = item.querySelector('.ping-result-container');

            if (!configData) {
                resultContainer.innerHTML = `<strong style="color:var(--ping-bad);">❌ نامعتبر</strong>`;
                continue;
            }

            const result = (configData.transport === 'webtransport')
                ? await testViaWebTransport(configData.host, configData.port)
                : await testViaWorkerBridge(configData.host, configData.port);

            let resultText, color, type = (configData.transport === 'webtransport') ? 'WT' : 'TCP';
            if (result.latency === null) {
                resultText = `❌ ${result.error || 'ناموفق'}`;
                color = 'var(--ping-bad)';
            } else {
                resultText = `[${type}] ${result.latency}ms`;
                color = result.latency < 500 ? 'var(--ping-good)' : (result.latency < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)');
            }
            resultContainer.innerHTML = `<strong style="color:${color};">${resultText}</strong>`;
        }

        buttonText.textContent = '🚀 تست مجدد پینگ';
        testButton.disabled = false;
    };

    // --- Personal Subscription Logic ---
    window.createPersonalSubscription = async (coreName, format, method = 'copy') => {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${coreName}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) {
            showToast('لطفا حداقل یک کانفیگ را انتخاب کنید!', true);
            return;
        }

        showToast('در حال ساخت لینک اشتراک...', false);
        try {
            const response = await fetch(`${workerUrl}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: selectedConfigs, uuid: userUuid }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);

            userUuid = data.uuid; // Save the new or existing UUID
            localStorage.setItem('v2v_user_uuid', userUuid);

            const urlToUse = format === 'clash' ? data.clashSubscriptionUrl : data.subscriptionUrl;

            if (method === 'download' && format === 'clash') {
                window.open(urlToUse, '_blank');
                showToast('دانلود فایل Clash آغاز شد.');
            } else {
                await copyToClipboard(urlToUse, 'لینک اشتراک کپی شد!');
                openQrModal(urlToUse);
            }
        } catch (error) {
            showToast(`خطا: ${error.message}`, true);
        }
    };


    // --- Init & Event Listeners ---
    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
