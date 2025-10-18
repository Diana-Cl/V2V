import { connect } from 'cloudflare:sockets';

const TTL = 120 * 24 * 60 * 60;
const ORIGINS = ['https://smbcryp.github.io', 'https://v2v-vercel.vercel.app', 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir'];

const cors = (o) => ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (d, s, h) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
const text = (t, c, h, f) => new Response(t, { status: 200, headers: { 'Content-Type': `${c}; charset=utf-8`, ...(f ? { 'Content-Disposition': `attachment; filename="${f}"` } : {}), ...h } });

const uid = (p, s, i) => {
  const h = (s + i).split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
  return `${p}-${Math.abs(h).toString(36).slice(0, 6)}`;
};

// Fixed base64 encoding to handle UTF-8 properly
const b64e = (str) => {
  try {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return btoa(unescape(encodeURIComponent(str)));
  }
};

const b64d = (s) => { 
  try { 
    return atob(s.replace(/-/g, '+').replace(/_/g, '/')); 
  } catch { 
    return null; 
  } 
};

const parseVmess = (cfg) => {
  try {
    if (!cfg?.startsWith('vmess://')) return null;
    const d = b64d(cfg.slice(8));
    if (!d) return null;
    const j = JSON.parse(d);
    if (!j.add || !j.port || !j.id) return null;
    return {
      s: j.add,
      p: parseInt(j.port),
      u: j.id,
      a: parseInt(j.aid) || 0,
      c: j.scy || 'auto',
      n: j.net || 'tcp',
      t: j.tls === 'tls',
      sni: j.sni || j.host || j.add,
      path: j.path || '/',
      host: j.host || j.add
    };
  } catch { return null; }
};

const parseVless = (cfg) => {
  try {
    if (!cfg?.startsWith('vless://')) return null;
    const u = new URL(cfg);
    if (!u.hostname || !u.port || !u.username) return null;
    const q = new URLSearchParams(u.search);
    return {
      s: u.hostname,
      p: parseInt(u.port),
      u: u.username,
      n: q.get('type') || 'tcp',
      t: q.get('security') === 'tls',
      sni: q.get('sni') || u.hostname,
      path: q.get('path') || '/',
      host: q.get('host') || u.hostname,
      flow: q.get('flow') || ''
    };
  } catch { return null; }
};

const parseTrojan = (cfg) => {
  try {
    if (!cfg?.startsWith('trojan://')) return null;
    const u = new URL(cfg);
    if (!u.hostname || !u.port || !u.username) return null;
    const q = new URLSearchParams(u.search);
    return {
      s: u.hostname,
      p: parseInt(u.port),
      pw: decodeURIComponent(u.username),
      sni: q.get('sni') || u.hostname
    };
  } catch { return null; }
};

const parseSs = (cfg) => {
  try {
    if (!cfg?.startsWith('ss://')) return null;
    const u = new URL(cfg);
    if (!u.hostname || !u.port || !u.username) return null;
    const d = b64d(u.username);
    if (!d || !d.includes(':')) return null;
    const i = d.indexOf(':');
    return {
      s: u.hostname,
      p: parseInt(u.port),
      m: d.slice(0, i),
      pw: d.slice(i + 1)
    };
  } catch { return null; }
};

// Sanitize string for YAML - removes non-printable characters
const sanitize = (str) => {
  if (!str) return '';
  return String(str).replace(/[^\x20-\x7E]/g, '').trim();
};

const genXraySubscription = (cfgs) => {
  const valid = [];
  const seen = new Set();
  
  for (const cfg of cfgs) {
    try {
      const u = new URL(cfg);
      const k = `${u.protocol}//${u.hostname}:${u.port}:${u.username}`;
      if (!seen.has(k) && ['vmess:', 'vless:', 'trojan:', 'ss:'].includes(u.protocol)) {
        seen.add(k);
        valid.push(cfg);
      }
    } catch {}
  }
  
  return b64e(valid.join('\n'));
};

const genClashForXray = (cfgs) => {
  const prx = [];
  const seen = new Set();
  
  for (let i = 0; i < cfgs.length; i++) {
    try {
      let p = null;
      let k = null;
      
      if (cfgs[i].startsWith('vmess://')) {
        const v = parseVmess(cfgs[i]);
        if (!v) continue;
        k = `vm${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('vm', v.s, i),
          type: 'vmess',
          server: sanitize(v.s),
          port: v.p,
          uuid: sanitize(v.u),
          alterId: v.a,
          cipher: sanitize(v.c),
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { 
            path: sanitize(v.path), 
            headers: { Host: sanitize(v.host) } 
          };
        }
        if (v.t) {
          p.tls = true;
          p.servername = sanitize(v.sni);
        }
      } else if (cfgs[i].startsWith('vless://')) {
        const v = parseVless(cfgs[i]);
        if (!v) continue;
        k = `vl${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('vl', v.s, i),
          type: 'vless',
          server: sanitize(v.s),
          port: v.p,
          uuid: sanitize(v.u),
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { 
            path: sanitize(v.path), 
            headers: { Host: sanitize(v.host) } 
          };
        }
        if (v.t) {
          p.tls = true;
          p.servername = sanitize(v.sni);
          if (v.flow) p.flow = sanitize(v.flow);
        }
      } else if (cfgs[i].startsWith('trojan://')) {
        const v = parseTrojan(cfgs[i]);
        if (!v) continue;
        k = `tr${v.s}${v.p}${v.pw}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('tr', v.s, i),
          type: 'trojan',
          server: sanitize(v.s),
          port: v.p,
          password: sanitize(v.pw),
          udp: true,
          sni: sanitize(v.sni),
          'skip-cert-verify': true
        };
      } else if (cfgs[i].startsWith('ss://')) {
        const v = parseSs(cfgs[i]);
        if (!v) continue;
        k = `ss${v.s}${v.p}${v.m}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('ss', v.s, i),
          type: 'ss',
          server: sanitize(v.s),
          port: v.p,
          cipher: sanitize(v.m),
          password: sanitize(v.pw),
          udp: true
        };
      }
      
      if (p && k) {
        seen.add(k);
        prx.push(p);
      }
    } catch {}
  }
  
  if (!prx.length) return null;
  
  const n = prx.map(x => x.name);
  
  let y = '# Clash Meta Config for Xray\n';
  y += '# Generated by V2V\n\n';
  y += 'port: 7890\n';
  y += 'socks-port: 7891\n';
  y += 'allow-lan: true\n';
  y += 'mode: rule\n';
  y += 'log-level: info\n\n';
  y += 'external-controller: 127.0.0.1:9090\n\n';
  y += 'dns:\n';
  y += '  enable: true\n';
  y += '  listen: 0.0.0.0:53\n';
  y += '  enhanced-mode: fake-ip\n';
  y += '  fake-ip-range: 198.18.0.1/16\n';
  y += '  nameserver:\n';
  y += '    - 8.8.8.8\n';
  y += '    - 1.1.1.1\n\n';
  y += 'proxies:\n';
  
  for (const x of prx) {
    y += `  - name: "${x.name}"\n`;
    y += `    type: ${x.type}\n`;
    y += `    server: ${x.server}\n`;
    y += `    port: ${x.port}\n`;
    
    if (x.type === 'vmess') {
      y += `    uuid: ${x.uuid}\n`;
      y += `    alterId: ${x.alterId}\n`;
      y += `    cipher: ${x.cipher}\n`;
      y += `    udp: true\n`;
      if (x.network) {
        y += `    network: ${x.network}\n`;
        if (x['ws-opts']) {
          y += `    ws-opts:\n      path: "${x['ws-opts'].path}"\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
        }
      }
      if (x.tls) {
        y += `    tls: true\n    servername: ${x.servername}\n`;
      }
      y += `    skip-cert-verify: true\n`;
    } else if (x.type === 'vless') {
      y += `    uuid: ${x.uuid}\n    udp: true\n`;
      if (x.network) {
        y += `    network: ${x.network}\n`;
        if (x['ws-opts']) {
          y += `    ws-opts:\n      path: "${x['ws-opts'].path}"\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
        }
      }
      if (x.tls) {
        y += `    tls: true\n    servername: ${x.servername}\n`;
        if (x.flow) y += `    flow: ${x.flow}\n`;
      }
      y += `    skip-cert-verify: true\n`;
    } else if (x.type === 'trojan') {
      y += `    password: ${x.password}\n    udp: true\n    sni: ${x.sni}\n    skip-cert-verify: true\n`;
    } else if (x.type === 'ss') {
      y += `    cipher: ${x.cipher}\n    password: ${x.password}\n    udp: true\n`;
    }
  }
  
  y += '\nproxy-groups:\n';
  y += '  - name: "AUTO"\n    type: url-test\n    proxies:\n';
  for (const name of n) y += `      - "${name}"\n`;
  y += '    url: http://www.gstatic.com/generate_204\n    interval: 300\n\n';
  y += '  - name: "SELECT"\n    type: select\n    proxies:\n      - AUTO\n';
  for (const name of n) y += `      - "${name}"\n`;
  y += '\nrules:\n  - GEOIP,IR,DIRECT\n  - MATCH,SELECT\n';
  
  return y;
};

