import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml'; 
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3; // 3 days
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

// تعریف پروتکل‌های پشتیبانی‌شده توسط هر هسته
const XRAY_PROTOCOLS = ['vless', 'vmess', 'trojan', 'ss', 'shadowsocks'];
const SINGBOX_PROTOCOLS = ['vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hysteria2', 'hy2', 'tuic'];

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
    return new Response(JSON.stringify(data, null, 2), { 
        status, 
        headers: { 
            'Content-Type': 'application/json; charset=utf-8', 
            ...corsHeaders 
        } 
    });
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

function parseConfigUrl(url) {
    try {
        const urlObj = new URL(url);
        let protocol = urlObj.protocol.replace(':', '');
        const params = new URLSearchParams(urlObj.search);
        
        let config = {
            protocol,
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            name: decodeURIComponent(urlObj.hash.substring(1) || `${protocol}-${urlObj.hostname}`)
        };
        
        // تطبیق پروتکل‌ها
        if (protocol === 'shadowsocks') config.protocol = 'ss';
        if (protocol === 'hysteria2') config.protocol = 'hy2';

        if (config.protocol === 'vmess') {
            try {
                const vmessData = url.replace('vmess://', '');
                const decodedData = JSON.parse(atob(vmessData));
                config.server = decodedData.add;
                config.port = parseInt(decodedData.port);
                config.uuid = decodedData.id;
                config.alterId = parseInt(decodedData.aid) || 0;
                config.cipher = decodedData.scy || 'auto'; 
                config.network = decodedData.net || 'tcp';
                config.name = decodedData.ps || config.name;
                
                if (decodedData.net === 'ws') {
                    config.wsPath = decodedData.path || '/';
                    config.wsHeaders = { Host: decodedData.host || decodedData.add };
                }
                if (decodedData.tls === 'tls') {
                    config.tls = true;
                    config.sni = decodedData.sni || decodedData.host || decodedData.add;
                }
            } catch (e) { 
                return null; 
            }
        } else if (config.protocol === 'vless') {
            config.uuid = urlObj.username;
            config.encryption = params.get('encryption') || 'none';
            config.flow = params.get('flow') || '';
            config.network = params.get('type') || 'tcp';
            
            if (config.network === 'ws') {
                config.wsPath = params.get('path') || '/';
                config.wsHeaders = { Host: params.get('host') || urlObj.hostname };
            }
            if (params.get('security') === 'tls') {
                config.tls = true;
                config.sni = params.get('sni') || urlObj.hostname;
            }
        } else if (config.protocol === 'trojan') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (config.protocol === 'ss') {
            try {
                const decoded = atob(urlObj.username);
                if (decoded.includes(':')) {
                    const [method, password] = decoded.split(':', 2);
                    config.cipher = method;
                    config.password = password;
                } else {
                    return null;
                }
            } catch (e) { 
                return null; 
            }
        } else if (config.protocol === 'hy2') {
            config.password = urlObj.username;
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else if (config.protocol === 'tuic') {
            config.uuid = urlObj.username;
            config.password = params.get('password') || '';
            config.tls = true;
            config.sni = params.get('sni') || urlObj.hostname;
        } else {
            return null;
        }

        return config;
    } catch (e) {
        return null;
    }
}

function generateClashYaml(configs, targetCore) {
    const proxies = [];
    const allowedProtocols = targetCore === 'xray' ? XRAY_PROTOCOLS : SINGBOX_PROTOCOLS;

    for (const url of configs) {
        const config = parseConfigUrl(url);
        
        if (!config || !allowedProtocols.includes(config.protocol)) continue;
        
        // Clash فقط از پروتکل‌های محدود پشتیبانی می‌کند
        if (['hy2', 'tuic'].includes(config.protocol)) continue;

        let proxy = {
            name: config.name,
            server: config.server, 
            port: config.port,
            'skip-cert-verify': true
        };
        
        if (config.protocol === 'vmess') {
            Object.assign(proxy, {
                type: 'vmess',
                uuid: config.uuid,
                alterId: config.alterId,
                cipher: config.cipher,
                network: config.network
            });
            
            if (config.network === 'ws') {
                proxy['ws-opts'] = {
                    path: config.wsPath,
                    headers: config.wsHeaders
                };
            }
            
            if (config.tls) {
                proxy.tls = true;
                proxy.servername = config.sni;
            }
        } else if (config.protocol === 'vless') {
            Object.assign(proxy, {
                type: 'vless',
                uuid: config.uuid,
                flow: config.flow,
                network: config.network
            });
            
            if (config.network === 'ws') {
                proxy['ws-opts'] = {
                    path: config.wsPath,
                    headers: config.wsHeaders
                };
            }
            
            if (config.tls) {
                proxy.tls = true;
                proxy.servername = config.sni;
            }
        } else if (config.protocol === 'trojan') {
            Object.assign(proxy, {
                type: 'trojan',
                password: config.password,
                sni: config.sni
            });
        } else if (config.protocol === 'ss') {
            Object.assign(proxy, {
                type: 'ss',
                cipher: config.cipher,
                password: config.password
            });
        }
        
        if (proxy.type) proxies.push(proxy);
    }
    
    if (proxies.length === 0) return null;
    
    const proxyNames = proxies.map(p => p.name);
    const proxyGroups = [
        {
            name: 'V2V-Auto',
            type: 'url-test',
            url: 'http://www.gstatic.com/generate_204',
            interval: 300,
            tolerance: 50,
            proxies: proxyNames
        },
        {
            name: 'V2V-Select',
            type: 'select',
            proxies: ['V2V-Auto', ...proxyNames]
        }
    ];

    const payload = {
        proxies,
        'proxy-groups': proxyGroups,
        rules: [
            'DOMAIN-SUFFIX,local,DIRECT',
            'IP-CIDR,127.0.0.0/8,DIRECT',
            'IP-CIDR,172.16.0.0/12,DIRECT',
            'IP-CIDR,192.168.0.0/16,DIRECT',
            'IP-CIDR,10.0.0.0/8,DIRECT',
            'GEOIP,IR,DIRECT',
            'MATCH,V2V-Select'
        ]
    };

    try {
        return YAML.dump(payload, { skipInvalid: true, flowLevel: -1 }); 
    } catch (e) {
        console.error("YAML generation error:", e.message);
        return null;
    }
}

function generateSingboxJson(configs, targetCore) {
    const outbounds = [];
    const allowedProtocols = targetCore === 'xray' ? XRAY_PROTOCOLS : SINGBOX_PROTOCOLS;

    for (const url of configs) {
        const config = parseConfigUrl(url);
        
        if (!config || !allowedProtocols.includes(config.protocol)) continue;

        let outbound = {
            tag: config.name,
            type: config.protocol === 'hy2' ? 'hysteria2' : config.protocol,
            server: config.server,
            server_port: config.port
        };
        
        if (config.tls) {
            outbound.tls = {
                enabled: true,
                server_name: config.sni || config.server,
                insecure: true
            };
        }

        if (config.protocol === 'vmess') {
            Object.assign(outbound, {
                uuid: config.uuid,
                alter_id: config.alterId,
                security: config.cipher
            });
            
            if (config.network === 'ws') {
                outbound.transport = {
                    type: 'ws',
                    path: config.wsPath,
                    headers: config.wsHeaders
                };
            }
        } else if (config.protocol === 'vless') {
            Object.assign(outbound, {
                uuid: config.uuid,
                flow: config.flow,
                packet_encoding: 'xudp'
            });
            
            if (config.network === 'ws') {
                outbound.transport = {
                    type: 'ws',
                    path: config.wsPath,
                    headers: config.wsHeaders
                };
            }
        } else if (config.protocol === 'trojan') {
            Object.assign(outbound, {
                password: config.password
            });
        } else if (config.protocol === 'ss') {
            Object.assign(outbound, {
                method: config.cipher,
                password: config.password
            });
        } else if (config.protocol === 'hy2') {
            Object.assign(outbound, {
                type: 'hysteria2',
                password: config.password,
                up_mbps: 100,
                down_mbps: 100
            });
        } else if (config.protocol === 'tuic') {
            Object.assign(outbound, {
                uuid: config.uuid,
                password: config.password,
                congestion_control: 'cubic',
                udp_relay_mode: 'native'
            });
        }
        
        outbounds.push(outbound);
    }
    
    if (outbounds.length === 0) return null;
    
    const payload = {
        log: {
            disabled: false,
            level: "info"
        },
        dns: {
            servers: [
                {
                    address: "8.8.8.8",
                    strategy: "prefer_ipv4"
                }
            ]
        },
        inbounds: [
            {
                type: "mixed",
                listen: "127.0.0.1",
                listen_port: 7890
            }
        ],
        outbounds: [
            {
                tag: "V2V-Select",
                type: "urltest",
                outbounds: outbounds.map(o => o.tag),
                url: "http://www.gstatic.com/generate_204",
                interval: "5m"
            },
            ...outbounds,
            {
                tag: "direct",
                type: "direct"
            }
        ],
        route: {
            rules: [
                {
                    geoip: "ir",
                    outbound: "direct"
                },
                {
                    geoip: "private",
                    outbound: "direct"
                }
            ],
            auto_detect_interface: true
        }
    };
    
    return JSON.stringify(payload, null, 2);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const corsHeaders = generateCorsHeaders(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // تست پینگ واقعی با اتصال TCP
            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port, tls, sni } = await request.json();
                
                if (!host || !port) {
                    return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                }

                try {
                    const startTime = Date.now();
                    const timeoutMs = 8000;
                    
                    const socketOptions = { 
                        hostname: host, 
                        port: parseInt(port) 
                    };
                    
                    if (tls) {
                        socketOptions.secureTransport = 'on';
                        socketOptions.servername = sni || host;
                    }
                    
                    const socket = connect(socketOptions);
                    
                    // منتظر باز شدن کانکشن
                    await Promise.race([
                        socket.opened,
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Connection timeout')), timeoutMs)
                        )
                    ]);
                    
                    const latency = Date.now() - startTime;
                    await socket.close();
                    
                    if (latency > 0 && latency < timeoutMs) {
                        return jsonResponse({ 
                            latency: latency, 
                            status: 'Live' 
                        }, 200, corsHeaders);
                    } else {
                        return jsonResponse({ 
                            latency: null, 
                            status: 'Dead', 
                            error: 'Invalid latency' 
                        }, 200, corsHeaders);
                    }
                    
                } catch (error) {
                    return jsonResponse({ 
                        latency: null, 
                        status: 'Dead', 
                        error: error.message 
                    }, 200, corsHeaders);
                }
            }

            // ایجاد subscription شخصی
            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid, core: targetCore } = await request.json(); 
                
                if (!Array.isArray(configs) || configs.length === 0) {
                    return jsonResponse({ error: 'configs array is required and must not be empty' }, 400, corsHeaders);
                }
                
                const validatedConfigs = configs.filter(c => parseConfigUrl(c) !== null);
                
                if (validatedConfigs.length === 0) {
                    return jsonResponse({ error: 'No valid configs found' }, 400, corsHeaders);
                }

                const userUuid = clientUuid || uuidv4();
                
                try {
                    await env.v2v_kv.put(
                        `sub:${userUuid}`, 
                        JSON.stringify({ 
                            configs: validatedConfigs, 
                            core: targetCore || 'xray',
                            created: Date.now()
                        }), 
                        { expirationTtl: TTL_USER_SUBSCRIPTION_STORE }
                    );
                } catch (e) {
                    return jsonResponse({ error: 'Storage error: ' + e.message }, 500, corsHeaders);
                }
                
                // URL های کوتاه با امضای v2v
                return jsonResponse({ 
                    uuid: userUuid, 
                    clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, 
                    singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` 
                }, 200, corsHeaders);
            }
            
            // سرویس subscription URLs
            const subMatch = url.pathname.match(/^\/sub\/(clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1];
                const uuid = subMatch[2];
                
                let storedData;
                try {
                    storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                } catch (e) {
                    return textResponse('Storage read error: ' + e.message, 500, null, corsHeaders);
                }

                if (!storedData || !Array.isArray(storedData.configs)) {
                    return textResponse('Subscription not found or expired', 404, null, corsHeaders);
                }
                
                // تمدید TTL
                await env.v2v_kv.put(`sub:${uuid}`, JSON.stringify(storedData), { 
                    expirationTtl: TTL_USER_SUBSCRIPTION_STORE 
                });
                
                const configs = storedData.configs;
                const targetCore = storedData.core || 'xray';
                
                if (format === 'clash') {
                    const content = generateClashYaml(configs, targetCore);
                    return content ? 
                        yamlResponse(content, 200, `v2v-clash-${uuid}.yaml`, corsHeaders) : 
                        textResponse('Failed to generate Clash config', 500, null, corsHeaders);
                }
                
                if (format === 'singbox') {
                    const content = generateSingboxJson(configs, targetCore);
                    return content ? 
                        jsonResponse(JSON.parse(content), 200, corsHeaders) : 
                        textResponse('Failed to generate Sing-box config', 500, null, corsHeaders);
                }
            }
            
            return textResponse('V2V Worker is running successfully', 200, null, corsHeaders);
            
        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ 
                error: 'Internal server error', 
                details: err.message 
            }, 500, corsHeaders);
        }
    },
};