# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import socket
import ssl
import random
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs, unquote
from github import Github, Auth
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import yaml
import signal

def timeout_handler(signum, frame):
    print("⏰ TIMEOUT: Script exceeded maximum runtime")
    exit(1)

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(50 * 60)

print("🚀 V2V Enhanced Scraper v8.0 - ZERO DUPLICATES + FIXED PING")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hy2', 'tuic'}
ALL_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
}

GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 10000
MAX_CONFIGS_PER_PROTOCOL = 500
MAX_TEST_WORKERS = 100
TCP_TIMEOUT = 4.0
MAX_LATENCY_MS = 5000
GITHUB_SEARCH_LIMIT = int(os.environ.get('GITHUB_SEARCH_LIMIT', 150))
MAX_RETRIES = 2

def get_config_hash(config: str) -> str:
    """ایجاد hash منحصر به فرد برای هر کانفیگ"""
    try:
        parsed = urlparse(config)
        # استفاده از server, port و username/id برای hash
        unique_parts = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}:{parsed.username}"
        return hashlib.sha256(unique_parts.encode()).hexdigest()[:16]
    except:
        return hashlib.sha256(config.encode()).hexdigest()[:16]

def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip():
        return ""
    
    methods = [
        lambda x: base64.b64decode(x).decode('utf-8', 'ignore'),
        lambda x: base64.urlsafe_b64decode(x + '===').decode('utf-8', 'ignore'),
    ]
    
    content = content.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    
    for method in methods:
        try:
            return method(content)
        except:
            continue
    return ""

def normalize_protocol(protocol: str) -> str:
    protocol = protocol.lower().strip()
    if protocol in ['shadowsocks']:
        return 'ss'
    if protocol in ['hysteria2', 'hysteria']:
        return 'hy2'
    return protocol

def parse_tuic_config(config: str) -> Optional[Dict]:
    try:
        parsed = urlparse(config)
        if not parsed.hostname or not parsed.port:
            return None
        
        params = parse_qs(parsed.query)
        uuid = parsed.username if parsed.username else params.get('uuid', [''])[0]
        password = params.get('password', [''])[0]
        
        if not uuid and not password:
            return None
        
        return {
            'hostname': parsed.hostname,
            'port': int(parsed.port),
            'uuid': uuid,
            'password': password,
            'sni': params.get('sni', [parsed.hostname])[0],
        }
    except:
        return None

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip():
        return False
    
    config = config.strip()
    
    try:
        parsed = urlparse(config)
        scheme = normalize_protocol(parsed.scheme)
        
        if scheme not in ALL_PROTOCOLS:
            return False
        
        if scheme == 'vmess':
            try:
                vmess_data = config.replace("vmess://", "")
                decoded = json.loads(decode_base64_content(vmess_data))
                return bool(decoded.get('add')) and bool(decoded.get('port')) and bool(decoded.get('id'))
            except:
                return False
        
        if scheme == 'tuic':
            tuic_info = parse_tuic_config(config)
            return tuic_info is not None
        
        return bool(parsed.hostname) and bool(parsed.port)
        
    except:
        return False

def extract_configs_from_content(content: str) -> Set[str]:
    configs = set()
    if not content:
        return configs
    
    protocols = ['vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hysteria2', 'hy2', 'tuic', 'hysteria']
    
    for protocol in protocols:
        pattern = rf'{protocol}://[^\s<>"\'`\n\r\[\]{{}}\|\\]+'
        matches = re.findall(pattern, content, re.IGNORECASE | re.MULTILINE)
        for match in matches:
            clean_match = match.strip()
            if is_valid_config(clean_match):
                configs.add(clean_match)
    
    base64_pattern = r'[A-Za-z0-9+/=]{100,}'
    for b64_block in re.findall(base64_pattern, content)[:30]:
        try:
            decoded = decode_base64_content(b64_block)
            if decoded:
                for line in decoded.splitlines()[:200]:
                    clean_line = line.strip()
                    if is_valid_config(clean_line):
                        configs.add(clean_line)
        except:
            continue
    
    return configs