const genSingboxSubscription = (cfgs) => {
  const out = [];
  const seen = new Set();
  
  for (let i = 0; i < cfgs.length; i++) {
    try {
      let o = null;
      let k = null;
      
      if (cfgs[i].startsWith('vmess://')) {
        const v = parseVmess(cfgs[i]);
        if (!v) continue;
        k = `vm${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('vm', v.s, i),
          type: 'vmess',
          server: sanitize(v.s),
          server_port: v.p,
          uuid: sanitize(v.u),
          alter_id: v.a,
          security: sanitize(v.c)
        };
        if (v.n === 'ws') {
          o.transport = { 
            type: 'ws', 
            path: sanitize(v.path), 
            headers: { Host: sanitize(v.host) } 
          };
        }
        if (v.t) {
          o.tls = { enabled: true, server_name: sanitize(v.sni), insecure: true };
        }
      } else if (cfgs[i].startsWith('vless://')) {
        const v = parseVless(cfgs[i]);
        if (!v) continue;
        k = `vl${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('vl', v.s, i),
          type: 'vless',
          server: sanitize(v.s),
          server_port: v.p,
          uuid: sanitize(v.u)
        };
        if (v.n === 'ws') {
          o.transport = { 
            type: 'ws', 
            path: sanitize(v.path), 
            headers: { Host: sanitize(v.host) } 
          };
        }
        if (v.t) {
          o.tls = { enabled: true, server_name: sanitize(v.sni), insecure: true };
          if (v.flow) o.flow = sanitize(v.flow);
        }
      } else if (cfgs[i].startsWith('trojan://')) {
        const v = parseTrojan(cfgs[i]);
        if (!v) continue;
        k = `tr${v.s}${v.p}${v.pw}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('tr', v.s, i),
          type: 'trojan',
          server: sanitize(v.s),
          server_port: v.p,
          password: sanitize(v.pw),
          tls: { enabled: true, server_name: sanitize(v.sni), insecure: true }
        };
      } else if (cfgs[i].startsWith('ss://')) {
        const v = parseSs(cfgs[i]);
        if (!v) continue;
        k = `ss${v.s}${v.p}${v.m}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('ss', v.s, i),
          type: 'shadowsocks',
          server: sanitize(v.s),
          server_port: v.p,
          method: sanitize(v.m),
          password: sanitize(v.pw)
        };
      } else if (cfgs[i].startsWith('hysteria2://') || cfgs[i].startsWith('hy2://')) {
        try {
          const u = new URL(cfgs[i]);
          if (!u.hostname || !u.port) continue;
          const q = new URLSearchParams(u.search);
          k = `hy2${u.hostname}${u.port}`;
          if (seen.has(k)) continue;
          o = {
            tag: uid('hy2', u.hostname, i),
            type: 'hysteria2',
            server: sanitize(u.hostname),
            server_port: parseInt(u.port),
            password: sanitize(u.username || q.get('password') || q.get('auth') || ''),
            tls: { enabled: true, server_name: sanitize(q.get('sni') || u.hostname), insecure: true }
          };
          if (q.get('obfs')) {
            o.obfs = { type: q.get('obfs'), password: sanitize(q.get('obfs-password') || '') };
          }
        } catch {}
      } else if (cfgs[i].startsWith('tuic://')) {
        try {
          const u = new URL(cfgs[i]);
          if (!u.hostname || !u.port) continue;
          const q = new URLSearchParams(u.search);
          let uuid = u.username;
          let password = '';
          if (uuid && uuid.includes(':')) {
            [uuid, password] = uuid.split(':', 2);
          }
          if (!uuid) uuid = q.get('uuid') || q.get('user') || '';
          if (!password) password = q.get('password') || q.get('pass') || '';
          if (!uuid && !password) continue;
          k = `tuic${u.hostname}${u.port}${uuid}`;
          if (seen.has(k)) continue;
          o = {
            tag: uid('tuic', u.hostname, i),
            type: 'tuic',
            server: sanitize(u.hostname),
            server_port: parseInt(u.port),
            uuid: sanitize(uuid),
            password: sanitize(password),
            congestion_control: q.get('congestion_control') || 'bbr',
            udp_relay_mode: q.get('udp_relay_mode') || 'native',
            tls: { 
              enabled: true, 
              server_name: sanitize(q.get('sni') || u.hostname), 
              insecure: true, 
              alpn: [q.get('alpn') || 'h3'] 
            }
          };
        } catch {}
      }
      
      if (o && k) {
        seen.add(k);
        out.push(o);
      }
    } catch {}
  }
  
  if (!out.length) return null;
  
  return JSON.stringify({
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'google', address: '8.8.8.8', strategy: 'prefer_ipv4' },
        { tag: 'local', address: 'local', detour: 'direct' }
      ],
      rules: [{ geosite: 'ir', server: 'local' }],
      final: 'google'
    },
    inbounds: [
      { tag: 'mixed-in', type: 'mixed', listen: '127.0.0.1', listen_port: 7890 }
    ],
    outbounds: [
      {
        tag: 'AUTO',
        type: 'urltest',
        outbounds: out.map(x => x.tag),
        url: 'http://www.gstatic.com/generate_204',
        interval: '5m',
        tolerance: 50
      },
      {
        tag: 'SELECT',
        type: 'selector',
        outbounds: ['AUTO', ...out.map(x => x.tag)],
        default: 'AUTO'
      },
      ...out,
      { tag: 'direct', type: 'direct' },
      { tag: 'block', type: 'block' }
    ],
    route: {
      rules: [
        { geoip: 'ir', outbound: 'direct' },
        { geoip: 'private', outbound: 'direct' },
        { geosite: 'category-ads-all', outbound: 'block' }
      ],
      final: 'SELECT',
      auto_detect_interface: true
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: { external_controller: '127.0.0.1:9090' }
    }
  }, null, 2);
};

