document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const WORKER_URL = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json'; // This will be fetched from a mirror
    const CACHE_URL_WORKER = `${WORKER_URL}/cache-version`;
    const TEST_TIMEOUT = 8000;

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
            pGroupEl.className = 'protocol-group open';
            pGroupEl.dataset.protocolName = protocol;
            const configs = groupedConfigs[protocol];
            let itemsHTML = '';
            configs.forEach((config) => {
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                let name = 'V2V | Unnamed';
                try { name = decodeURIComponent(new URL(config).hash.substring(1) || 'V2V Config'); } catch {}
                itemsHTML += `<li class="config-item" data-config='${safeConfig}'><input type="checkbox" class="config-checkbox"><div class="config-details"><span class="server">${name}</span><div class="ping-result-container"></div></div><div class="config-actions"><button class="copy-btn" data-action="copy-single">کپی</button><button class="copy-btn" data-action="qr-single">QR</button></div></li>`;
            });
            pGroupEl.innerHTML = `<div class="protocol-header" data-action="toggle-protocol"><div class="protocol-header-title"><span>${protocol.toUpperCase()} (${configs.length})</span><span class="toggle-icon">▼</span></div><div class="protocol-header-actions"><button class="action-btn-small" data-action="copy-protocol">کپی همه</button></div></div><ul class="config-list">${itemsHTML}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    }

    // --- INITIAL DATA LOAD ---
    (async () => {
        try {
            const verRes = await fetch(`${CACHE_URL_WORKER}?t=${Date.now()}`);
            if (verRes.ok) statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(await verRes.text())}`;
        } catch { statusBar.textContent = 'عدم دسترسی به نسخه بروزرسانی.'; }
        try {
            const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`);
            if (!dataRes.ok) throw new Error('Failed to load configs');
            allConfigs = await dataRes.json();
            await renderCore('xray', allConfigs.xray || {});
            await renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg; singboxWrapper.innerHTML = errorMsg;
        }
    })();

    // --- RELIABLE SEQUENTIAL TESTING LOGIC ---
    function parseConfig(configStr) {
        try {
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.substring(8)));
                return { protocol: 'vmess', host: data.add, port: parseInt(data.port), transport: data.net, path: data.path || '/' };
            }
            const url = new URL(configStr);
            const params = new URLSearchParams(url.search);
            const protocol = url.protocol.replace(':', '').toLowerCase();
            let transport = params.get('type') || 'tcp';
            if (protocol === 'hysteria2' || protocol === 'hy2' || protocol === 'tuic') transport = 'webtransport';
            return { protocol, host: url.hostname, port: parseInt(url.port), transport, path: params.get('path') || '/' };
        } catch { return null; }
    }

    async function runAdvancedPingTest(core, testButton) {
        const buttonText = testButton.querySelector('.test-button-text');
        if (testButton.disabled) return;
        testButton.disabled = true;
        
        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            buttonText.innerHTML = `<span class="loader"></span> تست ${i + 1} از ${allItems.length}`;
            const config = parseConfig(item.dataset.config);
            
            if (!config) {
                updateItemUI(item, 'FAIL', null);
                continue;
            }
            
            let result = { latency: null };
            if (config.transport === 'webtransport') {
                result = await testDirectWebTransport(config);
                updateItemUI(item, 'WT', result.latency);
            } else { // All TCP-based protocols
                result = await testBridgeTCP(config);
                updateItemUI(item, 'TCP', result.latency);
            }
            item.dataset.finalScore = result.latency !== null ? result.latency : 9999;
        }

        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
            const list = group.querySelector('.config-list');
            Array.from(list.children)
                .sort((a, b) => (parseInt(a.dataset.finalScore) || 9999) - (parseInt(b.dataset.finalScore) || 9999))
                .forEach(node => list.appendChild(node));
        });

        buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
        testButton.disabled = false;
    }

    async function testBridgeTCP(config) {
        try {
            const res = await fetch(`${WORKER_URL}/tcp-probe`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: config.host, port: config.port }),
                signal: AbortSignal.timeout(TEST_TIMEOUT)
            });
            if (!res.ok) return { latency: null };
            return await res.json();
        } catch { return { latency: null }; }
    }
    
    async function testDirectWebTransport(config) {
        if (typeof WebTransport === "undefined") return { latency: null };
        return new Promise(async resolve => {
            try {
                const transport = new WebTransport(`https://${config.host}:${config.port}`);
                const startTime = Date.now();
                const timeout = setTimeout(() => { transport.close(); resolve({ latency: null }); }, TEST_TIMEOUT);
                await transport.ready;
                clearTimeout(timeout);
                transport.close();
                resolve({ latency: Date.now() - startTime });
            } catch { resolve({ latency: null }); }
        });
    }

    function updateItemUI(item, type, latency) {
        const container = item.querySelector('.ping-result-container');
        if (type === 'FAIL') {
            container.innerHTML = `<strong style="color:var(--ping-bad);">❌ نامعتبر</strong>`; return;
        }
        let resultText, color;
        if (latency === null) {
            resultText = '❌ ناموفق';
            color = 'var(--ping-bad)';
        } else {
            resultText = `[${type}] ${latency}ms`;
            color = latency < 700 ? 'var(--ping-good)' : (latency < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)');
        }
        container.innerHTML = `<strong style="color:${color};">${resultText}</strong>`;
    }

    // --- EVENT HANDLING & ACTIONS ---
    async function createPersonalSubscription(core, type, method) {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`)).map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) { showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true); return; }
        try {
            const res = await fetch(`${WORKER_URL}/api/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configs: selectedConfigs }) });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            const finalUrl = `${WORKER_URL}/sub${type === 'clash' ? '/clash' : ''}/${data.uuid}`;
            if (method === 'qr') showQrCode(finalUrl);
            else { navigator.clipboard.writeText(finalUrl); showToast(`لینک اشتراک شخصی ${type === 'clash' ? 'Clash' : ''} کپی شد.`); }
        } catch (e) { showToast(`خطا در ساخت لینک اشتراک: ${e.message}`, true); }
    }

    function showQrCode(text) { if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; } qrContainer.innerHTML = ''; new QRCode(qrContainer, { text, width: 256, height: 256 }); qrModal.style.display = 'flex'; }
    
    document.body.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const { action, core, type, method } = target.dataset;
        const item = target.closest('.config-item');

        switch (action) {
            case 'run-ping-test': runAdvancedPingTest(core, target); break;
            case 'copy-single': navigator.clipboard.writeText(item.dataset.config); showToast('کانفیگ کپی شد.'); break;
            case 'qr-single': showQrCode(item.dataset.config); break;
            case 'copy-sub': navigator.clipboard.writeText(`${WORKER_URL}/sub/public/${core}`); showToast('لینک اشتراک کپی شد.'); break;
            case 'qr-sub': showQrCode(`${WORKER_URL}/sub/public/${core}`); break;
            case 'create-personal-sub': createPersonalSubscription(core, type, method); break;
            case 'copy-protocol':
                const configs = Array.from(target.closest('.protocol-group').querySelectorAll('.config-item')).map(el => el.dataset.config);
                navigator.clipboard.writeText(configs.join('\n'));
                showToast(`تمام ${configs.length} کانفیگ کپی شد.`);
                break;
            case 'toggle-protocol': target.closest('.protocol-group').classList.toggle('open'); break;
            case 'toggle-actions': target.closest('.action-group-collapsible').classList.toggle('open'); break;
        }
    });
    qrModal.onclick = () => qrModal.style.display = 'none';
});
