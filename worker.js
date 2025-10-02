import { v4 as uuidv4 } from 'uuid';
import YAML from 'js-yaml'; 
import { connect } from 'cloudflare:sockets';

const TTL_USER_SUBSCRIPTION_STORE = 60 * 60 * 24 * 3;
const ALLOWED_ORIGINS = [
    'https://smbcryp.github.io',
    'https://v2v-vercel.vercel.app',
    'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir',
];

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

function parseConfigUrl(config) {
    try {
        const urlObj = new URL(config);
        let protocol = urlObj.protocol.replace(':', '');
        const params = new URLSearchParams(urlObj.search);
        
        let cfg = {
            protocol,
            server: urlObj.hostname,
            port: parseInt(urlObj.port),
            name: decodeURIComponent(urlObj.hash.substring(1) || `v2v-${protocol}-${urlObj.hostname}`)
        };
        
        if (protocol === 'shadowsocks') cfg.protocol = 'ss';
        if (protocol === 'hysteria2') cfg.protocol = 'hy2';

        if (cfg.protocol === 'vmess') {
            try {
                const vmessData = config.replace('vmess://', '');
                const decodedData = JSON.parse(atob(vmessData));
                cfg.server = decodedData.add;
                cfg.port = parseInt(decodedData.port);
                cfg.uuid = decodedData.id;
                cfg.alterId = parseInt(decodedData.aid) || 0;
                cfg.cipher = decodedData.scy || 'auto'; 
                cfg.network = decodedData.net || 'tcp';
                cfg.name = decodedData.ps || `v2v-vmess-${cfg.server}`;
                
                if (decodedData.net === 'ws') {
                    cfg.wsPath = decodedData.path || '/';
                    cfg.wsHeaders = { Host: decodedData.host || decodedData.add };
                }
                if (decodedData.tls === 'tls') {
                    cfg.tls = true;
                    cfg.sni = decodedData.sni || decodedData.host || decodedData.add;
                }
            } catch (e) { 
                return null; 
            }
        } else if (cfg.protocol === 'vless') {
            cfg.uuid = urlObj.username;
            cfg.encryption = params.get('encryption') || 'none';
            cfg.flow = params.get('flow') || '';
            cfg.network = params.get('type') || 'tcp';
            
            if (cfg.network === 'ws') {
                cfg.wsPath = params.get('path') || '/';
                cfg.wsHeaders = { Host: params.get('host') || urlObj.hostname };
            }
            if (params.get('security') === 'tls') {
                cfg.tls = true;
                cfg.sni = params.get('sni') || urlObj.hostname;
            }
        } else if (cfg.protocol === 'trojan') {
            cfg.password = urlObj.username;
            cfg.tls = true;
            cfg.sni = params.get('sni') || urlObj.hostname;
        } else if (cfg.protocol === 'ss') {
            try {
                const decoded = atob(urlObj.username);
                if (decoded.includes(':')) {
                    const [method, password] = decoded.split(':', 2);
                    cfg.cipher = method;
                    cfg.password = password;
                } else {
                    return null;
                }
            } catch (e) { 
                return null; 
            }
        } else if (cfg.protocol === 'hy2') {
            cfg.password = urlObj.username;
            cfg.tls = true;
            cfg.sni = params.get('sni') || urlObj.hostname;
        } else if (cfg.protocol === 'tuic') {
            cfg.uuid = urlObj.username;
            cfg.password = params.get('password') || '';
            cfg.tls = true;
            cfg.sni = params.get('sni') || urlObj.hostname;
        } else {
            return null;
        }

        return cfg;
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

async function deepPingTest(host, port, tls, sni) {
    const maxAttempts = 3;
    const latencies = [];
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const startTime = Date.now();
            const timeoutMs = 7000;
            
            const socketOptions = { 
                hostname: host, 
                port: parseInt(port) 
            };
            
            if (tls) {
                socketOptions.secureTransport = 'on';
                socketOptions.servername = sni || host;
                socketOptions.allowHalfOpen = false;
            }
            
            const socket = connect(socketOptions);
            
            await Promise.race([
                (async () => {
                    await socket.opened;
                    
                    const writer = socket.writable.getWriter();
                    const testData = new Uint8Array([0x00, 0x01, 0x02]);
                    await writer.write(testData);
                    writer.releaseLock();
                    
                    const reader = socket.readable.getReader();
                    const readPromise = reader.read();
                    await Promise.race([
                        readPromise,
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Read timeout')), 2000)
                        )
                    ]);
                    reader.releaseLock();
                })(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), timeoutMs)
                )
            ]);
            
            const latency = Date.now() - startTime;
            await socket.close();
            
            if (latency > 0 && latency < timeoutMs) {
                latencies.push(latency);
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            continue;
        }
    }
    
    if (latencies.length === 0) {
        return { latency: null, status: 'Dead', error: 'All attempts failed' };
    }
    
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    
    return { 
        latency: avgLatency,
        status: 'Live'
    };
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
            if (url.pathname === '/ping' && request.method === 'POST') {
                const { host, port, tls, sni } = await request.json();
                
                if (!host || !port) {
                    return jsonResponse({ error: 'Invalid host or port' }, 400, corsHeaders);
                }

                const result = await deepPingTest(host, port, tls, sni);
                return jsonResponse(result, 200, corsHeaders);
            }

            if (url.pathname === '/create-personal-sub' && request.method === 'POST') {
                const { configs, uuid: clientUuid, core: targetCore } = await request.json(); 
                
                if (!Array.isArray(configs) || configs.length === 0) {
                    return jsonResponse({ error: 'configs array is required' }, 400, corsHeaders);
                }
                
                const validatedConfigs = configs.filter(c => parseConfigUrl(c) !== null);
                
                if (validatedConfigs.length === 0) {
                    return jsonResponse({ error: 'No valid configs' }, 400, corsHeaders);
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
                    return jsonResponse({ error: 'Storage error' }, 500, corsHeaders);
                }
                
                return jsonResponse({ 
                    uuid: userUuid, 
                    clashSubscriptionUrl: `${url.origin}/sub/clash/${userUuid}`, 
                    singboxSubscriptionUrl: `${url.origin}/sub/singbox/${userUuid}` 
                }, 200, corsHeaders);
            }
            
            const subMatch = url.pathname.match(/^\/sub\/(clash|singbox)\/([^/]+)/);
            if (subMatch) {
                const format = subMatch[1];
                const uuid = subMatch[2];
                
                let storedData;
                try {
                    storedData = await env.v2v_kv.get(`sub:${uuid}`, { type: 'json' });
                } catch (e) {
                    return textResponse('Storage error', 500, null, corsHeaders);
                }

                if (!storedData || !Array.isArray(storedData.configs)) {
                    return textResponse('Subscription not found', 404, null, corsHeaders);
                }
                
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
            
            return textResponse('V2V Worker Active', 200, null, corsHeaders);
            
        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ 
                error: 'Internal error', 
                details: err.message 
            }, 500, corsHeaders);
        }
    },
};