import json
import base64
import time
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import socket
import ssl
import os
import requests
import re
import yaml
import string

# --- configuration ---
# ... (Configuration constants remain the same) ...
SOURCES_FILE = 'sources.json'
OUTPUT_DIR = '.'
OUTPUT_JSON_FILE = 'all_live_configs.json'
CACHE_VERSION_FILE = 'cache_version.txt'
XRAY_RAW_FALLBACK_FILE = 'xray_raw_configs.txt'
SINGBOX_RAW_FALLBACK_FILE = 'singbox_raw_configs.txt'
CLASH_ALL_YAML_FILE = 'v2v-clash-all.yaml'

GITHUB_PAT = os.getenv('GH_PAT', '')
GITHUB_SEARCH_LIMIT = 500

MAX_CONFIGS_TO_TEST = 5000
MAX_LATENCY_MS = 5000
MAX_TEST_WORKERS = 200
TEST_TIMEOUT_SEC = 8
# 1. Update MAX/MIN configs per core
MAX_FINAL_CONFIGS_PER_CORE = 5000
MIN_FINAL_CONFIGS_PER_CORE = 500

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hy2', 'hysteria2', 'tuic'}
COMMON_PROTOCOLS = XRAY_PROTOCOLS.intersection(SINGBOX_PROTOCOLS)
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_PROTOCOLS)

BASE58_ALPHABET = string.digits + string.ascii_uppercase + string.ascii_lowercase + '-_~'

# ... (base58_decode and fetch_url_content remain the same) ...
def base58_decode(s: str) -> bytes:
    base = len(BASE58_ALPHABET)
    value = 0
    for i, c in enumerate(s[::-1]):
        value += BASE58_ALPHABET.index(c) * (base ** i)
    result = bytearray()
    while value > 0:
        result.insert(0, value % 256)
        value //= 256
    return bytes(result)

def fetch_url_content(url: str, headers: dict = None) -> str | None:
    try:
        if headers is None: headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=TEST_TIMEOUT_SEC)
        response.raise_for_status()
        content = response.text
        try:
            missing_padding = len(content) % 4
            if missing_padding: content += '=' * (4 - missing_padding)
            return base64.b64decode(content).decode('utf-8')
        except (Exception):
            try:
                return base58_decode(content).decode('utf-8')
            except (Exception):
                return content
    except requests.exceptions.RequestException:
        return None

# ... (fetch_from_sources and fetch_from_github remain the same) ...

def fetch_from_sources(sources: list[str]) -> set[str]:
    collected = set()
    print("  Fetching from static sources...")
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(fetch_url_content, url) for url in sources}
        for future in as_completed(futures):
            content = future.result()
            if content:
                for line in content.splitlines():
                    if any(line.strip().lower().startswith(p + "://") for p in VALID_PROTOCOLS):
                        collected.add(line.strip())
    print(f"  ✅ Found {len(collected)} configs from static sources.")
    return collected

def fetch_from_github(pat: str, search_limit: int) -> set[str]:
    collected = set()
    print("  Fetching from GitHub...")
    try:
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/vnd.github.v3.raw'}
        if pat: headers['Authorization'] = f'token {pat}'
        queries = ['filename:vless', 'filename:vmess', 'filename:trojan', 'filename:ss', 'filename:hy2', 'filename:tuic', 'path:*.txt "vless://"', 'path:*.txt "vmess://"']
        
        for query in queries:
            if len(collected) >= search_limit: break
            api_url = f"https://api.github.com/search/code?q={query}+size:1..10000&per_page=100"
            response = requests.get(api_url, headers=headers, timeout=TEST_TIMEOUT_SEC)
            response.raise_for_status()
            items = response.json().get('items', [])
            for item in items:
                if len(collected) >= search_limit: break
                raw_url = item['html_url'].replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
                content = fetch_url_content(raw_url, headers)
                if content:
                    for line in content.splitlines():
                        if any(line.strip().lower().startswith(p + "://") for p in VALID_PROTOCOLS):
                            collected.add(line.strip())
    except Exception as e:
        # 3. تمیزکاری لاگ: فقط خطاهای جدی نمایش داده شوند
        print(f"  ⚠️ Error during GitHub fetching (API or connection): {e}")
    print(f"  ✅ Found {len(collected)} configs from GitHub.")
    return collected

