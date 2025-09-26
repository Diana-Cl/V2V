// worker.js

import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml';
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const TEST_TIMEOUT_WORKER = 25000; // 25 seconds for the whole batch
const MAX_CONFIGS_PER_BATCH = 50; // برای جلوگیری از بار زیاد روی Worker

const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

function generateCorsHeaders(requestOrigin) {
    if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
        return {
            'Access-Control-Allow-Origin': requestOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Cache-Version',
            'Vary': 'Origin',
        };
    }
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
}

function jsonResponse(data, status = 200, corsHeaders) {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders } });
}

function textResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

function yamlResponse(text, status = 200, filename = null, corsHeaders) {
    const headers = { 'Content-Type': 'application/x-yaml; charset=utf-8', ...corsHeaders };
    if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    return new Response(text, { status, headers });
}

// توابع ایزوله و تقویت شده برای پارس URL و تولید خروجی
function parseConfigUrl(url) {
    try {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol.replace(':', '');
        const params = new URLSearchParams(urlObj.search);
        let config = {
            protocol,
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            // نام کانفیگ استاندارد از Hash یا Hostname
            name: decodeURIComponent(urlObj.hash.substring(1) || urlObj.hostname)
        };
        
        // Vmess: تقویت مدیریت خطا
        if (protocol === 'vmess') {
            try {
                const decodedData = JSON.parse(atob(urlObj.hostname + urlObj.pathname.replace(/^\/+/, '')));
                config.server = decodedData.add;
                config.port = parseInt(decodedData.port);
                config.uuid = decodedData.id;
                config.alterId = decodedData.aid;
                config.cipher = 'auto';
                config.network = decodedData.net;
                if (decodedData.net === 'ws') {
                    config.wsPath = decodedData.path;
                    config.wsHeaders = { Host: decodedData.host || decodedData.add };
                }
                if (decodedData.tls === 'tls') {
                    config.tls = true;
                    config.sni = decodedData.sni || decodedData.host;
                }
            } catch (e) {
                // console.error("Error parsing Vmess data:", e);
                return null; 
            }
        } else if (protocol === 'vless') {
            config.uuid = urlObj.username;
            config.encryption = params.get('encryption') || 'none';
            config.flow = params.get('flow');
            config.network = params.get('type') || 'tcp';
            if (config.network === 'ws') {
                config.wsPath = params.get('path');
                config.wsHeaders = { Host: params.get('host') || urlObj.hostname };
            }
            if (params.get('security') === 'tls') {
                config.tls = true;
                config.sni = params.get('sni') || urlObj.hostname;
                config.alpn = params.get('alpn'); // پارامتر حیاتی
                config.skipCertVerify = params.get('allowInsecure') === '1'; // پارامتر حیاتی
            }
        } else if (protocol === 'trojan') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
            config.alpn = params.get('alpn'); // پارامتر حیاتی
            config.skipCertVerify = params.get('allowInsecure') === '1'; // پارامتر حیاتی
        } else if (protocol === 'ss' || protocol === 'shadowsocks') {
            const [method, password] = atob(urlObj.username).split(':');
            config.protocol = 'ss';
            config.cipher = method;
            config.password = password;
        } else if (protocol === 'hy2' || protocol === 'hysteria2') {
            config.protocol = 'hysteria2';
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (protocol === 'tuic') {
            config.protocol = 'tuic';
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        }
        return config;
    } catch (e) {
        // console.error("Error parsing config URL:", e);
        return null;
    }
}

