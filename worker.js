import { connect } from 'cloudflare:sockets';

const TTL = 120 * 24 * 60 * 60; // 120 days
const ORIGINS = ['https://smbcryp.github.io', 'https://v2v-vercel.vercel.app', 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir'];

const cors = (o) => ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' } : { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (d, s, h) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
const text = (t, c, h, f) => new Response(t, { status: 200, headers: { 'Content-Type': `${c}; charset=utf-8`, ...(f ? { 'Content-Disposition': `attachment; filename="${f}"` } : {}), ...h } });

const uid = (p, s, i) => {
  const h = (s + i).split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
  return `${p}-${Math.abs(h).toString(36).slice(0, 8)}`;
};

const b64d = (s) => { try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; } };
const b64e = (s) => btoa(s);

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
      pw: u.username,
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

// ============ XRAY SUBSCRIPTION (Raw Configs) ============
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

// ============ CLASH FOR XRAY (Meta Compatible) ============
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
          server: v.s,
          port: v.p,
          uuid: v.u,
          alterId: v.a,
          cipher: v.c,
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          p.tls = true;
          p.servername = v.sni;
        }
      } else if (cfgs[i].startsWith('vless://')) {
        const v = parseVless(cfgs[i]);
        if (!v) continue;
        k = `vl${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('vl', v.s, i),
          type: 'vless',
          server: v.s,
          port: v.p,
          uuid: v.u,
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          p.tls = true;
          p.servername = v.sni;
          if (v.flow) p.flow = v.flow;
        }
      } else if (cfgs[i].startsWith('trojan://')) {
        const v = parseTrojan(cfgs[i]);
        if (!v) continue;
        k = `tr${v.s}${v.p}${v.pw}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('tr', v.s, i),
          type: 'trojan',
          server: v.s,
          port: v.p,
          password: v.pw,
          udp: true,
          sni: v.sni,
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
          server: v.s,
          port: v.p,
          cipher: v.m,
          password: v.pw,
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
  
  // Clash Meta for Xray with proper structure
  let y = '# ============================================\n';
  y += '# Clash Meta Config for Xray Core\n';
  y += '# Generated by V2V - github.com/smbcryp/V2V\n';
  y += '# Expiry: 120 days from creation\n';
  y += '# ============================================\n\n';
  y += 'port: 7890\n';
  y += 'socks-port: 7891\n';
  y += 'allow-lan: true\n';
  y += 'mode: rule\n';
  y += 'log-level: info\n\n';
  y += 'external-controller: 127.0.0.1:9090\n';
  y += 'secret: ""\n\n';
  y += 'dns:\n';
  y += '  enable: true\n';
  y += '  listen: 0.0.0.0:53\n';
  y += '  enhanced-mode: fake-ip\n';
  y += '  fake-ip-range: 198.18.0.1/16\n';
  y += '  nameserver:\n';
  y += '    - 8.8.8.8\n';
  y += '    - 1.1.1.1\n';
  y += '  fallback:\n';
  y += '    - https://dns.google/dns-query\n\n';
  y += 'proxies:\n';
  
  for (const x of prx) {
    y += `  - name: ${x.name}\n`;
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
          y += `    ws-opts:\n      path: ${x['ws-opts'].path}\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
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
          y += `    ws-opts:\n      path: ${x['ws-opts'].path}\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
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
  y += '  - name: "🚀 Xray-Auto"\n    type: url-test\n    proxies:\n';
  for (const name of n) y += `      - ${name}\n`;
  y += '    url: http://www.gstatic.com/generate_204\n    interval: 300\n    tolerance: 50\n\n';
  y += '  - name: "🎯 Xray-Select"\n    type: select\n    proxies:\n      - 🚀 Xray-Auto\n';
  for (const name of n) y += `      - ${name}\n`;
  y += '\nrules:\n  - GEOIP,IR,DIRECT\n  - MATCH,🎯 Xray-Select\n';
  
  return y;
};

// ============ SINGBOX SUBSCRIPTION (JSON) ============
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
          server: v.s,
          server_port: v.p,
          uuid: v.u,
          alter_id: v.a,
          security: v.c
        };
        if (v.n === 'ws') {
          o.transport = { type: 'ws', path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          o.tls = { enabled: true, server_name: v.sni, insecure: true };
        }
      } else if (cfgs[i].startsWith('vless://')) {
        const v = parseVless(cfgs[i]);
        if (!v) continue;
        k = `vl${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('vl', v.s, i),
          type: 'vless',
          server: v.s,
          server_port: v.p,
          uuid: v.u
        };
        if (v.n === 'ws') {
          o.transport = { type: 'ws', path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          o.tls = { enabled: true, server_name: v.sni, insecure: true };
          if (v.flow) o.flow = v.flow;
        }
      } else if (cfgs[i].startsWith('trojan://')) {
        const v = parseTrojan(cfgs[i]);
        if (!v) continue;
        k = `tr${v.s}${v.p}${v.pw}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('tr', v.s, i),
          type: 'trojan',
          server: v.s,
          server_port: v.p,
          password: v.pw,
          tls: { enabled: true, server_name: v.sni, insecure: true }
        };
      } else if (cfgs[i].startsWith('ss://')) {
        const v = parseSs(cfgs[i]);
        if (!v) continue;
        k = `ss${v.s}${v.p}${v.m}`;
        if (seen.has(k)) continue;
        o = {
          tag: uid('ss', v.s, i),
          type: 'shadowsocks',
          server: v.s,
          server_port: v.p,
          method: v.m,
          password: v.pw
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
            server: u.hostname,
            server_port: parseInt(u.port),
            password: u.username || q.get('password') || q.get('auth') || '',
            tls: { enabled: true, server_name: q.get('sni') || u.hostname, insecure: true }
          };
          if (q.get('obfs')) {
            o.obfs = { type: q.get('obfs'), password: q.get('obfs-password') || '' };
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
            server: u.hostname,
            server_port: parseInt(u.port),
            uuid: uuid,
            password: password,
            congestion_control: q.get('congestion_control') || 'bbr',
            udp_relay_mode: q.get('udp_relay_mode') || 'native',
            tls: { 
              enabled: true, 
              server_name: q.get('sni') || u.hostname, 
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
        tag: '🚀 Singbox-Auto',
        type: 'urltest',
        outbounds: out.map(x => x.tag),
        url: 'http://www.gstatic.com/generate_204',
        interval: '5m',
        tolerance: 50
      },
      {
        tag: '🎯 Singbox-Select',
        type: 'selector',
        outbounds: ['🚀 Singbox-Auto', ...out.map(x => x.tag)],
        default: '🚀 Singbox-Auto'
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
      final: '🎯 Singbox-Select',
      auto_detect_interface: true
    },
    experimental: {
      cache_file: { enabled: true },
      clash_api: { external_controller: '127.0.0.1:9090' }
    }
  }, null, 2);
};

