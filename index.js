document.addEventListener('DOMContentLoaded', () => {
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 10000;
    
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    let workerIndex = 0;
    let workerAvailable = true;
    
    const getNextWorkerUrl = () => {
        const url = WORKER_URLS[workerIndex];
        workerIndex = (workerIndex + 1) % WORKER_URLS.length;
        return url;
    };
    
    const PING_BATCH_SIZE = 15;
    
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');

    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    window.copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) { 
            showToast('خطا در کپی کردن!', true); 
        }
    };

    window.openQrModal = (text) => {
        if (!window.QRCode) { 
            showToast('کتابخانه QR در حال بارگذاری است...', true); 
            return; 
        }
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { 
            text, 
            width: 256, 
            height: 256, 
            correctLevel: QRCode.CorrectLevel.H 
        });
        qrModal.style.display = 'flex';
    };

    qrModal.addEventListener('click', (e) => {
        if (e.target === qrModal) {
            qrModal.style.display = 'none';
        }
    });

    let allLiveConfigsData = null;

    const removeDuplicates = (configs) => {
        const seen = new Set();
        return configs.filter(config => {
            const normalized = config.toLowerCase().trim();
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
    };

    const shortenName = (name, protocol, server) => {
        if (!name || name.length > 30) {
            return `v2v-${protocol}-${server.substring(0, 15)}`;
        }
        return name;
    };

    const parseVmessConfig = (config) => {
        try {
            const vmessData = config.replace('vmess://', '');
            const decoded = JSON.parse(atob(vmessData));
            return {
                server: decoded.add, port: parseInt(decoded.port), uuid: decoded.id,
                alterId: parseInt(decoded.aid) || 0, cipher: decoded.scy || 'auto',
                network: decoded.net || 'tcp', tls: decoded.tls === 'tls',
                sni: decoded.sni || decoded.host || decoded.add, path: decoded.path || '/',
                host: decoded.host || decoded.add, name: decoded.ps || `v2v-vmess-${decoded.add.substring(0,10)}`
            };
        } catch { return null; }
    };

    const parseVlessConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const params = new URLSearchParams(urlObj.search);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), uuid: urlObj.username,
                network: params.get('type') || 'tcp', tls: params.get('security') === 'tls',
                sni: params.get('sni') || urlObj.hostname, path: params.get('path') || '/',
                host: params.get('host') || urlObj.hostname, flow: params.get('flow') || '',
                name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-vless-${urlObj.hostname.substring(0,10)}`
            };
        } catch { return null; }
    };

    const parseTrojanConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const params = new URLSearchParams(urlObj.search);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), password: urlObj.username,
                sni: params.get('sni') || urlObj.hostname,
                name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-trojan-${urlObj.hostname.substring(0,10)}`
            };
        } catch { return null; }
    };

    const parseSsConfig = (config) => {
        try {
            const urlObj = new URL(config);
            const decoded = atob(urlObj.username);
            if (!decoded.includes(':')) return null;
            const [method, password] = decoded.split(':', 2);
            return {
                server: urlObj.hostname, port: parseInt(urlObj.port), method, password,
                name: decodeURIComponent(urlObj.hash.substring(1)) || `v2v-ss-${urlObj.hostname.substring(0,10)}`
            };
        } catch { return null; }
    };

    const generateClashYAML = (configs, coreName) => {
        const proxies = [];
        
        for (const config of configs) {
            let proxy = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                proxy = { name: p.name, type: 'vmess', server: p.server, port: p.port, uuid: p.uuid, alterId: p.alterId, cipher: p.cipher, udp: true, 'skip-cert-verify': true };
                if (p.network === 'ws') { proxy.network = 'ws'; proxy['ws-opts'] = { path: p.path, headers: { Host: p.host } }; }
                if (p.tls) { proxy.tls = true; proxy.servername = p.sni; }
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;
                proxy = { name: p.name, type: 'vless', server: p.server, port: p.port, uuid: p.uuid, udp: true, 'skip-cert-verify': true };
                if (p.network === 'ws') { proxy.network = 'ws'; proxy['ws-opts'] = { path: p.path, headers: { Host: p.host } }; }
                if (p.tls) { proxy.tls = true; proxy.servername = p.sni; }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;
                proxy = { name: p.name, type: 'trojan', server: p.server, port: p.port, password: p.password, udp: true, sni: p.sni, 'skip-cert-verify': true };
            } else if (config.startsWith('ss://')) {
                const p = parseSsConfig(config);
                if (!p) continue;
                proxy = { name: p.name, type: 'ss', server: p.server, port: p.port, cipher: p.method, password: p.password, udp: true };
            }
            
            if (proxy) proxies.push(proxy);
        }
        
        if (proxies.length === 0) return null;
        
        const names = proxies.map(p => p.name);
        const yaml = {
            proxies,
            'proxy-groups': [
                { name: `V2V-${coreName}-Auto`, type: 'url-test', proxies: names, url: 'http://www.gstatic.com/generate_204', interval: 300 },
                { name: `V2V-${coreName}-Select`, type: 'select', proxies: [`V2V-${coreName}-Auto`, ...names] }
            ],
            rules: ['DOMAIN-SUFFIX,local,DIRECT', 'IP-CIDR,127.0.0.0/8,DIRECT', 'IP-CIDR,10.0.0.0/8,DIRECT', 'IP-CIDR,172.16.0.0/12,DIRECT', 'IP-CIDR,192.168.0.0/16,DIRECT', 'GEOIP,IR,DIRECT', `MATCH,V2V-${coreName}-Select`]
        };
        
        return jsyaml.dump(yaml, { flowLevel: -1, sortKeys: false });
    };

    const generateSingboxJSON = (configs, coreName) => {
        const outbounds = [];
        
        for (const config of configs) {
            let outbound = null;
            
            if (config.startsWith('vmess://')) {
                const p = parseVmessConfig(config);
                if (!p) continue;
                outbound = { tag: p.name, type: 'vmess', server: p.server, server_port: p.port, uuid: p.uuid, alter_id: p.alterId, security: p.cipher };
                if (p.network === 'ws') outbound.transport = { type: 'ws', path: p.path, headers: { Host: p.host } };
                if (p.tls) outbound.tls = { enabled: true, server_name: p.sni, insecure: true };
            } else if (config.startsWith('vless://')) {
                const p = parseVlessConfig(config);
                if (!p) continue;
                outbound = { tag: p.name, type: 'vless', server: p.server, server_port: p.port, uuid: p.uuid };
                if (p.network === 'ws') outbound.transport = { type: 'ws', path: p.path, headers: { Host: p.host } };
                if (p.tls) { outbound.tls = { enabled: true, server_name: p.sni, insecure: true }; if (p.flow) outbound.flow = p.flow; }
            } else if (config.startsWith('trojan://')) {
                const p = parseTrojanConfig(config);
                if (!p) continue;
                outbound = { tag: p.name, type: 'trojan', server: p.server, server_port: p.port, password: p.password, tls: { enabled: true, server_name: p.sni, insecure: true } };
            } else if (config.startsWith('ss://')) {
                const p = parseSsConfig(config);
                if (!p) continue;
                outbound = { tag: p.name, type: 'shadowsocks', server: p.server, server_port: p.port, method: p.method, password: p.password };
            }
            
            if (outbound) outbounds.push(outbound);
        }
        
        if (outbounds.length === 0) return null;
        
        return JSON.stringify({
            log: { disabled: false, level: "info" },
            dns: { servers: [{ address: "8.8.8.8", strategy: "prefer_ipv4" }] },
            inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: 7890 }],
            outbounds: [
                { tag: `V2V-${coreName}-Select`, type: "urltest", outbounds: outbounds.map(o => o.tag), url: "http://www.gstatic.com/generate_204", interval: "5m" },
                ...outbounds,
                { tag: "direct", type: "direct" }
            ],
            route: { rules: [{ geoip: "ir", outbound: "direct" }, { geoip: "private", outbound: "direct" }], auto_detect_interface: true }
        }, null, 2);
    };

    const downloadFile = (content, filename, mimeType) => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        showToast('فایل دانلود شد!');
    };

    window.generateSubscription = async (coreName, scope, format, action) => {
        let configs = [];
        
        if (scope === 'selected') {
            const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
            if (checkboxes.length === 0) {
                showToast('هیچ کانفیگی انتخاب نشده!', true);
                return;
            }
            configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        } else {
            const coreData = allLiveConfigsData[coreName];
            for (const protocol in coreData) {
                configs.push(...coreData[protocol]);
            }
        }
        
        if (configs.length === 0) {
            showToast('کانفیگی یافت نشد!', true);
            return;
        }
        
        showToast('در حال ساخت...', false);
        
        if (workerAvailable) {
            try {
                const uuid = crypto.randomUUID();
                const workerUrl = getNextWorkerUrl();
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                const response = await fetch(`${workerUrl}/create-sub`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uuid, configs, core: coreName, format }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const subUrl = `${workerUrl}/sub/${format}/${uuid}`;
                    
                    if (action === 'copy') {
                        await window.copyToClipboard(subUrl, 'لینک V2V کپی شد (معتبر 120 روز)!');
                    } else if (action === 'qr') {
                        window.openQrModal(subUrl);
                    }
                    return;
                }
                
                workerAvailable = false;
                showToast('Worker در دسترس نیست، حالت Fallback فعال شد', true);
            } catch (error) {
                workerAvailable = false;
                showToast('Worker در دسترس نیست، حالت Fallback فعال شد', true);
            }
        }
        
        const uuid = crypto.randomUUID();
        let content, filename, mimeType;
        
        if (format === 'clash') {
            content = generateClashYAML(configs, coreName);
            if (!content) {
                showToast('خطا در ساخت فایل Clash!', true);
                return;
            }
            filename = `v2v-${coreName}-clash-${uuid}.yaml`;
            mimeType = 'application/x-yaml';
        } else {
            content = generateSingboxJSON(configs, coreName);
            if (!content) {
                showToast('خطا در ساخت فایل Singbox!', true);
                return;
            }
            filename = `v2v-${coreName}-singbox-${uuid}.json`;
            mimeType = 'application/json';
        }
        
        if (action === 'copy') {
            await window.copyToClipboard(content, 'محتوا کپی شد (Fallback Mode)!');
        } else if (action === 'qr') {
            window.openQrModal(content);
        } else if (action === 'download') {
            downloadFile(content, filename, mimeType);
        }
    };

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { signal: AbortSignal.timeout(10000) });
            if (!configResponse.ok) throw new Error(`HTTP ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            for (const core in allLiveConfigsData) {
                for (const protocol in allLiveConfigsData[core]) {
                    allLiveConfigsData[core][protocol] = removeDuplicates(allLiveConfigsData[core][protocol]);
                }
            }
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { signal: AbortSignal.timeout(5000) });
                if (versionResponse.ok) {
                    cacheVersion = await versionResponse.text();
                }
            } catch (error) {}

            const updateTime = new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
            statusBar.textContent = `آخرین بروزرسانی: ${updateTime}`;
            
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            console.error('Fetch error:', error);
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast('خطا در دریافت کانفیگ‌ها!', true);
        }
    };
    
    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ</button>`;
        const copySelectedButton = `<button class="action-btn-wide" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;
        
        let contentHtml = runPingButton + copySelectedButton + `
            ${actionGroupTitle(`لینک اشتراک Clash [${coreName}]`)}
            <div class="action-box">
                <span class="action-box-label">Clash Subscription</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'selected', 'clash', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'selected', 'clash', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'all', 'clash', 'copy')">همه (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'all', 'clash', 'qr')">همه (QR)</button>
                </div>
            </div>
            ${actionGroupTitle(`لینک اشتراک Singbox [${coreName}]`)}
            <div class="action-box">
                <span class="action-box-label">Singbox Subscription</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'selected', 'singbox', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'selected', 'singbox', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'all', 'singbox', 'copy')">همه (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscription('${coreName}', 'all', 'singbox', 'qr')">همه (QR)</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            if (configs.length === 0) continue;
            
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1)
                .replace('ss', 'Shadowsocks')
                .replace('hy2', 'Hysteria2')
                .replace('tuic', 'TUIC');
            
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>
                    <ul class="config-list">`;
            
            configs.forEach((config, idx) => {
                try {
                    const urlObj = new URL(config);
                    const server = urlObj.hostname;
                    const port = urlObj.port;
                    const rawName = decodeURIComponent(urlObj.hash.substring(1) || `${protocol}-${server}`);
                    const name = shortenName(rawName, protocol, server);
                    
                    contentHtml += `
                        <li class="config-item">
                            <input type="checkbox" class="config-checkbox" data-core="${coreName}" data-protocol="${protocol}" data-config="${encodeURIComponent(config)}" id="${coreName}-${protocol}-${idx}">
                            <div class="config-details">
                                <label for="${coreName}-${protocol}-${idx}">${name}</label>
                                <span class="server">${server}:${port}</span>
                            </div>
                            <div class="ping-result-container" id="ping-${coreName}-${protocol}-${idx}"></div>
                            <div class="config-item-buttons">
                                <button class="action-btn-small" onclick="window.copyToClipboard(decodeURIComponent('${encodeURIComponent(config)}'))">کپی</button>
                                <button class="action-btn-small" onclick="window.openQrModal(decodeURIComponent('${encodeURIComponent(config)}'))">QR</button>
                            </div>
                        </li>
                    `;
                } catch (e) {}
            });
            
            contentHtml += `</ul></div>`;
        }

        wrapper.innerHTML = contentHtml;

        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.protocol-group').classList.toggle('open');
            });
        });
    };

    window.copySelectedConfigs = (coreName) => {
        const checkboxes = document.querySelectorAll(`input.config-checkbox[data-core="${coreName}"]:checked`);
        if (checkboxes.length === 0) {
            showToast('هیچ کانفیگی انتخاب نشده!', true);
            return;
        }
        const configs = Array.from(checkboxes).map(cb => decodeURIComponent(cb.dataset.config));
        window.copyToClipboard(configs.join('\n'), `${configs.length} کانفیگ کپی شد!`);
    };

    window.runPingTest = async (coreName) => {
        const btn = getEl(`ping-${coreName}-btn`);
        if (!btn) return;
        
        if (!workerAvailable) {
            showToast('تست پینگ نیازمند Worker است که در دسترس نیست', true);
            return;
        }
        
        btn.disabled = true;
        btn.innerHTML = '<span class="loader-small"></span> تست...';

        const coreData = allLiveConfigsData[coreName];
        const allConfigs = [];
        
        for (const protocol in coreData) {
            coreData[protocol].forEach((config, idx) => {
                allConfigs.push({ config, protocol, idx });
            });
        }

        let completed = 0;
        const total = allConfigs.length;

        for (let i = 0; i < allConfigs.length; i += PING_BATCH_SIZE) {
            const batch = allConfigs.slice(i, i + PING_BATCH_SIZE);
            
            await Promise.all(batch.map(async ({ config, protocol, idx }, batchIdx) => {
                const resultEl = getEl(`ping-${coreName}-${protocol}-${idx}`);
                if (!resultEl) return;

                resultEl.innerHTML = '<span class="loader-small"></span>';

                try {
                    const urlObj = new URL(config);
                    const host = urlObj.hostname;
                    const port = urlObj.port;
                    
                    let tls = false;
                    let sni = host;

                    if (protocol === 'vmess') {
                        const parsed = parseVmessConfig(config);
                        if (parsed) {
                            tls = parsed.tls;
                            sni = parsed.sni;
                        }
                    } else if (protocol === 'vless') {
                        const parsed = parseVlessConfig(config);
                        if (parsed) {
                            tls = parsed.tls;
                            sni = parsed.sni;
                        }
                    } else if (['trojan', 'hy2', 'tuic'].includes(protocol)) {
                        tls = true;
                        const params = new URLSearchParams(urlObj.search);
                        sni = params.get('sni') || host;
                    }

                    const workerUrl = WORKER_URLS[batchIdx % WORKER_URLS.length];
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT);

                    const response = await fetch(`${workerUrl}/ping`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ host, port, tls, sni }),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const result = await response.json();
                        if (result.latency && result.latency > 0) {
                            const color = result.latency < 200 ? '#4CAF50' : result.latency < 500 ? '#FFC107' : '#F44336';
                            resultEl.innerHTML = `<span style="color: ${color};">${result.latency}ms</span>`;
                        } else {
                            resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                        }
                    } else {
                        resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                    }
                } catch (error) {
                    resultEl.innerHTML = '<span style="color: #F44336;">✗</span>';
                }

                completed++;
                btn.textContent = `تست (${completed}/${total})`;
            }));
        }

        btn.disabled = false;
        btn.textContent = `تست پینگ`;
        showToast('تست تکمیل شد!');
    };

    fetchAndRender();
});