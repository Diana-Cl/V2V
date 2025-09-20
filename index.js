document.addEventListener('DOMContentLoaded', () => {
    // --- configuration ---
    const worker_urls = [
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://v2v-proxy.mbrgh87.workers.dev'
    ];
    // انتخاب رندوم یکی از ورکرها برای توزیع بار در هر بار لود صفحه
    const worker_url = worker_urls[Math.floor(Math.random() * worker_urls.length)]; 

    const cache_url_worker = `${worker_url}/cache-version`;
    const test_timeout = 8000; // 8 seconds

    // --- dom elements ---
    const statusbar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrcodeContainer = document.getElementById('qr-code-container');
    const toastElement = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} };

    // --- helpers ---
    const toShamsi = (timestamp) => {
        if (!timestamp || isNaN(timestamp)) return 'n/a';
        try {
            const ts = parseInt(timestamp, 10);
            if (isNaN(ts)) return 'n/a';
            return new Date(ts * 1000).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
        } catch {
            return 'n/a';
        }
    };

    const showToast = (message, isError = false) => {
        toastElement.textContent = message;
        toastElement.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => {
            toastElement.className = 'toast';
        }, 3000);
    };

    // --- render function ---
    async function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = ''; // clear previous content

        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`;
            return;
        }

        const isXray = core === 'xray';
        const actionsHtml = `
            <button class="test-button" data-action="run-ping-test" data-core="${core}">
                <span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span>
            </button>
            <div class="action-group-collapsible open">
                <div class="protocol-header" data-action="toggle-actions"><span>گزینه‌های اشتراک</span><span class="toggle-icon">▼</span></div>
                <div class="collapsible-content">
                    <div class="action-group-title">اشتراک عمومی (همه کانفیگ‌ها)</div>
                    <div class="action-box">
                        <div class="action-row">
                            <span class="action-box-label">لینک اشتراک Standard</span>
                            <div class="action-box-buttons">
                                <button class="action-btn-small" data-action="copy-sub" data-core="${core}">کپی</button>
                                <button class="action-btn-small" data-action="qr-sub" data-core="${core}">QR</button>
                            </div>
                        </div>
                    </div>
                    <div class="action-group-title">اشتراک شخصی (کانفیگ‌های انتخابی)</div>
                    <div class="action-box">
                        <div class="action-row">
                            <span class="action-box-label">لینک Standard</span>
                            <div class="action-box-buttons">
                                <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="standard">کپی</button>
                                <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="standard" data-method="qr">QR</button>
                            </div>
                        </div>
                        ${isXray ? `
                        <div class="action-row" style="margin-top:10px;">
                            <span class="action-box-label">لینک Clash</span>
                            <div class="action-box-buttons">
                                <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash" data-method="download">دانلود</button>
                                <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash">کپی URL</button>
                                <button class="action-btn-small" data-action="create-personal-sub" data-core="${core}" data-type="clash" data-method="qr">QR</button>
                            </div>
                        </div>` : ''}
                    </div>
                </div>
            </div>`;
        wrapper.insertAdjacentHTML('beforeend', actionsHtml);
        
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
                    if (config.startsWith('vmess://')) {
                         const vmessData = JSON.parse(atob(config.substring(8)));
                         name = decodeURIComponent(vmessData.ps || 'v2v config');
                    } else {
                        const urlObj = new URL(config);
                        name = decodeURIComponent(urlObj.hash.substring(1) || 'v2v config'); 
                    }
                } catch (e) { console.warn("Could not parse config name:", config); }

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

    // --- initial data load ---
    (async () => {
        try {
            const verRes = await fetch(`${cache_url_worker}?t=${Date.now()}`);
            if (verRes.ok) statusbar.textContent = `آخرین بروزرسانی: ${toShamsi(await verRes.text())}`;
        } catch (e) {
            console.error("Error fetching cache version:", e);
            statusbar.textContent = 'عدم دسترسی به نسخه بروزرسانی.';
        }
        try {
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

    // --- reliable sequential testing logic ---
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
            if (['hysteria2', 'hy2', 'tuic'].includes(protocol)) transport = 'webtransport';
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
            
            if (!config) { updateItemUI(item, 'fail', null); continue; }
            
            const result = (config.transport === 'webtransport') ? await testDirectWebtransport(config) : await testBridgeTCP(config);
            const type = (config.transport === 'webtransport') ? 'wt' : 'tcp';
            updateItemUI(item, type, result.latency);
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
            const res = await fetch(`${worker_url}/tcp-probe`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: config.host, port: config.port }),
                signal: AbortSignal.timeout(test_timeout)
            });
            if (!res.ok) return { latency: null };
            return await res.json();
        } catch (e) { return { latency: null }; }
    }
    
    async function testDirectWebtransport(config) {
        if (typeof WebTransport === "undefined") {
            showToast('مرورگر شما از WebTransport پشتیبانی نمی‌کند.', true);
            return { latency: null };
        }
        return new Promise(resolve => {
            let transport;
            const timeout = setTimeout(() => { 
                if (transport && transport.state === "connecting") transport.close();
                resolve({ latency: null }); 
            }, test_timeout);
            
            try {
                transport = new WebTransport(`https://${config.host}:${config.port}`);
                const startTime = Date.now();
                transport.ready.then(() => {
                    clearTimeout(timeout);
                    transport.close();
                    resolve({ latency: Date.now() - startTime });
                }).catch(() => {
                    clearTimeout(timeout);
                    resolve({ latency: null });
                });
            } catch (e) {
                clearTimeout(timeout);
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
            resultText = `[${type.toUpperCase()}] ${latency}ms`;
            color = latency < 700 ? 'var(--ping-good)' : (latency < 1500 ? 'var(--ping-medium)' : 'var(--ping-bad)');
        }
        container.innerHTML = `<strong style="color:${color};">${resultText}</strong>`;
    }

    // --- event handling & actions ---
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
                showQRCode(finalUrl);
            } else if (method === 'download' && type === 'clash') {
                const downloadRes = await fetch(finalUrl);
                if (!downloadRes.ok) throw new Error('Failed to download clash config.');
                const blob = await downloadRes.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'v2v.yaml';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('فایل Clash دانلود شد.');
            } else { 
                await navigator.clipboard.writeText(finalUrl); 
                showToast(`لینک اشتراک شخصی ${type === 'clash' ? 'Clash' : ''} کپی شد.`); 
            }
        } catch (e) { showToast(`خطا در ساخت لینک اشتراک: ${e.message}`, true); }
    }

    function showQRCode(text) { 
        if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; } 
        qrcodeContainer.innerHTML = ''; 
        new QRCode(qrcodeContainer, { text, width: 256, height: 256 });
        qrModal.style.display = 'flex'; 
    }
    
    document.body.addEventListener('click', async (event) => {
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
                case 'qr-single': showQRCode(item.dataset.config); break;
                case 'copy-sub': 
                    await navigator.clipboard.writeText(`${worker_url}/sub/public/${core}`); 
                    showToast('لینک اشتراک عمومی کپی شد.'); 
                    break;
                case 'qr-sub': showQRCode(`${worker_url}/sub/public/${core}`); break;
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
