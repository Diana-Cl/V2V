document.addEventListener('DOMContentLoaded', () => {
    // Configuration
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const PING_TIMEOUT = 8000; 
    
    // 4 Active Worker Endpoints
    const WORKER_URLS = [
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    let workerIndex = 0;
    const getNextWorkerUrl = () => {
        const url = WORKER_URLS[workerIndex];
        workerIndex = (workerIndex + 1) % WORKER_URLS.length;
        return url;
    };
    
    const PING_BATCH_SIZE = 50;
    
    // DOM Elements
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');
    let userUuid = localStorage.getItem('v2v_user_uuid') || null;

    // Helper Functions
    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    window.copyToClipboardAndShowQr = async (text, successMessage = 'کپی شد!', openQr = false) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
            if (openQr) {
                window.openQrModal(text);
            }
        } catch (err) { 
            showToast('خطا در کپی کردن!', true); 
        }
    };

    window.copyToClipboard = window.copyToClipboardAndShowQr;

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

    // Core Logic
    let allLiveConfigsData = null;

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { 
                signal: AbortSignal.timeout(10000) 
            });
            if (!configResponse.ok) throw new Error(`HTTP ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { 
                    signal: AbortSignal.timeout(5000) 
                });
                if (versionResponse.ok) {
                    cacheVersion = await versionResponse.text();
                }
            } catch (error) {
                console.warn('Cache version fetch failed:', error);
            }

            const updateTime = new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { 
                dateStyle: 'short', 
                timeStyle: 'short' 
            });
            statusBar.textContent = `آخرین بروزرسانی: ${updateTime}`;
            
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            console.error('Fetch error:', error);
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast('خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.', true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.</div>`;
        }
    };
    
    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست پینگ ${coreName.toUpperCase()}</button>`;
        const copySelectedButton = `<button class="action-btn-wide copy-selected-btn" onclick="window.copySelectedConfigs('${coreName}')">کپی موارد انتخابی</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;
        
        let contentHtml = runPingButton + `
            ${copySelectedButton} 
            
            ${actionGroupTitle(`لینک اشتراک YAML (Clash) [${coreName}]`)}
            <div class="action-box">
                <span class="action-box-label">اشتراک YAML (کلش)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'download')">انتخابی (دانلود)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'qr')">همه (QR)</button> 
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'clash', 'download')">همه (دانلود)</button>
                </div>
            </div>

            ${actionGroupTitle(`لینک اشتراک JSON (Sing-box) [${coreName}]`)}
            <div class="action-box">
                <span class="action-box-label">اشتراک JSON (سینگ‌باکس)</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'copy')">انتخابی (کپی)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'qr')">انتخابی (QR)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'download')">انتخابی (دانلود)</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'qr')">همه (QR)</button> 
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'all', 'singbox', 'download')">همه (دانلود)</button>
                </div>
            </div>
        `;

        // رندر پروتکل‌ها - همه به صورت باز
        for (const protocol in coreData) {
            const configs = coreData[protocol];
            if (configs.length === 0) continue; 
            
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1)
                .replace('ss', 'Shadowsocks')
                .replace('hy2', 'Hysteria2')
                .replace('tuic', 'TUIC');
            
            contentHtml += `
                <div class="protocol-group open" data-protocol="${protocol}">
                    <div class="protocol-header">
                        <span>${protocolName} (${configs.length})</span>
                        <div class="action-box-buttons">
                             <button class="action-btn-small copy-all-btn" onclick="window.copyProtocolConfigs('${coreName}', '${protocol}')">کپی همه</button>
                             <button class="action-btn-small qr-all-btn" onclick="window.showProtocolConfigsQr('${coreName}', '${protocol}')">QR همه</button>
                             <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none"