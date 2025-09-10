document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const PING_TIMEOUT = 3000; // 3 seconds

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    let allConfigs = { xray: [], singbox: [] };

    // --- HELPERS ---
    const toShamsi = (timestamp) => {
        if (!timestamp || isNaN(timestamp) || !window.jalaali) return 'N/A';
        try {
            const date = new Date(parseInt(timestamp, 10) * 1000);
            const jd = jalaali.toJalaali(date);
            return `${jd.jy}/${jd.jm}/${jd.jd} - ${date.toLocaleTimeString('fa-IR')}`;
        } catch { return 'Invalid Date'; }
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

    // --- RENDER FUNCTIONS ---
    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = ''; // Clear previous content

        if (!configs || configs.length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی یافت نشد.</div>`;
            return;
        }

        // 1. Render action buttons
        const actionsEl = document.createElement('div');
        actionsEl.innerHTML = `
            <button class="test-button" id="${core}-test-btn" onclick="window.v2v.runAdvancedPingTest('${core}')">🚀 تست پیشرفته کانفیگ‌ها</button>
            <div class="action-group">
                <div class="action-buttons">
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}')">ساخت و کپی لینک اشتراک UUID</button>
                    <button class="action-button" onclick="window.v2v.generateClashConfig('${core}')">دانلود فایل Clash Meta</button>
                </div>
            </div>
        `;
        wrapper.appendChild(actionsEl);

        // 2. Render configs grouped by protocol
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
                        <input type="checkbox" class="config-checkbox">
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
    }

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
            allConfigs = data; // Store configs globally
            renderCore('xray', data.xray || []);
            renderCore('singbox', data.singbox || []);
        } catch (e) {
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- GLOBAL V2V OBJECT ---
    window.v2v = {
        runAdvancedPingTest: async (core) => {
            console.clear();
            console.log(`🚀 Advanced Ping Test Started for [${core}] core...`);

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
        },
        
        createSubscription: async (core) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                .map(cb => cb.closest('.config-item').dataset.config);

            if (selectedConfigs.length === 0) {
                alert('لطفاً حداقل یک کانفیگ را برای ساخت اشتراک انتخاب کنید.');
                return;
            }

            try {
                const response = await fetch(`${API_ENDPOINT}/api/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs: selectedConfigs })
                });

                if (!response.ok) throw new Error(`Server responded with ${response.status}`);
                
                const data = await response.json();
                navigator.clipboard.writeText(data.subscription_url);
                alert('لینک اشتراک شخصی شما با موفقیت ساخته و در کلیپ‌بورد کپی شد.');
            } catch (e) {
                alert('خطا در ساخت لینک اشتراک. لطفاً دوباره تلاش کنید.');
                console.error('Subscription creation failed:', e);
            }
        },

        generateClashConfig: (core) => {
            if (!window.jsyaml) {
                alert('کتابخانه مورد نیاز برای ساخت فایل کلش بارگذاری نشده است.');
                return;
            }
            let selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                .map(cb => cb.closest('.config-item').dataset.config);
            
            if (selectedConfigs.length === 0) {
                selectedConfigs = allConfigs[core] || [];
                if (selectedConfigs.length === 0) {
                    alert('هیچ کانفیگی برای ساخت فایل وجود ندارد.');
                    return;
                }
            }

            const proxies = [];
            const uniqueCheck = new Set();

            for (const config of selectedConfigs) {
                try {
                    const parsed = parseProxyForClash(config);
                    if (parsed) {
                        const uniqueKey = `${parsed.server}:${parsed.port}`;
                        if (!uniqueCheck.has(uniqueKey)) {
                            proxies.push(parsed);
                            uniqueCheck.add(uniqueKey);
                        }
                    }
                } catch (e) { console.warn('Could not parse config for Clash:', config, e); }
            }

            if (proxies.length === 0) {
                alert('هیچ کانفیگ سازگاری برای ساخت فایل کلش یافت نشد.');
                return;
            }
            
            const proxyNames = proxies.map(p => p.name);
            const clashConfig = {
                'proxies': proxies,
                'proxy-groups': [
                    { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 },
                    { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] }
                ],
                'rules': ['MATCH,V2V-Select']
            };

            try {
                const yamlString = jsyaml.dump(clashConfig, { indent: 2, sortKeys: false, lineWidth: -1 });
                const blob = new Blob([yamlString], { type: 'text/yaml;charset=utf-8' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `v2v-clash-${core}.yaml`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (e) {
                alert('خطا در هنگام ساخت فایل YAML کلش.');
                console.error('Clash YAML generation failed:', e);
            }
        }
    };
});

// --- PING TEST FUNCTIONS ---
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
        const response = await fetch(apiUrl + '/api/ping', {
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

// --- CLASH PARSING FUNCTION ---
function parseProxyForClash(configStr) {
    const protocol = configStr.split('://')[0];
    let name = `V2V-${Date.now().toString().slice(-4)}`;
    if (configStr.includes('#')) {
        name = decodeURIComponent(configStr.split('#').pop());
    }

    const baseProxy = { name, 'skip-cert-verify': true };
    
    if (protocol === 'vmess') {
        const decoded = JSON.parse(atob(configStr.substring(8)));
        return { ...baseProxy, type: 'vmess', server: decoded.add, port: parseInt(decoded.port), uuid: decoded.id, alterId: parseInt(decoded.aid), cipher: decoded.scy || 'auto', tls: decoded.tls === 'tls', network: decoded.net, servername: decoded.sni || decoded.host, 'ws-opts': decoded.net === 'ws' ? { path: decoded.path, headers: { Host: decoded.host } } : undefined };
    }
    
    const url = new URL(configStr);
    const params = new URLSearchParams(url.search);
    
    if (protocol === 'vless') {
        return { ...baseProxy, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni'), 'ws-opts': params.get('type') === 'ws' ? { path: params.get('path'), headers: { Host: params.get('host') } } : undefined };
    }
    
    if (protocol === 'trojan') {
        return { ...baseProxy, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
    }
    
    if (protocol === 'ss') {
        const [cipher, password] = atob(url.username).split(':');
        return { ...baseProxy, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher, password };
    }
    
    return null;
}
