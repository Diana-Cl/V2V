// index.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const WORKER_URLS = [
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    
    const FALLBACK_STATIC_URLS = [
        'https://smbcryp.github.io/v2v-data/all_live_configs.json',
        'https://v2v-vercel.vercel.app/api/configs', // Assuming Vercel serves the same structure
    ];

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
    const fetchWithFailover = async (urls) => {
        for (const url of urls) {
            try {
                const fetchUrl = new URL(url);
                if (!url.includes('workers.dev')) fetchUrl.searchParams.set('v', Date.now());
                const response = await fetch(fetchUrl.toString(), { signal: AbortSignal.timeout(8000) });
                if (!response.ok) throw new Error(`Status ${response.status}`);
                console.log(`Successfully fetched from: ${url}`);
                return response;
            } catch (error) {
                console.warn(`Failed to fetch from ${url}:`, error.message);
            }
        }
        throw new Error('تمام منابع دریافت کانفیگ از دسترس خارج هستند.');
    };
    
    let allLiveConfigsData = null;

    const fetchAndRender = async () => {
        statusBar.textContent = 'در حال دریافت کانفیگ‌ها...';
        try {
            const shuffledWorkers = WORKER_URLS.sort(() => 0.5 - Math.random());
            const allSources = [...shuffledWorkers.map(u => `${u}/configs`), ...FALLBACK_STATIC_URLS];
            const response = await fetchWithFailover(allSources);
            allLiveConfigsData = await response.json();
            const cacheVersion = response.headers.get('X-Cache-Version');
            statusBar.textContent = cacheVersion ? `آخرین بروزرسانی: ${new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}` : 'کانفیگ‌ها از منبع استاتیک دریافت شدند.';
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast(error.message, true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">${error.message}</div>`;
        }
    };

    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگی برای هسته ${coreName} یافت نشد.</div>`; return;
        }
        let html = `<button class="test-button" id="test-button-${coreName}" onclick="window.runPingTest('${coreName}')"><span class="test-button-text">🚀 تست پینگ همه کانفیگ‌ها</span></button>
            <div class="action-group-title">ساخت اشتراک شخصی</div>
            <div class="action-box"><span class="action-box-label">لینک اشتراک / Sub-link</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'raw', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'raw', 'qr')">QR Code</button></div></div>
            <div class="action-box"><span class="action-box-label">لینک Clash</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'clash', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'clash', 'qr')">QR Code</button></div></div>
            <div class="action-box"><span class="action-box-label">لینک Sing-box</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'singbox', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'singbox', 'qr')">QR Code</button></div></div>`;
        
        for (const protocol in coreData) {
            html += `<div class="protocol-group open" id="${coreName}-${protocol}-group">
                <div class="protocol-header" onclick="this.parentElement.classList.toggle('open')"><span>${protocol.toUpperCase()} (${coreData[protocol].length})</span><span class="toggle-icon">▼</span></div>
                <ul class="config-list">
                    ${coreData[protocol].map(config => {
                        const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                        let name = 'v2v-config'; try { name = decodeURIComponent(new URL(config).hash.substring(1) || new URL(config).hostname); } catch {}
                        return `<li class="config-item" data-config='${safeConfig}' id="config-item-${btoa(config).replace(/=/g, '')}"><input type="checkbox" class="config-checkbox"><div class="config-details"><span class="server">${name}</span></div><div class="ping-result-container"></div><button class="copy-btn" onclick="copyToClipboard('${safeConfig}')">کپی</button><button class="copy-btn" onclick="openQrModal('${safeConfig}')">QR</button></li>`;
                    }).join('')}
                </ul></div>`;
        }
        wrapper.innerHTML = html;
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
            const tls = (params.get('security') === 'tls' || scheme === 'trojan' || ['hy2', 'hysteria2'].includes(scheme));
            const sni = params.get('sni') || url.hostname;
            return { host: url.hostname, port: parseInt(url.port), tls, sni };
        } catch { return null; }
    };
    
    window.runPingTest = async (coreName) => {
        const testButton = getEl(`test-button-${coreName}`);
        if (testButton.disabled) return;
        testButton.disabled = true;

        const allItems = Array.from(document.querySelectorAll(`#${coreName}-section .config-item`));
        allItems.forEach(item => item.dataset.latency = Infinity); // Reset latency
        
        let workerIndex = 0;
        const testPromises = allItems.map(item => (async () => {
            const resultContainer = item.querySelector('.ping-result-container');
            resultContainer.innerHTML = `<span class="loader-small"></span>`;
            
            const configData = parseConfigForPing(item.dataset.config);
            if (!configData) {
                resultContainer.innerHTML = `<strong style="color:var(--ping-bad);">❌</strong>`; return;
            }
            
            const currentWorkerUrl = WORKER_URLS[workerIndex++ % WORKER_URLS.length];
            try {
                const response = await fetch(`${currentWorkerUrl}/ping`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(configData), signal: AbortSignal.timeout(PING_TIMEOUT)
                });
                const result = await response.json();
                if (result.status === 'Live') {
                    item.dataset.latency = result.latency;
                    resultContainer.innerHTML = `<strong style="color:${result.latency < 500 ? 'var(--ping-good)' : (result.latency < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)')};">${result.latency}ms</strong>`;
                } else {
                    resultContainer.innerHTML = `<strong style="color:var(--ping-bad);">❌</strong>`;
                }
            } catch (e) {
                resultContainer.innerHTML = `<strong style="color:var(--ping-bad);">❌</strong>`;
            }
        })());

        let completed = 0;
        testPromises.forEach(p => p.finally(() => {
            completed++;
            testButton.querySelector('.test-button-text').textContent = `تست ${completed} از ${allItems.length}`;
            if (completed === allItems.length) {
                const protocolGroups = document.querySelectorAll(`#${coreName}-section .protocol-group`);
                protocolGroups.forEach(group => {
                    const configsInGroup = Array.from(group.querySelectorAll('.config-item'));
                    configsInGroup.sort((a, b) => a.dataset.latency - b.dataset.latency);
                    configsInGroup.forEach(li => group.querySelector('.config-list').appendChild(li));
                });
                testButton.querySelector('.test-button-text').textContent = '🚀 تست مجدد پینگ';
                testButton.disabled = false;
                showToast('تست پینگ کامل شد.');
            }
        }));
    };

    window.createPersonalSubscription = async (coreName, format, method = 'copy') => {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${coreName}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) { showToast('لطفا حداقل یک کانفیگ را انتخاب کنید!', true); return; }
        showToast('در حال ساخت لینک اشتراک...', false);
        const activeWorkerUrl = WORKER_URLS[Math.floor(Math.random() * WORKER_URLS.length)];
        try {
            const response = await fetch(`${activeWorkerUrl}/create-personal-sub`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: selectedConfigs, uuid: userUuid }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'خطای ناشناخته');
            userUuid = data.uuid;
            localStorage.setItem('v2v_user_uuid', userUuid);
            const urlToUse = format === 'clash' ? data.clashSubscriptionUrl : (format === 'singbox' ? data.singboxSubscriptionUrl : data.subscriptionUrl);
            if (method === 'copy' || (method === 'download' && format !== 'clash')) {
                 await copyToClipboard(urlToUse, 'لینک اشتراک کپی شد!');
                 if(method === 'qr') openQrModal(urlToUse);
            } else if(method === 'download' && format === 'clash'){
                window.open(urlToUse, '_blank');
            } else if (method === 'qr') {
                 openQrModal(urlToUse);
            }
        } catch (error) { showToast(`خطا: ${error.message}`, true); }
    };

    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
