document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const STATIC_CLASH_URL = 'https://smbcryp.github.io/V2V/clash_subscription.yml';
    const PING_TIMEOUT = 3000;
    const READY_SUB_COUNT = 30;
    const MAX_NAME_LENGTH = 50;

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} };

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
            const original_name = decodeURIComponent(configStr.split('#')[1] || 'Unnamed');
            let sanitized_name = original_name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
            if (sanitized_name.length > MAX_NAME_LENGTH) {
                sanitized_name = sanitized_name.substring(0, MAX_NAME_LENGTH) + '...';
            }
            return `V2V | ${sanitized_name || 'Config'}`;
        } catch { 
            return 'V2V | Unnamed Config';
        }
    };

    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    };

    // --- RENDER FUNCTION ---
    function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';

        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی یافت نشد.</div>`;
            return;
        }

        const isXray = core === 'xray';
        let actionsHTML = `
            <button class="test-button" data-action="run-ping-test" data-core="${core}">
                <span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span>
            </button>
            <div class="action-group-collapsible">
                <div class="protocol-header" data-action="toggle-actions">
                    <span>گزینه‌های اشتراک</span>
                    <span class="toggle-icon">▼</span>
                </div>
                <div class="collapsible-content">
                    <div class="action-group-title">اشتراک آماده (بر اساس ${READY_SUB_COUNT} کانفیگ برتر)</div>
                    <div class="action-box">
                        <span class="action-box-label">لینک اشتراک Standard</span>
                        <div class="action-box-buttons">
                            <button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="standard" data-method="copy">کپی</button>
                            <button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="standard" data-method="qr">QR</button>
                        </div>
                    </div>
                    ${isXray ? `
                    <div class="action-box">
                        <span class="action-box-label">لینک اشتراک Clash Meta</span>
                        <div class="action-box-buttons">
                            <button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="clash" data-method="download">دانلود</button>
                            <button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="clash" data-method="copy">کپی URL</button>
                            <button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="clash" data-method="qr">QR</button>
                        </div>
                    </div>
                    ` : ''}
                    <div class="action-group-title">اشتراک شخصی (کانفیگ‌های انتخابی شما)</div>
                    <div class="action-box">
                        <span class="action-box-label">ساخت لینک از موارد انتخابی</span>
                        <div class="action-box-buttons">
                            <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}">ساخت و کپی UUID</button>
                        </div>
                    </div>
                     ${isXray ? `
                    <div class="action-box">
                        <span class="action-box-label">دانلود فایل Clash از موارد انتخابی</span>
                         <div class="action-box-buttons">
                            <button class="action-btn-small" data-action="generate-clash-file" data-core="${core}">دانلود</button>
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        wrapper.innerHTML = actionsHTML;
        
        for (const protocol in groupedConfigs) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            let itemsHTML = '';
            const configs = groupedConfigs[protocol];
            configs.forEach((config, index) => {
                const name = parseConfigName(config);
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                const uniqueId = `${core}-${protocol}-${index}`;
                itemsHTML += `
                    <li class="config-item" id="${uniqueId}" data-config='${safeConfig}'>
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details"><span class="server">${name}</span><span class="ping-result"></span></div>
                        <button class="copy-btn" data-action="copy-single-config" data-config='${safeConfig}'>کپی</button>
                    </li>`;
            });
            pGroupEl.innerHTML = `
                <div class="protocol-header" data-action="toggle-protocol">
                    <span>${protocol.toUpperCase()} (${configs.length})</span>
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
            if (!dataRes.ok) throw new Error('Failed to load configs');
            allConfigs = await dataRes.json();
            renderCore('xray', allConfigs.xray || {});
            renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            console.error("Config loading failed:", e);
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- EVENT HANDLING & GLOBAL API ---
    
    async function runAdvancedPingTest(core, testButton) {
        const buttonText = testButton.querySelector('.test-button-text');
        if (testButton.disabled) return;
        testButton.disabled = true;
        buttonText.innerHTML = `<span class="loader"></span> درحال تست...`;

        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => {
            item.querySelector('.ping-result').textContent = '[C]... / [S]...';
            item.dataset.clientPing = "pending";
            item.dataset.serverPing = "pending";
        });
        
        const clientPromises = allItems.map(item => testHttpProbe(item, PING_TIMEOUT));
        const serverPromise = testTcpBatch(allItems, API_ENDPOINT);

        await Promise.allSettled([...clientPromises, serverPromise]);

        allItems.forEach(item => {
            const clientPing = item.dataset.clientPing === "null" ? null : parseInt(item.dataset.clientPing, 10);
            const serverPing = item.dataset.serverPing === "null" ? null : parseInt(item.dataset.serverPing, 10);
            item.dataset.finalScore = Math.min(clientPing ?? 9999, serverPing ?? 9999);
        });

        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const sorted = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            sorted.forEach(item => list.appendChild(item));
        });
        testButton.disabled = false;
        buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
    }
    
    async function createSubscription(core) {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) return showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
        try {
            const res = await fetch(`${API_ENDPOINT}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
            if (!res.ok) throw new Error(`Server responded with ${res.status}`);
            const data = await res.json();
            navigator.clipboard.writeText(data.subscription_url);
            showToast('لینک اشتراک شخصی شما ساخته و کپی شد.');
        } catch (e) {
            showToast('خطا در ساخت لینک اشتراک.', true);
            console.error('Subscription creation failed:', e);
        }
    }

    function copyReadySubscription(core, type, method) {
        const allFlatConfigs = Object.values(allConfigs[core] || {}).flat();
        const topConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);
        if (topConfigs.length === 0) return showToast('کانفیگی برای ساخت لینک یافت نشد.', true);
        
        if (type === 'clash' && method === 'copy') {
            navigator.clipboard.writeText(STATIC_CLASH_URL);
            showToast('لینک اشتراک آماده Clash کپی شد.');
            return;
        }

        let url, content;
        if (type === 'clash') {
            content = generateClashYaml(topConfigs);
            if (!content) return showToast('کانفیگ سازگار با کلش یافت نشد.', true);
            url = `data:text/yaml;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(content)))}`;
        } else {
            content = topConfigs.join('\n');
            url = `data:text/plain;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(content)))}`;
        }

        if (method === 'download') {
            downloadFile(content, `v2v-clash-ready.yaml`, 'text/yaml');
        } else if(method === 'copy') {
            navigator.clipboard.writeText(url);
            showToast(`لینک اشتراک آماده ${type} کپی شد.`);
        } else if (method === 'qr') {
            showQrCode(url);
        }
    }

    function generateClashFile(core) {
        let selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) {
            showToast('هیچ کانفیگی انتخاب نشده، فایل از کانفیگ‌های برتر ساخته می‌شود.');
            const allFlatConfigs = Object.values(allConfigs[core] || {}).flat();
            selectedConfigs = allFlatConfigs.slice(0, READY_SUB_COUNT);
            if (selectedConfigs.length === 0) return showToast('هیچ کانفیگی برای ساخت فایل وجود ندارد.', true);
        }
        
        const yamlString = generateClashYaml(selectedConfigs);
        if (!yamlString) return showToast('ساخت فایل Clash از کانفیگ‌های انتخابی ممکن نبود.', true);
        downloadFile(yamlString, `v2v-clash-selected.yaml`, 'text/yaml');
    }

    function showQrCode(text) {
        if (!window.QRCode) return showToast('کتابخانه QR در حال بارگذاری است...', true);
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256 });
        qrModal.style.display = 'flex';
    }

    function handleClicks(event) {
        const target = event.target.closest('[data-action]');
        if (!target) return;

        const { action, core, type, method, config } = target.dataset;

        switch (action) {
            case 'run-ping-test': runAdvancedPingTest(core, target); break;
            case 'copy-ready-sub': copyReadySubscription(core, type, method); break;
            case 'create-personal-sub': createSubscription(core); break;
            case 'generate-clash-file': generateClashFile(core); break;
            case 'copy-single-config': navigator.clipboard.writeText(config); showToast('کانفیگ کپی شد.'); break;
            case 'toggle-protocol': target.parentElement.classList.toggle('open'); break;
            case 'toggle-actions': target.parentElement.classList.toggle('open'); break;
        }
    }
    xrayWrapper.addEventListener('click', handleClicks);
    singboxWrapper.addEventListener('click', handleClicks);
    qrModal.onclick = () => qrModal.style.display = 'none';

    // --- PING & UI HELPERS ---
    function updateItemUI(item, source, ping) {
        if (source === 'C') item.dataset.clientPing = ping;
        if (source === 'S') item.dataset.serverPing = ping;

        const clientPing = item.dataset.clientPing;
        const serverPing = item.dataset.serverPing;
        
        let clientResult = clientPing === "pending" ? "..." : (clientPing === "null" ? "ناموفق" : `${clientPing}ms`);
        let serverResult = serverPing === "pending" ? "..." : (serverPing === "null" ? "ناموفق" : `${serverPing}ms`);
        
        const bestPing = Math.min(
            clientPing === "null" || clientPing === "pending" ? 9999 : parseInt(clientPing),
            serverPing === "null" || serverPing === "pending" ? 9999 : parseInt(serverPing)
        );

        let color = 'var(--text-color)';
        if(bestPing !== 9999){
             color = bestPing < 700 ? 'var(--ping-good)' : (bestPing < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)');
        }
        
        item.querySelector('.ping-result').innerHTML = `<strong style="color:${color};">[C] ${clientResult} / [S] ${serverResult}</strong>`;
    }
    
    async function testHttpProbe(item, timeout) {
        const config = item.dataset.config;
        try {
            let hostname, port;
            if (config.startsWith('vmess://')) {
                const data = JSON.parse(atob(config.replace('vmess://', '')));
                hostname = data.add; port = data.port;
            } else {
                const url = new URL(config);
                hostname = url.hostname; port = url.port;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            
            const startTime = Date.now();
            await fetch(`https://${hostname}:${port}`, { method: 'HEAD', mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
            const latency = Date.now() - startTime;
            
            clearTimeout(timeoutId);
            updateItemUI(item, 'C', latency);
        } catch (e) {
            updateItemUI(item, 'C', null);
        }
    }
    
    async function testTcpBatch(items, apiUrl) {
        if (items.length === 0) return;
        try {
            const configsToTest = items.map(item => item.dataset.config);
            const res = await fetch(apiUrl + '/api/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: configsToTest }) });
            if (!res.ok) throw new Error('API response not OK');
            const results = await res.json();
            const resultsMap = new Map(results.map(r => [r.config, r.ping]));

            items.forEach(item => {
                const ping = resultsMap.get(item.dataset.config) ?? null;
                updateItemUI(item, 'S', ping);
            });
        } catch (e) {
            console.error("Backend TCP test failed:", e);
            items.forEach(item => updateItemUI(item, 'S', null));
        }
    }

    // --- CLASH & FILE HELPERS ---
    function downloadFile(content, fileName, contentType) {
        const blob = new Blob([content], { type: contentType });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function generateClashYaml(configs) {
        if (!window.jsyaml) { showToast('کتابخانه js-yaml بارگذاری نشده است.', true); return null; }
        try {
            const proxies = configs.map(parseProxyForClash).filter(p => p !== null);
            if (proxies.length === 0) return null;
            const proxyNames = proxies.map(p => p.name);
            const clashConfig = {
                'proxies': proxies,
                'proxy-groups': [
                    { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 },
                    { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] }
                ], 'rules': ['MATCH,V2V-Select']
            };
            return jsyaml.dump(clashConfig, { indent: 2, sortKeys: false, lineWidth: -1 });
        } catch (e) {
            console.error("YAML generation error:", e);
            showToast('خطا در ساخت فایل YAML کلش.', true);
            return null;
        }
    }
    
    function parseProxyForClash(configStr) {
       try {
            const original_name = decodeURIComponent(configStr.split('#').pop() || "Config");
            let sanitized_name = original_name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();
            if (sanitized_name.length > MAX_NAME_LENGTH) {
                sanitized_name = sanitized_name.substring(0, MAX_NAME_LENGTH) + '...';
            }
            const final_name = `V2V | ${sanitized_name || 'Config'}`;
            
            const base = { name: final_name, 'skip-cert-verify': true };
            const protocol = configStr.split('://')[0];

            if (protocol === 'vmess') {
                const d = JSON.parse(atob(configStr.substring(8)));
                const vmessProxy = { ...base, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: parseInt(d.aid), cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net, servername: d.sni || d.host };
                if (d.net === 'ws') vmessProxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add }};
                return vmessProxy;
            }
            const url = new URL(configStr), params = new URLSearchParams(url.search);
            if (protocol === 'vless') {
                 const vlessProxy = { ...base, type: 'vless', server: url.hostname, port: parseInt(url.port), uuid: url.username, tls: params.get('security') === 'tls', network: params.get('type'), servername: params.get('sni')};
                 if (params.get('type') === 'ws') vlessProxy['ws-opts'] = { path: params.get('path') || '/', headers: { Host: params.get('host') || url.hostname }};
                 return vlessProxy;
            }
            if (protocol === 'trojan') return { ...base, type: 'trojan', server: url.hostname, port: parseInt(url.port), password: url.username, sni: params.get('sni') };
            if (protocol === 'ss') { const [c, p] = atob(url.username).split(':'); return { ...base, type: 'ss', server: url.hostname, port: parseInt(url.port), cipher: c, password: p }; }
        } catch { return null; }
        return null;
    }
});