# ... (test_config remains the same, used for TCP/TLS test) ...

def test_config(config_url: str) -> tuple[str, int] | None:
    try:
        parsed_url = urlparse(config_url)
        hostname = parsed_url.hostname
        port = parsed_url.port
        if not hostname or not port: return None
        
        is_tls = False
        scheme = parsed_url.scheme.lower()
        query_params = parse_qs(parsed_url.query)
        
        if scheme in ['trojan', 'hy2', 'hysteria2', 'tuic']:
            is_tls = True
        elif scheme == 'vless' and (query_params.get('security') == ['tls'] or 'tls' in parsed_url.path):
            is_tls = True
        elif scheme == 'vmess' and config_url.startswith('vmess://'):
            try:
                # 2. تقویت پارسینگ Vmess (با try...except)
                vmess_data = json.loads(base64.b64decode(config_url[8:]).decode('utf-8'))
                if vmess_data.get('tls') == 'tls': is_tls = True
            except Exception: 
                # print(f"⚠️ Error parsing Vmess data for TLS check: {config_url}") # No print for log cleanup
                pass

        start_time = time.monotonic()
        with socket.create_connection((hostname, port), timeout=TEST_TIMEOUT_SEC) as sock:
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                    ssock.do_handshake()
            
            sock.settimeout(TEST_TIMEOUT_SEC)
            sock.sendall(b'GET / HTTP/1.1\r\nHost: www.google.com\r\n\r\n')
            response = sock.recv(1024)
            if not response:
                raise Exception("No response received")
        
        latency_ms = int((time.monotonic() - start_time) * 1000)
        return config_url, latency_ms
    except Exception:
        return None

# ... (shorten_name, parse_config_to_clash_proxy, generate_clash_yaml remain the same for scraper utility) ...

def shorten_name(url: str, latency: int, max_len: int = 20) -> str:
    parts = urlparse(url)
    protocol = parts.scheme
    hostname = parts.hostname
    
    short_name = hostname.replace('www.', '').split('.')[0]
    
    final_name = f"v2v-{protocol}-{short_name}-{latency}ms"
    
    if len(final_name) > max_len:
        trimmed_len = max_len - (len(protocol) + len(str(latency)) + 6)
        if trimmed_len > 0:
            short_name = short_name[:trimmed_len]
            final_name = f"v2v-{protocol}-{short_name}-{latency}ms"
        else:
            final_name = f"v2v-{protocol}-{latency}ms"
            
    return re.sub(r'[^a-zA-Z0-9-]', '', final_name)

