document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const API_ENDPOINT = 'https://rapid-scene-1da6.mbrgh87.workers.dev';
    const DATA_URL = 'all_live_configs.json';
    const CACHE_URL = 'cache_version.txt';

    // --- DOM ELEMENTS ---
    const statusBar = document.getElementById('status-bar');
    const xrayWrapper = document.getElementById('xray-content-wrapper');
    const singboxWrapper = document.getElementById('singbox-content-wrapper');

    // --- HELPERS ---
    const toShamsi = (timestamp) => { /* ... (Logic from previous versions) ... */ };
    const parseConfigName = (configStr) => { /* ... (Logic from previous versions) ... */ };

    // --- RENDER FUNCTIONS ---
    function renderCore(core, configs) {
        const wrapper = core === 'xray' ? xrayWrapper : singboxWrapper;
        wrapper.innerHTML = '';
        
        // Render action buttons
        wrapper.innerHTML += `
            <button class="test-button" onclick="window.v2v.runAdvancedPingTest('${core}')">🚀 تست پیشرفته</button>
            <div class="action-group">
                <div class="action-buttons">
                    <button onclick="window.v2v.createSubscription('${core}', 'standard')">کپی لینک UUID</button>
                    <button onclick="window.v2v.generateClashConfig('${core}')">دانلود فایل Clash</button>
                </div>
            </div>
        `;
        
        // Render configs
        const grouped = configs.reduce(/* ... (Grouping logic) ... */);
        for (const protocol in grouped) {
            // ... (Render each protocol group and config item with a checkbox) ...
        }
    }
    
    // --- INITIAL DATA LOAD ---
    (async () => { /* ... (Initial data loading logic) ... */ })();

    // --- GLOBAL FUNCTIONS ---
    window.v2v = {
        runAdvancedPingTest: async (core) => { /* ... (Cascading Ping Test logic from previous version) ... */ },
        
        createSubscription: async (core, type) => {
            const selectedConfigs = Array.from(document.querySelectorAll(`#${core}-section .config-checkbox:checked`))
                .map(cb => cb.closest('.config-item').dataset.config);

            if (selectedConfigs.length === 0) {
                alert('لطفاً حداقل یک کانفیگ را برای ساخت اشتراک انتخاب کنید.');
                return;
            }

            try {
                const response = await fetch(`${API_ENDPOINT}/api/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ configs: selectedConfigs, type: type })
                });

                if (!response.ok) throw new Error(`Server responded with ${response.status}`);
                
                const data = await response.json();
                navigator.clipboard.writeText(data.subscription_url);
                alert('لینک اشتراک شخصی شما با موفقیت ساخته و در کلیپ‌بورد کپی شد.');

            } catch (e) {
                alert('خطا در ساخت لینک اشتراک. لطفاً دوباره تلاش کنید.');
                console.error('Subscription creation failed:', e);
            }
        },

        generateClashConfig: (core) => {
            // ... (Robust Clash generation logic, inspired by Python script) ...
            // This logic will parse selected configs, remove duplicates, and use js-yaml to create the file.
        }
    };
});