// ============ CLASH FOR SINGBOX (Full Structure) ============
const genClashForSingbox = (cfgs) => {
  const prx = [];
  const seen = new Set();
  
  for (let i = 0; i < cfgs.length; i++) {
    try {
      let p = null;
      let k = null;
      
      // Same parsing logic as Xray, but with Singbox-specific features
      if (cfgs[i].startsWith('vmess://')) {
        const v = parseVmess(cfgs[i]);
        if (!v) continue;
        k = `vm${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('vm', v.s, i),
          type: 'vmess',
          server: v.s,
          port: v.p,
          uuid: v.u,
          alterId: v.a,
          cipher: v.c,
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          p.tls = true;
          p.servername = v.sni;
        }
      } else if (cfgs[i].startsWith('vless://')) {
        const v = parseVless(cfgs[i]);
        if (!v) continue;
        k = `vl${v.s}${v.p}${v.u}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('vl', v.s, i),
          type: 'vless',
          server: v.s,
          port: v.p,
          uuid: v.u,
          udp: true,
          'skip-cert-verify': true
        };
        if (v.n === 'ws') {
          p.network = 'ws';
          p['ws-opts'] = { path: v.path, headers: { Host: v.host } };
        }
        if (v.t) {
          p.tls = true;
          p.servername = v.sni;
          if (v.flow) p.flow = v.flow;
        }
      } else if (cfgs[i].startsWith('trojan://')) {
        const v = parseTrojan(cfgs[i]);
        if (!v) continue;
        k = `tr${v.s}${v.p}${v.pw}`;
        if (seen.has(k)) continue;
        p = {
          name: uid('tr', v.s, i),
          type: 'trojan',
          server: v.s,
          port: v.p,
          password: v.pw,
          udp: true,
          sni: v.sni,
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
          server: v.s,
          port: v.p,
          cipher: v.m,
          password: v.pw,
          udp: true
        };
      }
      // Note: Hysteria2 and TUIC are NOT supported in Clash format
      // Only in Singbox JSON format
      
      if (p && k) {
        seen.add(k);
        prx.push(p);
      }
    } catch {}
  }
  
  if (!prx.length) return null;
  
  const n = prx.map(x => x.name);
  
  // Singbox-compatible Clash structure
  let y = '# ============================================\n';
  y += '# Clash Config for Sing-box Core\n';
  y += '# Generated by V2V - github.com/smbcryp/V2V\n';
  y += '# Expiry: 120 days from creation\n';
  y += '# Note: TUIC/Hy2 only in Singbox JSON format\n';
  y += '# ============================================\n\n';
  y += 'port: 7890\n';
  y += 'socks-port: 7891\n';
  y += 'allow-lan: true\n';
  y += 'mode: rule\n';
  y += 'log-level: info\n\n';
  y += 'experimental:\n';
  y += '  external-controller: 127.0.0.1:9090\n';
  y += '  external-ui: ui\n';
  y += '  secret: ""\n\n';
  y += 'dns:\n';
  y += '  enable: true\n';
  y += '  listen: 0.0.0.0:53\n';
  y += '  enhanced-mode: fake-ip\n';
  y += '  fake-ip-range: 198.18.0.1/16\n';
  y += '  nameserver:\n';
  y += '    - 8.8.8.8\n';
  y += '  fallback:\n';
  y += '    - https://dns.google/dns-query\n\n';
  y += 'proxies:\n';
  
  for (const x of prx) {
    y += `  - name: ${x.name}\n`;
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
          y += `    ws-opts:\n      path: ${x['ws-opts'].path}\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
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
          y += `    ws-opts:\n      path: ${x['ws-opts'].path}\n      headers:\n        Host: ${x['ws-opts'].headers.Host}\n`;
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
  y += '  - name: "🚀 Singbox-Auto"\n    type: url-test\n    proxies:\n';
  for (const name of n) y += `      - ${name}\n`;
  y += '    url: http://www.gstatic.com/generate_204\n    interval: 300\n    tolerance: 50\n\n';
  y += '  - name: "🎯 Singbox-Select"\n    type: select\n    proxies:\n      - 🚀 Singbox-Auto\n';
  for (const name of n) y += `      - ${name}\n`;
  y += '\nrules:\n  - GEOIP,IR,DIRECT\n  - MATCH,🎯 Singbox-Select\n';
  
  return y;
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
          status: 'V2V Pro v9 - Complete Core Support',
          cores: {
            xray: {
              subscription: '/sub/xray/{id} - Raw Xray configs (base64)',
              clash: '/sub/xray-clash/{id} - Clash Meta for Xray'
            },
            singbox: {
              subscription: '/sub/singbox/{id} - Singbox JSON',
              clash: '/sub/singbox-clash/{id} - Clash for Singbox (optional)'
            }
          },
          endpoints: ['/ping', '/create-sub', '/sub/{format}/{id}']
        }, 200, h);
      }
      
      if (u.pathname === '/ping' && req.method === 'POST') {
        const { host, port } = await req.json();
        if (!host || !port) return json({ error: 'Missing params' }, 400, h);
        const r = await testConn(host, port);
        return json(r, 200, h);
      }
      
      if (u.pathname === '/create-sub' && req.method === 'POST') {
        const { configs, format, core } = await req.json();
        
        if (!Array.isArray(configs) || !configs.length) {
          return json({ error: 'Invalid configs' }, 400, h);
        }
        
        // Validate format and core combination
        const validFormats = ['xray', 'xray-clash', 'singbox', 'singbox-clash'];
        if (!validFormats.includes(format)) {
          return json({ error: `Invalid format. Must be one of: ${validFormats.join(', ')}` }, 400, h);
        }
        
        const id = genId();
        await env.v2v_kv.put(
          `sub:${id}`, 
          JSON.stringify({ configs, format, core: core || 'auto', created: Date.now() }), 
          { expirationTtl: TTL }
        );
        
        return json({ 
          success: true, 
          id, 
          urls: {
            [format]: `${u.origin}/sub/${format}/${id}`
          },
          info: `Created ${format} subscription for ${configs.length} configs`
        }, 200, h);
      }
      
      // Match subscription URLs
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
          if (!content) return json({ error: 'No valid Xray configs' }, 500, h);
          return text(content, 'text/yaml', h, 'V2V-Xray-Clash.yaml');
        }
        
        if (fmt === 'singbox') {
          const content = genSingboxSubscription(configs);
          if (!content) return json({ error: 'No valid Singbox configs' }, 500, h);
          return text(content, 'application/json', h, 'V2V-Singbox.json');
        }
        
        if (fmt === 'singbox-clash') {
          const content = genClashForSingbox(configs);
          if (!content) return json({ error: 'No valid configs for Clash' }, 500, h);
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