// --- CONFIGURATION & CONSTANTS ---
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
// ✅ اصلاح کلیدی ۱: شناسه ثابت برای اشتراک عمومی (آماده)
const PUBLIC_SUB_UUID = "00000000-v2v-public-sub-000000000000";

// --- HELPERS ---
function generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
async function fetchWithFailover(env) {
    // ✅ اصلاح کلیدی ۲: این تابع حالا لیست میرورها را از Secrets کلادفلر می‌خواند
    // این کار Worker را کاملاً مستقل و قابل конфиگ می‌کند.
    const mirrors = JSON.parse(env.DATA_MIRRORS || '[]');
    if (mirrors.length === 0) throw new Error("No data mirrors configured in Worker secrets.");
    
    for (const url of mirrors) {
        try {
            const response = await fetch(`${url}?t=${Date.now()}`, { headers: { 'User-Agent': 'V2V-Worker/1.0' } });
            if (response.ok) return await response.json();
        } catch (error) {
            console.warn(`Worker failed to fetch from mirror ${url}:`, error);
        }
    }
    throw new Error('All data mirrors failed.');
}

// --- API HANDLERS ---
async function handleSubscribeRequest(request, env) { /* ... (کد قبلی شما بدون تغییر) ... */ }

async function handleGetSubscription(request, env) {
    const url = new URL(request.url);
    const pathParts = url.pathname.substring(1).split('/');
    const subId = pathParts[pathParts.length - 1];
    const subType = pathParts.includes('clash') ? 'clash' : 'standard';
    const core = pathParts.includes('singbox') ? 'singbox' : 'xray';

    if (!env.V2V_KV) { return new Response('KV Namespace not configured.', { status: 500 }); }

    let finalConfigs = [];
    
    // ✅ اصلاح کلیدی ۳: منطق جدید برای سرویس‌دهی به اشتراک عمومی (آماده)
    if (subId === PUBLIC_SUB_UUID) {
        try {
            const liveData = await fetchWithFailover(env);
            finalConfigs = liveData[core] || [];
        } catch (e) {
            return new Response("Could not fetch live configs for public subscription.", { status: 503 });
        }
    } else {
        // منطق اشتراک شخصی
        const key = `sub:${subId}`;
        const userConfigsJson = await env.V2V_KV.get(key);
        if (!userConfigsJson) { return new Response('Subscription not found.', { status: 404 }); }
        
        const userConfigs = JSON.parse(userConfigsJson);
        let healedConfigs = [...userConfigs];
        try {
            const liveData = await fetchWithFailover(env);
            const liveConfigsSet = new Set(liveData[core] || []);
            healedConfigs = userConfigs.filter(c => liveConfigsSet.has(c));
            // (منطق healing بدون تغییر باقی می‌ماند)
        } catch (e) { console.error("Subscription healing failed:", e); }
        finalConfigs = healedConfigs;
    }

    if (finalConfigs.length === 0) { return new Response("No valid configs found.", { status: 500 }); }

    const output = finalConfigs.join('\n');
    const headers = { ...corsHeaders, 'Content-Type': 'text/plain;charset=utf-8' };
    return new Response(subType === 'clash' ? output : btoa(output), { headers });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') { return new Response(null, { headers: corsHeaders }); }
        const url = new URL(request.url);
        if (url.pathname === '/subscribe') { return handleSubscribeRequest(request, env); }
        const subPathRegex = /^(?:(xray|singbox)\/)?(?:(clash)\/)?([a-f0-9-]{36}|00000000-v2v-public-sub-000000000000)$/;
        if (subPathRegex.test(url.pathname.substring(1))) {
             return handleGetSubscription(request, env);
        }
        return new Response('V2V API Worker is active.', { status: 200, headers: corsHeaders });
    },
};