def parse_config_to_clash_proxy(url, name):
    try:
        parsed_url = urlparse(url)
        protocol = parsed_url.scheme.lower()
        
        proxy = {
            'name': name,
            'server': parsed_url.hostname,
            'port': parsed_url.port,
        }
        
        # Vmess
        if protocol == 'vmess':
            proxy['type'] = 'vmess'
            decoded_data = json.loads(base64.b64decode(parsed_url.netloc).decode('utf-8'))
            proxy['uuid'] = decoded_data.get('id', '')
            proxy['alterId'] = decoded_data.get('aid', 0)
            proxy['cipher'] = 'auto'
            if 'ws' in decoded_data.get('net', ''):
                proxy['network'] = 'ws'
                proxy['ws-path'] = decoded_data.get('path', '/')
                proxy['ws-headers'] = {'Host': decoded_data.get('host', '')}
            if decoded_data.get('tls') == 'tls':
                proxy['tls'] = True
                proxy['sni'] = decoded_data.get('host', '')

        # Vless
        elif protocol == 'vless':
            proxy['type'] = 'vless'
            proxy['uuid'] = parsed_url.username
            query_params = parse_qs(parsed_url.query)
            if query_params.get('security'):
                proxy['tls'] = query_params['security'][0] == 'tls'
            if query_params.get('flow'):
                proxy['flow'] = query_params['flow'][0]
            if query_params.get('encryption'):
                proxy['encryption'] = query_params['encryption'][0]
            if query_params.get('sni'):
                proxy['sni'] = query_params['sni'][0]
            if query_params.get('type') and query_params['type'][0] == 'ws':
                proxy['network'] = 'ws'
                if query_params.get('path'):
                    proxy['ws-path'] = query_params['path'][0]
                if query_params.get('host'):
                    proxy['ws-headers'] = {'Host': query_params['host'][0]}
        
        # Trojan
        elif protocol == 'trojan':
            proxy['type'] = 'trojan'
            proxy['password'] = parsed_url.username
            proxy['skip-cert-verify'] = True
            query_params = parse_qs(parsed_url.query)
            if query_params.get('sni'):
                proxy['sni'] = query_params['sni'][0]

        # Shadowsocks
        elif protocol in ('ss', 'shadowsocks'):
            proxy['type'] = 'ss'
            user_info = base64.b64decode(parsed_url.username).decode('utf-8')
            method, password = user_info.split(':', 1)
            proxy['cipher'] = method
            proxy['password'] = password
            
        return proxy
    except Exception as e:
        # print(f"⚠️ Error parsing config {url}: {e}") # No print for log cleanup
        return None

def generate_clash_yaml(configs):
    proxies = []
    
    for url, latency in configs:
        name = shorten_name(url, latency, max_len=20)
        proxy_config = parse_config_to_clash_proxy(url, name)
        if proxy_config:
            proxies.append(proxy_config)
    
    proxy_groups = []
    
    if proxies:
        proxy_groups.append({
            'name': 'v2v-auto-select',
            'type': 'url-test',
            'url': 'http://www.gstatic.com/generate_204',
            'interval': 300,
            'proxies': [p['name'] for p in proxies]
        })
        proxy_groups.append({
            'name': 'v2v-all',
            'type': 'select',
            'proxies': ['v2v-auto-select'] + [p['name'] for p in proxies]
        })
    
    return yaml.dump({'proxies': proxies, 'proxy-groups': proxy_groups, 'rules': []}, allow_unicode=True, sort_keys=False)


