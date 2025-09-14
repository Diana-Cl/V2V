document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const DNS_TIMEOUT = 2000;
    const READY_SUB_COUNT = 30;
    const MAX_NAME_LENGTH = 40;

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} };

    // --- HELPERS (Unchanged helpers are kept for brevity) ---
    const toShamsi = (timestamp) => { if (!timestamp || isNaN(timestamp)) return 'N/A'; try { const date = new Date(parseInt(timestamp, 10) * 1000); return date.toLocaleString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return 'Invalid Date'; } };
    const showToast = (message, isError = false) => { toast.textContent = message; toast.className = `toast show ${isError ? 'error' : ''}`; setTimeout(() => { toast.className = 'toast'; }, 3000); };
    async function generateProxyName(configStr) { try { const url = new URL(configStr); let name = decodeURIComponent(url.hash.substring(1) || ""); if (!name) { const server_id = `${url.hostname}:${url.port}`; const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(server_id)); name = `Config-${Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6)}`; } name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim(); if (name.length > MAX_NAME_LENGTH) name = name.substring(0, MAX_NAME_LENGTH) + '...'; return `V2V | ${name}`; } catch { return 'V2V | Unnamed Config'; } }

    // --- RENDER FUNCTION (Mostly Unchanged) ---
    async function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`;
            return;
        }
        const isXray = core === 'xray';
        let actionsHTML = `<button class="test-button" data-action="run-ping-test" data-core="${core}"><span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span></button><div class="action-group-collapsible"><div class="protocol-header" data-action="toggle-actions"><span>گزینه‌های اشتراک</span><span class="toggle-icon">▼</span></div><div class="collapsible-content"><div class="action-group-title">اشتراک آماده</div><div class="action-box"><span class="action-box-label">لینک اشتراک Standard</span><div class="action-box-buttons"><button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="standard" data-method="copy">کپی</button><button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="standard" data-method="qr">QR</button></div></div>${isXray ? `<div class="action-box"><span class="action-box-label">لینک اشتراک Clash Meta</span><div class="action-box-buttons"><button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="clash" data-method="download">دانلود</button><button class="action-btn-small" data-action="copy-ready-sub" data-core="${core}" data-type="clash" data-method="copy">کپی URL</button></div></div>` : ''}<div class="action-group-title">اشتراک شخصی</div><div class="action-box"><span class="action-box-label">ساخت لینک از موارد انتخابی</span><div class="action-box-buttons"><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}">ساخت و کپی</button></div></div>${isXray ? `<div class="action-box"><span class="action-box-label">دانلود فایل Clash از موارد انتخابی</span><div class="action-box-buttons"><button class="action-btn-small" data-action="generate-clash-file" data-core="${core}">دانلود</button></div></div>` : ''}</div></div>`;
        wrapper.innerHTML = actionsHTML;
        for (const protocol in groupedConfigs) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            const configs = groupedConfigs[protocol];
            const namePromises = configs.map(config => generateProxyName(config));
            const names = await Promise.all(namePromises);
            let itemsHTML = '';
            configs.forEach((config, index) => {
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                itemsHTML += `<li class="config-item" data-config='${safeConfig}'><input type="checkbox" class="config-checkbox"><div class="config-details"><span class="server">${names[index]}</span><span class="ping-result" title="آماده تست"></span></div><button class="copy-btn" data-action="copy-single-config" data-config='${safeConfig}'>کپی</button></li>`;
            });
            pGroupEl.innerHTML = `<div class="protocol-header" data-action="toggle-protocol"><span>${protocol.toUpperCase()} (${configs.length})</span><span class="toggle-icon">▼</span></div><ul class="config-list">${itemsHTML}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    }

    // --- INITIAL DATA LOAD ---
    (async () => {
        try {
            const verRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (verRes.ok) {
                const lastUpdate = await verRes.text();
                const baselinePing = await testBaselinePing();
                statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(lastUpdate)} | پینگ پایه تا کلادفلر: ${baselinePing !== null ? `${baselinePing}ms` : 'N/A'}`;
            }
        } catch { statusBar.textContent = 'عدم دسترسی به نسخه بروزرسانی.'; }
        try {
            const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!dataRes.ok) throw new Error('Failed to load configs');
            allConfigs = await dataRes.json();
            await renderCore('xray', allConfigs.xray || {});
            await renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg; singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- NEW 3-STAGE TESTING ARCHITECTURE ---
    async function runAdvancedPingTest(core, testButton) {
        const buttonText = testButton.querySelector('.test-button-text');
        if (testButton.disabled) return;
        testButton.disabled = true;
        buttonText.innerHTML = `<span class="loader"></span> مرحله ۱/۲: تست DNS...`;

        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => updateItemUI(item, 'pending'));

        // Stage 2: DNS Pre-Filter
        const dnsPromises = allItems.map(item => testDns(item));
        const dnsResults = await Promise.all(dnsPromises);

        const configsForTcpTest = dnsResults.filter(r => r.success).map(r => r.item.dataset.config);
        
        buttonText.innerHTML = `<span class="loader"></span> مرحله ۲/۲: تست TCP... (${configsForTcpTest.length} کانفیگ)`;

        // Stage 3: Main TCP Ping
        if (configsForTcpTest.length > 0) {
            await testTcpBatch(allItems, configsForTcpTest);
        }

        allItems.forEach(item => {
            const score = parseInt(item.dataset.tcpPing || 9999);
            item.dataset.finalScore = score;
        });
        
        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const sorted = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            sorted.forEach(item => list.appendChild(item));
        });

        testButton.disabled = false;
        buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
    }

    // Stage 1: Baseline Ping
    async function testBaselinePing() {
        try {
            const startTime = Date.now();
            const response = await fetch(`${API_ENDPOINT}/api/ping-test?t=${startTime}`, { cache: 'no-store' });
            if (!response.ok) return null;
            return Date.now() - startTime;
        } catch {
            return null;
        }
    }

    // Stage 2: DNS Pre-Filter
    async function testDns(item) {
        const config = item.dataset.config;
        let hostname;
        try {
            hostname = config.startsWith('vmess://')
                ? JSON.parse(atob(config.replace('vmess://', ''))).add
                : new URL(config).hostname;
        } catch {
            updateItemUI(item, 'dns-fail');
            return { success: false, item };
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), DNS_TIMEOUT);
            
            const startTime = Date.now();
            // Using a public DoH provider as an example
            await fetch(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`, {
                headers: { 'accept': 'application/dns-json' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const latency = Date.now() - startTime;
            item.dataset.dnsPing = latency;
            updateItemUI(item, 'dns-ok');
            return { success: true, item };
        } catch (e) {
            // Fallback: If DNS test fails, we still proceed to TCP test.
            item.dataset.dnsPing = "fail";
            updateItemUI(item, 'dns-fail-fallback');
            return { success: true, item }; // Return success to allow TCP test
        }
    }

    // Stage 3: Main TCP Ping (Batch)
    async function testTcpBatch(allItems, configsToTest) {
        try {
            const res = await fetch(`${API_ENDPOINT}/api/ping`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: configsToTest }) });
            if (!res.ok) throw new Error('API response not OK');
            const results = await res.json();
            const resultsMap = new Map(results.map(r => [r.config, r.ping]));
            
            allItems.forEach(item => {
                if (configsToTest.includes(item.dataset.config)) {
                    const ping = resultsMap.get(item.dataset.config) ?? null;
                    item.dataset.tcpPing = ping;
                    updateItemUI(item, ping !== null ? 'tcp-ok' : 'tcp-fail');
                }
            });
        } catch (e) {
            console.error("Backend TCP test failed:", e);
            allItems.forEach(item => updateItemUI(item, 'tcp-fail'));
        }
    }

    // --- NEW UI/UX HELPER ---
    function updateItemUI(item, state) {
        const resultEl = item.querySelector('.ping-result');
        const dnsPing = item.dataset.dnsPing;
        const tcpPing = item.dataset.tcpPing;
        let statusText, color, title;

        switch (state) {
            case 'pending':
                statusText = '⏳ در انتظار...'; color = 'gray'; title = 'آماده تست'; break;
            case 'dns-ok':
                statusText = '...  TCP در حال تست'; color = 'var(--ping-medium)'; title = `DNS: ${dnsPing}ms`; break;
            case 'dns-fail':
                statusText = '🔴 دامنه نامعتبر'; color = 'var(--ping-bad)'; title = `DNS: Fail`; break;
            case 'dns-fail-fallback':
                 statusText = '... TCP در حال تست'; color = 'var(--ping-medium)'; title = `DNS: Fail (Fallback)`; break;
            case 'tcp-ok':
                statusText = `✅ ${tcpPing}ms`; color = tcpPing < 700 ? 'var(--ping-good)' : 'var(--ping-medium)'; title = `DNS: ${dnsPing}ms | TCP: ${tcpPing}ms`; break;
            case 'tcp-fail':
                statusText = '❌ اتصال ناموفق'; color = 'var(--ping-bad)'; title = `DNS: ${dnsPing}ms | TCP: Fail`; break;
            default:
                statusText = ''; color = 'gray'; title = '';
        }
        resultEl.innerHTML = `<strong style="color:${color};">${statusText}</strong>`;
        resultEl.title = title;
    }

    // --- EVENT HANDLING & OTHER FUNCTIONS ---
    function copyReadySubscription(core, type, method) {
        // Fixed: Use correct, specific URL for Clash
        const subUrl = (type === 'clash')
            ? `${API_ENDPOINT}/sub/public/clash/xray`
            : `${API_ENDPOINT}/sub/public/${core}`;

        if (method === 'copy') {
            navigator.clipboard.writeText(subUrl);
            showToast(`لینک اشتراک ${type === 'clash' ? 'Clash' : ''} کپی شد.`);
        } else if (method === 'download' && type === 'clash') {
            window.open(subUrl, '_blank');
        }
    }
    async function createSubscription(core) { /* ... (unchanged) ... */ }
    async function generateClashFile(core) { /* ... (unchanged) ... */ }
    function downloadFile(content, fileName, contentType) { /* ... (unchanged) ... */ }
    async function generateClashYaml(configs) { /* ... (unchanged) ... */ }

    // Fixed: Corrected typo in vless ws-opts assignment
    async function parseProxyForClash(configStr) {
       try {
            const final_name = await generateProxyName(configStr);
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
    
    // Kept for brevity, they are unchanged
    createSubscription = async function(core) { const sel = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config); if (sel.length === 0) return showToast('حداقل یک کانفیگ انتخاب کنید.', true); try { const res = await fetch(`${API_ENDPOINT}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: sel }) }); if (!res.ok) throw new Error(`Server responded with ${res.status}`); const data = await res.json(); navigator.clipboard.writeText(data.subscription_url); showToast('لینک اشتراک شخصی شما ساخته و کپی شد.'); } catch (e) { showToast('خطا در ساخت لینک اشتراک.', true); } };
    generateClashFile = async function(core) { let sel = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config); if (sel.length === 0) { showToast('کانفیگی انتخاب نشده، از کانفیگ‌های برتر استفاده می‌شود.'); const flat = Object.values(allConfigs[core] || {}).flat(); sel = flat.slice(0, READY_SUB_COUNT); if (sel.length === 0) return showToast('هیچ کانفیگی برای ساخت فایل وجود ندارد.', true); } const yaml = await generateClashYaml(sel); if (!yaml) return showToast('ساخت فایل Clash ممکن نبود.', true); downloadFile(yaml, `v2v-clash-selected.yaml`, 'text/yaml'); };
    downloadFile = function(content, fileName, contentType) { const blob = new Blob([content], { type: contentType }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = fileName; document.body.appendChild(link); link.click(); document.body.removeChild(link); };
    generateClashYaml = async function(configs) { if (!window.jsyaml) { showToast('کتابخانه js-yaml بارگذاری نشده است.', true); return null; } try { const proxies = (await Promise.all(configs.map(parseProxyForClash))).filter(p => p !== null); if (proxies.length === 0) return null; const proxyNames = proxies.map(p => p.name); const conf = { 'proxies': proxies, 'proxy-groups': [ { 'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxyNames, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300 }, { 'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', ...proxyNames] } ], 'rules': ['MATCH,V2V-Select'] }; return jsyaml.dump(conf, { indent: 2, sortKeys: false, lineWidth: -1 }); } catch (e) { showToast('خطا در ساخت فایل YAML کلش.', true); return null; } };
});