def fetch_from_static_sources(sources: List[str]) -> Set[str]:
    all_configs = set()
    print(f"📡 Fetching from {len(sources)} static sources...")

    def fetch_url(url: str, retry: int = 0) -> Set[str]:
        if retry >= MAX_RETRIES:
            return set()
        try:
            time.sleep(random.uniform(0.5, 2.0))
            response = requests.get(url, headers=HEADERS, timeout=25, verify=False)
            response.raise_for_status()
            configs = extract_configs_from_content(response.text)
            if configs:
                print(f"  ✓ Found {len(configs)} from {url[:60]}")
            return configs
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429 and retry < MAX_RETRIES:
                time.sleep(45)
                return fetch_url(url, retry + 1)
            return set()
        except:
            return set()

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_url, url): url for url in sources}
        for future in as_completed(futures, timeout=800):
            try:
                all_configs.update(future.result(timeout=60))
            except:
                continue
    
    return all_configs

def fetch_from_github(pat: str, limit: int) -> Set[str]:
    if not pat:
        return set()
    
    all_configs = set()
    processed = 0
    
    try:
        g = Github(auth=Auth.Token(pat), timeout=30)
        queries = [
            "vless vmess trojan ss extension:txt",
            "hysteria2 hy2 extension:json",
            "tuic:// protocol",
            "subscription v2ray proxy"
        ]
        
        print(f"🔍 Searching GitHub (limit: {limit})")
        start = time.time()
        
        for query in queries:
            if processed >= limit or time.time() - start > 1200:
                break
            try:
                results = g.search_code(query, order='desc', per_page=100)
                for file in results:
                    if processed >= limit:
                        break
                    try:
                        time.sleep(random.uniform(0.2, 0.5))
                        content = file.content.decode('utf-8', 'ignore')
                        configs = extract_configs_from_content(content)
                        if configs:
                            all_configs.update(configs)
                            processed += 1
                            if processed % 50 == 0:
                                print(f"  📄 Processed {processed} files")
                    except:
                        continue
            except:
                continue
        
        print(f"  ✅ GitHub: {len(all_configs)} configs from {processed} files")
        return all_configs
    except:
        return set()

