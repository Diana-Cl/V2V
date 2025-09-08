document.addEventListener('DOMContentLoaded', () => {
    // --- پیکربندی نهایی ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const AUTO_SELECT_COUNT = 30;
    const PING_TIMEOUT = 3000; // 3 ثانیه

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-code-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const qrDownloadBtn = document.getElementById('qr-download-btn');

    // --- HELPER FUNCTIONS ---
    const parseAndFormatName = (fullName) => {
        const flagRegex = /^([\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF])/;
        let flag = '';
        let cleanName = fullName;
        const match = fullName.match(flagRegex);
        if (match) {
            flag = match[1];
            cleanName = fullName.replace(flagRegex, '').trim();
        }
        return { flag: flag || '🏳️', name: cleanName };
    };
    
    const toShamsi = (timestamp) => {
        try {
            const date = new Date(parseInt(timestamp, 10) * 1000);
            if (isNaN(date.getTime())) return "نامشخص";
            const jalaaliDate = jalaali.toJalaali(date);
            const format = (n) => n < 10 ? '0' + n : n;
            return `${jalaaliDate.jy}/${format(jalaaliDate.jm)}/${format(jalaaliDate.jd)} ساعت ${format(date.getHours())}:${format(date.getMinutes())}`;
        } catch (e) { return "نامشخص"; }
    };

    const copyToClipboard = (text, msg = 'کپی شد!') => {
        navigator.clipboard.writeText(text).then(() => alert(msg)).catch(() => alert('خطا در کپی کردن.'));
    };
    
    window.closeModal = () => qrModal.style.display = 'none';
    
    window.showQrCode = (event, text) => {
        event.stopPropagation();
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256 });
        qrDownloadBtn.onclick = () => {
            const img = qrContainer.querySelector('img');
            const link = document.createElement('a');
            link.download = 'V2V-QRCode.png';
            link.href = img.src;
            link.click();
        };
        qrModal.style.display = 'flex';
    };

    window.toggleGroup = (groupId) => document.getElementById(groupId)?.parentNode.classList.toggle('open');
    
    // --- CORE LOGIC ---
    async function fetchData() {
        try {
            const versionRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (versionRes.ok) statusBar.textContent = `آخرین بروزرسانی: ${toShamsi((await versionRes.text()).trim())}`;
        } catch (e) { console.error("Failed to fetch cache version:", e); }
        
        try {
            const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!dataRes.ok) throw new Error(`Status: ${dataRes.status}`);
            return await dataRes.json();
        } catch (error) {
            statusBar.textContent = 'خطا در بارگذاری';
            throw new Error('All data sources failed.');
        }
    }

    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = ''; 
        const actionsContainer = document.createElement('div');
        actionsContainer.innerHTML = `
            <button class="test-button" id="${core}-test-btn">اجرای تست سرعت دقیق</button>
            <div class="action-group">
                <h4 class="action-group-title">اشتراک شخصی (Standard)</h4>
                <div class="action-buttons">
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'standard', 'url', event)">کپی لینک UUID</button>
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'standard', 'qr', event)">QR Code لینک</button>
                </div>
            </div>`;
        if (core === 'xray') {
            actionsContainer.innerHTML += `
            <div class="action-group">
                <h4 class="action-group-title">اشتراک شخصی (Clash)</h4>
                <div class="action-buttons">
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'clash', 'url', event)">کپی لینک Clash</button>
                    <button class="action-button" onclick="window.v2v.downloadClashFile('${core}', event)">دانلود فایل Clash</button>
                </div>
            </div>`;
        }
        wrapper.appendChild(actionsContainer);
        document.getElementById(`${core}-test-btn`).addEventListener('click', () => runHybridPingTest(core));

        if (!configs || configs.length === 0) {
            wrapper.insertAdjacentHTML('beforeend', '<div class="alert">هیچ کانفیگ سالمی برای این هسته یافت نشد.</div>');
            return;
        }
        
        const grouped = configs.reduce((acc, item) => {
            const proto = item.config.split("://")[0];
            if (!acc[proto]) acc[proto] = [];
            acc[proto].push(item);
            return acc;
        }, {});

        for (const protocol in grouped) {
            const protocolGroupId = `${protocol}-${core}`;
            const protocolGroup = document.createElement('div');
            protocolGroup.className = 'protocol-group';
            protocolGroup.innerHTML = `<div class="protocol-header" onclick="toggleGroup('${protocolGroupId}')"><span>${protocol.toUpperCase()} (${grouped[protocol].length})</span><span class="toggle-icon"></span></div><ul class="config-list" id="${protocolGroupId}"></ul>`;
            const configList = protocolGroup.querySelector('.config-list');
            grouped[protocol].forEach(configObj => {
                const li = document.createElement('li');
                li.className = 'config-item';
                li.dataset.config = configObj.config;
                try {
                    const rawName = configObj.config.includes('#') ? decodeURIComponent(configObj.config.split('#')[1]) : new URL(configObj.config).hostname;
                    const { flag, name } = parseAndFormatName(rawName);
                    li.innerHTML = `
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details">
                            <span class="server" title="${name}">
                                <span class="flag">${flag}</span> ${name}
                            </span>
                            <span class="ping-result"></span>
                        </div>
                        <div class="copy-button-container">
                            <button class="copy-btn" onclick="window.v2v.copyConfig(event)">کپی</button>
                            <button class="copy-btn" onclick="window.v2v.showConfigQr(event)">QR</button>
                        </div>`;
                    configList.appendChild(li);
                } catch(e) { console.error("Error parsing config for display:", configObj.config, e); }
            });
            wrapper.appendChild(protocolGroup);
        }
    }
    
    async function runHybridPingTest(core) {
        const testButton = document.getElementById(`${core}-test-btn`);
        if (testButton.disabled) return;
        testButton.disabled = true;
        testButton.textContent = 'درحال تست...';

        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => {
            item.style.display = 'flex';
            const pingEl = item.querySelector('.ping-result');
            pingEl.textContent = '';
        });
        
        const allConfigs = allItems.map(item => item.dataset.config);
        const results = new Map();
        const backendPingList = [];

        const clientPingPromises = allConfigs.map(config => {
            try {
                const params = new URLSearchParams(new URL(config).search);
                if (params.get('type') === 'ws') {
                    return new Promise(resolve => {
                        const startTime = Date.now();
                        const wsUrl = `wss://${new URL(config).hostname}:${new URL(config).port}`;
                        const ws = new WebSocket(wsUrl);
                        let resolved = false;

                        const fail = () => {
                            if (!resolved) {
                                resolved = true;
                                results.set(config, null);
                                resolve();
                            }
                        };
                        
                        ws.onopen = () => {
                            if (!resolved) {
                                resolved = true;
                                results.set(config, Date.now() - startTime);
                                ws.close();
                                resolve();
                            }
                        };
                        ws.onerror = fail;
                        ws.onclose = fail;
                        setTimeout(fail, PING_TIMEOUT);
                    });
                } else {
                    backendPingList.push(config);
                }
            } catch (e) {
                backendPingList.push(config);
            }
            return Promise.resolve();
        });

        await Promise.all(clientPingPromises);

        if (backendPingList.length > 0) {
            try {
                testButton.textContent = 'تست کانفیگ‌های TCP...';
                const response = await fetch(`${API_ENDPOINT}/ping`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs: backendPingList })
                });
                if (!response.ok) throw new Error('Backend ping failed');
                const backendResults = await response.json();
                backendResults.forEach(res => {
                    results.set(res.config, res.ping); // Backend returns null on failure
                });
            } catch (e) {
                console.error("Backend ping failed:", e);
                backendPingList.forEach(c => results.set(c, null));
            }
        }

        allItems.forEach(item => {
            const ping = results.get(item.dataset.config);
            if (ping !== null && ping > 0) {
                const pingEl = item.querySelector('.ping-result');
                let pingColor = 'var(--ping-good)';
                if (ping > 600) pingColor = 'var(--ping-medium)';
                if (ping > 1200) pingColor = 'var(--ping-bad)';
                item.dataset.finalScore = ping;
                pingEl.innerHTML = `پینگ: <strong style="color:${pingColor};">${ping}ms</strong>`;
                item.style.display = 'flex';
            } else {
                item.dataset.finalScore = 9999;
                item.style.display = 'none';
            }
        });

        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const sortedItems = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            sortedItems.forEach(item => list.appendChild(item));
        });

        testButton.disabled = false;
        testButton.textContent = 'اجرای مجدد تست سرعت';
    }

    // --- GLOBAL API FOR BUTTONS ---
    window.v2v = {
        copyConfig: (event) => { /* ... بدون تغییر ... */ },
        showConfigQr: (event) => { /* ... بدون تغییر ... */ },
        getSelectedConfigs: (core) => { /* ... بدون تغییر ... */ },
        createSubscription: async (core, type, action, event) => { /* ... بدون تغییر ... */ },
        downloadClashFile: (core, event) => { /* ... بدون تغییر ... */ }
    };
    
    // --- INITIALIZE APP ---
    (async () => {
        try {
            const data = await fetchData();
            renderCore('xray', data.xray || []);
            renderCore('singbox', data.singbox || []);
        } catch (error) {
            console.error(error);
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفاً صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();
});
