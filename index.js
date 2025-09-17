document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const WORKER_URL = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const MAX_NAME_LENGTH = 40;
    const TEST_TIMEOUT = 5000;
    const CONCURRENT_TESTS = 15;

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} };

    // --- HELPERS ---
    const toShamsi = (ts) => { if (!ts || isNaN(ts)) return 'N/A'; try { return new Date(parseInt(ts, 10) * 1000).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }); } catch { return 'N/A'; } };
    const showToast = (message, isError = false) => { toast.textContent = message; toast.className = `toast show ${isError ? 'error' : ''}`; setTimeout(() => { toast.className = 'toast'; }, 3000); };
    async function generateProxyName(configStr) { try { const url = new URL(configStr); let name = decodeURIComponent(url.hash.substring(1) || ""); if (!name) { const server_id = `${url.hostname}:${url.port}`; const buffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(server_id)); name = `Config-${Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6)}`; } name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim().substring(0, MAX_NAME_LENGTH); return `V2V | ${name}`; } catch { return 'V2V | Unnamed Config'; } }

    // --- RENDER FUNCTION ---
    async function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`; return;
        }
        const isXray = core === 'xray';
        let actionsHTML = `<button class="test-button" data-action="run-ping-test" data-core="${core}"><span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span></button>
                           <div class="action-group-collapsible open">
                               <div class="protocol-header" data-action="toggle-actions"><span>گزینه‌های اشتراک</span><span class="toggle-icon">▼</span></div>
                               <div class="collapsible-content">
                                   <div class="action-group-title">اشتراک آماده</div>
                                   <div class="action-box">
                                       <div class="action-row"><span class="action-box-label">لینک اشتراک Standard</span><div class="action-box-buttons"><button class="action-btn-small" data-action="copy-sub" data-core="${core}" data-type="standard">کپی</button><button class="action-btn-small" data-action="qr-sub" data-core="${core}" data-type="standard">QR</button></div></div>
                                   </div>
                                   <div class="action-group-title">اشتراک شخصی</div>
                                   <div class="action-box">
                                       <div class="action-row"><span class="action-box-label">لینک Standard از موارد انتخابی</span><div class="action-box-buttons"><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="standard">کپی</button><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="standard" data-method="qr">QR</button></div></div>
                                       ${isXray ? `<div class="action-row" style="margin-top:10px;"><span class="action-box-label">لینک Clash از موارد انتخابی</span><div class="action-box-buttons"><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash" data-method="download">دانلود</button><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash">کپی URL</button><button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash" data-method="qr">QR</button></div></div>` : ''}
                                   </div>
                               </div>
                           </div>`;
        wrapper.innerHTML = actionsHTML;
        for (const protocol in groupedConfigs) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group open'; // Default to open
            pGroupEl.dataset.protocolName = protocol;
            const configs = groupedConfigs[protocol];
            const names = await Promise.all(configs.map(generateProxyName));
            let itemsHTML = '';
            configs.forEach((config, index) => {
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                itemsHTML += `<li class="config-item" data-config='${safeConfig}'><input type="checkbox" class="config-checkbox"><div class="config-details"><span class="server">${names[index]}</span><div class="ping-result-container"></div></div><div class="config-actions"><button class="copy-btn" data-action="copy-single" data-config='${safeConfig}'>کپی</button><button class="copy-btn" data-action="qr-single" data-config='${safeConfig}'>QR</button></div></li>`;
            });
            pGroupEl.innerHTML = `<div class="protocol-header" data-action="toggle-protocol"><div class="protocol-header-title"><span>${protocol.toUpperCase()} (${configs.length})</span><span class="toggle-icon">▼</span></div><div class="protocol-header-actions"><button class="action-btn-small" data-action="copy-protocol" data-protocol="${protocol}">کپی همه</button></div></div><ul class="config-list">${itemsHTML}</ul>`;
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
            await renderCore('xray', allConfigs.xray || {});
            await renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg; singboxWrapper.innerHTML = errorMsg;
        }
    })();
    
    // --- ADVANCED PARALLEL TESTING LOGIC ---
    function parseConfig(configStr) {
        if (!configStr || typeof configStr !== 'string') return null;
        try {
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.substring(8)));
                return { protocol: 'vmess', host: data.add, port: parseInt(data.port), transport: data.net, path: data.path || '/' };
            }
            const url = new URL(configStr);
            const params = new URLSearchParams(url.search);
            const protocol = url.protocol.replace(':', '');
            return { protocol, host: url.hostname, port: parseInt(url.port), transport: params.get('type') || (protocol === 'ss' ? 'tcp' : 'tcp'), path: params.get('path') || '/' };
        } catch (e) { console.error("Config Parse Error:", e); return null; }
    }

    async function runAdvancedPingTest(core, testButton) {
        const buttonText = testButton.querySelector('.test-button-text');
        testButton.disabled = true;
        buttonText.innerHTML = `<span class="loader"></span> در حال تست...`;
        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        
        // Prepare UI for detailed results
        allItems.forEach(item => {
            const resultContainer = item.querySelector('.ping-result-container');
            resultContainer.innerHTML = `
                <span class="ping-label">TCP:</span><span class="ping-result-item" data-type="TCP">--</span>
                <span class="ping-label">WS:</span><span class="ping-result-item" data-type="WS">--</span>
                <span class="ping-label">WT:</span><span class="ping-result-item" data-type="WT">--</span>`;
        });
        
        const queue = allItems.slice();
        const runTask = async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                const config = parseConfig(item.dataset.config);
                if (!config) {
                    updateItemUI(item, 'FAIL', null);
                    continue;
                }
                
                let promises = [];
                // Test 1: TCP Probe via Worker (for all TCP-based protocols)
                promises.push(testBridgeTCP(config).then(res => updateItemUI(item, 'TCP', res.latency)));

                // Test 2: Direct WebSocket (if transport is 'ws')
                if (config.transport === 'ws') {
                    promises.push(testDirectWebSocket(config).then(res => updateItemUI(item, 'WS', res.latency)));
                }

                // Test 3: Direct WebTransport (for specific protocols like hy2/tuic)
                if (['hysteria2', 'hy2', 'tuic'].includes(config.protocol)) {
                    promises.push(testDirectWebTransport(config).then(res => updateItemUI(item, 'WT', res.latency)));
                }
                
                await Promise.allSettled(promises);
            }
        };

        const workers = Array(CONCURRENT_TESTS).fill(null).map(runTask);
        await Promise.all(workers);

        allItems.forEach(item => {
            const latencies = ['tcp', 'ws', 'wt'].map(t => parseInt(item.dataset[t] || 9999));
            item.dataset.finalScore = Math.min(...latencies);
        });
        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            const sorted = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
            sorted.forEach(item => list.appendChild(item));
        });

        testButton.disabled = false;
        buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
    }
    
    // REFACTORED: testBridgeTCP now uses HTTP POST to /tcp-probe
    async function testBridgeTCP(config) {
        try {
            const response = await fetch(`${WORKER_URL}/tcp-probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: config.host, port: config.port }),
                signal: AbortSignal.timeout(TEST_TIMEOUT)
            });
            if (!response.ok) return { latency: null };
            const data = await response.json();
            return { latency: data.latency };
        } catch (e) {
            return { latency: null };
        }
    }

    async function testDirectWebSocket(config) {
        if (!config.host || !config.port) return Promise.resolve({ latency: null });
        return new Promise(resolve => {
            const startTime = Date.now();
            // Note: Direct WebSocket test from browser often fails due to mixed-content or CORS issues,
            // unless the server is specifically configured for it.
            const ws = new WebSocket(`wss://${config.host}:${config.port}${config.path || '/'}`);
            const timeout = setTimeout(() => {
                ws.close();
                resolve({ latency: null });
            }, TEST_TIMEOUT);

            ws.onopen = () => {
                clearTimeout(timeout);
                resolve({ latency: Date.now() - startTime });
                ws.close();
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                resolve({ latency: null });
            };
        });
    }

    async function testDirectWebTransport(config) {
        if (typeof WebTransport === "undefined") return Promise.resolve({ latency: null });
        return new Promise(async (resolve) => {
            const timeout = setTimeout(() => resolve({ latency: null }), TEST_TIMEOUT);
            try {
                const startTime = Date.now();
                const transport = new WebTransport(`https://${config.host}:${config.port}`);
                await transport.ready;
                clearTimeout(timeout);
                resolve({ latency: Date.now() - startTime });
                transport.close();
            } catch (e) {
                clearTimeout(timeout);
                resolve({ latency: null });
            }
        });
    }

    function updateItemUI(item, type, latency) {
        const container = item.querySelector('.ping-result-container');
        if (type === 'FAIL') {
            container.innerHTML = `<strong style="color:var(--ping-bad);">❌ نامعتبر</strong>`;
            return;
        }
        
        const resultEl = container.querySelector(`.ping-result-item[data-type="${type}"]`);
        if (!resultEl) return;

        item.dataset[type.toLowerCase()] = latency;

        if (latency === null) {
            resultEl.textContent = '❌';
            resultEl.style.color = 'var(--ping-bad)';
        } else {
            resultEl.textContent = `${latency}ms`;
            let color = 'var(--ping-bad)';
            if (latency < 700) color = 'var(--ping-good)';
            else if (latency < 1500) color = 'var(--ping-medium)';
            resultEl.style.color = color;
        }
    }

    // --- EVENT HANDLING & ACTIONS ---
    function getSubscriptionUrl(core, type) {
        // Public clash is disabled per worker logic
        if (type === 'clash') return ''; 
        return `${WORKER_URL}/sub/public/${core}`;
    }

    async function createPersonalSubscription(core, type, method) {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) { showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true); return; }
        try {
            const res = await fetch(`${WORKER_URL}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
            if (!res.ok) throw new Error('Server Error');
            const data = await res.json();
            
            const isClash = type === 'clash';
            const clashPart = isClash ? '/clash' : '';
            const finalUrl = `${WORKER_URL}/sub${clashPart}/${data.uuid}`;

            if (method === 'qr') showQrCode(finalUrl);
            else if (method === 'download') window.open(finalUrl, '_blank');
            else { navigator.clipboard.writeText(finalUrl); showToast(`لینک اشتراک شخصی ${isClash ? 'Clash' : ''} کپی شد.`); }
        } catch (e) { showToast('خطا در ساخت لینک اشتراک.', true); }
    }
    
    function showQrCode(text) { if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; } qrContainer.innerHTML = ''; new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H }); qrModal.style.display = 'flex'; }
    function getProtocolConfigs(target) { return Array.from(target.closest('.protocol-group').querySelectorAll('.config-item')).map(item => item.dataset.config); }

    async function handleClicks(event) {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const { action, core, type, method, config, protocol } = target.dataset;

        switch (action) {
            case 'run-ping-test': runAdvancedPingTest(core, target); break;
            case 'copy-single': navigator.clipboard.writeText(config); showToast('کانفیگ کپی شد.'); break;
            case 'qr-single': showQrCode(config); break;
            case 'copy-sub': 
                const subUrl = getSubscriptionUrl(core, type);
                if (method === 'download') { window.open(subUrl, '_blank'); } 
                else { navigator.clipboard.writeText(subUrl); showToast('لینک اشتراک کپی شد.'); }
                break;
            case 'qr-sub': showQrCode(getSubscriptionUrl(core, type)); break;
            case 'create-personal-sub': createPersonalSubscription(core, type, method); break;
            case 'copy-protocol': const pcfgs = getProtocolConfigs(target); if (pcfgs.length > 0) { navigator.clipboard.writeText(pcfgs.join('\n')); showToast(`تمام ${pcfgs.length} کانفیگ ${protocol} کپی شد.`); } break;
            case 'toggle-protocol': target.closest('.protocol-group').classList.toggle('open'); break;
            case 'toggle-actions': target.closest('.action-group-collapsible').classList.toggle('open'); break;
        }
    }
    document.querySelectorAll('.main-wrapper').forEach(w => w.addEventListener('click', handleClicks));
    qrModal.onclick = () => qrModal.style.display = 'none';
});
