document.addEventListener('DOMContentLoaded', () => {
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 8000;
    
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    let workerIndex = 0;
    const getNextWorkerUrl = () => {
        const url = WORKER_URLS[workerIndex];
        workerIndex = (workerIndex + 1) % WORKER_URLS.length;
        return url;
    };
    
    const PING_BATCH_SIZE = 30;
    
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');
    let userUuid = localStorage.getItem('v2v_user_uuid') || null;

    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    window.copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) { 
            showToast('خطا در کپی کردن!', true); 
        }
    };

    window.openQrModal = (text) => {
        if (!window.QRCode) { 
            showToast('کتابخانه QR در حال بارگذاری است...', true); 
            return; 
        }
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { 
            text, 
            width: 256, 
            height: 256, 
            correctLevel: QRCode.CorrectLevel.H 
        });
        qrModal.style.display = 'flex';
    };

    qrModal.addEventListener('click', (e) => {
        if (e.target === qrModal) {
            qrModal.style.display = 'none';
        }
    });

    let allLiveConfigsData = null;

    const removeDuplicates = (configs) => {
        const seen = new Set();
        return configs.filter(config => {
            const normalized = config.toLowerCase().trim();
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
    };

    const shortenName = (name, protocol, server) => {
        if (name.length > 30) {
            return `v2v-${protocol}-${server.split('.')[0].slice(0, 10)}`;
        }
        return name;
    };

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { 
                signal: AbortSignal.timeout(10000) 
            });
            if (!configResponse.ok) throw new Error(`HTTP ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            for (const core in allLiveConfigsData) {
                for (const protocol in allLiveConfigsData[core]) {
                    allLiveConfigsData[core][protocol] = removeDuplicates(allLiveConfigsData[core][protocol]);
                }
            }
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { 
                    signal: AbortSignal.timeout(5000) 
                });
                if (versionResponse.ok) {
                    cacheVersion = await versionResponse.text();
                }
            } catch (error) {
                console.warn('Cache version fetch failed:', error);
            }

            const updateTime = new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { 
                dateStyle: 'short', 
                timeStyle: 'short' 
            });
            statusBar.textContent = `آخرین بروزرسانی: ${updateTime}`;
            
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            console.error('Fetch error:', error);
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

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ ${coreName.toUpperCase()}</button>`;
        const copySelectedButton = `<button class="action-btn-wide copy-selected-btn" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;
        
        let contentHtml = runPingButton + `
            ${copySelectedButton} 
            
            ${actionGroupTitle(`لینک اشتراک [${coreName}]`)}
            <div class="action-box">
                <span class="action-box-label">اشتراک YAML (کلش)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'copy')">همه (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'qr')">همه (QR)</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">اشتراک JSON (سینگ‌باکس)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'copy')">همه (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'qr')">همه (QR)</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            if (configs.length === 0) continue; 
            
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1)
                .replace('ss', 'Shadowsocks')
                .replace('hy2', 'Hysteria2')
                .replace('tuic', 'TUIC');
            
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>
                    <ul class="config-list">`;
            
            configs.forEach((config, idx) => {
                try {
                    const urlObj = new URL(config);
                    const server = urlObj.hostname;
                    const port = urlObj.port;
                    const rawName = decodeURIComponent(urlObj.hash.substring(1) || `${protocol}-${server}`);
                    const name = shortenName(rawName, protocol, server);
                    
                    contentHtml += `
                        <li class="config-item">
                            <input type="checkbox" class="config-checkbox" data-core="${coreName}" data-protocol="${protocol}" data-config="${encodeURIComponent(config)}" id="${coreName}-${protocol}-${idx}">
                            <div class="config-details">
                                <label for="${coreName}-${protocol}-${idx}" style="cursor:pointer; font-weight: 500;">${name}</label>
                                <span class="server">${server}:${port}</span>
                            </div>
                            <div class="ping-result-container" id="ping-${coreName}-${protocol}-${idx}"></div>
                            <button class="action-btn-small" onclick="window.copyToClipboard(decodeURIComponent('${encodeURIComponent(config)}'), 'کپی شد!')">کپی</button>
                            <button class="action-btn-small" onclick="window.openQrModal(decodeURIComponent('${encodeURIComponent(config)}'))">QR</button>
                        </li>
                    `;
                } catch (e) {
                    console.error('Config parse error:', e);
                }
            });
            
            contentHtml += `</ul></div>`;
        }

        wrapper.innerHTML = contentHtml;

        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', () => {
                const group = header.closest('.protocol-group');
                group.classList.toggle('open');
            });
        });
    };

    window.copySelectedConfigs = (coreName) => {
        const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
        if (checkboxes.length === 0) {
            showToast('هیچ کانفیگی انتخاب نشده!', true);
            return;
        }
        const configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        const text = configs.join('\n');
        window.copyToClipboard(text, `${configs.length} کانفیگ کپی شد!`);
    };

    window.generateSubscriptionUrl = async (coreName, scope, format, action) => {
        let configs = [];
        
        if (scope === 'selected') {
            const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
            if (checkboxes.length === 0) {
                showToast('هیچ کانفیگی انتخاب نشده!', true);
                return;
            }
            configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        } else if (scope === 'all') {
            const coreData = allLiveConfigsData[coreName];
            for (const protocol in coreData) {
                configs.push(...coreData[protocol]);
            }
        }

        if (configs.length === 0) {
            showToast('کانفیگی یافت نشد!', true);
            return;
        }

        try {
            if (!userUuid) {
                userUuid = crypto.randomUUID();
                localStorage.setItem('v2v_user_uuid', userUuid);
            }

            const workerUrl = getNextWorkerUrl();
            const response = await fetch(`${workerUrl}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs, uuid: userUuid, core: coreName })
            });

            if (!response.ok) throw new Error('Worker request failed');
            
            const data = await response.json();
            const subUrl = format === 'clash' ? data.clashSubscriptionUrl : data.singboxSubscriptionUrl;

            if (action === 'copy') {
                await window.copyToClipboard(subUrl, 'لینک اشتراک V2V کپی شد!');
            } else if (action === 'qr') {
                window.openQrModal(subUrl);
            }
        } catch (error) {
            console.error('Subscription generation error:', error);
            showToast('خطا در ایجاد لینک اشتراک!', true);
        }
    };

    window.runPingTest = async (coreName) => {
        const btn = getEl(`ping-${coreName}-btn`);
        if (!btn) return;
        
        btn.disabled = true;
        btn.innerHTML = '<span class="loader-small"></span> در حال تست...';

        const coreData = allLiveConfigsData[coreName];
        const allConfigs = [];
        
        for (const protocol in coreData) {
            coreData[protocol].forEach((config, idx) => {
                allConfigs.push({ config, protocol, idx });
            });
        }

        let completed = 0;
        const total = allConfigs.length;

        for (let i = 0; i < allConfigs.length; i += PING_BATCH_SIZE) {
            const batch = allConfigs.slice(i, i + PING_BATCH_SIZE);
            
            await Promise.all(batch.map(async ({ config, protocol, idx }) => {
                const resultEl = getEl(`ping-${coreName}-${protocol}-${idx}`);
                if (!resultEl) return;

                resultEl.innerHTML = '<span class="loader-small"></span>';

                try {
                    const urlObj = new URL(config);
                    const host = urlObj.hostname;
                    const port = urlObj.port;
                    
                    let tls = false;
                    let sni = host;

                    if (protocol === 'vmess') {
                        try {
                            const vmessData = config.replace('vmess://', '');
                            const decoded = JSON.parse(atob(vmessData));
                            tls = decoded.tls === 'tls';
                            sni = decoded.sni || decoded.host || host;
                        } catch (e) {}
                    } else if (protocol === 'vless') {
                        const params = new URLSearchParams(urlObj.search);
                        tls = params.get('security') === 'tls';
                        sni = params.get('sni') || host;
                    } else if (['trojan', 'hy2', 'tuic'].includes(protocol)) {
                        tls = true;
                        const params = new URLSearchParams(urlObj.search);
                        sni = params.get('sni') || host;
                    }

                    const workerUrl = getNextWorkerUrl();
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT);

                    const response = await fetch(`${workerUrl}/ping`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ host, port, tls, sni }),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const result = await response.json();
                        if (result.latency && result.latency > 0) {
                            const color = result.latency < 200 ? '#4CAF50' : 
                                        result.latency < 500 ? '#FFC107' : '#F44336';
                            resultEl.innerHTML = `<span style="color: ${color};">${result.latency}ms</span>`;
                        } else {
                            resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                        }
                    } else {
                        resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                    }
                } catch (error) {
                    resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                }

                completed++;
                btn.textContent = `تست پینگ (${completed}/${total})`;
            }));
        }

        btn.disabled = false;
        btn.textContent = `تست پینگ ${coreName.toUpperCase()}`;
        showToast('تست پینگ تکمیل شد!');
    };

    fetchAndRender();
});