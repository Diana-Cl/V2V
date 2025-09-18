document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    // این URL باید به آدرس واقعی Cloudflare Worker شما اشاره کند
    // اگر ورکر در یک ساب‌دومین است، مثلاً https://api.yourdomain.com
    // اگر در خود دامین اصلی است، مثلاً https://yourdomain.com
    const worker_url = 'https://rapid-scene-1da6.mbrgh87.workers.dev'; // مثال
    const data_url = `${worker_url}/all_live_configs.json`; // دیتا مستقیماً از ورکر فچ می‌شود
    const cache_url_worker = `${worker_url}/cache-version`;
    const test_timeout = 8000; // 8 seconds

    // --- DOM Elements ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrCodeContainer = document.getElementById('qr-code-container');
    const toastElement = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} };

    // --- Helpers ---
    const toShamsi = (timestamp) => {
        if (!timestamp || isNaN(timestamp)) return 'N/A';
        try {
            // اطمینان از اینکه timestamp از نوع رشته یا عدد است
            const ts = parseInt(timestamp, 10);
            if (isNaN(ts)) return 'N/A';
            return new Date(ts * 1000).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
        } catch {
            return 'N/A';
        }
    };

    const showToast = (message, isError = false) => {
        toastElement.textContent = message;
        toastElement.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => {
            toastElement.className = 'toast';
        }, 3000);
    };

    // --- Render Function ---
    async function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = ''; // Clear previous content

        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`;
            return;
        }

        const isXray = core === 'xray';
        let actionsHtml = `
            <button class="test-button" data-action="run-ping-test" data-core="${core}">
                <span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span>
            </button>
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
        wrapper.innerHTML = actionsHtml; // Assign to wrapper
        
        for (const protocol in groupedConfigs) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group open';
            pGroupEl.dataset.protocolName = protocol;
            const configs = groupedConfigs[protocol];
            let itemsHtml = '';
            configs.forEach((config) => {
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                let name = 'v2v | unnamed';
                try { 
                    const urlObj = new URL(config);
                    name = decodeURIComponent(urlObj.hash.substring(1) || 'v2v config'); 
                } catch (e) {
                    console.warn("Could not parse config name:", e, config);
                }
                itemsHtml += `
                    <li class="config-item" data-config='${safeConfig}'>
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details">
                            <span class="server">${name}</span>
                            <div class="ping-result-container"></div>
                        </div>
                        <div class="config-actions">
                            <button class="copy-btn" data-action="copy-single">کپی</button>
                            <button class="copy-btn" data-action="qr-single">QR</button>
                        </div>
                    </li>`;
            });
            pGroupEl.innerHTML = `
                <div class="protocol-header" data-action="toggle-protocol">
                    <div class="protocol-header-title">
                        <span>${protocol.toUpperCase()} (${configs.length})</span><span class="toggle-icon">▼</span>
                    </div>
                    <div class="protocol-header-actions">
                        <button class="action-btn-small" data-action="copy-protocol">کپی همه</button>
                    </div>
                </div>
                <ul class="config-list">${itemsHtml}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    }

    // --- Initial Data Load ---
    (async () => {
        try {
            const verRes = await fetch(`${cache_url_worker}?t=${Date.now()}`);
            if (verRes.ok) {
                statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(await verRes.text())}`;
            }
        } catch (e) {
            console.error("Error fetching cache version:", e);
            statusBar.textContent = 'عدم دسترسی به نسخه بروزرسانی.';
        }
        try {
            // حالا دیتا از ورکر اصلی فچ می‌شود نه از یک فایل استاتیک
            const dataRes = await fetch(`${worker_url}/configs`); 
            if (!dataRes.ok) throw new Error('Failed to load configs from worker.');
            allConfigs = await dataRes.json();
            await renderCore('xray', allConfigs.xray || {});
            await renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            console.error("Error loading configs:", e);
            const errorMessage = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMessage;
            singboxWrapper.innerHTML = errorMessage;
        }
    })();

    // --- Reliable Sequential Testing Logic ---
    function parseConfig(configStr) {
        try {
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.substring(8)));
                return { protocol: 'vmess', host: data.add, port: parseInt(data.port), transport: data.net, path: data.path || '/' };
            }
            const urlObj = new URL(configStr);
            const params = new URLSearchParams(urlObj.search);
            const protocol = urlObj.protocol.replace(':', '').toLowerCase();
            let transport = params.get('type') || 'tcp';
            if (protocol === 'hysteria2' || protocol === 'hy2' || protocol === 'tuic') transport = 'webtransport';
            return { protocol, host: urlObj.hostname, port: parseInt(urlObj.port), transport, path: params.get('path') || '/' };
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
                updateItemUI(item, 'fail', null);
                continue;
            }
            
            let result = { latency: null };
            if (config.transport === 'webtransport') {
                result = await testDirectWebTransport(config);
                updateItemUI(item, 'wt', result.latency);
            } else { // all tcp-based protocols
                result = await testBridgeTCP(config);
                updateItemUI(item, 'tcp', result.latency);
            }
            item.dataset.finalScore = result.latency !== null ? result.latency : 9999;
        }

        // Sort configs by finalScore
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
            const res = await fetch(`${worker_url}/tcp-probe`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: config.host, port: config.port }),
                signal: AbortSignal.timeout(test_timeout) // Use AbortSignal.timeout
            });
            if (!res.ok) return { latency: null };
            return await res.json();
        } catch (e) { 
            console.error("TCP probe error:", e); // Log error for debugging
            return { latency: null }; 
        }
    }
    
    async function testDirectWebTransport(config) {
        // Check for WebTransport API support
        if (typeof WebTransport === "undefined") {
            showToast('مرورگر شما از WebTransport پشتیبانی نمی‌کند.', true);
            return { latency: null };
        }
        return new Promise(async resolve => {
            let transport;
            try {
                // WebTransport requires HTTPS. Ensure the worker is on HTTPS.
                transport = new WebTransport(`https://${config.host}:${config.port}`);
                const startTime = Date.now();
                const timeout = setTimeout(() => { 
                    if (transport && transport.state === "connecting") {
                        transport.close();
                    }
                    resolve({ latency: null }); 
                }, test_timeout);
                
                await transport.ready; // Wait for the transport to be ready
                clearTimeout(timeout);
                
                // For a simple ping, closing immediately after ready is enough.
                transport.close(); 
                resolve({ latency: Date.now() - startTime });
            } catch (e) { 
                console.error("WebTransport test error:", e);
                if (transport && transport.state === "connecting") {
                    transport.close();
                }
                resolve({ latency: null }); 
            }
        });
    }

    function updateItemUI(item, type, latency) {
        const container = item.querySelector('.ping-result-container');
        if (type === 'fail') {
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

    // --- Event Handling & Actions ---
    async function createPersonalSubscription(core, type, method) {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                                    .map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) { showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true); return; }
        try {
            const res = await fetch(`${worker_url}/api/subscribe`, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ configs: selectedConfigs }) 
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            const finalUrl = `${worker_url}/sub${type === 'clash' ? '/clash' : ''}/${data.uuid}`;
            if (method === 'qr') {
                showQrCode(finalUrl);
            } else if (method === 'download' && type === 'clash') {
                // برای دانلود فایل Clash
                const downloadRes = await fetch(finalUrl);
                if (!downloadRes.ok) throw new Error('Failed to download Clash config.');
                const blob = await downloadRes.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'v2v.yaml'; // نام فایل دانلود
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('فایل Clash دانلود شد.');
            }
            else { 
                await navigator.clipboard.writeText(finalUrl); 
                showToast(`لینک اشتراک شخصی ${type === 'clash' ? 'Clash' : ''} کپی شد.`); 
            }
        } catch (e) { showToast(`خطا در ساخت لینک اشتراک: ${e.message}`, true); }
    }

    function showQrCode(text) { 
        if (!window.QRCode) { // Changed qrcode to QRCode as per library's global variable name
            showToast('کتابخانه QR در حال بارگذاری است...', true); 
            return; 
        } 
        qrCodeContainer.innerHTML = ''; 
        new QRCode(qrCodeContainer, { text, width: 256, height: 256 }); // Changed qrcode to QRCode
        qrModal.style.display = 'flex'; 
    }
    
    document.body.addEventListener('click', async (event) => { // Added async for inner await
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const { action, core, type, method } = target.dataset;
        const item = target.closest('.config-item');

        try {
            switch (action) {
                case 'run-ping-test': await runAdvancedPingTest(core, target); break;
                case 'copy-single': 
                    await navigator.clipboard.writeText(item.dataset.config); 
                    showToast('کانفیگ کپی شد.'); 
                    break;
                case 'qr-single': showQrCode(item.dataset.config); break;
                case 'copy-sub': 
                    await navigator.clipboard.writeText(`${worker_url}/sub/public/${core}`); 
                    showToast('لینک اشتراک کپی شد.'); 
                    break;
                case 'qr-sub': showQrCode(`${worker_url}/sub/public/${core}`); break;
                case 'create-personal-sub': await createPersonalSubscription(core, type, method); break;
                case 'copy-protocol':
                    const configs = Array.from(target.closest('.protocol-group').querySelectorAll('.config-item')).map(el => el.dataset.config);
                    await navigator.clipboard.writeText(configs.join('\n'));
                    showToast(`تمام ${configs.length} کانفیگ کپی شد.`);
                    break;
                case 'toggle-protocol': target.closest('.protocol-group').classList.toggle('open'); break;
                case 'toggle-actions': target.closest('.action-group-collapsible').classList.toggle('open'); break;
            }
        } catch (e) {
            console.error("Action error:", e);
            showToast(`خطایی رخ داد: ${e.message}`, true);
        }
    });
    qrModal.onclick = () => qrModal.style.display = 'none';
});