function generateClashYaml(configs) {
    const proxies = [];
    const validProtocols = ['vmess', 'vless', 'trojan', 'ss'];
    for (const url of configs) {
        const config = parseConfigUrl(url);
        if (!config || !validProtocols.includes(config.protocol)) continue; // فیلترینگ منطبق با هسته Clash
        
        let proxy = {
            name: config.name,
            server: config.server,
            port: config.port,
        };
        
        if (config.protocol === 'vmess') {
            Object.assign(proxy, {
                type: 'vmess', uuid: config.uuid, alterId: config.alterId, cipher: config.cipher
            });
            if (config.network === 'ws') Object.assign(proxy, { network: 'ws', 'ws-path': config.wsPath, 'ws-headers': config.wsHeaders });
            if (config.tls) Object.assign(proxy, { tls: true, sni: config.sni, 'skip-cert-verify': true });
        } else if (config.protocol === 'vless') {
            Object.assign(proxy, {
                type: 'vless', uuid: config.uuid, encryption: config.encryption || 'none', flow: config.flow || ''
            });
            if (config.network === 'ws') Object.assign(proxy, { network: 'ws', 'ws-path': config.wsPath, 'ws-headers': config.wsHeaders });
            if (config.tls) Object.assign(proxy, { tls: true, sni: config.sni, 'skip-cert-verify': config.skipCertVerify || false, alpn: config.alpn ? config.alpn.split(',') : undefined });
        } else if (config.protocol === 'trojan') {
            Object.assign(proxy, {
                type: 'trojan', password: config.password, tls: true, sni: config.sni, 'skip-cert-verify': config.skipCertVerify || false, alpn: config.alpn ? config.alpn.split(',') : undefined
            });
        } else if (config.protocol === 'ss') {
            Object.assign(proxy, {
                type: 'ss', cipher: config.cipher, password: config.password
            });
        }
        
        proxies.push(proxy);
    }
    
    if (proxies.length === 0) return null;
    
    // تولید YAML استاندارد: از js-yaml استفاده می‌کند که مقادیر بولی/عددی را به درستی فرمت می‌کند.
    const proxyNames = proxies.map(p => p.name);
    const proxyGroups = [{
        name: 'v2v-auto-select',
        type: 'url-test',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        proxies: proxyNames
    }];
    
    const payload = {
        proxies,
        'proxy-groups': proxyGroups,
        rules: ["MATCH,v2v-auto-select"]
    };
    return YAML.dump(payload);
}

function generateSingboxJson(configs) {
    const outbounds = [];
    const validProtocols = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2', 'tuic'];
    for (const url of configs) {
        const config = parseConfigUrl(url);
        if (!config || !validProtocols.includes(config.protocol)) continue; // فیلترینگ منطبق با هسته Sing-box
        
        let outbound = {
            tag: config.name,
            type: config.protocol,
            server: config.server,
            server_port: config.port
        };
        
        // منطق کامل Sing-box (باید با مستندات آن منطبق باشد)
        if (config.protocol === 'vmess') {
            Object.assign(outbound, {
                uuid: config.uuid, alter_id: config.alterId, security: config.cipher, network: config.network
            });
            // جزئیات TLS/WS
        } else if (config.protocol === 'vless') {
            Object.assign(outbound, {
                uuid: config.uuid, flow: config.flow, network: config.network
            });
            // جزئیات TLS/WS
        } else if (config.protocol === 'trojan') {
            Object.assign(outbound, { password: config.password });
            // جزئیات TLS
        } else if (config.protocol === 'ss') {
            Object.assign(outbound, { method: config.cipher, password: config.password });
        } else if (config.protocol === 'hysteria2') {
            Object.assign(outbound, { password: config.password });
            // جزئیات TLS
        } else if (config.protocol === 'tuic') {
            Object.assign(outbound, { password: config.password });
            // جزئیات TLS
        }
        
        outbounds.push(outbound);
    }
    
    if (outbounds.length === 0) return null;
    
    const payload = {
        log: { disabled: true },
        dns: {
            "servers": [{"address": "8.8.8.8", "strategy": "prefer_ipv4"}],
            "rules": []
        },
        inbounds: [],
        outbounds: outbounds,
        route: { rules: [] }
    };
    return JSON.stringify(payload, null, 2);
}