def test_protocol_connection(config: str) -> Optional[Tuple[str, int, str]]:
    """تست اتصال با پشتیبانی کامل از همه پروتکل‌ها"""
    try:
        parsed = urlparse(config)
        protocol = normalize_protocol(parsed.scheme)
        
        hostname, port, is_tls, sni = None, None, False, None
        
        if protocol == 'vmess':
            try:
                decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
                hostname = decoded.get('add')
                port = int(decoded.get('port', 0))
                is_tls = decoded.get('tls') in ['tls', 'xtls']
                sni = decoded.get('sni') or decoded.get('host') or hostname
            except:
                return None
                
        elif protocol == 'tuic':
            tuic_info = parse_tuic_config(config)
            if not tuic_info:
                return None
            hostname = tuic_info['hostname']
            port = tuic_info['port']
            is_tls = True
            sni = tuic_info['sni']
            
        elif protocol in ['vless', 'trojan']:
            hostname = parsed.hostname
            port = int(parsed.port or 0)
            params = parse_qs(parsed.query)
            
            # برای Trojan همیشه TLS فعال است
            if protocol == 'trojan':
                is_tls = True
                sni = params.get('sni', [hostname])[0] if params.get('sni') else hostname
            else:  # vless
                is_tls = params.get('security', [''])[0] == 'tls'
                sni = params.get('sni', [hostname])[0] if params.get('sni') else hostname
                
        elif protocol == 'ss':
            hostname = parsed.hostname
            port = int(parsed.port or 0)
            
        elif protocol == 'hy2':
            hostname = parsed.hostname
            port = int(parsed.port or 0)
            is_tls = True
            
        else:
            return None
        
        if not all([hostname, port]) or port <= 0 or port > 65535:
            return None
        
        start = time.monotonic()
        
        # تست UDP برای Hy2 و TUIC
        if protocol in ['tuic', 'hy2']:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.settimeout(TCP_TIMEOUT)
                sock.connect((hostname, port))
                sock.send(b'\x00' * 16)
                try:
                    sock.recv(16)
                except:
                    pass
                sock.close()
            except:
                return None
        else:
            # تست TCP برای بقیه پروتکل‌ها
            try:
                sock = socket.create_connection((hostname, port), timeout=TCP_TIMEOUT)
                
                # برای پروتکل‌های TLS (Trojan, VLESS با TLS, VMess با TLS)
                if is_tls:
                    context = ssl.create_default_context()
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                    context.minimum_version = ssl.TLSVersion.TLSv1_2
                    
                    try:
                        ssock = context.wrap_socket(sock, server_hostname=sni or hostname)
                        # خواندن داده‌های اولیه برای اطمینان از اتصال
                        ssock.do_handshake()
                        ssock.close()
                    except ssl.SSLError:
                        # برخی سرورها ممکن است SSLError برگردانند ولی باز هم کار می‌کنند
                        sock.close()
                else:
                    sock.close()
                    
            except socket.timeout:
                return None
            except socket.error:
                return None
            except:
                return None
        
        latency = int((time.monotonic() - start) * 1000)
        
        if latency > 0 and latency <= MAX_LATENCY_MS:
            return config, latency, protocol
        
        return None
        
    except Exception as e:
        return None

def balance_protocols_separate(configs_with_info: List[Tuple[str, int, str]], protocols: Set[str]) -> List[str]:
    """توزیع جداگانه با حذف تکرار کامل"""
    protocol_groups = defaultdict(list)
    seen_hashes = set()
    
    for config, latency, protocol in configs_with_info:
        if protocol in protocols:
            config_hash = get_config_hash(config)
            
            if config_hash not in seen_hashes:
                protocol_groups[protocol].append((config, latency, config_hash))
                seen_hashes.add(config_hash)
    
    # مرتب‌سازی بر اساس ping
    for protocol in protocol_groups:
        protocol_groups[protocol].sort(key=lambda x: x[1])
    
    selected = []
    for protocol in sorted(protocols):
        if protocol in protocol_groups:
            count = min(MAX_CONFIGS_PER_PROTOCOL, len(protocol_groups[protocol]))
            for config, _, _ in protocol_groups[protocol][:count]:
                selected.append(config)
    
    return selected

