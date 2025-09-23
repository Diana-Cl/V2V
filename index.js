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
        'https://smbcryp.github.io/v2v-data/configs.json',
        'https://v2v-vercel.vercel.app/api/configs',
    ];

    const PING_TIMEOUT = 5000;
    const CONCURRENT_PINGS_PER_WORKER = 5;
    const MAX_CONCURRENT_PINGS = WORKER_URLS.length * CONCURRENT_PINGS_PER_WORKER;

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
        } catch (err) {
            showToast('خطا در کپی کردن!', true);
        }
    };

    const openQrModal = (text) => {
        if (!window.QRCode) {
            showToast('کتابخانه QR در حال بارگذاری است...', true);
            return;
        }
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H });
        qrModal.style.display = 'flex';
    };

    // --- Core Logic ---
    const fetchWithFailover = async (urls) => {
        for (const url of urls) {
            try {
                const fetchUrl = new URL(url);
                if (!url.includes('workers.dev')) {
                    fetchUrl.searchParams.set('v', Date.now());
                }
                const response = await fetch(fetchUrl.toString());
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
            
            statusBar.textContent = cacheVersion 
                ? `آخرین بروزرسانی: ${new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}` 
                : 'کانفیگ‌ها از منبع استاتیک دریافت شدند.';
            
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

        let html = `
            <button class="test-button" id="test-button-${coreName}" onclick="window.runPingTest('${coreName}')">
                <span class="test-button-text">🚀 تست پینگ همه کانفیگ‌ها</span>
            </button>
            <div class="action-group-title">ساخت اشتراک شخصی</div>
            <div class="action-box"><span class="action-box-label">لینک اشتراک / Sub-link</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'raw', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'raw', 'qr')">QR Code</button></div></div>
            <div class="action-box"><span class="action-box-label">لینک Clash</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'clash', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'clash', 'qr')">QR Code</button></div></div>
            <div class="action-box"><span class="action-box-label">لینک Sing-box</span><div class="action-box-buttons"><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'singbox', 'copy')">کپی URL</button><button class="action-btn-small" onclick="window.createPersonalSubscription('${coreName}', 'singbox', 'qr')">QR Code</button></div></div>
            <div class="config-list-container" id="${coreName}-config-list-container"></div>`;

        wrapper.innerHTML = html;
        const configListContainer = getEl(`${coreName}-config-list-container`);
        
        let allConfigsForCore = [];
        for (const protocol in coreData) {
            coreData[protocol].forEach(configUrl => {
                allConfigsForCore.push({
                    protocol: protocol,
                    url: configUrl,
                    latency: Infinity,
                    status: 'Untested',
                    name: (() => { try { return decodeURIComponent(new URL(configUrl).hash.substring(1) || new URL(configUrl).hostname); } catch { return 'v2v-config'; }})()
                });
            });
        }
        renderConfigItems(configListContainer, allConfigsForCore);
    };

    const renderConfigItems = (containerElement, configsArray) => {
        containerElement.innerHTML = '';
        const fragment = document.createDocumentFragment();

        configsArray.forEach(cfg => {
            const safeConfig = cfg.url.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
            const li = document.createElement('li');
            li.className = 'config-item';
            li.dataset.config = safeConfig;
            li.id = `config-item-${btoa(cfg.url).replace(/=/g, '')}`;
            
            let color = 'var(--text-color)';
            let resultText = '';
            if (cfg.latency !== Infinity) {
                resultText = `${cfg.latency}ms`;
                color = cfg.latency < 500 ? 'var(--ping-good)' : (cfg.latency < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)');
            } else if (cfg.status === 'Dead') {
                resultText = '❌ ناموفق';
                color = 'var(--ping-bad)';
            } else if (cfg.status === 'Testing') {
                resultText = `<span class="loader-small"></span>`;
                color = '#ffab40';
            }
            li.innerHTML = `<input type="checkbox" class="config-checkbox"><div class="config-details"><span class="server">${cfg.name}</span> <span class="protocol-badge">${cfg.protocol}</span></div><div class="ping-result-container" style="color:${color};">${resultText}</div><button class="copy-btn" onclick="copyToClipboard('${safeConfig}')">کپی</button>`;
            fragment.appendChild(li);
        });
        containerElement.appendChild(fragment);
    };

    const parseConfigForPing = (configUrl) => {
        try {
            if (configUrl.startsWith('vmess://')) {
                const data = JSON.parse(atob(configUrl.substring(8)));
                return { host: data.add, port: parseInt(data.port), protocol: 'vmess', tls: data.tls === 'tls', sni: data.sni || data.host };
            }
            const url = new URL(configUrl);
            const params = new URLSearchParams(url.search);
            const scheme = url.protocol.replace(':', '');
            const tls = (params.get('security') === 'tls' || scheme === 'trojan' || ['hy2', 'hysteria2'].includes(scheme));
            const sni = params.get('sni') || url.hostname;
            return { host: url.hostname, port: parseInt(url.port), protocol: scheme, tls, sni };
        } catch(e) { 
            return null; 
        }
    };
    
    window.runPingTest = async (coreName) => {
        const testButton = getEl(`test-button-${coreName}`);
        if (testButton.disabled) return;
        testButton.disabled = true;

        const configListContainer = getEl(`${coreName}-config-list-container`);
        let allConfigsForCore = [];
        for (const protocol in allLiveConfigsData[coreName]) {
            allLiveConfigsData[coreName][protocol].forEach(configUrl => {
                allConfigsForCore.push({
                    protocol,
                    url: configUrl,
                    latency: Infinity,
                    status: 'Untested',
                    name: (() => { try { return decodeURIComponent(new URL(configUrl).hash.substring(1) || new URL(configUrl).hostname); } catch { return 'v2v-config'; }})()
                });
            });
        }
        
        const configsToTest = [...allConfigsForCore];
        const totalConfigs = configsToTest.length;
        let testedCount = 0;
        let workerIndex = 0;

        configsToTest.forEach(cfg => {
            cfg.status = 'Testing';
            const li = getEl(`config-item-${btoa(cfg.url).replace(/=/g, '')}`);
            if (li) li.querySelector('.ping-result-container').innerHTML = `<span class="loader-small"></span>`;
        });
        
        const testPromises = configsToTest.map(cfg => {
            return (async () => {
                const configData = parseConfigForPing(cfg.url);
                if (!configData) {
                    cfg.status = 'Dead';
                    return;
                }
                
                const currentWorkerUrl = WORKER_URLS[workerIndex++ % WORKER_URLS.length];
                try {
                    const response = await fetch(`${currentWorkerUrl}/ping`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(configData),
                        signal: AbortSignal.timeout(PING_TIMEOUT)
                    });
                    const result = await response.json();
                    cfg.status = result.status;
                    cfg.latency = result.latency !== null ? result.latency : Infinity;
                } catch (e) {
                    cfg.status = 'Dead';
                    cfg.latency = Infinity;
                } finally {
                    testedCount++;
                    testButton.querySelector('.test-button-text').textContent = `تست ${testedCount} از ${totalConfigs}`;
                    allConfigsForCore.sort((a, b) => a.latency - b.latency);
                    renderConfigItems(configListContainer, allConfigsForCore);
                }
            })();
        });

        await Promise.all(testPromises);
        testButton.querySelector('.test-button-text').textContent = '🚀 تست مجدد پینگ';
        testButton.disabled = false;
        showToast('تست پینگ کامل شد.');
    };

    window.createPersonalSubscription = async (coreName, format, method) => {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${coreName}-config-list-container .config-checkbox:checked`))
            .map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) {
            showToast('لطفا حداقل یک کانفیگ را انتخاب کنید!', true); return;
        }
        showToast('در حال ساخت لینک اشتراک...', false);
        const activeWorkerUrl = WORKER_URLS[Math.floor(Math.random() * WORKER_URLS.length)];
        try {
            const response = await fetch(`${activeWorkerUrl}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: selectedConfigs, uuid: userUuid }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'خطای ناشناخته');
            userUuid = data.uuid;
            localStorage.setItem('v2v_user_uuid', userUuid);
            const urlToUse = format === 'clash' ? data.clashSubscriptionUrl : (format === 'singbox' ? data.singboxSubscriptionUrl : data.subscriptionUrl);
            if (method === 'copy') await copyToClipboard(urlToUse, 'لینک اشتراک کپی شد!');
            else if (method === 'qr') openQrModal(urlToUse);
        } catch (error) {
            showToast(`خطا: ${error.message}`, true);
        }
    };

    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
