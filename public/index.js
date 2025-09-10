<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>V2V Project</title>

    <meta name="theme-color" content="#121212">
    <link rel="apple-touch-icon" href="https://raw.githubusercontent.com/SMBCRYP/V2V/main/icon-192.png">
    <link rel="manifest" href="manifest.json">

    <style>
        :root {
            --primary-bg: #121212; --secondary-bg: #1a1a1a; --text-color: #d1d1d1;
            --logo-red: #D32F2F; --logo-green: #388E3C; --border-color: #333;
            --ping-excellent: #4CAF50; --ping-good: #8BC34A; --ping-medium: #FFC107; 
            --ping-bad: #FF5722; --ping-terrible: #D32F2F;
        }
        html { height: 100%; box-sizing: border-box; }
        *, *:before, *:after { box-sizing: inherit; }
        body {
            background-color: var(--primary-bg); color: var(--text-color);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            text-align: center; margin: 0; display: flex; flex-direction: column;
            align-items: center; min-height: 100%;
        }
        .main-wrapper {
            width: 100%; max-width: 700px; padding: 20px 10px;
            display: flex; flex-direction: column; flex-grow: 1;
        }
        .header { margin-bottom: 20px; flex-shrink: 0; }
        .header img { width: 100px; height: 100px; }
        .header p { color: #888; font-style: italic; }
        .status-bar { font-size: 0.8em; color: #888; margin-bottom: 15px; min-height: 1em; }
        .container {
            width: 100%; background-color: var(--secondary-bg); padding: 20px;
            border-radius: 10px; box-shadow: 0 0 15px rgba(0, 0, 0, 0.5);
            margin-bottom: 20px;
        }
        .core-section { margin-bottom: 20px; }
        .core-section:last-child { margin-bottom: 0; }
        .core-header {
            color: white; padding: 15px; border-radius: 8px; font-size: 1.3em;
            font-weight: bold; margin-bottom: 20px;
        }
        #xray-header { background-color: var(--logo-red); }
        #singbox-header { background-color: var(--logo-green); }
        .core-test-container { margin-bottom: 20px; }
        .test-button {
            background-color: var(--logo-green); color: white; border: none; padding: 12px 24px;
            border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 1em;
            display: inline-flex; align-items: center; gap: 8px; transition: all 0.3s ease;
        }
        .test-button:hover { background-color: #2E7D32; transform: translateY(-1px); }
        .test-button:disabled { background-color: #555; cursor: not-allowed; transform: none; }
        .loader { width: 16px; height: 16px; border: 2px solid #fff; border-bottom-color: transparent; border-radius: 50%; display: inline-block; box-sizing: border-box; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .protocol-group { border-top: 1px solid var(--border-color); }
        .protocol-header { background-color: transparent; padding: 10px 5px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .protocol-title-wrapper { display: flex; align-items: center; gap: 10px; font-weight: bold; }
        .toggle-icon {
            content: ''; display: inline-block; width: 6px; height: 6px;
            border-bottom: 2px solid var(--text-color); border-right: 2px solid var(--text-color);
            transform: rotate(45deg); transition: transform 0.3s ease-in-out;
        }
        .protocol-group.open .toggle-icon { transform: rotate(-135deg); }
        .config-list { list-style: none; padding: 0; margin: 0; max-height: 0; transition: max-height 0.3s ease-out; overflow: hidden; }
        .protocol-group.open .config-list { max-height: 3000px; }
        .config-item { padding: 12px 5px; border-top: 1px solid var(--border-color); display: flex; align-items: center; gap: 10px; transition: background-color 0.2s ease; }
        .config-item:hover { background-color: rgba(255, 255, 255, 0.05); }
        .config-details { flex-grow: 1; text-align: left; overflow: hidden; }
        .config-details .server-name { font-weight: bold; word-break: break-all; font-size: 0.85em; color: #fff; margin-bottom: 4px; }
        .ping-result { font-size: 0.8em; }
        .copy-button-container { display: flex; gap: 6px; flex-shrink: 0; }
        .copy-btn { background-color: #333; border: 1px solid var(--border-color); padding: 6px 10px; border-radius: 5px; cursor: pointer; color: var(--text-color); font-size: 0.8em; transition: background-color 0.2s ease; }
        .copy-btn:hover { background-color: #444; }
        .bottom-links { margin-top: auto; padding-top: 20px; border-top: 2px solid var(--border-color); width: 100%; display: flex; gap: 20px; justify-content: center; flex-shrink: 0; }
        .bottom-links a { color: var(--text-color); text-decoration: none; font-size: 0.9em; transition: color 0.2s ease; }
        .bottom-links a:hover { color: #fff; }
        .alert { padding: 20px; font-weight: bold; color: var(--logo-red); }
    </style>
</head>
<body>
    <div class="main-wrapper">
        <header class="header">
            <img src="https://raw.githubusercontent.com/SMBCRYP/V2V/main/logo.png" alt="V2V Logo">
            <p>Special thanks to all contributors.</p>
        </header>
        <div class="status-bar" id="status-bar">Initializing...</div>

        <div class="container">
            <section id="xray-section" class="core-section">
                <div class="core-header" id="xray-header">Xray-Core</div>
                <div class="core-test-container">
                    <button class="test-button" id="xray-test-btn" onclick="runHybridPingTest('xray')">Run Speed Test</button>
                </div>
                <div id="xray-content-wrapper"><div class="alert">Loading configs...</div></div>
            </section>
            
            <section id="singbox-section" class="core-section">
                <div class="core-header" id="singbox-header">Sing-box Core</div>
                 <div class="core-test-container">
                    <button class="test-button" id="singbox-test-btn" onclick="runHybridPingTest('singbox')">Run Speed Test</button>
                </div>
                <div id="singbox-content-wrapper"><div class="alert">Loading configs...</div></div>
            </section>
        </div>
        
        <footer class="bottom-links">
            <a href="https://smbcryp.github.io/V2V/" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://v2v-final.vercel.app/" target="_blank" rel="noopener noreferrer">Vercel</a>
        </footer>
    </div>
    
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
            const DATA_URL = 'all_live_configs.json';
            const CACHE_URL = 'cache_version.txt';
            const PING_TIMEOUT = 2500;

            const statusBar = document.getElementById('status-bar');
            const xrayWrapper = document.getElementById('xray-content-wrapper');
            const singboxWrapper = document.getElementById('singbox-content-wrapper');

            const toLocalDate = (timestamp) => {
                if (!timestamp || isNaN(timestamp)) return 'N/A';
                const date = new Date(parseInt(timestamp, 10) * 1000);
                return date.toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: false
                });
            };

            const parseConfigName = (configStr) => {
                try {
                    if (configStr.includes('#')) {
                        return decodeURIComponent(configStr.split('#')[1]);
                    }
                    if (configStr.startsWith('vmess://')) {
                        const vmessData = JSON.parse(atob(configStr.replace('vmess://', '')));
                        return vmessData.ps || vmessData.add;
                    }
                    const url = new URL(configStr);
                    return url.hostname;
                } catch {
                    return 'Unnamed Config';
                }
            };

            async function fetchData() {
                try {
                    const versionRes = await fetch(`${CACHE_URL}?t=${Date.now()}`, { cache: 'no-store' });
                    if (versionRes.ok) {
                        const timestamp = (await versionRes.text()).trim();
                        statusBar.textContent = `Last Update: ${toLocalDate(timestamp)}`;
                    } else {
                         statusBar.textContent = 'Could not fetch update time.';
                    }
                } catch (e) {
                    console.error("Failed to fetch cache version:", e);
                    statusBar.textContent = 'Update check failed.';
                }
                
                try {
                    const dataRes = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
                    if (!dataRes.ok) throw new Error(`Status: ${dataRes.status}`);
                    return await dataRes.json();
                } catch (error) {
                    statusBar.textContent = 'Error loading configurations.';
                    throw new Error('All data sources failed.');
                }
            }

            function renderCore(core, configs) {
                const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
                wrapper.innerHTML = '';

                if (!configs || configs.length === 0) {
                    wrapper.innerHTML = `<div class="alert">No active configs found.</div>`;
                    return;
                }

                const groupedByProtocol = configs.reduce((acc, config) => {
                    const protocol = config.match(/^(\w+):\/\//)?.[1]?.toLowerCase() || 'unknown';
                    if (!acc[protocol]) acc[protocol] = [];
                    acc[protocol].push(config);
                    return acc;
                }, {});

                for (const protocol in groupedByProtocol) {
                    const protocolGroupId = `${protocol}-${core}`;
                    const protocolGroupEl = document.createElement('div');
                    protocolGroupEl.className = 'protocol-group';

                    let listItems = '';
                    groupedByProtocol[protocol].forEach(config => {
                        const name = parseConfigName(config);
                        const safeConfig = config.replace(/'/g, "&apos;").replace(/"/g, "&quot;");
                        listItems += `
                            <li class="config-item" data-config='${safeConfig}'>
                                <div class="config-details">
                                    <div class="server-name">${name}</div>
                                    <div class="ping-result">Not tested</div>
                                </div>
                                <div class="copy-button-container">
                                    <button class="copy-btn" onclick="window.v2v.copyToClipboard('${safeConfig}')">Copy</button>
                                </div>
                            </li>`;
                    });

                    protocolGroupEl.innerHTML = `
                        <div class="protocol-header" onclick="window.v2v.toggleGroup('${protocolGroupId}')">
                            <div class="protocol-title-wrapper">
                                <span>${protocol.toUpperCase()} (${groupedByProtocol[protocol].length})</span>
                            </div>
                            <span class="toggle-icon"></span>
                        </div>
                        <ul class="config-list" id="${protocolGroupId}">${listItems}</ul>`;
                    
                    wrapper.appendChild(protocolGroupEl);
                }
            }
            
            window.v2v = {
                copyToClipboard: (text, msg = 'Copied to clipboard!') => {
                    navigator.clipboard.writeText(text).then(() => alert(msg)).catch(err => alert('Copy failed: ' + err));
                },
                toggleGroup: (groupId) => {
                    document.getElementById(groupId)?.parentNode.classList.toggle('open');
                }
            };
            
            (async () => {
                try {
                    const data = await fetchData();
                    renderCore('xray', data.xray || []);
                    renderCore('singbox', data.singbox || []);
                } catch(e) {
                    console.error(e);
                    xrayWrapper.innerHTML = `<div class="alert">Failed to load Xray configs.</div>`;
                    singboxWrapper.innerHTML = `<div class="alert">Failed to load Sing-box configs.</div>`;
                }
            })();
            
            window.runHybridPingTest = async (core) => {
                console.clear();
                console.log(`🚀 Hybrid Ping Test Started for [${core}] core...`);

                const testButton = document.getElementById(`${core}-test-btn`);
                if (testButton.disabled) return;
                testButton.disabled = true;
                testButton.innerHTML = `<span class="loader"></span> Testing...`;

                const allItems = Array.from(document.querySelectorAll(`#${core}-section .config-item`));
                allItems.forEach(item => {
                    item.style.display = 'flex';
                    const pingEl = item.querySelector('.ping-result');
                    pingEl.style.color = 'var(--ping-medium)';
                    pingEl.textContent = '⏳ Pending...';
                    delete item.dataset.finalScore;
                });

                const configs = allItems.map(item => item.dataset.config);
                const results = new Map();
                let overallTestSuccess = false;

                const configsForBackendPing = [];
                const wsConfigs = [];

                configs.forEach(config => {
                    try {
                        const params = new URLSearchParams(new URL(config).search);
                        if ((config.startsWith('vless://') || config.startsWith('vmess://')) && params.get('type') === 'ws') {
                            wsConfigs.push(config);
                        } else {
                            configsForBackendPing.push(config);
                        }
                    } catch (e) {
                        configsForBackendPing.push(config);
                    }
                });

                console.log(`📊 Found ${wsConfigs.length} WebSocket configs to test locally.`);
                console.log(`📡 Found ${configsForBackendPing.length} other configs to send to the backend worker.`);

                const wsPingPromises = wsConfigs.map(config => {
                    const item = allItems.find(i => i.dataset.config === config);
                    if (item) item.querySelector('.ping-result').textContent = 'Testing (WS)...';

                    return new Promise(resolve => {
                        try {
                            const url = new URL(config);
                            const startTime = Date.now();
                            const wsProtocol = (url.searchParams.get('security') === 'tls' || url.port === '443') ? 'wss://' : 'ws://';
                            const wsPath = url.searchParams.get('path') || '/';
                            const wsUrl = `${wsProtocol}${url.hostname}:${url.port}${wsPath}`;
                            
                            const ws = new WebSocket(wsUrl);
                            ws.onopen = () => {
                                results.set(config, Date.now() - startTime);
                                ws.close();
                                resolve();
                            };
                            ws.onerror = (err) => {
                                results.set(config, null);
                                ws.close();
                                resolve();
                            };
                            setTimeout(() => {
                                if (ws.readyState !== WebSocket.OPEN) {
                                    results.set(config, null);
                                    ws.close();
                                    resolve();
                                }
                            }, PING_TIMEOUT);
                        } catch {
                            results.set(config, null);
                            resolve();
                        }
                    });
                });

                await Promise.all(wsPingPromises);

                if (configsForBackendPing.length > 0) {
                    console.log('📤 Sending configs to Cloudflare Worker for TCP ping test...');
                    configsForBackendPing.forEach(config => {
                        const item = allItems.find(i => i.dataset.config === config);
                        if (item) item.querySelector('.ping-result').textContent = 'Testing (API)...';
                    });

                    try {
                        const response = await fetch(`${API_ENDPOINT}/ping`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ configs: configsForBackendPing })
                        });
                        if (!response.ok) throw new Error('Backend ping failed with status: ' + response.status);

                        const backendResults = await response.json();
                        console.log('✅ Backend response received:', backendResults);

                        backendResults.forEach(res => {
                            results.set(res.config, res.ping !== null ? 500 : null);
                        });
                    } catch (e) {
                        console.error("❌ CRITICAL ERROR: Backend ping failed entirely.", e);
                        allItems.forEach(item => {
                             if (configsForBackendPing.includes(item.dataset.config)) {
                                const pingEl = item.querySelector('.ping-result');
                                pingEl.textContent = 'API Test Error';
                                pingEl.style.color = 'var(--ping-terrible)';
                             }
                        });
                        testButton.disabled = false;
                        testButton.textContent = 'Test Again (Error)';
                        alert('Could not connect to the test server. Please check your connection and try again.');
                        return;
                    }
                }
                
                console.log('🏁 All tests finished. Processing results...');

                results.forEach(pingValue => {
                    if (pingValue !== null) overallTestSuccess = true;
                });

                if (!overallTestSuccess) {
                    alert('No configs passed the test. This might be a network issue.');
                    testButton.disabled = false;
                    testButton.textContent = 'Run Speed Test';
                    return;
                }

                allItems.forEach(item => {
                    const ping = results.get(item.dataset.config);
                    const pingEl = item.querySelector('.ping-result');
                    if (ping !== null && ping > 0) {
                        let pingClass, pingColor;
                        if (ping < 200) { pingClass = 'excellent'; pingColor = 'var(--ping-excellent)'; }
                        else if (ping < 600) { pingClass = 'good'; pingColor = 'var(--ping-good)'; }
                        else if (ping < 1200) { pingClass = 'medium'; pingColor = 'var(--ping-medium)'; }
                        else { pingClass = 'bad'; pingColor = 'var(--ping-bad)'; }
                        
                        item.dataset.finalScore = ping;
                        pingEl.innerHTML = `Ping: <strong style="color:${pingColor};">${ping}ms</strong>`;
                        item.style.display = 'flex';
                    } else {
                        item.dataset.finalScore = 9999;
                        item.style.display = 'none';
                    }
                });

                document.querySelectorAll(`#${core}-section .protocol-group`).forEach(group => {
                    const list = group.querySelector('.config-list');
                    if (!list) return;
                    const sortedItems = Array.from(list.children).sort((a, b) => (a.dataset.finalScore || 9999) - (b.dataset.finalScore || 9999));
                    sortedItems.forEach(item => list.appendChild(item));
                });

                testButton.disabled = false;
                testButton.textContent = 'Run Speed Test';
                console.log('✅ UI updated and sorted.');
            }
        });
    </script>
</body>
</html>