def generate_clash_yaml(configs: List[str]) -> Optional[str]:
    """تولید فایل Clash با ساختار صحیح"""
    proxies = []
    seen_hashes = set()
    
    for config in configs:
        try:
            parsed = urlparse(config)
            protocol = normalize_protocol(parsed.scheme)
            
            if protocol in SINGBOX_ONLY_PROTOCOLS:
                continue
            
            config_hash = get_config_hash(config)
            if config_hash in seen_hashes:
                continue
            seen_hashes.add(config_hash)
            
            name = unquote(parsed.fragment) if parsed.fragment else f"V2V-{protocol}-{random.randint(1000,9999)}"
            name = re.sub(r'[^\w\-_.]', '', name)[:50]
            
            proxy = {
                'name': name,
                'server': parsed.hostname,
                'port': int(parsed.port),
                'skip-cert-verify': True
            }
            
            if protocol == 'vmess':
                decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
                proxy.update({
                    'type': 'vmess',
                    'uuid': decoded.get('id'),
                    'alterId': int(decoded.get('aid', 0)),
                    'cipher': decoded.get('scy', 'auto'),
                    'udp': True
                })
                if decoded.get('net') == 'ws':
                    proxy['network'] = 'ws'
                    proxy['ws-opts'] = {
                        'path': decoded.get('path', '/'),
                        'headers': {'Host': decoded.get('host', parsed.hostname)}
                    }
                if decoded.get('tls') == 'tls':
                    proxy['tls'] = True
                    proxy['servername'] = decoded.get('sni') or decoded.get('host') or parsed.hostname
                    
            elif protocol == 'vless':
                proxy.update({
                    'type': 'vless',
                    'uuid': parsed.username,
                    'udp': True
                })
                params = parse_qs(parsed.query)
                if params.get('type', [''])[0] == 'ws':
                    proxy['network'] = 'ws'
                    proxy['ws-opts'] = {
                        'path': params.get('path', ['/'])[0],
                        'headers': {'Host': params.get('host', [parsed.hostname])[0]}
                    }
                if params.get('security', [''])[0] == 'tls':
                    proxy['tls'] = True
                    proxy['servername'] = params.get('sni', [parsed.hostname])[0]
                    if params.get('flow'):
                        proxy['flow'] = params.get('flow')[0]
                        
            elif protocol == 'trojan':
                proxy.update({
                    'type': 'trojan',
                    'password': parsed.username,
                    'udp': True
                })
                params = parse_qs(parsed.query)
                proxy['sni'] = params.get('sni', [parsed.hostname])[0]
                
            elif protocol == 'ss':
                decoded = decode_base64_content(parsed.username)
                if ':' in decoded:
                    method, password = decoded.split(':', 1)
                    proxy.update({
                        'type': 'ss',
                        'cipher': method,
                        'password': password,
                        'udp': True
                    })
            
            if proxy.get('type'):
                proxies.append(proxy)
                
        except:
            continue
    
    if not proxies:
        return None
    
    names = [p['name'] for p in proxies]
    
    clash_config = {
        'proxies': proxies,
        'proxy-groups': [
            {
                'name': '🚀 V2V Auto',
                'type': 'url-test',
                'proxies': names,
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300,
                'tolerance': 50
            },
            {
                'name': '🎯 V2V Select',
                'type': 'select',
                'proxies': ['🚀 V2V Auto'] + names
            }
        ],
        'rules': [
            'GEOIP,IR,DIRECT',
            'MATCH,🎯 V2V Select'
        ]
    }
    
    try:
        return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, default_flow_style=False)
    except:
        return None

