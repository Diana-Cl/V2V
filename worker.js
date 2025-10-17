import { connect } from 'cloudflare:sockets';

const TTL = 365 * 24 * 60 * 60; // 1 year
const ORIGINS = ['https://smbcryp.github.io', 'https://v2v-vercel.vercel.app', 'https://v2v-data.s3-website.ir-thr-at1.arvanstorage.ir'];

const cors = (o) => ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (d, s, h) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
const text = (t, c, h, f) => new Response(t, { status: 200, headers: { 'Content-Type': `${c}; charset=utf-8`, ...(f ? { 'Content-Disposition': `attachment; filename="${f}"` } : {}), ...h } });

// Unique ID generator
const uid = (p, s, i) => {
  const h = (s + i).split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
  return `${p}${Math.abs(h).toString(36).slice(0, 7)}`;
};

const b64d = (s) => { try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; } };

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

const genClash = (cfgs) => {
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
  
  if (!prx.length) return 'proxies: []';
  
  const n = prx.map(x => x.name);
  let y = 'proxies:\n';
  
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
  y += '  - name: V2V-Auto\n    type: url-test\n    proxies:\n';
  for (const x of n) y += `      - ${x}\n`;
  y += '    url: http://www.gstatic.com/generate_204\n    interval: 300\n\n';
  y += '  - name: V2V-Select\n    type: select\n    proxies:\n      - V2V-Auto\n';
  for (const x of n) y += `      - ${x}\n`;
  y += '\nrules:\n  - GEOIP,IR,DIRECT\n  - MATCH,V2V-Select\n';
  
  return y;
};

const genSingbox = (cfgs) => {
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
      }
      
      if (o && k) {
        seen.add(k);
        out.push(o);
      }
    } catch {}
  }
  
  if (!out.length) return null;
  
  return JSON.stringify({
    log: { level: 'info' },
    dns: { servers: [{ tag: 'g', address: '8.8.8.8' }, { tag: 'l', address: 'local', detour: 'direct' }] },
    inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 7890 }],
    outbounds: [
      { tag: 'V2V-Auto', type: 'urltest', outbounds: out.map(x => x.tag), url: 'http://www.gstatic.com/generate_204', interval: '5m' },
      { tag: 'V2V-Select', type: 'selector', outbounds: ['V2V-Auto', ...out.map(x => x.tag)] },
      ...out,
      { tag: 'direct', type: 'direct' },
      { tag: 'block', type: 'block' }
    ],
    route: { rules: [{ geoip: 'ir', outbound: 'direct' }], final: 'V2V-Select' }
  }, null, 2);
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
        return json({ status: 'V2V Pro v7', endpoints: ['/ping', '/create-sub', '/sub/{format}/{id}'] }, 200, h);
      }
      
      if (u.pathname === '/ping' && req.method === 'POST') {
        const { host, port } = await req.json();
        if (!host || !port) return json({ error: 'Missing params' }, 400, h);
        const r = await testConn(host, port);
        return json(r, 200, h);
      }
      
      if (u.pathname === '/create-sub' && req.method === 'POST') {
        const { configs, format } = await req.json();
        if (!Array.isArray(configs) || !configs.length) return json({ error: 'Invalid configs' }, 400, h);
        if (!['clash', 'singbox'].includes(format)) return json({ error: 'Invalid format' }, 400, h);
        
        const id = genId();
        await env.v2v_kv.put(`sub:${id}`, JSON.stringify({ configs, format, created: Date.now() }), { expirationTtl: TTL });
        return json({ success: true, id, url: `${u.origin}/sub/${format}/${id}` }, 200, h);
      }
      
      const m = u.pathname.match(/^\/sub\/(clash|singbox)\/([a-z0-9]{8})$/);
      if (m && req.method === 'GET') {
        const [, fmt, id] = m;
        const d = await env.v2v_kv.get(`sub:${id}`, { type: 'json' });
        if (!d?.configs) return new Response('Not found', { status: 404, headers: h });
        
        if (fmt === 'clash') {
          const c = genClash(d.configs);
          return text(c, 'text/yaml', h, 'V2V.yaml');
        }
        
        if (fmt === 'singbox') {
          const c = genSingbox(d.configs);
          if (!c) return json({ error: 'No valid configs' }, 500, h);
          return text(c, 'application/json', h, 'V2V.json');
        }
      }
      
      return new Response('Not Found', { status: 404, headers: h });
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500, h);
    }
  }
};