// نقطه پایانی جدید برای تست دسته‌ای
async function handleTestBatch(request, corsHeaders) {
    const { configs } = await request.json();
    if (!Array.isArray(configs) || configs.length === 0 || configs.length > MAX_CONFIGS_PER_BATCH) {
        return jsonResponse({ error: 'Invalid batch size.' }, 400, corsHeaders);
    }

    const testStartTime = Date.now();
    const results = [];
    
    for (const url of configs) {
        if (Date.now() - testStartTime > TEST_TIMEOUT_WORKER) {
            results.push({ url, latency: 99999, status: 'Timeout', error: 'Worker Timeout' });
            continue;
        }

        const config = parseConfigUrl(url);
        if (!config || !config.server || !config.port) {
            results.push({ url, latency: 99999, status: 'Dead', error: 'Parse Error' });
            continue;
        }

        try {
            const startTime = Date.now();
            const socket = connect({ hostname: config.server, port: config.port });
            
            // Timeout برای هر کانکشن (برای تست واقعی)
            const connectionTimeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection Timeout')), 7000)
            );
            
            let finalSocket = socket;
            if (config.tls) {
                finalSocket = await Promise.race([
                    socket.startTls({ servername: config.sni || config.server }),
                    connectionTimeout
                ]);
            } else {
                 // فقط چک کردن اتصال TCP
                 await Promise.race([
                    finalSocket.closed,
                    connectionTimeout
                ]);
            }

            // فقط چک کردن اتصال TCP/TLS
            await finalSocket.close();
            
            results.push({ url, latency: Date.now() - startTime, status: 'Live' });
        } catch (e) {
            results.push({ url, latency: 99999, status: 'Dead', error: e.message });
        }
    }

    return jsonResponse({ results }, 200, corsHeaders);
}


export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        try {
            // نقطه پایانی جدید برای تست دسته‌ای
            if (url.pathname === '/test-batch' && request.method === 'POST') {
                return handleTestBatch(request, corsHeaders);
            }
            
            // نقطه پایانی قدیمی /ping حذف شد
            
            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid } = await request.json();
                if (!Array.isArray(configs) || configs.length === 0) return textResponse('`configs` array is required.', 400, null, corsHeaders); // مدیریت خطای بهتر
                const userUuid = clientUuid || uuidv4();
                
                // فیلترینگ قوی برای اطمینان از ذخیره شدن فقط لینک‌های URL صحیح
                const validConfigs = configs.filter(cfg => typeof cfg === 'string' && cfg.includes('://'));
                if (validConfigs.length === 0) return textResponse('No valid configs found.', 400, null, corsHeaders);
                
                await env.v2v_kv.put(`sub:${userUuid}`, JSON.stringify(validConfigs), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                return jsonResponse({ uuid: userUuid, subscriptionUrl: `${url.origin}/sub/raw/${userUuid}`, clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` }, 200, corsHeaders);
            }
            
            // مدیریت خطای KV و JSON (عملیات خواندن)
            const subMatch = url.pathname.match(/^\/sub\/(raw|clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1], uuid = subMatch[2];
                let storedData;
                try {
                    const data = await env.v2v_kv.get(`sub:${uuid}`, { type: 'text' });
                    if (!data) return textResponse('Subscription not found or expired.', 404, null, corsHeaders);
                    storedData = JSON.parse(data);
                } catch (e) {
                    return textResponse('Invalid subscription data format.', 500, null, corsHeaders);
                }
                
                // تمدید TTL
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { expirationTtl: TTL_USER_SUBSCRIPTION_STORE });
                
                // تولید خروجی
                if (format === 'raw') return textResponse(btoa(storedData.join('\n')), 200, `v2v-${uuid}.txt`, corsHeaders);
                
                const coreName = (format === 'clash') ? 'clash' : 'singbox';
                
                let content;
                if (coreName === 'clash') content = generateClashYaml(storedData);
                else if (coreName === 'singbox') content = generateSingboxJson(storedData);

                if (!content) return textResponse(`Failed to generate ${coreName} config.`, 500, null, corsHeaders);
                
                if (coreName === 'clash') return yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders);
                if (coreName === 'singbox') return jsonResponse(JSON.parse(content), 200, corsHeaders);
            }
            
            return textResponse('v2v Worker is running.', 200, null, corsHeaders);
        } catch (err) {
            // مدیریت خطای عمومی Worker
            return jsonResponse({ error: 'An unexpected error occurred.', details: err.message }, 500, corsHeaders);
        }
    },
};
