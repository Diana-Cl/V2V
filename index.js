document.addEventListener('DOMContentLoaded', () => {
    // --- configuration ---
    const WORKER_URL = 'https://rapid-scene-1da6.mbrgh87.workers.dev'; // Replace with your actual worker URL
    // const DATA_URL = 'all_live_configs.json'; // Removed: Will now fetch from worker
    const CACHE_URL = 'cache_version.txt'; // Assuming this might still be a static asset or another endpoint
    const MAX_NAME_LENGTH = 40;
    const TEST_TIMEOUT = 10000; // Increased timeout for potentially slow connections (10 seconds)
    const CONCURRENT_TESTS = 8; // Concurrency limit adjusted for potentially longer probe times, can be tuned

    // --- DOM elements ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const toast = document.getElementById('toast');
    let allConfigs = { xray: {}, singbox: {} }; // Stores fetched configs

    // --- Helpers ---
    const toShamsi = (ts) => { if (!ts || isNaN(ts)) return 'n/a'; try { return new Date(parseInt(ts, 10) * 1000).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }); } catch { return 'n/a'; } };
    const showToast = (message, isError = false) => { toast.textContent = message; toast.className = `toast show ${isError ? 'error' : ''}`; setTimeout(() => { toast.className = 'toast'; }, 3000); };
    
    async function generateProxyName(configStr) {
        try {
            const url = new URL(configStr);
            let name = decodeURIComponent(url.hash.substring(1) || "");
            if (!name) {
                const serverId = `${url.hostname}:${url.port}`;
                const buffer = await crypto.subtle.digest('MD5', new TextEncoder().encode(serverId));
                name = `config-${Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 6)}`;
            }
            name = name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim().substring(0, MAX_NAME_LENGTH);
            return `V2V | ${name}`;
        } catch {
            return 'V2V | Unnamed Config';
        }
    }
    
    // --- Render Function ---
    async function renderCore(core, groupedConfigs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        if (!groupedConfigs || Object.keys(groupedConfigs).length === 0) {
            wrapper.innerHTML = `<div class="alert">هیچ کانفیگ فعالی برای هسته ${core} یافت نشد.</div>`;
            return;
        }
        const isXray = core === 'xray';

        // Pre-render action buttons (unchanged from your original code, adjusted for clarity)
        let actionsHtml = `<button class="test-button" data-action="run-ping-test" data-core="${core}"><span class="test-button-text">🚀 تست پیشرفته کانفیگ‌ها</span></button>
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
        wrapper.innerHTML = actionsHtml;

        for (const protocol in groupedConfigs) {
            const pGroupEl = document.createElement('div');
            pGroupEl.className = 'protocol-group';
            pGroupEl.dataset.protocolName = protocol;
            const configs = groupedConfigs[protocol];
            const names = await Promise.all(configs.map(generateProxyName));
            let itemsHtml = '';
            configs.forEach((config, index) => {
                const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, '&quot;');
                itemsHtml += `<li class="config-item" data-config='${safeConfig}' data-protocol="${protocol.toLowerCase()}">
                                <input type="checkbox" class="config-checkbox">
                                <div class="config-details">
                                    <span class="server">${names[index]}</span>
                                    <div class="ping-result-container">
                                        <span class="ping-result-item" data-type="tcp">--</span>
                                        <span class="ping-result-item" data-type="ws">--</span>
                                        <span class="ping-result-item" data-type="wt">--</span>
                                    </div>
                                </div>
                                <div class="config-actions">
                                    <button class="copy-btn" data-action="copy-single" data-config='${safeConfig}'>کپی</button>
                                    <button class="copy-btn" data-action="qr-single" data-config='${safeConfig}'>QR</button>
                                </div>
                              </li>`;
            });
            pGroupEl.innerHTML = `<div class="protocol-header" data-action="toggle-protocol"><div class="protocol-header-title"><span>${protocol.toUpperCase()} (${configs.length})</span><span class="toggle-icon">▼</span></div><div class="protocol-header-actions"><button class="action-btn-small" data-action="copy-protocol" data-protocol="${protocol}">کپی همه</button></div></div><ul class="config-list">${itemsHtml}</ul>`;
            wrapper.appendChild(pGroupEl);
        }
    }

    // --- Initial Data Load ---
    (async () => {
        try {
            // Fetch cache_version from a static asset or a worker endpoint if available
            const verRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (verRes.ok) statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(await verRes.text())}`;
        } catch { statusBar.textContent = 'عدم دسترسی به نسخه بروزرسانی.'; }

        try {
            // Fetch all_live_configs.json from the worker (new endpoint)
            const dataRes = await fetch(`${WORKER_URL}/all_live_configs.json?t=${Date.now()}`, { cache: 'no-store' });
            if (!dataRes.ok) throw new Error('Failed to load configs from worker');
            allConfigs = await dataRes.json();
            await renderCore('xray', allConfigs.xray || {});
            await renderCore('singbox', allConfigs.singbox || {});
        } catch (e) {
            console.error("Error loading initial configs:", e);
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفا صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();
    
    // --- Advanced Parallel Testing Logic ---
    function parseConfig(configStr) {
        if (!configStr || typeof configStr !== 'string') return null;
        try {
            if (configStr.startsWith('vmess://')) {
                const data = JSON.parse(atob(configStr.substring(8)));
                // VMess usually implies TCP (even if transport is WS)
                return { protocol: 'vmess', host: data.add, port: parseInt(data.port), network: data.net, tls: data.tls === 'tls', path: data.path || '/' };
            }
            const url = new URL(configStr);
            const params = new URLSearchParams(url.search);
            const protocol = url.protocol.replace(':', '');

            let tls = false;
            if (protocol === 'vless' || protocol === 'trojan') {
                tls = params.get('security') === 'tls' || params.get('security') === 'xtls' || url.port === '443';
            } else if (protocol === 'ss') {
                // SS does not have native TLS in URL, assume not TLS for direct ping
                tls = false;
            } else if (protocol === 'hysteria2' || protocol === 'hy2' || protocol === 'tuic') {
                // WebTransport protocols use TLS implicitly
                tls = true;
            }
            
            return {
                protocol: protocol,
                host: url.hostname,
                port: parseInt(url.port),
                network: params.get('type') || (protocol === 'ss' ? 'tcp' : undefined), // Default SS to TCP
                tls: tls,
                path: params.get('path') || '/'
            };
        } catch (e) {
            console.error("Error parsing config string:", configStr, e);
            return null;
        }
    }

    async function runAdvancedPingTest(core, testButton) {
        const buttonText = testButton.querySelector('.test-button-text');
        testButton.disabled = true;
        buttonText.innerHTML = `<span class="loader"></span> در حال تست...`;
        
        const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
        allItems.forEach(item => {
            const resultContainer = item.querySelector('.ping-result-container');
            resultContainer.innerHTML = `<span class="ping-result-item" data-type="tcp">--</span><span class="ping-result-item" data-type="ws">--</span><span class="ping-result-item" data-type="wt">--</span>`;
            // Reset existing dataset pings
            item.dataset.tcp = '';
            item.dataset.ws = '';
            item.dataset.wt = '';
            item.dataset.finalscore = 9999;
        });
        
        const queue = allItems.slice(); // Clone array for the queue
        const activeTests = new Set(); // To track active promises
        
        const runNextTest = async () => {
            if (queue.length === 0 && activeTests.size === 0) {
                return; // All tests done
            }
            if (queue.length > 0 && activeTests.size < CONCURRENT_TESTS) {
                const item = queue.shift();
                const configStr = item.dataset.config;
                const config = parseConfig(configStr);

                if (!config) {
                    updateItemUI(item, 'fail', null);
                    // No need to add to activeTests, it failed immediately
                    // Schedule next test immediately as this one didn't consume concurrency slot fully
                    setTimeout(runNextTest, 0); 
                    return; 
                }
                
                let testPromise;
                // Determine which test(s) to run based on protocol and network
                if (['hysteria2', 'hy2', 'tuic'].includes(config.protocol)) {
                    testPromise = testDirectWebTransport(config).then(res => updateItemUI(item, 'wt', res.latency));
                } else if (config.network === 'ws' || (config.protocol === 'vmess' && config.network === 'ws')) {
                    // For WS transport, try direct WebSocket first
                    testPromise = testDirectWebSocket(config).then(res => updateItemUI(item, 'ws', res.latency))
                                   .catch(() => testBridgeTcpProbe(config).then(res => updateItemUI(item, 'tcp', res.latency))); // Fallback to TCP probe via worker
                } else {
                    // Default to TCP probe via worker for all other TCP-based protocols
                    testPromise = testBridgeTcpProbe(config).then(res => updateItemUI(item, 'tcp', res.latency));
                }

                // Add to active tests and handle completion
                const completionPromise = testPromise.finally(() => {
                    activeTests.delete(completionPromise); // Remove from active tests
                    runNextTest(); // Try to run next test
                });
                activeTests.add(completionPromise);
                runNextTest(); // Immediately try to run another test if concurrency allows
            }

            if (queue.length === 0 && activeTests.size > 0) {
                 // If queue is empty but tests are still active, wait for them
                 await Promise.race(Array.from(activeTests)); // Wait for any active test to complete
                 runNextTest(); // Then try again
            }

            if (queue.length === 0 && activeTests.size === 0) {
                // All tests completed
                // Sorting after all tests are done
                allItems.forEach(item => {
                    const latencies = ['tcp', 'ws', 'wt']
                        .map(t => parseInt(item.dataset[t] || '9999', 10))
                        .filter(l => !isNaN(l)); // Filter out NaN from non-run tests
                    item.dataset.finalscore = latencies.length > 0 ? Math.min(...latencies) : 9999;
                });
                document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
                    const list = group.querySelector('.config-list');
                    const sorted = Array.from(list.children).sort((a, b) => (parseInt(a.dataset.finalscore, 10) || 9999) - (parseInt(b.dataset.finalscore, 10) || 9999));
                    sorted.forEach(item => list.appendChild(item));
                });

                testButton.disabled = false;
                buttonText.innerHTML = '🚀 تست مجدد کانفیگ‌ها';
            }
        };

        // Start the initial set of concurrent tests
        for (let i = 0; i < CONCURRENT_TESTS && i < allItems.length; i++) {
            runNextTest();
        }
    }
    
    // NEW: Function to send TCP probe request to worker
    async function testBridgeTcpProbe(config) {
        try {
            const payload = { host: config.host, port: config.port, tls: config.tls };
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), TEST_TIMEOUT); // Abort if timeout
            
            const response = await fetch(`${WORKER_URL}/tcp-probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(id);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown worker error' }));
                console.warn(`Worker TCP probe failed for ${config.host}:${config.port} (TLS: ${config.tls}). Status: ${response.status}, Error: ${errorData.error}`);
                return { latency: null, error: errorData.error };
            }
            const data = await response.json();
            return { latency: data.latency || null };

        } catch (e) {
            if (e.name === 'AbortError') {
                console.warn(`TCP probe timed out for ${config.host}:${config.port}`);
                return { latency: null, error: 'Timeout' };
            }
            console.error(`Error during TCP probe to worker for ${config.host}:${config.port}:`, e);
            return { latency: null, error: e.message };
        }
    }

    // Existing: Direct WebSocket test
    async function testDirectWebSocket(config) {
        return new Promise(resolve => {
            const startTime = Date.now();
            // Ensure wss for secure websocket
            const wsUrl = `wss://${config.host}:${config.port}${config.path}`;
            let ws;
            try {
                 ws = new WebSocket(wsUrl);
            } catch (e) {
                console.warn(`Failed to create WebSocket for ${wsUrl}: ${e.message}`);
                resolve({ latency: null, error: e.message });
                return;
            }

            const timeoutId = setTimeout(() => {
                ws.close();
                resolve({ latency: null, error: 'Timeout' });
            }, TEST_TIMEOUT);

            ws.onopen = () => {
                clearTimeout(timeoutId);
                resolve({ latency: Date.now() - startTime });
                ws.close();
            };
            ws.onerror = (e) => {
                clearTimeout(timeoutId);
                console.warn(`WebSocket error for ${wsUrl}:`, e);
                resolve({ latency: null, error: 'Connection error' });
            };
        });
    }

    // Existing: Direct WebTransport test
    async function testDirectWebTransport(config) {
        if (typeof WebTransport === "undefined") {
            return Promise.resolve({ latency: null, error: "WebTransport not supported" });
        }
        return new Promise(async resolve => {
            const startTime = Date.now();
            let transport;
            try {
                // WebTransport always uses HTTPS/WSS for connection
                transport = new WebTransport(`https://${config.host}:${config.port}`);
                const timeoutId = setTimeout(() => {
                    transport.close();
                    resolve({ latency: null, error: 'Timeout' });
                }, TEST_TIMEOUT);

                await transport.ready;
                clearTimeout(timeoutId);
                resolve({ latency: Date.now() - startTime });
                transport.close();
            } catch (e) {
                console.warn(`WebTransport error for ${config.host}:${config.port}:`, e.message);
                resolve({ latency: null, error: e.message });
            } finally {
                if (transport && transport.state === 'connected') {
                    transport.close();
                }
            }
        });
    }

    function updateItemUI(item, type, latency) {
        const container = item.querySelector('.ping-result-container');
        if (type === 'fail') {
            container.innerHTML = `<strong style="color:var(--ping-bad);">❌ نامعتبر</strong>`;
            item.dataset.finalscore = 9999;
            return;
        }

        let resultEl = item.querySelector(`.ping-result-item[data-type="${type}"]`);
        if (!resultEl) { // Should not happen with new structure but good for robustness
            resultEl = document.createElement('span');
            resultEl.className = 'ping-result-item';
            resultEl.dataset.type = type;
            container.appendChild(resultEl);
        }
        
        item.dataset[type] = latency !== null ? latency : '9999'; // Store for sorting
        
        resultEl.textContent = latency === null ? '❌' : `[${type.toUpperCase()}] ${latency}ms`;
        resultEl.style.color = latency === null ? 'var(--ping-bad)' : (latency < 700 ? 'var(--ping-good)' : 'var(--ping-medium)');

        // Hide other placeholders if a test completed successfully for a type
        container.querySelectorAll('.ping-result-item').forEach(el => {
            if (el.dataset.type !== type && el.textContent === '--') {
                el.style.display = 'none';
            }
        });

        // Determine best ping for final score, if all types tested, show the best one
        const currentPings = ['tcp', 'ws', 'wt'].map(t => parseInt(item.dataset[t] || '9999', 10));
        item.dataset.finalscore = Math.min(...currentPings);
    }

    // --- Event Handling & Actions ---
    function getSubscriptionUrl(core, type) {
        const isClash = type === 'clash';
        if (isClash) {
            // Public clash is disabled, return a message
            showToast('اشتراک عمومی Clash غیرفعال است.', true);
            return '';
        }
        // Assuming public standard subscription logic remains
        return `${WORKER_URL}/sub/public/${core}`;
    }

    async function createPersonalSubscription(core, type, method) {
        const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                                .map(cb => cb.closest('.config-item').dataset.config);
        if (selectedConfigs.length === 0) { showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true); return; }
        
        try {
            // Step 1: Request worker to store the selected configs and get a unique UUID for this list
            const res = await fetch(`${WORKER_URL}/api/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: selectedConfigs })
            });
            if (!res.ok) throw new Error('Server error when creating personal sub reference.');
            const data = await res.json(); // { subscription_url, clash_subscription_url, uuid }

            let finalUrl;
            if (type === 'clash') {
                finalUrl = data.clash_subscription_url;
                // Add .yaml extension if not present, and handle the content-disposition
                if (!finalUrl.endsWith('.yaml') && !finalUrl.endsWith('.yml')) {
                    finalUrl += '.yaml'; // Ensure the worker sends it with .yaml extension
                }
            } else {
                finalUrl = data.subscription_url;
            }

            if (method === 'qr') {
                showToast(`در حال تولید QR Code...`);
                // Give a small delay for toast to show before potentially blocking with QR generation
                setTimeout(() => showQRCode(finalUrl), 100); 
            } else if (method === 'download') {
                window.open(finalUrl, '_blank');
                showToast(`فایل Clash دانلود خواهد شد.`);
            } else { // Copy URL
                await navigator.clipboard.writeText(finalUrl);
                showToast(`لینک اشتراک شخصی ${type === 'clash' ? 'Clash ' : ''}کپی شد.`);
            }
        } catch (e) {
            console.error("Error creating personal subscription:", e);
            showToast('خطا در ساخت لینک اشتراک.', true);
        }
    }
    
    function showQRCode(text) {
        if (typeof QRCode === 'undefined') { // Check for global QRCode object
            showToast('کتابخانه QR در حال بارگذاری است. لحظاتی دیگر تلاش کنید.', true);
            return;
        }
        qrContainer.innerHTML = ''; // Clear previous QR
        new QRCode(qrContainer, { // Use new QRCode() directly
            text: text,
            width: 256,
            height: 256,
            correctLevel: QRCode.CorrectLevel.H
        });
        qrModal.style.display = 'flex';
    }
    function getProtocolConfigs(target) { return Array.from(target.closest('.protocol-group').querySelectorAll('.config-item')).map(item => item.dataset.config); }

    async function handleClicks(event) {
        const target = event.target.closest('[data-action]');
        if (!target) return;
        const { action, core, type, method, config, protocol } = target.dataset;

        switch (action) {
            case 'run-ping-test': runAdvancedPingTest(core, target); break;
            case 'copy-single': navigator.clipboard.writeText(config); showToast('کانفیگ کپی شد.'); break;
            case 'qr-single': showQRCode(config); break;
            case 'copy-sub': 
                const subUrlToCopy = getSubscriptionUrl(core, type);
                if (subUrlToCopy) {
                    await navigator.clipboard.writeText(subUrlToCopy); 
                    showToast('لینک اشتراک کپی شد.');
                }
                break;
            case 'qr-sub': 
                const subUrlToQR = getSubscriptionUrl(core, type);
                if (subUrlToQR) showQRCode(subUrlToQR);
                break;
            case 'create-personal-sub': createPersonalSubscription(core, type, method); break;
            case 'copy-protocol': 
                const pCfgs = getProtocolConfigs(target); 
                if (pCfgs.length > 0) { 
                    await navigator.clipboard.writeText(pCfgs.join('\n')); 
                    showToast(`تمام ${pCfgs.length} کانفیگ ${protocol} کپی شد.`); 
                }
                break;
            case 'toggle-protocol': target.closest('.protocol-group').classList.toggle('open'); break;
            case 'toggle-actions': target.closest('.action-group-collapsible').classList.toggle('open'); break;
        }
    }
    document.querySelectorAll('.main-wrapper').forEach(w => w.addEventListener('click', handleClicks));
    qrModal.onclick = () => qrModal.style.display = 'none';
});
