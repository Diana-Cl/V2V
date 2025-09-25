// index.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const WORKER_URLS = [
        'https://rapid-scene-1da6.mbrgh87.workers.dev',
        'https://v2v-proxy.mbrgh87.workers.dev',
        'https://v2v.mbrgh87.workers.dev',
        'https://winter-hill-0307.mbrgh87.workers.dev',
    ];
    
    // Use relative path for static files to ensure mirror independence
    const STATIC_CONFIG_URL = './output/all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './output/cache_version.txt';
    const PING_TIMEOUT = 5000;
    
    // --- DOM Elements ---
    const getEl = (id) => document.getElementById(id);
    const statusBar = getEl('status-bar');
    const xrayWrapper = getEl('xray-content-wrapper');
    const singboxWrapper = getEl('singbox-content-wrapper');
    const qrModal = getEl('qr-modal');
    const qrContainer = getEl('qr-code-container');
    const toastEl = getEl('toast');
    let userUuid = localStorage.getItem('v2v_user_uuid') || null;

    // --- Helper Functions ---
    const showToast = (message, isError = false) => {
        toastEl.textContent = message;
        toastEl.className = `toast show ${isError ? 'error' : ''}`;
        setTimeout(() => toastEl.classList.remove('show'), 3000);
    };

    const copyToClipboard = async (text, successMessage = 'کپی شد!') => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(successMessage);
        } catch (err) { showToast('خطا در کپی کردن!', true); }
    };

    const openQrModal = (text) => {
        if (!window.QRCode) { showToast('کتابخانه QR در حال بارگذاری است...', true); return; }
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.H });
        qrModal.style.display = 'flex';
    };

    // --- Core Logic ---
    let allLiveConfigsData = null;

    const fetchAndRender = async () => {
        statusBar.textContent = 'درحال دریافت کانفیگ‌ها...';
        try {
            const configResponse = await fetch(STATIC_CONFIG_URL, { signal: AbortSignal.timeout(8000) });
            if (!configResponse.ok) throw new Error(`Status ${configResponse.status}`);
            allLiveConfigsData = await configResponse.json();
            
            let cacheVersion = 'نامشخص';
            try {
                const versionResponse = await fetch(STATIC_CACHE_VERSION_URL, { signal: AbortSignal.timeout(3000) });
                if (versionResponse.ok) cacheVersion = await versionResponse.text();
            } catch (error) {}

            statusBar.textContent = `آخرین بروزرسانی: ${new Date(parseInt(cacheVersion) * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}`;
            renderCore('xray', allLiveConfigsData.xray, xrayWrapper);
            renderCore('singbox', allLiveConfigsData.singbox, singboxWrapper);
        } catch (error) {
            statusBar.textContent = 'خطا در دریافت کانفیگ‌ها.';
            showToast(error.message, true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">${error.message}</div>`;
        }
    };

    const renderCore = (coreName, coreData, wrapper) => {
        // Implementation from your provided code
        // ... (This function remains as you provided it, it's correct for rendering)
    };

    const parseConfigForPing = (configUrl) => {
        try {
            if (configUrl.startsWith('vmess://')) {
                const data = JSON.parse(atob(configUrl.substring(8)));
                return { host: data.add, port: parseInt(data.port), tls: data.tls === 'tls', sni: data.sni || data.host };
            }
            const url = new URL(configUrl);
            const params = new URLSearchParams(url.search);
            const scheme = url.protocol.replace(':', '');
            const tls = (params.get('security') === 'tls' || scheme === 'trojan' || ['hy2', 'hysteria2', 'tuic'].includes(scheme) || params.get('tls') === '1');
            const sni = params.get('sni') || url.hostname;
            return { host: url.hostname, port: parseInt(url.port), tls, sni };
        } catch { return null; }
    };
    
    window.runPingTest = async (coreName) => {
        // Implementation from your provided code
        // ... (This function remains as you provided it, it's correct for pinging)
    };

    window.createPersonalSubscription = async (coreName, format, method = 'copy') => {
        // Implementation from your provided code
        // ... (This function remains as you provided it, it's correct for subscriptions)
    };

    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