def main():
    try:
        print("\n" + "="*60)
        print("🚀 V2V SCRAPER STARTED")
        print("="*60)
        
        print("\n📂 1. Loading Sources...")
        with open(SOURCES_FILE, 'r') as f:
            sources = json.load(f).get("static", [])
        print(f"   ✓ Loaded {len(sources)} sources")

        print("\n📥 2. Fetching Configs...")
        all_configs = set()
        
        with ThreadPoolExecutor(max_workers=2) as executor:
            static_future = executor.submit(fetch_from_static_sources, sources)
            github_future = executor.submit(fetch_from_github, GITHUB_PAT, GITHUB_SEARCH_LIMIT)
            
            try:
                all_configs.update(static_future.result(timeout=1200))
                all_configs.update(github_future.result(timeout=1500))
            except:
                pass
        
        if not all_configs:
            print("   ❌ No configs found")
            return
        
        print(f"   ✓ Total unique: {len(all_configs)}")

        print("\n🔬 3. Testing Configs...")
        tested = []
        to_test = list(all_configs)[:MAX_CONFIGS_TO_TEST]
        
        with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
            futures = {executor.submit(test_protocol_connection, cfg): cfg for cfg in to_test}
            completed = 0
            for future in as_completed(futures, timeout=1800):
                try:
                    result = future.result(timeout=10)
                    if result:
                        tested.append(result)
                    completed += 1
                    if completed % 500 == 0:
                        print(f"   📊 {completed}/{len(to_test)} tested ({len(tested)} working)")
                except:
                    pass
        
        print(f"   ✓ Found {len(tested)} working configs")

        print("\n🎯 4. Selecting Best Configs (ZERO DUPLICATES)...")
        
        # Xray
        xray_tested = [(cfg, lat, prot) for cfg, lat, prot in tested if prot in XRAY_PROTOCOLS]
        selected_xray = balance_protocols_separate(xray_tested, XRAY_PROTOCOLS)
        
        # Singbox (با حذف کانفیگ‌های استفاده شده در Xray)
        used_hashes = set(get_config_hash(cfg) for cfg in selected_xray)
        remaining_tested = [
            (cfg, lat, prot) for cfg, lat, prot in tested 
            if get_config_hash(cfg) not in used_hashes
        ]
        selected_singbox = balance_protocols_separate(remaining_tested, ALL_PROTOCOLS)
        
        print(f"   ✓ Xray: {len(selected_xray)} configs")
        print(f"   ✓ Singbox: {len(selected_singbox)} configs")
        
        def group_configs(configs: List[str]) -> Dict[str, List[str]]:
            grouped = defaultdict(list)
            seen_per_protocol = defaultdict(set)
            
            for config in configs:
                protocol = normalize_protocol(urlparse(config).scheme)
                config_hash = get_config_hash(config)
                
                if config_hash not in seen_per_protocol[protocol]:
                    grouped[protocol].append(config)
                    seen_per_protocol[protocol].add(config_hash)
            
            return dict(grouped)
        
        xray_grouped = group_configs(selected_xray)
        singbox_grouped = group_configs(selected_singbox)
        
        for p in XRAY_PROTOCOLS:
            if p not in xray_grouped:
                xray_grouped[p] = []
        
        for p in ALL_PROTOCOLS:
            if p not in singbox_grouped:
                singbox_grouped[p] = []
        
        output = {"xray": xray_grouped, "singbox": singbox_grouped}
        
        print("\n📊 Protocol Distribution:")
        print("   Xray:")
        for p in sorted(xray_grouped.keys()):
            print(f"     • {p}: {len(xray_grouped[p])}")
        print("   Singbox:")
        for p in sorted(singbox_grouped.keys()):
            print(f"     • {p}: {len(singbox_grouped[p])}")
        
        # بررسی تکرار
        xray_hashes = set()
        for configs_list in xray_grouped.values():
            xray_hashes.update(get_config_hash(c) for c in configs_list)
        
        singbox_hashes = set()
        for configs_list in singbox_grouped.values():
            singbox_hashes.update(get_config_hash(c) for c in configs_list)
        
        duplicates = xray_hashes.intersection(singbox_hashes)
        
        if duplicates:
            print(f"\n   ⚠️  WARNING: Found {len(duplicates)} duplicates!")
        else:
            print("\n   ✅ ZERO duplicates confirmed!")

        print("\n💾 5. Writing Files...")
        
        with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print(f"   ✓ {OUTPUT_JSON_FILE}")
        
        clash_yaml = generate_clash_yaml(selected_xray)
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_yaml if clash_yaml else "# No valid Clash configs\nproxies: []\n")
        print(f"   ✓ {OUTPUT_CLASH_FILE}")
        
        with open(CACHE_VERSION_FILE, 'w') as f:
            f.write(str(int(time.time())))
        print(f"   ✓ {CACHE_VERSION_FILE}")
        
        print("\n" + "="*60)
        print("✅ SCRAPER COMPLETED SUCCESSFULLY")
        print("="*60)
        total_xray = sum(len(v) for v in xray_grouped.values())
        total_singbox = sum(len(v) for v in singbox_grouped.values())
        print(f"📈 Final Stats:")
        print(f"   • Xray: {total_xray} configs")
        print(f"   • Singbox: {total_singbox} configs")
        print(f"   • Total: {total_xray + total_singbox} configs")
        print("="*60 + "\n")
        
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        signal.alarm(0)

if __name__ == "__main__":
    main()