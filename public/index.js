document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = '[https://rapid-scene-1da6.mbrgh87.workers.dev](https://rapid-scene-1da6.mbrgh87.workers.dev)';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const PING_TIMEOUT = 3000;
    const READY_SUB_COUNT = 30;

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: [], singbox: [] };

    // --- HELPERS ---
    const toShamsi = (timestamp) => {
        if (!timestamp || isNaN(timestamp)) return 'N/A';
        try {
            const date = new Date(parseInt(timestamp, 10) * 1000);
            return date.toLocaleString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch { return 'Invalid Date'; }
    };

    const parseConfigName = (configStr) => {
        try {
            if (configStr.includes('#')) return decodeURIComponent(configStr.split('#')[1] || `Unnamed`);
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.replace('vmess://', '')));
                return data.ps || data.add;
            }
            return new URL(configStr).hostname;
        } catch { return 'Unnamed Config'; }
    };
    
    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.className = 'toast show';
        if (isError) toast.classList.add('error');
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    };

    // --- RENDER FUNCTIONS ---
    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';

        if (!configs || configs.length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی یافت نشد.</div>`;
            return;
        }

        const isXray = core === 'xray';
        let actionsHTML = `
            <button class="test-button" id="${core}-test-btn" onclick="v2v.runAdvancedPingTest('${core}')">
                <span id="${core}-test-btn-text">🚀 تست پیشرفته کانفیگ‌ها</span>
            </button>
            
            <div class="action-group-title">اشتراک آماده (بر اساس ${READY_SUB_COUNT} کانفیگ برتر)</div>
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک Standard</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.copyReadySubscription('${core}', 'standard', 'copy')">کپی</button>
                    <button class="action-btn-small" onclick="v2v.copyReadySubscription('${core}', 'standard', 'qr')">QR</button>
                </div>
            </div>
            ${isXray ? `
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک Clash Meta</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.open('clash_subscription.yml', '_blank')">دانلود</button>
                    <button class="action-btn-small" onclick="v2v.copyStaticClashSub('copy')">کپی URL</button>
                    <button class="action-btn-small" onclick="v2v.copyStaticClashSub('qr')">QR</button>
                </div>
            </div>` : ''}

            <div class="action-group-title">اشتراک شخصی (کانفیگ‌های انتخابی شما)</div>
            <div class="action-box">
                <span class="action-box-label">ساخت لینک UUID از موارد انتخابی</span>
                <div class="action-box-buttons">
                     <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'standard', 'copy')">کپی لینک</button>
                     <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'standard', 'qr')">QR Code</button>
                </div>
            </div>
             ${isXray ? `
            <div class="action-box">
                <span class="action-box-label">ساخت لینک Clash از موارد انتخابی</span>
                 <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'clash', 'copy')">کپی لینک</button>
                    <button class="action-btn-small" onclick="v2v.createSubscription('${core}', 'clash', 'qr')">QR Code</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">دانلود فایل Clash از موارد انتخابی</span>
                 <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="v2v.generateClashFile('${core}')">دانلود فایل</button>
                </div>
            </div>` : ''}
        `;
        wrapper.innerHTML = actionsHTML;

        const grouped = configs.reduce((acc, config) => {
            const protocol = config.match(/^(\w+):\/\//)?.[1]?.toLowerCase() || 'unknown';
            if (!acc[protocol]) acc[protocol] = [];
            acc[protocol].push(config);
        }, {});

        for (const protocol in grouped) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            let itemsHTML = '';
            grouped[protocol].forEach(config => {
                const name = parseConfigName(config);
                const safeConfig = config.replace(/'/g, "&apos;");
                itemsHTML += `
                    <li class="config-item" data-config='${safeConfig}'>
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details"><span class="server">${name}</span><span class="ping-result"></span></div>
                        <button class="copy-btn" onclick="navigator.clipboard.writeText('${safeConfig}'); v2v.showToast('کانفیگ کپی شد!');">کپی</button>
                    </li>`;
            });
            pGroupEl.innerHTML = `
                <div class="protocol-header" onclick="this.parentElement.classList.toggle('open')">
                    <span>${protocol.toUpperCase()} (${grouped[protocol].length})</span>
                    <span class="toggle-icon">▼</span>
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
            if (!dataRes.ok) throw new Error(`Failed to load configs (status: ${dataRes.status})`);
            allConfigs = await dataRes.json();
            renderCore('xray', allConfigs.xray || []);
            renderCore('singbox', allConfigs.singbox || []);
        } catch (e) {
            console.error("Config load error:", e);
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- GLOBAL V2V OBJECT ---
    window.v2v = {
        showToast,
        runAdvancedPingTest: async (core) => {
            const testButton = document.getElementById(`${core}-test-btn`);
            const buttonText = document.getElementById(`${core}-test-btn-text`);
            if (testButton.disabled) return;
            testButton.disabled = true;
            buttonText.innerHTML = `<span class="loader"></span> درحال تست...`;

            const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
            allItems.forEach(item => { item.style.display = 'flex'; item.querySelector('.ping-result').textContent = '...'; });

            const configsToTestBackend = [];
            const wsTestPromises = [];

            for (const item of allItems) {
                const config = item.dataset.config;
                let isWs = false;
                try {
                    if ((config.startsWith('vless://') || config.startsWith('vmess://')) && (new URL(config).searchParams.get('type') === 'ws')) isWs = true;
                } catch {}
                if (isWs) wsTestPromises.push(testWebSocket(config, item, PING_TIMEOUT));
                else configsToTestBackend.push({ config, item });
            }
            
            await Promise.allSettled([...wsTestPromises, testTcpBatch(configsToTestBackend, API_ENDPOINT)]);

            document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
                const list = group.querySelector('.config-list');
                const sorted = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
                sorted.forEach(item => list.appendChild(item));
            });
            testButton.disabled = false;
            buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
        },
        
        createSubscription: async (core, type, action) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selectedConfigs.length === 0) return showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            
            try {
                const res = await fetch(`${API_ENDPOINT}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
                if (!res.ok) throw new Error(`Server responded with ${res.status}`);
                const data = await res.json();
                
                let finalUrl = data.subscription_url;
                if (type === 'clash') {
                    finalUrl = finalUrl.replace('/sub/', '/sub/clash/');
                }

                if (action === 'copy') {
                    navigator.clipboard.writeText(finalUrl);
                    showToast('لینک اشتراک شخصی شما کپی شد.');
                } else if (action === 'qr') {
                    v2v.showQrCode(finalUrl);
                }
            } catch (e) {
                showToast('خطا در ساخت لینک اشتراک.', true);
                console.error('Subscription creation failed:', e);
            }
        },

        copyReadySubscription: (core, type, action) => {
            const topConfigs = (allConfigs[core] || []).slice(0, READY_SUB_COUNT);
            if (topConfigs.length === 0) return showToast('کانفیگی برای ساخت لینک یافت نشد.', true);
            
            const content = topConfigs.join('\n');
            const url = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(content)))}`;

            if(action === 'copy') {
                navigator.clipboard.writeText(url);
                showToast(`لینک اشتراک آماده کپی شد.`);
            } else if (action === 'qr') {
                v2v.showQrCode(url);
            }
        },
        
        copyStaticClashSub: (action) => {
            const url = new URL('clash_subscription.yml', window.location.href).href;
             if(action === 'copy') {
                navigator.clipboard.writeText(url);
                showToast(`لینک اشتراک آماده کلش کپی شد.`);
            } else if (action === 'qr') {
                v2v.showQrCode(url);
            }
        },

        generateClashFile: (core) => {
            let selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
            if (selectedConfigs.length === 0) {
                 selectedConfigs = (allConfigs[core] || []).slice(0, READY_SUB_COUNT);
                 if (selectedConfigs.length === 0) return showToast('هیچ کانفیگی برای ساخت فایل وجود ندارد.', true);
            }
            const yamlString = generateClashYaml(selectedConfigs);
            if (!yamlString) return;

            const blob = new Blob([yamlString], { type: 'text/yaml;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `v2v-clash-${core}.yaml`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        },

        showQrCode: (text) => {
            if (!window.QRCode) return showToast('کتابخانه QR در حال بارگذاری است.', true);
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel : QRCode.CorrectLevel.M });
            qrModal.style.display = 'flex';
        }
    };
    qrModal.onclick = () => qrModal.style.display = 'none';

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
                const wsProtocol = (url.protocol === 'vless:' && url.searchParams.get('security') === 'tls') || url.port === '443' ? 'wss://' : 'ws://';
                const wsPath = url.searchParams.get('path') || '/';
                const wsUrl = `${wsProtocol}${url.hostname}:${url.port}${wsPath}`;
                const startTime = Date.now();
                const ws = new WebSocket(wsUrl);
                const timeoutId = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, timeout);
                ws.onopen = () => { clearTimeout(timeoutId); ws.close(); resolve(Date.now() - startTime); };
                ws.onerror = () => { clearTimeout(timeoutId); reject(new Error('WebSocket Error')); };
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
            const res = await fetch(apiUrl + '/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: items.map(i => i.config) }) });
            if (!res.ok) throw new Error('API response not OK');
            const results = await res.json();
            const resultsMap = new Map(results.map(r => [r.config, r.ping]));
            items.forEach(({ config, item }) => updateItemUI(item, { source: 'S', ping: resultsMap.get(config) ?? null }));
        } catch (e) {
            console.error("Backend TCP test failed:", e);
            items.forEach(({ item }) => updateItemUI(item, { source: 'S', ping: null }));
        }
    }

    function generateClashYaml(configs) {
        if (!window.jsyaml) { showToast('کتابخانه YAML بارگذاری نشده است.', true); return null; }
        const proxies = [];
        const uniqueCheck = new Set();
        configs.forEach(config => {
            try {
                const parsed = parseProxyForClash(config);
                if (parsed) {
                    const key = `${parsed.server}:${parsed.port}:${parsed.name}`;
                    if (!uniqueCheck.has(key)) { proxies.push(parsed); uniqueCheck.add(key); }
                }
            } catch {}
        });
        if (proxies.length === 0) { showToast('هیچ کانفیگ سازگاری یافت نشد.', true); return null; }
        const proxyNames = proxies.map(p => p.name);
        const clashConfig = {
            'proxies': proxies,
            'proxy-groups': [
                { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': '[http://www.gstatic.com/generate_204](http://www.gstatic.com/generate_204)', 'interval': 300 },
                { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] }
            ], 'rules': ['MATCH,V2V-Select']
        };
        try { return jsyaml.dump(clashConfig, { indent: 2, sortKeys: false, lineWidth: -1 }); }
        catch (e) { showToast('خطا در ساخت فایل YAML.', true); console.error(e); return null; }
    }
    
    function parseProxyForClash(configStr) {
        try {
            let name = decodeURIComponent(configStr.split('#').pop() || `V2V-${Date.now().toString().slice(-4)}`);
            const base = { name, 'skip-cert-verify': true };
            const protocol = configStr.split('://')[0];
            if (protocol === 'vmess') {
                const d = JSON.parse(atob(configStr.substring(8)));
                const proxy = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid || 0), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
                if (d.net === 'ws') proxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add } };
                return proxy;
            }
            const url = new URL(configStr), params = new URLSearchParams(url.search);
            if (protocol === 'vless') {
                const proxy = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni') };
                if (params.get('type') === 'ws') proxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname } };
                return proxy;
            }
            if (protocol === 'trojan') {
                 if(!url.username) return null;
                 return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
            }
            if (protocol === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; }
        } catch {}
        return null;
    }
});


