document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_BASE_URL = ''; // Vercel API is on the same domain
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';
    const PING_URL = '/'; // CORRECTED: Root of the API returns a quick response
    const AUTO_SELECT_COUNT = 30;

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');
    const qrModal = document.getElementById('qr-code-modal');
    const qrContainer = document.getElementById('qr-code-container');
    const qrDownloadBtn = document.getElementById('qr-download-btn');
    
    // --- GLOBAL STATE ---
    let allConfigs = { xray: [], singbox: [] };

    // --- HELPER FUNCTIONS ---
    const toShamsi = (timestamp) => {
        const date = new Date(parseInt(timestamp, 10) * 1000);
        const jalaaliDate = jalaali.toJalaali(date);
        const format = (n) => n < 10 ? '0' + n : n;
        return `${jalaaliDate.jy}/${format(jalaaliDate.jm)}/${format(jalaaliDate.jd)} ساعت ${format(date.getHours())}:${format(date.getMinutes())}`;
    };
    const copyToClipboard = (text, msg = 'کپی شد!') => {
        navigator.clipboard.writeText(text).then(() => alert(msg)).catch(() => alert('خطا: امکان کپی وجود ندارد.'));
    };
    window.closeModal = () => qrModal.style.display = 'none';
    window.showQrCode = (event, text) => {
        event.stopPropagation();
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, { text, width: 256, height: 256 });
        qrDownloadBtn.onclick = () => {
            const img = qrContainer.querySelector('img');
            const link = document.createElement('a');
            link.download = 'V2V-QRCode.png';
            link.href = img.src;
            link.click();
        };
        qrModal.style.display = 'flex';
    };
    window.toggleGroup = (groupId) => document.getElementById(groupId)?.parentNode.classList.toggle('open');
    const getUserPing = async (timeout = 4000) => {
        const startTime = performance.now();
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), timeout);
            await fetch(`${PING_URL}?t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
            return Math.round(performance.now() - startTime);
        } catch (error) {
            return null; // Return null on failure
        }
    };
    
    // --- CORE LOGIC ---
    async function fetchData() {
        try {
            const versionRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (versionRes.ok) {
                const timestamp = (await versionRes.text()).trim();
                statusBar.textContent = `آخرین بروزرسانی: ${toShamsi(timestamp)}`;
            }
        } catch (e) { console.warn("Could not fetch version."); }
        
        try {
            const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!dataRes.ok) throw new Error(`Status: ${dataRes.status}`);
            return await dataRes.json();
        } catch (error) {
            statusBar.textContent = 'خطا در بارگذاری';
            throw new Error('All data sources failed.');
        }
    }

    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = ''; // Clear loading message
        
        const actionsContainer = document.createElement('div');
        actionsContainer.innerHTML = `
            <button class="test-button" id="${core}-test-btn">اجرای تست سرعت ترکیبی</button>
            <div class="action-group">
                <h4 class="action-group-title">اشتراک شخصی (Standard)</h4>
                <div class="action-buttons">
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'standard', 'url')">کپی لینک UUID</button>
                    <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'standard', 'qr')">QR Code لینک</button>
                </div>
            </div>
        `;
        if (core === 'xray') {
            actionsContainer.innerHTML += `
                <div class="action-group">
                    <h4 class="action-group-title">اشتراک شخصی (Clash)</h4>
                    <div class="action-buttons">
                        <button class="action-button" onclick="window.v2v.createSubscription('${core}', 'clash', 'url')">کپی لینک Clash</button>
                        <button class="action-button" onclick="window.v2v.downloadClashFile('${core}')">دانلود فایل Clash</button>
                    </div>
                </div>`;
        }
        wrapper.appendChild(actionsContainer);
        document.getElementById(`${core}-test-btn`).addEventListener('click', () => runHybridSpeedTest(core));

        if (!configs || configs.length === 0) {
            wrapper.insertAdjacentHTML('beforeend', '<div class="alert">هیچ کانفیگ سالمی برای این هسته یافت نشد.</div>');
            return;
        }
        
        const grouped = configs.reduce((acc, item) => {
            const proto = item.config.split("://")[0];
            if (!acc[proto]) acc[proto] = [];
            acc[proto].push(item);
            return acc;
        }, {});

        for (const protocol in grouped) {
            const protocolGroupId = `${protocol}-${core}`;
            const protocolGroup = document.createElement('div');
            protocolGroup.className = 'protocol-group';
            protocolGroup.innerHTML = `
                <div class="protocol-header" onclick="toggleGroup('${protocolGroupId}')">
                    <span>${protocol.toUpperCase()} (${grouped[protocol].length})</span>
                    <span class="toggle-icon"></span>
                </div>
                <ul class="config-list" id="${protocolGroupId}"></ul>`;
            const configList = protocolGroup.querySelector('.config-list');
            grouped[protocol].forEach(configObj => {
                const li = document.createElement('li');
                li.className = 'config-item';
                li.dataset.config = configObj.config;
                li.dataset.backendPing = configObj.ping;
                try {
                    const serverName = configObj.config.includes('#') ? decodeURIComponent(configObj.config.split('#')[1]) : new URL(configObj.config).hostname;
                    let pingColor = 'var(--ping-good)';
                    if (configObj.ping > 700) pingColor = 'var(--ping-medium)';
                    if (configObj.ping > 1500) pingColor = 'var(--ping-bad)';

                    li.innerHTML = `
                        <input type="checkbox" class="config-checkbox">
                        <div class="config-details">
                            <span class="server">${serverName}</span>
                            <span class="ping-result" style="color:${pingColor};">پینگ بک‌اند: ${configObj.ping}ms</span>
                        </div>
                        <div class="copy-button-container">
                            <button class="copy-btn" onclick="window.v2v.copyConfig(event)">کپی</button>
                            <button class="copy-btn" onclick="window.v2v.showConfigQr(event)">QR</button>
                        </div>`;
                    configList.appendChild(li);
                } catch(e) {}
            });
            wrapper.appendChild(protocolGroup);
        }
    }

    async function runHybridSpeedTest(core) {
        const testButton = document.getElementById(`${core}-test-btn`);
        if (testButton.disabled) return;
        testButton.disabled = true;
        testButton.textContent = 'درحال تست...';

        const userPing = await getUserPing();
        if (userPing === null) {
            alert('تست پینگ کاربر با شکست مواجه شد. لطفاً اتصال خود را بررسی کنید.');
            testButton.disabled = false;
            testButton.textContent = 'اجرای مجدد تست';
            return;
        }
        
        const items = document.querySelectorAll(`#${core}-section .config-item`);
        items.forEach(item => {
            const pingEl = item.querySelector('.ping-result');
            const backendPing = parseInt(item.dataset.backendPing, 10);
            const finalScore = userPing + backendPing;
            
            let pingColor = 'var(--ping-good)';
            if (finalScore > 800) pingColor = 'var(--ping-medium)';
            if (finalScore > 1600) pingColor = 'var(--ping-bad)';
            
            item.dataset.finalScore = finalScore;
            pingEl.innerHTML = `امتیاز نهایی: <strong style="color:${pingColor};">${finalScore}</strong>`;
        });
        
        document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => { 
            const list = group.querySelector('.config-list'); 
            const items = Array.from(list.children); 
            items.sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999)); 
            items.forEach(item => list.appendChild(item)); 
        });

        testButton.disabled = false;
        testButton.textContent = 'اجرای مجدد تست سرعت';
    }

    // --- GLOBAL API INTERACTION ---
    window.v2v = {
        copyConfig: (event) => {
            event.stopPropagation();
            const config = event.target.closest('.config-item').dataset.config;
            copyToClipboard(config);
        },
        showConfigQr: (event) => {
            event.stopPropagation();
            const config = event.target.closest('.config-item').dataset.config;
            showQrCode(window.event, config);
        },
        getSelectedConfigs: (core) => {
            let selected = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                                .map(cb => cb.closest('.config-item').dataset.config);
            if (selected.length === 0) {
                alert(`هیچ کانفیگی انتخاب نشده. ${AUTO_SELECT_COUNT} عدد از بهترین کانفیگ‌ها به صورت خودکار انتخاب می‌شوند.`);
                selected = Array.from(document.querySelectorAll(`#${core}-section .config-item`))
                                .sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999))
                                .slice(0, AUTO_SELECT_COUNT)
                                .map(item => item.dataset.config);
            }
            return selected;
        },
        createSubscription: async (core, type, action) => {
            const configs = window.v2v.getSelectedConfigs(core);
            if (configs.length === 0) return alert('هیچ کانفیگی برای ساخت لینک وجود ندارد.');
            
            const btn = event.target;
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '...درحال ساخت';
            try {
                const response = await fetch(`${API_BASE_URL}/api/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs, type })
                });
                if (!response.ok) throw new Error('API request failed');
                const data = await response.json();
                
                if (action === 'url') {
                    copyToClipboard(data.subscription_url, 'لینک اشتراک UUID کپی شد!');
                } else if (action === 'qr') {
                    showQrCode(window.event, data.subscription_url);
                }
            } catch (error) {
                alert('خطا در ساخت لینک اشتراک. لطفاً دوباره تلاش کنید.');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        },
        downloadClashFile: (core) => {
            const configs = window.v2v.getSelectedConfigs(core);
            if (configs.length === 0) return alert('هیچ کانفیگی برای ساخت فایل وجود ندارد.');

            const proxies = configs.map(configStr => {
                 try {
                    if (configStr.includes('reality')) return null;
                    const name = configStr.includes('#') ? decodeURIComponent(configStr.split('#')[1]) : new URL(configStr).hostname;
                    let proxy = { name };
                    if (configStr.startsWith('vmess://')) { const d = JSON.parse(atob(configStr.replace('vmess://', ''))); proxy = {...proxy, type: 'vmess', server: d.add, port: parseInt(d.port), uuid: d.id, alterId: d.aid, cipher: d.scy || 'auto', tls: d.tls === 'tls', network: d.net || 'tcp', 'skip-cert-verify': true, servername: d.sni || d.add }; if (proxy.network === 'ws') proxy['ws-opts'] = { path: d.path || '/', headers: { Host: d.host || d.add } }; } 
                    else if (configStr.startsWith('vless://')) { const u = new URL(configStr); const p = new URLSearchParams(u.search); proxy = {...proxy, type: 'vless', server: u.hostname, port: parseInt(u.port), uuid: u.username, tls: p.get('security') === 'tls', network: p.get('type') || 'tcp', servername: p.get('sni') || u.hostname, 'skip-cert-verify': true}; if (proxy.network === 'ws') proxy['ws-opts'] = { path: p.get('path') || '/', headers: { Host: p.get('host') || u.hostname } }; } 
                    else if (configStr.startsWith('trojan://')) { const u = new URL(configStr); const p = new URLSearchParams(u.search); proxy = {...proxy, type: 'trojan', server: u.hostname, port: parseInt(u.port), password: u.username, sni: p.get('sni') || u.hostname, 'skip-cert-verify': true }; } 
                    else if (configStr.startsWith('ss://')) { const u = new URL(configStr); const [cipher, password] = atob(decodeURIComponent(u.username)).split(':'); proxy = {...proxy, type: 'ss', server: u.hostname, port: parseInt(u.port), cipher, password}; } 
                    else { return null; } 
                    return proxy; 
                } catch { return null; } 
            }).filter(p => p);
            
            if (proxies.length === 0) { alert('کانفیگ‌های انتخاب شده با کلش سازگار نیستند.'); return; }
            const clashConfig = { proxies, 'proxy-groups': [{'name': 'V2V-Personal-Auto', 'type': 'url-test', 'proxies': proxies.map(p => p.name), 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}, {'name': 'V2V-Personal', 'type': 'select','proxies': ['V2V-Personal-Auto', ...proxies.map(p => p.name)]}], 'rules': ['MATCH,V2V-Personal'] }; 
            const yamlConfig = jsyaml.dump(clashConfig, { indent: 2, sortKeys: false }); 
            const blob = new Blob([yamlConfig], { type: 'text/yaml' }); 
            const link = document.createElement('a'); 
            link.href = URL.createObjectURL(blob); 
            link.download = 'v2v-clash-personal.yaml'; 
            link.click(); 
            URL.revokeObjectURL(link.href);
        }
    };

    // --- INITIALIZE ---
    (async () => {
        try {
            const data = await fetchData();
            allConfigs = { xray: data.xray || [], singbox: data.singbox || [] };
            renderCore('xray', allConfigs.xray);
            renderCore('singbox', allConfigs.singbox);
        } catch (error) {
            console.error(error);
            const errorMsg = `<div class="alert">خطا در بارگذاری کانفیگ‌ها. لطفاً صفحه را رفرش کنید.</div>`;
            xrayWrapper.innerHTML = errorMsg;
            singboxWrapper.innerHTML = errorMsg;
        }
    })();
});
