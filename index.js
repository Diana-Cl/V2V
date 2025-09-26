// index.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const STATIC_CONFIG_URL = './all_live_configs.json';
    const STATIC_CACHE_VERSION_URL = './cache_version.txt';
    const CONFIGS_PER_BATCH = 50; // اندازه دسته برای تست واقعی
    const WORKER_URL = 'https://v2v-proxy.mbrgh87.workers.dev';
    
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

    const setButtonsDisabled = (coreName, disabled) => {
        const wrapper = getEl(coreName === 'xray' ? 'xray-content-wrapper' : 'singbox-content-wrapper');
        wrapper.querySelectorAll('button:not(.copy-btn)').forEach(btn => btn.disabled = disabled);
        wrapper.querySelectorAll('.config-checkbox').forEach(chk => chk.disabled = disabled);
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
            showToast('خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.', true);
            xrayWrapper.innerHTML = singboxWrapper.innerHTML = `<div class="alert">خطا در دریافت کانفیگ‌ها. لطفاً دوباره تلاش کنید.</div>`;
        }
    };

    const renderCore = (coreName, coreData, wrapper) => {
        if (!coreData || Object.keys(coreData).length === 0) {
            wrapper.innerHTML = `<div class="alert">کانفیگی یافت نشد.</div>`;
            return;
        }

        // تغییر نام دکمه تست پینگ
        const runPingButton = `<button class="test-button" onclick="window.runPingTest('${coreName}')" id="ping-${coreName}-btn">تست و به‌روزرسانی زنده (شبکه کاربر)</button>`;
        const actionGroupTitle = (title) => `<div class="action-group-title">${title}</div>`;

        let contentHtml = runPingButton + `
            ${actionGroupTitle('دریافت کانفیگ')}
            <div class="action-box">
                <span class="action-box-label">لینک تک‌کانفیگ</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.copyConfigs('${coreName}', 'selected')">کپی انتخابی</button>
                    <button class="action-btn-small" onclick="window.copyConfigs('${coreName}', 'all')">کپی همه</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">فایل YAML کلش</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateClashFile('${coreName}', 'selected', 'download')">دانلود انتخابی</button>
                    <button class="action-btn-small" onclick="window.generateClashFile('${coreName}', 'all', 'download')">دانلود همه</button>
                </div>
            </div>
            <div class="action-box">
                <span class="action-box-label">لینک اشتراک پویا</span>
                <div class="action-box-buttons">
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'clash', 'copy')">کلش انتخابی</button>
                    <button class="action-btn-small" onclick="window.generateSubscriptionUrl('${coreName}', 'selected', 'singbox', 'copy')">سینگ‌باکس انتخابی</button>
                </div>
            </div>
        `;

        for (const protocol in coreData) {
            const configs = coreData[protocol];
            const protocolName = protocol.charAt(0).toUpperCase() + protocol.slice(1);
            contentHtml += `
                <div class="protocol-group" data-protocol="${protocol}">
                    <div class="protocol-header">
                        ${protocolName} (${configs.length})
                        <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                    </div>
                    <ul class="config-list">
                        ${configs.map(cfg => `
                            <li class="config-item" data-url="${cfg[0]}" data-ping="${cfg[1] || '0'}">
                                <input type="checkbox" class="config-checkbox">
                                <div class="config-details">
                                    <span class="server">${cfg[0]}</span>
                                </div>
                                <div class="ping-result-container">
                                    <span class="ping-result" style="color: ${cfg[1] < 500 ? 'var(--ping-good)' : 'grey'};">${cfg[1] || '---'}ms</span>
                                </div>
                                <button class="copy-btn" onclick="window.copyToClipboard('${cfg[0]}', 'کانفیگ کپی شد!')">کپی</button>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }

        wrapper.innerHTML = contentHtml;
        wrapper.querySelectorAll('.protocol-header').forEach(header => {
            header.addEventListener('click', () => {
                header.parentElement.classList.toggle('open');
            });
        });
    };
    
    // تابع کمکی برای به‌روزرسانی UI پینگ
    const updatePingUI = (configElement, ping, status) => {
        const pingResultEl = configElement.querySelector('.ping-result');
        if (status === 'Live') {
            pingResultEl.textContent = `${ping}ms`;
            if (ping < 200) pingResultEl.style.color = 'var(--ping-good)';
            else if (ping < 500) pingResultEl.style.color = 'var(--ping-medium)';
            else pingResultEl.style.color = 'var(--ping-bad)';
            configElement.dataset.ping = ping;
        } else {
            pingResultEl.textContent = 'خطا';
            pingResultEl.style.color = 'var(--ping-bad)';
            configElement.dataset.ping = '99999';
        }
    };

    // --- تابع تست پینگ دسته‌بندی شده (Batching) ---
    window.runPingTest = async (coreName) => {
        const wrapper = getEl(coreName === 'xray' ? 'xray-content-wrapper' : 'singbox-content-wrapper');
        const pingButton = getEl(`ping-${coreName}-btn`);
        
        // ۱. مدیریت پایداری UI
        setButtonsDisabled(coreName, true);
        pingButton.classList.add('testing-active');
        const allConfigElements = Array.from(wrapper.querySelectorAll('.config-item'));
        const totalConfigs = allConfigElements.length;
        
        showToast(`شروع تست ${totalConfigs} کانفیگ. لطفاً منتظر بمانید...`, false);
        let configsTested = 0;

        // ۲. تقسیم‌بندی به دسته‌های ۵۰ تایی
        const batches = [];
        for (let i = 0; i < totalConfigs; i += CONFIGS_PER_BATCH) {
            const batchUrls = allConfigElements.slice(i, i + CONFIGS_PER_BATCH).map(el => el.dataset.url);
            batches.push({ urls: batchUrls, elements: allConfigElements.slice(i, i + CONFIGS_PER_BATCH) });
        }
        
        // ۳. اجرای متوالی دسته‌ها و به‌روزرسانی زنده
        for (const batch of batches) {
            try {
                pingButton.innerHTML = `<span class="loader-small"></span> درحال تست... (${configsTested}/${totalConfigs})`;
                
                const response = await fetch(`${WORKER_URL}/test-batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs: batch.urls }),
                });

                const data = await response.json();
                
                if (response.ok && data.results) {
                    data.results.forEach((result, index) => {
                        const configElement = batch.elements[index];
                        if (configElement) {
                            updatePingUI(configElement, result.latency, result.status);
                        }
                        configsTested++;
                    });
                } else {
                    // در صورت خطای Worker، دسته‌بندی را با خطا علامت بزن
                    batch.elements.forEach(el => {
                        updatePingUI(el, 99999, 'Dead');
                        configsTested++;
                    });
                }
            } catch (err) {
                // خطای شبکه یا Timeout فرانت‌اند
                batch.elements.forEach(el => {
                    updatePingUI(el, 99999, 'Dead');
                    configsTested++;
                });
                console.error(`Error processing batch: ${err}`);
            }
        }
        
        // ۴. مرتب‌سازی نهایی
        allConfigElements.sort((a, b) => {
            const pingA = parseInt(a.dataset.ping) || 99999;
            const pingB = parseInt(b.dataset.ping) || 99999;
            return pingA - pingB;
        });

        // بازسازی لیست‌ها
        wrapper.querySelectorAll('.config-list').forEach(ul => ul.innerHTML = '');
        const grouped = {};
        allConfigElements.forEach(el => {
            const protocolMatch = el.dataset.url.match(/^([^:]+):\/\//);
            let protocol = protocolMatch ? protocolMatch[1].toLowerCase() : 'unknown';
            // استانداردسازی پروتکل
            if (protocol === 'hysteria2') protocol = 'hy2';
            else if (protocol === 'shadowsocks') protocol = 'ss';
            
            if (!grouped[protocol]) grouped[protocol] = [];
            grouped[protocol].push(el);
        });

        for (const protocol in grouped) {
             const ul = wrapper.querySelector(`.protocol-group[data-protocol="${protocol}"] .config-list`);
            if (ul) grouped[protocol].forEach(el => ul.appendChild(el));
        }

        // ۵. بازگرداندن UI
        setButtonsDisabled(coreName, false);
        pingButton.innerHTML = 'تست و به‌روزرسانی زنده (شبکه کاربر)';
        pingButton.classList.remove('testing-active');
        showToast('تست و مرتب‌سازی به پایان رسید.');
    };
    
    // ... (توابع generateSubscriptionUrl و generateClashFile برای استفاده از خروجی‌های Worker و UUID پویا) ...
    // این توابع قبلا اصلاحات خوبی داشتند، فقط باید از آدرس‌های صحیح Worker استفاده کنند.

    window.copyConfigs = (coreName, type) => {
        const configs = (type === 'all')
            ? Array.from(document.querySelectorAll(`#${coreName}-section .config-item`)).map(el => el.dataset.url)
            : Array.from(document.querySelectorAll(`#${coreName}-section .config-item input.config-checkbox:checked`)).map(el => el.closest('.config-item').dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }
        copyToClipboard(configs.join('\n'));
    };

    window.generateSubscriptionUrl = async (coreName, type, client, method) => {
        const configs = (type === 'all')
            ? Array.from(document.querySelectorAll(`#${coreName}-section .config-item`)).map(el => el.dataset.url)
            : Array.from(document.querySelectorAll(`#${coreName}-section .config-item input.config-checkbox:checked`)).map(el => el.closest('.config-item').dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }
        
        // افزودن UUID در صورتی که قبلاً ذخیره شده است
        const configsToProcess = type === 'selected' ? configs : allLiveConfigsData[coreName].flatMap(Object.values).flat().map(c => c[0]);

        try {
            const response = await fetch(`${WORKER_URL}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: configsToProcess, uuid: userUuid }),
            });
            
            if (!response.ok) throw new Error('خطا در ایجاد لینک اشتراک.');
            
            const result = await response.json();
            userUuid = result.uuid;
            localStorage.setItem('v2v_user_uuid', userUuid);

            let url = '';
            // فیلترینگ URL بر اساس کلاینت
            if (client === 'clash') url = result.clashSubscriptionUrl;
            else if (client === 'singbox') url = result.singboxSubscriptionUrl;
            else url = result.subscriptionUrl; // raw

            if (method === 'copy') copyToClipboard(url);
            else if (method === 'qr') openQrModal(url);
        } catch (err) {
            showToast(err.message, true);
        }
    };
    
    // تابع دانلود فایل کلش - استفاده از خروجی URL UUID
    window.generateClashFile = async (coreName, type) => {
        // برای دانلود همه، از لیست کامل JSON اصلی استفاده می‌کنیم.
        const allConfigs = coreName === 'xray' ? allLiveConfigsData.xray : allLiveConfigsData.singbox;
        const flatAllConfigs = Object.values(allConfigs).flat().map(c => c[0]);
        
        const configs = (type === 'all')
            ? flatAllConfigs
            : Array.from(document.querySelectorAll(`#${coreName}-section .config-item input.config-checkbox:checked`)).map(el => el.closest('.config-item').dataset.url);

        if (configs.length === 0) {
            showToast('لطفاً حداقل یک کانفیگ را انتخاب کنید.', true);
            return;
        }

        try {
            const response = await fetch(`${WORKER_URL}/create-personal-sub`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs }),
            });
            if (!response.ok) throw new Error('خطا در ایجاد فایل.');
            
            const result = await response.json();
            const downloadUrl = result.clashSubscriptionUrl;
            
            // هدایت به آدرس دانلود YAML
            window.location.href = downloadUrl;
            showToast('دانلود فایل آغاز شد. (اگر آغاز نشد، آدرس لینک اشتراک کلش را کپی کنید).');
        } catch (err) {
            showToast(err.message, true);
        }
    };


    fetchAndRender();
    qrModal.addEventListener('click', () => (qrModal.style.display = 'none'));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (qrModal.style.display = 'none'));
});
