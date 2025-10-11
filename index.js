document.addEventListener('DOMContentLoaded', () => {
    const STATIC_CONFIG_URL = './all_live_configs.json?t=' + Date.now();
    const STATIC_CACHE_VERSION_URL = './cache_version.txt?t=' + Date.now();
    const PING_TIMEOUT = 2000;
    
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    
    let activeWorkers = [];
    let workerAvailable = false;
    
    const PING_BATCH_SIZE = 20;  // کاهش یافت برای دقت بیشتر
    const PING_ATTEMPTS = 5;     // افزایش تعداد تلاش
    const PING_TIMEOUT = 4000;   // 4 ثانیه timeout
    const PING_RETRY_DELAY = 100; // 100ms بین تلاش‌ها
    
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

    async function detectActiveWorkers() {
        console.log('🔍 Testing all workers in parallel...');
        activeWorkers = [];
        
        const startTime = Date.now();
        
        const testPromises = WORKER_URLS.map(async (url, index) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                
                const testStart = Date.now();
                const response = await fetch(`${url}/ping`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ host: '8.8.8.8', port: 53 }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                const latency = Date.now() - testStart;
                
                if (response.ok) {
                    console.log(`✅ Worker ${index + 1} active (${latency}ms)`);
                    return { url, latency, index: index + 1 };
                }
            } catch (e) {
                console.log(`❌ Worker ${index + 1} failed`);
            }
            return null;
        });
        
        const results = await Promise.all(testPromises);
        const validWorkers = results.filter(w => w !== null);
        
        // مرتب‌سازی بر اساس سرعت
        validWorkers.sort((a, b) => a.latency - b.latency);
        activeWorkers = validWorkers.map(w => w.url);
        
        workerAvailable = activeWorkers.length > 0;
        
        const totalTime = Date.now() - startTime;
        console.log(`📊 Active workers: ${activeWorkers.length}/${WORKER_URLS.length} (tested in ${totalTime}ms)`);
        
        if (validWorkers.length > 0) {
            console.log('🏆 Workers sorted by speed:', validWorkers.map(w => `Worker ${w.index} (${w.latency}ms)`).join(', '));
        }
        
        return workerAvailable;
    }

    function getRandomWorker() {
        if (activeWorkers.length === 0) return null;
        return activeWorkers[Math.floor(Math.random() * activeWorkers.length)];
    }

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
        if (!name || name.length > 25) {
            return `${protocol}-${server.substring(0, 12)}`;
        }
        return name;
    };

    window.copyProtocolConfigs = (coreName, protocol) => {
        const coreData = allLiveConfigsData[coreName];
        if (!coreData || !coreData[protocol] || coreData[protocol].length === 0) {
            showToast('کانفیگی یافت نشد!', true);
            return;
        }
        
        const configs = coreData[protocol].join('\n');
        window.copyToClipboard(configs, `${coreData[protocol].length} کانفیگ ${protocol.toUpperCase()} کپی شد!`);
    };

    window.generateSubscription = async (coreName, scope, format, action) => {
        if (!workerAvailable || activeWorkers.length === 0) {
            showToast('در حال بررسی Workers...', false);
            await detectActiveWorkers();
            if (!workerAvailable) {
                showToast('هیچ Worker فعالی یافت نشد', true);
                return;
            }
        }

        let configs = [];
        
        if (scope === 'selected') {
            const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
            if (checkboxes.length === 0) {
                showToast('هیچ کانفیگی انتخاب نشده!', true);
                return;
            }
            configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        } else if (scope === 'auto') {
            configs = getTopConfigsFromBackend(coreName);
            if (configs.length === 0) {
                showToast('کانفیگی یافت نشد!', true);
                return;
            }
        }
        
        if (configs.length === 0) {
            showToast('کانفیگی یافت نشد!', true);
            return;
        }
        
        console.log(`🚀 Creating subscription with ${activeWorkers.length} workers in parallel...`);
        
        // تلاش موازی با تمام Workers - اولین موفق برنده می‌شه
        const createPromises = activeWorkers.map(async (workerUrl, index) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                
                console.log(`⏳ Worker ${index + 1} trying...`);
                
                const response = await fetch(`${workerUrl}/create-sub`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs, format }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ Worker ${index + 1} SUCCESS! ID: ${data.id}`);
                    return { success: true, workerUrl, id: data.id, workerIndex: index + 1 };
                } else {
                    console.log(`❌ Worker ${index + 1} failed with status ${response.status}`);
                }
            } catch (error) {
                console.log(`❌ Worker ${index + 1} error:`, error.message);
            }
            return { success: false, workerUrl, workerIndex: index + 1 };
        });
        
        try {
            // استفاده از Promise.race برای اولین نتیجه موفق
            const firstSuccess = await Promise.race(
                createPromises.map(p => 
                    p.then(result => result.success ? result : Promise.reject(result))
                )
            ).catch(() => null);
            
            if (firstSuccess) {
                const subUrl = `${firstSuccess.workerUrl}/sub/${format}/${firstSuccess.id}`;
                
                if (action === 'copy') {
                    await window.copyToClipboard(subUrl, `لینک کپی شد! (Worker ${firstSuccess.workerIndex})`);
                } else if (action === 'qr') {
                    window.openQrModal(subUrl);
                    showToast(`QR ساخته شد (Worker ${firstSuccess.workerIndex})`);
                }
                
                console.log(`🎯 Final URL: ${subUrl}`);
                return;
            }
            
            // اگر Promise.race موفق نشد، منتظر تمام Workers می‌مونیم
            console.log('⚠️ No quick success, waiting for all workers...');
            const allResults = await Promise.all(createPromises);
            const successResult = allResults.find(r => r.success);
            
            if (successResult) {
                const subUrl = `${successResult.workerUrl}/sub/${format}/${successResult.id}`;
                
                if (action === 'copy') {
                    await window.copyToClipboard(subUrl, `لینک کپی شد! (Worker ${successResult.workerIndex})`);
                } else if (action === 'qr') {
                    window.openQrModal(subUrl);
                    showToast(`QR ساخته شد (Worker ${successResult.workerIndex})`);
                }
                
                console.log(`🎯 Final URL: ${subUrl}`);
                return;
            }
            
            throw new Error('All workers failed');
        } catch (error) {
            console.error('❌ All workers failed:', error);
            showToast(`خطا در ساخت لینک! (${activeWorkers.length} Worker تست شد)`, true);
            
            // ری‌تست Workers در صورت خطا
            console.log('🔄 Re-testing workers...');
            await detectActiveWorkers();
            
            if (activeWorkers.length > 0) {
                showToast(`${activeWorkers.length} Worker فعال یافت شد. دوباره تلاش کنید`, false);
            }
        }
    };

    const getTopConfigsFromBackend = (coreName) => {
        const coreData = allLiveConfigsData[coreName];
        const allConfigs = [];
        
        for (const protocol in coreData) {
            coreData[protocol].forEach((config, idx) => {
                const key = `${coreName}-${protocol}-${idx}`;
                const ping = pingResults[key];
                if (ping && ping > 0 && ping < 500) {
                    allConfigs.push({ config, ping });
                }
            });
        }
        
        if (allConfigs.length === 0) {
            for (const protocol in coreData) {
                allConfigs.push(...coreData[protocol].slice(0, 5).map(config => ({ config, ping: 9999 })));
            }
        }
        
        allConfigs.sort((a, b) => a.ping - b.ping);
        return allConfigs.slice(0, 20).map(item => item.config);
    };

    const fetchAndRender = async () => {
        statusBar.textContent = 'بارگذاری...';
        
        await detectActiveWorkers();
        
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { 
                signal: AbortSignal.timeout(15000),
                cache: 'no-store'
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
                    signal: AbortSignal.timeout(5000),
                    cache: 'no-store'
                });
                if (versionResponse.ok) {
                    cacheVersion = await versionResponse.text();
                }
            } catch (error) {}

            const updateTime = new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
            const workerStatus = workerAvailable ? `✅ ${activeWorkers.length} Worker فعال` : '❌ Worker غیرفعال';
            statusBar.textContent = `${updateTime} | ${workerStatus}`;
            
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

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ (${activeWorkers.length} Worker)</button>`;
        const copySelectedButton = `<button class="action-btn-wide" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        
        let contentHtml = runPingButton + copySelectedButton + `
            <div class="sub-section">
                <div class="sub-title">Clash</div>
                <div class="sub-actions">
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'selected', 'clash', 'copy')">انتخابی</button>
                    <button class="sub-btn" onclick="window.generateSubscription('${coreName}', 'auto', 'clash', 'copy')">خودکار</button>
                    <button class="sub-btn qr" onclick="window.generateSubscription('${coreName}', 'auto', 'clash', 'qr')">QR</button>
                </div>
            </div>
            <div class="sub-section">
                <div class="sub-title">Singbox</div>
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
            
            const protocolMap = {
                'vmess': 'VMess',
                'vless': 'VLESS',
                'trojan': 'Trojan',
                'ss': 'SS',
                'hy2': 'Hy2',
                'tuic': 'TUIC'
            };
            const protocolName = protocolMap[protocol] || protocol.toUpperCase();
            
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <button class="btn-copy-protocol" onclick="window.copyProtocolConfigs('${coreName}', '${protocol}')" title="کپی همه ${protocolName}">📋 کپی</button>
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
                            <div class="config-info">
                                <label for="${coreName}-${protocol}-${idx}">${name}</label>
                                <span class="server">${server}:${port}</span>
                            </div>
                            <span class="ping-result" id="ping-${coreName}-${protocol}-${idx}"></span>
                            <div class="config-btns">
                                <button class="btn-icon" onclick="window.copyToClipboard(decodeURIComponent('${encodeURIComponent(config)}'))" title="کپی">📋</button>
                                <button class="btn-icon" onclick="window.openQrModal(decodeURIComponent('${encodeURIComponent(config)}'))" title="QR">📱</button>
                            </div>
                        </li>
                    `;
                } catch (e) {}
            });
            
            contentHtml += `</ul></div>`;
        }

        wrapper.innerHTML = contentHtml;

        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (!e.target.classList.contains('btn-copy-protocol')) {
                    header.closest('.protocol-group').classList.toggle('open');
                }
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
        
        if (!workerAvailable || activeWorkers.length === 0) {
            showToast('در حال بررسی Workers...', false);
            await detectActiveWorkers();
            if (!workerAvailable) {
                showToast('تست پینگ نیازمند Workers فعال است', true);
                return;
            }
        }
        
        btn.disabled = true;
        btn.innerHTML = `<span class="loader-small"></span> تست با ${activeWorkers.length} Worker...`;
        
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
        
        // توزیع موازی بین تمام Workers فعال
        for (let i = 0; i < allConfigs.length; i += (PING_BATCH_SIZE * activeWorkers.length)) {
            const megaBatch = allConfigs.slice(i, i + (PING_BATCH_SIZE * activeWorkers.length));
            
            await Promise.all(activeWorkers.map(async (workerUrl, workerIdx) => {
                const workerBatch = megaBatch.filter((_, idx) => idx % activeWorkers.length === workerIdx);
                
                await Promise.all(workerBatch.map(async ({ config, protocol, idx }) => {
                    const resultEl = getEl(`ping-${coreName}-${protocol}-${idx}`);
                    if (!resultEl) return;

                    resultEl.innerHTML = '<span class="loader-mini"></span>';

                    try {
                        const urlObj = new URL(config);
                        const host = urlObj.hostname;
                        const port = urlObj.port;

                        const latencies = [];
                        
                        for (let attempt = 0; attempt < PING_ATTEMPTS; attempt++) {
                            try {
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
                                        latencies.push(result.latency);
                                    }
                                }
                            } catch (e) {}
                            
                            if (attempt < PING_ATTEMPTS - 1) {
                                await new Promise(resolve => setTimeout(resolve, 30));
                            }
                        }
                        
                        if (latencies.length > 0) {
                            const avgLatency = Math.round(latencies.reduce((a, b) => a + b) / latencies.length);
                            const color = avgLatency < 200 ? '#4CAF50' : avgLatency < 500 ? '#FFC107' : '#F44336';
                            resultEl.innerHTML = `<span style="color: ${color};">${avgLatency}ms</span>`;
                            pingResults[`${coreName}-${protocol}-${idx}`] = avgLatency;
                            
                            sortConfigsByPingLive(coreName, protocol);
                        } else {
                            resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                        }
                    } catch (error) {
                        resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                    }

                    completed++;
                    const progress = Math.round((completed / total) * 100);
                    btn.textContent = `تست ${progress}% (${completed}/${total})`;
                }));
            }));
        }

        btn.disabled = false;
        btn.textContent = `تست پینگ (${activeWorkers.length} Worker)`;
        showToast('تست تکمیل شد!');
    };
    
    const sortConfigsByPingLive = (coreName, protocol) => {
        const wrapper = coreName === 'xray' ? xrayWrapper : singboxWrapper;
        const group = wrapper.querySelector(`.protocol-group[data-protocol="${protocol}"]`);
        if (!group) return;
        
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
    };

    fetchAndRender();
});