# --- main logic ---
def main():
    print("--- 1. Fetching configs ---")
    # ... (Fetching code remains the same) ...
    all_configs = fetch_from_sources(json.load(open(SOURCES_FILE, 'r')).get("static", []))
    all_configs.update(fetch_from_github(GITHUB_PAT, GITHUB_SEARCH_LIMIT))
    if not all_configs: 
        print("FATAL: No configs found.")
        return
    print(f"📊 Total unique configs fetched: {len(all_configs)}")

    print("\n--- 2. Testing configs ---")
    live_configs = []
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_config, cfg): cfg for cfg in list(all_configs)[:MAX_CONFIGS_TO_TEST]}
        for future in as_completed(futures):
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS and result[1] > 0: # 3. فیلترینگ نتایج ۰ms یا نامعتبر
                live_configs.append(result)
    if not live_configs: 
        print("FATAL: No live configs found.")
        return
    live_configs.sort(key=lambda x: x[1])
    print(f"🏆 Found {len(live_configs)} live configs with acceptable latency.")

    print("\n--- 3. Grouping and filling configs ---")
    
    xray_configs_with_ping = [(cfg, ping) for cfg, ping in live_configs if urlparse(cfg).scheme.lower().replace('shadowsocks', 'ss') in XRAY_PROTOCOLS]
    singbox_configs_with_ping = [(cfg, ping) for cfg, ping in live_configs if urlparse(cfg).scheme.lower().replace('shadowsocks', 'ss') in SINGBOX_PROTOCOLS]

    xray_final = xray_configs_with_ping[:MAX_FINAL_CONFIGS_PER_CORE]
    singbox_final = singbox_configs_with_ping[:MAX_FINAL_CONFIGS_PER_CORE]
    
    # Logic for filling up to MIN_FINAL_CONFIGS_PER_CORE (500)
    # This logic remains correct for the new 500/5000 limits

    if len(singbox_final) < MIN_FINAL_CONFIGS_PER_CORE:
        print("  Sing-box list is not full. Filling with common configs from Xray.")
        common_xray_configs = [cfg for cfg, _ in xray_configs_with_ping if urlparse(cfg).scheme.lower().replace('shadowsocks', 'ss') in COMMON_PROTOCOLS]
        for cfg in common_xray_configs:
            if len(singbox_final) >= MIN_FINAL_CONFIGS_PER_CORE: break
            if cfg not in [c[0] for c in singbox_final]:
                singbox_final.append( (cfg, [p for p in live_configs if p[0] == cfg][0][1]) )
    
    if len(xray_final) < MIN_FINAL_CONFIGS_PER_CORE:
        print("  Xray list is not full. Filling with common configs from Sing-box.")
        common_singbox_configs = [cfg for cfg, _ in singbox_configs_with_ping if urlparse(cfg).scheme.lower().replace('shadowsocks', 'ss') in COMMON_PROTOCOLS]
        for cfg in common_singbox_configs:
            if len(xray_final) >= MIN_FINAL_CONFIGS_PER_CORE: break
            if cfg not in [c[0] for c in xray_final]:
                xray_final.append( (cfg, [p for p in live_configs if p[0] == cfg][0][1]) )

    if len(xray_final) < MIN_FINAL_CONFIGS_PER_CORE:
        print(f"⚠️ Warning: Not enough live configs found to fill Xray core. Found only {len(xray_final)}.")
    if len(singbox_final) < MIN_FINAL_CONFIGS_PER_CORE:
        print(f"⚠️ Warning: Not enough live configs found to fill Sing-box core. Found only {len(singbox_final)}.")
    
    print(f"✅ Final Xray configs: {len(xray_final)} / {MAX_FINAL_CONFIGS_PER_CORE}")
    print(f"✅ Final Sing-box configs: {len(singbox_final)} / {MAX_FINAL_CONFIGS_PER_CORE}")

    def group_by_protocol(configs, all_protocols):
        grouped = {p: [] for p in all_protocols}
        for cfg, latency in configs:
            proto = urlparse(cfg).scheme.lower().replace('hysteria2', 'hy2').replace('shadowsocks', 'ss')
            # Only include protocols that are in the core's allowed list
            if proto in all_protocols:
                 grouped[proto].append((cfg, latency))
        return dict(grouped)

    output_data = {
        "xray": group_by_protocol(xray_final, XRAY_PROTOCOLS),
        "singbox": group_by_protocol(singbox_final, SINGBOX_PROTOCOLS)
    }

    # ... (Writing output files remains the same) ...
    print("\n--- 4. Writing output files ---")
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    with open(XRAY_RAW_FALLBACK_FILE, 'w', encoding='utf-8') as f:
        f.write("\n".join([c[0] for c in xray_final]))
    with open(SINGBOX_RAW_FALLBACK_FILE, 'w', encoding='utf-8') as f:
        f.write("\n".join([c[0] for c in singbox_final]))
    with open(CLASH_ALL_YAML_FILE, 'w', encoding='utf-8') as f:
        # Generate clash YAML for all live configs (up to 5000) for the main file
        f.write(generate_clash_yaml(live_configs[:MAX_FINAL_CONFIGS_PER_CORE])) 
    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print("✅ All output files written successfully.")

if __name__ == "__main__":
    main()