const genClashForSingbox = (cfgs) => {
  return genClashForXray(cfgs)?.replace('Xray', 'Singbox');
};

const testConn = async (h, p) => {
  try {
    const t = Date.now();
    const s = connect({ hostname: h, port: parseInt(p) });
    await Promise.race([s.opened, new Promise((_, r) => setTimeout(r, 5000))]);
    const l = Date.now() - t;
    try { await s.close(); } catch {}
    return { latency: l, status: 'Live' };
  } catch { return { latency: null, status: 'Dead' }; }
};

const genId = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const o = req.headers.get('Origin');
    const h = cors(o);
    
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    
    try {
      if (u.pathname === '/' && req.method === 'GET') {
        return json({ 
          status: 'V2V Pro v10 - Fixed',
          endpoints: {
            xray: '/sub/xray/{id}',
            'xray-clash': '/sub/xray-clash/{id}',
            singbox: '/sub/singbox/{id}',
            'singbox-clash': '/sub/singbox-clash/{id}'
          }
        }, 200, h);
      }
      
      if (u.pathname === '/ping' && req.method === 'POST') {
        const { host, port } = await req.json();
        if (!host || !port) return json({ error: 'Missing params' }, 400, h);
        const r = await testConn(host, port);
        return json(r, 200, h);
      }
      
      if (u.pathname === '/create-sub' && req.method === 'POST') {
        const { configs, format } = await req.json();
        
        if (!Array.isArray(configs) || !configs.length) {
          return json({ error: 'Invalid configs' }, 400, h);
        }
        
        const validFormats = ['xray', 'xray-clash', 'singbox', 'singbox-clash'];
        if (!validFormats.includes(format)) {
          return json({ error: `Invalid format. Must be: ${validFormats.join(', ')}` }, 400, h);
        }
        
        const id = genId();
        await env.v2v_kv.put(
          `sub:${id}`, 
          JSON.stringify({ configs, format, created: Date.now() }), 
          { expirationTtl: TTL }
        );
        
        return json({ 
          success: true, 
          id, 
          url: `${u.origin}/sub/${format}/${id}`,
          info: `Created ${format} subscription`
        }, 200, h);
      }
      
      const m = u.pathname.match(/^\/sub\/(xray|xray-clash|singbox|singbox-clash)\/([a-z0-9]{8})$/);
      if (m && req.method === 'GET') {
        const [, fmt, id] = m;
        const d = await env.v2v_kv.get(`sub:${id}`, { type: 'json' });
        
        if (!d?.configs) {
          return new Response('Subscription not found or expired', { status: 404, headers: h });
        }
        
        const { configs } = d;
        
        if (fmt === 'xray') {
          const content = genXraySubscription(configs);
          return text(content, 'text/plain', h, 'V2V-Xray.txt');
        }
        
        if (fmt === 'xray-clash') {
          const content = genClashForXray(configs);
          if (!content) return json({ error: 'No valid configs' }, 500, h);
          return text(content, 'text/yaml', h, 'V2V-Xray-Clash.yaml');
        }
        
        if (fmt === 'singbox') {
          const content = genSingboxSubscription(configs);
          if (!content) return json({ error: 'No valid configs' }, 500, h);
          return text(content, 'application/json', h, 'V2V-Singbox.json');
        }
        
        if (fmt === 'singbox-clash') {
          const content = genClashForSingbox(configs);
          if (!content) return json({ error: 'No valid configs' }, 500, h);
          return text(content, 'text/yaml', h, 'V2V-Singbox-Clash.yaml');
        }
      }
      
      return new Response('Not Found', { status: 404, headers: h });
      
    } catch (e) {
      console.error('Worker error:', e);
      return json({ error: e.message, stack: e.stack }, 500, h);
    }
  }
};