document.addEventListener('DOMContentLoaded', () => {
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 5000;
    
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    let workerIndex = 0;
    let workerAvailable = true;
    
    const getNextWorkerUrl = () => {
        const url = WORKER_URLS[workerIndex];
        workerIndex = (workerIndex + 1) % WORKER_URLS.length;
        return url;
    };
    
    const PING_BATCH_SIZE = 40;
    
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');

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
    let pingResults = {};

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
        if (!name || name.length > 30) {
            return `${protocol}-${server.substring(0, 15)}`;
        }
        return name;
    };

    const parseVmessConfig = (config) => {
        try {
            const vmessData = config.replace('vmess://', '');
            const decoded = JSON.parse(atob(vmessData));
            return {
                server: decoded.add, port: parseInt(decoded.port), uuid: decoded.id,
                alterId: parseInt(decoded.aid) || 0, cipher: decoded.scy || 'auto',
                network: decoded.net || 'tcp', tls: decoded.tls === 'tls',
                sni: decoded.sni || decoded.host || decoded.add, path: decoded.path || '/',
                host: decoded.host || decoded.add, name: decoded.ps || `vmess-${decoded.add.substring(0,8)}`
            };
        } catch { return null; }
    };

    const parseVlessConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const params = new URLSearchParams(urlObj.search);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), uuid: urlObj.username,
                network: params.get('type') || 'tcp', tls: params.get('security') === 'tls',
                sni: params.get('sni') || urlObj.hostname, path: params.get('path') || '/',
                host: params.get('host') || urlObj.hostname, flow: params.get('flow') || '',
                name: decodeURIComponent(urlObj.hash.substring(1)) || `vless-${urlObj.hostname.substring(0,8)}`
            };
        } catch { return null; }
    };

    const parseTrojanConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const params = new URLSearchParams(urlObj.search);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), password: urlObj.username,
                sni: params.get('sni') || urlObj.hostname,
                name: decodeURIComponent(urlObj.hash.substring(1)) || `trojan-${urlObj.hostname.substring(0,8)}`
            };
        } catch { return null; }
    };

    const parseSsConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const decoded = atob(urlObj.username);
            if (!decoded.includes(':')) return null;
            const [method, password] = decoded.split(':', 2);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), method, password,
                name: decodeURIComponent(urlObj.hash.substring(1)) || `ss-${urlObj.hostname.substring(0,8)}`
            };
        } catch { return null; }
    };

    window.generateSubscription = async (coreName, scope, format, action) => {
        let configs = [];
        
        if (scope === 'selected') {
            const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
            if (checkboxes.length === 0) {
                showToast('هیچ کانفیگی انتخاب نشده!', true);
                return;
            }
            configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        } else if (scope === 'auto') {
            const sortedConfigs = getSortedConfigsByPing(coreName);
            configs = sortedConfigs.slice(0, Math.min(20, sortedConfigs.length));
            
            if (configs.length === 0) {
                showToast('ابتدا تست پینگ را اجرا کنید!', true);
                return;
            }
        } else {
            const coreData = allLiveConfigsData[coreName];
            for (const protocol in coreData) {
                configs.push(...coreData[protocol]);
            }
        }
        
        if (configs.length === 0) {
            showToast('کانفیگی یافت نشد!', true);
            return;
        }
        
        showToast('در حال ساخت...', false);
        
        if (workerAvailable) {
            try {
                const workerUrl = getNextWorkerUrl();
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const response = await fetch(`${workerUrl}/create-sub`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs, core: coreName, format }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const data = await response.json();
                    const subUrl = `${workerUrl}/sub/${format}/${data.id}`;
                    
                    if (action === 'copy') {
                        await window.copyToClipboard(subUrl, 'لینک کپی شد!');
                    } else if (action === 'qr') {
                        window.openQrModal(subUrl);
                    }
                    return;
                }
                
                workerAvailable = false;
                showToast('Worker در دسترس نیست', true);
            } catch (error) {
                workerAvailable = false;
                showToast('Worker در دسترس نیست', true);
            }
        }
    };

    const getSortedConfigsByPing = (coreName) => {
        const coreData = allLiveConfigsData[coreName];
        const configsWithPing = [];
        
        for (const protocol in coreData) {
            coreData[protocol].forEach((config, idx) => {
                const key = `${coreName}-${protocol}-${idx}`;
                const ping = pingResults[key];
                if (ping && ping > 0) {
                    configsWithPing.push({ config, ping });
                }
            });
        }
        
        configsWithPing.sort((a, b) => a.ping - b.ping);
        return configsWithPing.map(item => item.config);
    };

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { signal: AbortSignal.timeout(10000) });
            if (!configResponse.ok) throw new Error(`HTTP ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            for (const core in allLiveConfigsData) {
                for (const protocol in allLiveConfigsData[core]) {
                    allLiveConfigsData[core][protocol] = removeDuplicates(allLiveConfigsData[core][protocol]);
                }
            }
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { signal: AbortSignal.timeout(5000) });
                if (versionResponse.ok) {
                    cacheVersion = await versionResponse.text();
                }
            } catch (error) {}

            const updateTime = new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
            statusBar.textContent = `آخرین بروزرسانی: ${updateTime}`;
            
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            console.error('Fetch error:', error);
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast('خطا در دریافت کانفیگ‌ها!', true);
        }
    };
    
    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ</button>`;
        const copySelectedButton = `<button class="action-btn-wide" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        
        let contentHtml = runPingButton + copySelectedButton + `
            <div class="sub-section">
                <div class="sub-title">Clash Subscription</div>
                <div class="sub-actions">
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'selected', 'clash', 'copy')">انتخابی</button>
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'auto', 'clash', 'copy')">خودکار</button>
                    <button class="sub-btn qr" onclick="window.generateSubscription('${coreName}', 'auto', 'clash', 'qr')">QR</button>
                </div>
            </div>
            <div class="sub-section">
                <div class="sub-title">Singbox Subscription</div>
                <div class="sub-actions">
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'selected', 'singbox', 'copy')">انتخابی</button>
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'auto', 'singbox', 'copy')">خودکار</button>
                    <button class="sub-btn qr" onclick="window.generateSubscription('${coreName}', 'auto', 'singbox', 'qr')">QR</button>
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
                        <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
                        <li class="config-item" data-config-key="${coreName}-${protocol}-${idx}">
                            <input type="checkbox" class="config-checkbox" data-core="${coreName}" data-protocol="${protocol}" data-config="${encodeURIComponent(config)}" id="${coreName}-${protocol}-${idx}">
                            <div class="config-details">
                                <label for="${coreName}-${protocol}-${idx}">${name}</label>
                                <span class="server">${server}:${port}</span>
                            </div>
                            <div class="ping-result-container" id="ping-${coreName}-${protocol}-${idx}"></div>
                            <div class="config-item-buttons">
                                <button class="action-btn-small" onclick="window.copyToClipboard(decodeURIComponent('${encodeURIComponent(config)}'))">کپی</button>
                                <button class="action-btn-small" onclick="window.openQrModal(decodeURIComponent('${encodeURIComponent(config)}'))">QR</button>
                            </div>
                        </li>
                    `;
                } catch (e) {}
            });
            
            contentHtml += `</ul></div>`;
        }

        wrapper.innerHTML = contentHtml;

        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.protocol-group').classList.toggle('open');
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
        window.copyToClipboard(configs.join('\n'), `${configs.length} کانفیگ کپی شد!`);
    };

    window.runPingTest = async (coreName) => {
        const btn = getEl(`ping-${coreName}-btn`);
        if (!btn) return;
        
        if (!workerAvailable) {
            showToast('تست پینگ نیازمند Worker است', true);
            return;
        }
        
        btn.disabled = true;
        btn.innerHTML = '<span class="loader-small"></span> تست...';
        
        pingResults = {};

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
            
            await Promise.all(batch.map(async ({ config, protocol, idx }, batchIdx) => {
                const resultEl = getEl(`ping-${coreName}-${protocol}-${idx}`);
                if (!resultEl) return;

                resultEl.innerHTML = '<span class="loader-small"></span>';

                try {
                    const urlObj = new URL(config);
                    const host = urlObj.hostname;
                    const port = urlObj.port;

                    const workerUrl = WORKER_URLS[batchIdx % WORKER_URLS.length];
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT);

                    const response = await fetch(`${workerUrl}/ping`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ host, port }),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const result = await response.json();
                        if (result.latency && result.latency > 0) {
                            const color = result.latency < 200 ? '#4CAF50' : result.latency < 500 ? '#FFC107' : '#F44336';
                            resultEl.innerHTML = `<span style="color: ${color};">${result.latency}ms</span>`;
                            pingResults[`${coreName}-${protocol}-${idx}`] = result.latency;
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
                btn.textContent = `تست (${completed}/${total})`;
            }));
        }
        
        sortConfigsByPing(coreName);

        btn.disabled = false;
        btn.textContent = `تست پینگ`;
        showToast('تست تکمیل شد!');
    };
    
    const sortConfigsByPing = (coreName) => {
        const wrapper = coreName === 'xray' ? xrayWrapper : singboxWrapper;
        const protocolGroups = wrapper.querySelectorAll('.protocol-group');
        
        protocolGroups.forEach(group => {
            const configList = group.querySelector('.config-list');
            if (!configList) return;
            
            const items = Array.from(configList.querySelectorAll('.config-item'));
            
            items.sort((a, b) => {
                const keyA = a.dataset.configKey;
                const keyB = b.dataset.configKey;
                const pingA = pingResults[keyA] || 9999999;
                const pingB = pingResults[keyB] || 9999999;
                return pingA - pingB;
            });
            
            items.forEach(item => configList.appendChild(item));
        });
    };

    fetchAndRender();
});