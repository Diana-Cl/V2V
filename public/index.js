document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev'; // آدرس صحیح ورکر شما
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');

    // --- HELPERS ---
    const toShamsi = (timestamp) => {
        if (!timestamp || !window.jalaali) return 'N/A';
        const date = new Date(parseInt(timestamp, 10) * 1000);
        const jd = jalaali.toJalaali(date);
        return `${jd.jy}/${jd.jm}/${jd.jd} - ${date.toLocaleTimeString('fa-IR')}`;
    };

    const parseConfigName = (configStr) => {
        try {
            if (configStr.includes('#')) return decodeURIComponent(configStr.split('#')[1]);
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.replace('vmess://', '')));
                return data.ps || data.add;
            }
            return new URL(configStr).hostname;
        } catch { return 'Unnamed Config'; }
    };
    
    // --- CORE RENDERING ---
    const renderCore = (core, configs) => {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        if (!configs || configs.length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی یافت نشد.</div>`;
            return;
        }

        const grouped = configs.reduce((acc, config) => {
            const protocol = config.match(/^(\w+):\/\//)?.[1]?.toLowerCase() || 'unknown';
            if (!acc[protocol]) acc[protocol] = [];
            acc[protocol].push(config);
            return acc;
        }, {});

        for (const protocol in grouped) {
            const pGroupId = `${protocol}-${core}`;
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            
            let itemsHTML = '';
            grouped[protocol].forEach(config => {
                const name = parseConfigName(config);
                const safeConfig = config.replace(/'/g, "&apos;");
                itemsHTML += `
                    <li class="config-item" data-config='${safeConfig}'>
                        <div class="config-details">
                            <div class="server">${name}</div>
                            <div class="ping-result"></div>
                        </div>
                        <div class="copy-button-container">
                            <button class="copy-btn" onclick="navigator.clipboard.writeText('${safeConfig}')">کپی</button>
                        </div>
                    </li>`;
            });

            pGroupEl.innerHTML = `
                <div class="protocol-header" onclick="this.parentElement.classList.toggle('open')">
                    <span>${protocol.toUpperCase()} (${grouped[protocol].length})</span>
                    <span class="toggle-icon"></span>
                </div>
                <ul class="config-list">${itemsHTML}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    };

    // --- INITIAL DATA LOAD ---
    (async () => {
        try {
            const verRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (verRes.ok) statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(await verRes.text())}`;
        } catch { statusBar.textContent = 'عدم دسترسی به نسخه بروزرسانی.'; }
        
        try {
            const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!dataRes.ok) throw new Error('Failed to load configs');
            const data = await dataRes.json();
            renderCore('xray', data.xray || []);
            renderCore('singbox', data.singbox || []);
        } catch (e) {
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- ADVANCED PING TEST LOGIC ---
    // Make the function globally accessible
    window.runAdvancedPingTest = async (core) => {
        console.clear();
        console.log(`🚀 Advanced Ping Test Started for [${core}] core...`);
        
        const PING_TIMEOUT = 3000;

        const testButton = document.getElementById(`${core}-test-btn`);
        if (testButton.disabled) return;
        testButton.disabled = true;
        testButton.textContent = '...درحال تست';

        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => {
            item.style.display = 'flex';
            item.querySelector('.ping-result').textContent = '...';
        });

        const configsToTestBackend = [];
        const wsTestPromises = [];

        for (const item of allItems) {
            const config = item.dataset.config;
            let isWs = false;
            try {
                const params = new URLSearchParams(new URL(config).search);
                if ((config.startsWith('vless://') || config.startsWith('vmess://')) && params.get('type') === 'ws') {
                    isWs = true;
                }
            } catch {}

            if (isWs) {
                wsTestPromises.push(testWebSocket(config, item, PING_TIMEOUT));
            } else {
                configsToTestBackend.push({ config, item });
            }
        }
        
        const backendPromise = testTcpBatch(configsToTestBackend, API_ENDPOINT);
        await Promise.allSettled([...wsTestPromises, backendPromise]);

        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const sortedItems = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            sortedItems.forEach(item => list.appendChild(item));
        });

        testButton.disabled = false;
        testButton.textContent = '🚀 تست پیشرفته کانفیگ‌ها';
    };

    function updateItemUI(item, result) {
        item.dataset.finalScore = result.ping ?? 9999;
        const pingEl = item.querySelector('.ping-result');
        if (result.ping !== null) {
            let color = result.ping < 400 ? 'var(--ping-good)' : (result.ping < 1000 ? 'var(--ping-medium)' : 'var(--ping-bad)');
            pingEl.innerHTML = `[${result.source}] <strong style="color:${color};">${result.ping}ms</strong>`;
        } else {
            pingEl.textContent = `[${result.source}] ناموفق`;
        }
    }

    async function testWebSocket(config, item, timeout) {
        updateItemUI(item, { source: 'C', ping: null });
        try {
            const ping = await new Promise((resolve, reject) => {
                const url = new URL(config);
                const params = new URLSearchParams(url.search);
                const startTime = Date.now();
                const wsProtocol = (params.get('security') === 'tls' || url.port === '443') ? 'wss://' : 'ws://';
                const wsPath = params.get('path') || '/';
                const wsUrl = `${wsProtocol}${url.hostname}:${url.port}${wsPath}`;

                const ws = new WebSocket(wsUrl);
                const timeoutId = setTimeout(() => reject(new Error('Timeout')), timeout);
                ws.onopen = () => { clearTimeout(timeoutId); ws.close(); resolve(Date.now() - startTime); };
                ws.onerror = () => { clearTimeout(timeoutId); ws.close(); reject(new Error('WebSocket Error')); };
            });
            updateItemUI(item, { source: 'C', ping });
        } catch {
            updateItemUI(item, { source: 'C', ping: null });
        }
    }

    async function testTcpBatch(items, apiUrl) {
        if (items.length === 0) return;
        items.forEach(({ item }) => updateItemUI(item, { source: 'S', ping: null }));
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: items.map(i => i.config) })
            });
            if (!response.ok) throw new Error('API response not OK');
            const results = await response.json();
            const resultsMap = new Map(results.map(r => [r.config, r.ping]));

            items.forEach(({ config, item }) => {
                const ping = resultsMap.get(config);
                updateItemUI(item, { source: 'S', ping: ping ?? null });
            });
        } catch (e) {
            console.error("Backend TCP test failed:", e);
            items.forEach(({ item }) => updateItemUI(item, { source: 'S', ping: null }));
        }
    }
});
