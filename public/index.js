document.addEventListener('DOMContentLoaded', () => {
    // --- پیکربندی نهایی ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const AUTO_SELECT_COUNT = 30;
    const PING_TIMEOUT = 5000; // 5 ثانیه

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
    
    function parseConfigForClient(config) {
        try {
            if (config.startsWith('vmess://')) {
                const decoded = atob(config.replace("vmess://", ""));
                const data = JSON.parse(decoded);
                const params = { type: data.net || 'tcp' };
                return { hostname: data.add, port: parseInt(data.port), params, path: data.path || '/' };
            }
            const url = new URL(config);
            const params = Object.fromEntries(new URLSearchParams(url.search).entries());
            return { hostname: url.hostname, port: parseInt(url.port), params, path: params.path || '/' };
        } catch (e) {
            return { hostname: null, port: null, params: {} };
        }
    }

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
        document.getElementById(`${core}-test-btn`).addEventListener('click', () => runUserPingTest(core));

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
                    let rawName = new URL(configObj.config).hostname;
                    if(configObj.config.includes('#')) {
                       rawName = decodeURIComponent(configObj.config.split('#')[1]);
                    }
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
                } catch(e) { /* Silently fail for configs that can't be parsed */ }
            });
            wrapper.appendChild(protocolGroup);
        }
    }
    
    async function runUserPingTest(core) {
        const testButton = document.getElementById(`${core}-test-btn`);
        if (testButton.disabled) return;
        testButton.disabled = true;
        testButton.textContent = 'درحال تست...';

        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => { // Reset UI for new test
            item.style.display = 'flex';
            item.querySelector('.ping-result').textContent = '...';
            delete item.dataset.finalScore;
        });
        
        const allConfigs = allItems.map(item => item.dataset.config);
        const results = new Map();
        
        // Stage 1: WebSocket Ping from Client
        testButton.textContent = 'تست مستقیم WebSocket...';
        const wsPromises = allConfigs.map(config => new Promise(resolve => {
            const { hostname, port, params, path } = parseConfigForClient(config);
            if (hostname && port && params.type === 'ws') {
                const startTime = Date.now();
                const ws = new WebSocket(`wss://${hostname}:${port}${path}`);
                let resolved = false;
                const finish = (ping) => {
                    if (!resolved) {
                        resolved = true;
                        if(ws.readyState < 2) ws.close();
                        resolve({ config, ping, method: 'WS' });
                    }
                };
                ws.onopen = () => finish(Date.now() - startTime);
                ws.onerror = () => finish(null);
                setTimeout(() => finish(null), PING_TIMEOUT);
            } else {
                resolve({ config, ping: null, method: 'N/A' }); // Not a WebSocket config
            }
        }));

        const wsResults = await Promise.allSettled(wsPromises);
        const backendPingList = [];
        wsResults.forEach(res => {
            if (res.status === 'fulfilled') {
                if (res.value.ping !== null) {
                    results.set(res.value.config, { ping: res.value.ping, method: res.value.method });
                } else {
                    if (res.value.method === 'N/A') { // Not a WS config, send to backend
                        backendPingList.push(res.value.config);
                    } else { // Was a WS config but failed, mark as failed
                        results.set(res.value.config, { ping: null, method: 'WS' });
                    }
                }
            }
        });

        // Stage 2: Cloudflare Ping for the rest
        if (backendPingList.length > 0) {
            try {
                testButton.textContent = `تست ${backendPingList.length} کانفیگ از کلادفلر...`;
                const response = await fetch(`${API_ENDPOINT}/ping`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs: backendPingList })
                });
                if (response.ok) {
                    const backendResults = await response.json();
                    backendResults.forEach(res => {
                        results.set(res.config, { ping: res.ping, method: 'CF' });
                    });
                } else {
                    backendPingList.forEach(c => results.set(c, { ping: null, method: 'CF' }));
                }
            } catch (e) {
                console.error("Cloudflare ping failed:", e);
                backendPingList.forEach(c => results.set(c, { ping: null, method: 'CF' }));
            }
        }
        
        // Final UI Update
        allItems.forEach(item => {
            const result = results.get(item.dataset.config);
            const pingEl = item.querySelector('.ping-result');
            if (result && result.ping !== null && result.ping > 0) {
                let pingColor = 'var(--ping-good)';
                if (result.ping > 600) pingColor = 'var(--ping-medium)';
                if (result.ping > 1200) pingColor = 'var(--ping-bad)';
                item.dataset.finalScore = result.ping;
                pingEl.innerHTML = `پینگ (${result.method}): <strong style="color:${pingColor};">${result.ping}ms</strong>`;
                item.style.display = 'flex';
            } else {
                item.dataset.finalScore = 9999;
                item.style.display = 'none';
            }
        });

        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const visibleItems = Array.from(list.children).filter(item => item.style.display !== 'none');
            const hiddenItems = Array.from(list.children).filter(item => item.style.display === 'none');
            visibleItems.sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            list.innerHTML = '';
            visibleItems.forEach(item => list.appendChild(item));
            hiddenItems.forEach(item => list.appendChild(item));
        });

        testButton.disabled = false;
        testButton.textContent = 'اجرای مجدد تست سرعت';
    }

    // --- GLOBAL API FOR BUTTONS ---
    window.v2v = {
        copyConfig: (event) => {
            event.stopPropagation();
            copyToClipboard(event.target.closest('.config-item').dataset.config);
        },
        showConfigQr: (event) => {
            event.stopPropagation();
            showQrCode(event, event.target.closest('.config-item').dataset.config);
        },
        getSelectedConfigs: (core) => {
            let selected = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selected.length === 0) {
                alert(`هیچ کانفیگی انتخاب نشده. ${AUTO_SELECT_COUNT} عدد از بهترین کانفیگ‌ها به صورت خودکار انتخاب می‌شوند.`);
                const visibleItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`)).filter(item => item.style.display !== 'none');
                selected = visibleItems.sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999)).slice(0, AUTO_SELECT_COUNT).map(item => item.dataset.config);
            }
            return selected;
        },
        createSubscription: async (core, type, action, event) => {
            const configs = window.v2v.getSelectedConfigs(core);
            if (configs.length === 0) return alert('هیچ کانفیگی برای ساخت لینک وجود ندارد.');
            const btn = event.target;
            const originalText = btn.textContent;
            btn.disabled = true; btn.textContent = '...درحال ساخت';
            try {
                const response = await fetch(`${API_ENDPOINT}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs, type }) });
                if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
                const data = await response.json();
                if (action === 'url') { copyToClipboard(data.subscription_url, 'لینک اشتراک کپی شد!'); } 
                else if (action === 'qr') { showQrCode(event, data.subscription_url); }
            } catch (error) {
                alert('خطا در ساخت لینک اشتراک. لطفاً دوباره تلاش کنید.');
                console.error("Subscription creation failed:", error);
            } finally { btn.disabled = false; btn.textContent = originalText; }
        },
        downloadClashFile: (core, event) => {
            const configs = window.v2v.getSelectedConfigs(core);
            if (configs.length === 0) return alert('هیچ کانفیگی برای ساخت فایل وجود ندارد.');

            const usedNames = new Set();
            const proxies = configs.map(configStr => {
                try {
                    if (configStr.includes('reality')) return null;

                    let rawName = new URL(configStr).hostname;
                    if (configStr.includes('#')) rawName = decodeURIComponent(configStr.split('#')[1]);

                    let name = rawName;
                    let counter = 1;
                    while (usedNames.has(name)) { name = `${rawName}_${++counter}`; }
                    usedNames.add(name);

                    let proxy = { name };
                    if (configStr.startsWith('vmess://')) {
                        const d = JSON.parse(atob(configStr.replace('vmess://', '')));
                        proxy = { ...proxy, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: d.aid, cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net || 'tcp', 'skip-cert-verify': true, servername: d.sni || d.host || d.add };
                        if (proxy.network === 'ws') proxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add } };
                    } else if (configStr.startsWith('vless://')) {
                        const u = new URL(configStr);
                        const p = new URLSearchParams(u.search);
                        proxy = { ...proxy, type: 'vless', server: u.hostname, port: parseInt(u.port), uuid: u.username, tls: p.get('security') === 'tls', network: p.get('type') || 'tcp', servername: p.get('sni') || u.hostname, 'skip-cert-verify': true, client-fingerprint: 'chrome' };
                        if (proxy.network === 'ws') {
                            proxy['ws-opts'] = { path: p.get('path') || '/', headers: { Host: p.get('host') || u.hostname } };
                        } else if (proxy.network === 'grpc') {
                            proxy['grpc-opts'] = { 'grpc-service-name': p.get('serviceName') || '' };
                        }
                    } else if (configStr.startsWith('trojan://')) {
                        const u = new URL(configStr);
                        const p = new URLSearchParams(u.search);
                        proxy = { ...proxy, type: 'trojan', server: u.hostname, port: parseInt(u.port), password: u.username, sni: p.get('sni') || u.hostname, 'skip-cert-verify': true };
                    } else if (configStr.startsWith('ss://')) {
                        const u = new URL(configStr);
                        const [cipher, password] = atob(decodeURIComponent(u.username)).split(':');
                        proxy = { ...proxy, type: 'ss', server: u.hostname, port: parseInt(u.port), cipher, password };
                    } else { return null; }
                    return proxy;
                } catch (e) {
                    console.warn("Skipping invalid config for Clash:", configStr, e);
                    return null;
                }
            }).filter(p => p);

            if (proxies.length === 0) {
                alert('کانفیگ‌های انتخاب شده با کلش سازگار نیستند.'); return;
            }

            const proxyNames = proxies.map(p => p.name);
            const clashConfig = {
                'mixed-port': 7890, 'allow-lan': false, 'mode': 'rule', 'log-level': 'info',
                'external-controller': '127.0.0.1:9090',
                'dns': { 'enable': true, 'listen': '0.0.0.0:53', 'nameserver': ['8.8.8.8', '1.1.1.1'], 'fallback': ['1.0.0.1', 'dns.google'] },
                proxies,
                'proxy-groups': [
                    { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 },
                    { 'name': 'PROXY', 'type': 'select', 'proxies': ['V2V-Auto', 'DIRECT', ...proxyNames] }
                ],
                'rules': ['MATCH,PROXY']
            };
            
            const yamlConfig = jsyaml.dump(clashConfig, { indent: 2, sortKeys: false });
            const blob = new Blob([yamlConfig], { type: 'text/yaml;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'v2v-clash-meta.yaml';
            link.click();
            URL.revokeObjectURL(link.href);
        }
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
