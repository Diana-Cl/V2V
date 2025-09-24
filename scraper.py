# scraper.py
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

# --- configuration ---
SOURCES_FILE = 'sources.json'
OUTPUT_DIR = 'output'
OUTPUT_JSON_FILE = 'all_live_configs.json'
CACHE_VERSION_FILE = 'cache_version.txt'
XRAY_RAW_FALLBACK_FILE = 'xray_raw_configs.txt'
SINGBOX_RAW_FALLBACK_FILE = 'singbox_raw_configs.txt'

GITHUB_PAT = os.getenv('GH_PAT', '')
GITHUB_SEARCH_LIMIT = 1000

MAX_CONFIGS_TO_TEST = 5000 # Increased to find more configs
MAX_LATENCY_MS = 1500
MAX_TEST_WORKERS = 200
TEST_TIMEOUT_SEC = 8
MAX_FINAL_CONFIGS_PER_CORE = 1000

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hy2', 'hysteria2', 'tuic'}
COMMON_PROTOCOLS = XRAY_PROTOCOLS.intersection(SINGBOX_PROTOCOLS)

os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- helpers ---
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
            return content
    except requests.exceptions.RequestException:
        return None

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
        queries = ['filename:vless', 'filename:vmess', 'filename:trojan', 'path:*.txt "vless://"']
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
        print(f"  ⚠️ Error during GitHub fetching: {e}")
    print(f"  ✅ Found {len(collected)} configs from GitHub.")
    return collected

def test_config(config_url: str) -> tuple[str, int] | None:
    try:
        parsed_url = urlparse(config_url)
        hostname = parsed_url.hostname
        port = parsed_url.port
        if not hostname or not port: return None
        
        is_tls = False
        scheme = parsed_url.scheme.lower()
        query_params = parse_qs(parsed_url.query)
        
        if scheme in ['trojan', 'hy2', 'hysteria2']:
            is_tls = True
        elif scheme == 'vless' and query_params.get('security') == ['tls']:
            is_tls = True
        elif scheme == 'vmess' and config_url.startswith('vmess://'):
            try:
                vmess_data = json.loads(base64.b64decode(config_url[8:]).decode('utf-8'))
                if vmess_data.get('tls') == 'tls': is_tls = True
            except Exception: pass

        start_time = time.monotonic()
        with socket.create_connection((hostname, port), timeout=TEST_TIMEOUT_SEC) as sock:
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                    ssock.do_handshake()
            
            # Additional check for reliability
            sock.settimeout(TEST_TIMEOUT_SEC)
            sock.sendall(b'GET / HTTP/1.1\r\nHost: www.google.com\r\n\r\n')
            response = sock.recv(1024)
            if not response:
                raise Exception("No response received")
        
        latency_ms = int((time.monotonic() - start_time) * 1000)
        return config_url, latency_ms
    except Exception:
        return None

def main():
    print("--- 1. Fetching configs ---")
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
            if result and result[1] <= MAX_LATENCY_MS:
                live_configs.append(result)
    if not live_configs: 
        print("FATAL: No live configs found.")
        return
    live_configs.sort(key=lambda x: x[1])
    print(f"🏆 Found {len(live_configs)} live configs with acceptable latency.")

    print("\n--- 3. Grouping and filling configs ---")
    xray_initial = [cfg for cfg, _ in live_configs if urlparse(cfg).scheme.lower() in XRAY_PROTOCOLS]
    singbox_initial = [cfg for cfg, _ in live_configs if urlparse(cfg).scheme.lower() in SINGBOX_PROTOCOLS]

    xray_final = xray_initial[:MAX_FINAL_CONFIGS_PER_CORE]
    singbox_final = singbox_initial[:MAX_FINAL_CONFIGS_PER_CORE]

    # Fill Sing-box with common configs from Xray if needed
    if len(singbox_final) < MAX_FINAL_CONFIGS_PER_CORE:
        print("  Sing-box list is not full. Filling with common configs from Xray.")
        common_xray_configs = [cfg for cfg in xray_initial if urlparse(cfg).scheme.lower() in COMMON_PROTOCOLS]
        for cfg in common_xray_configs:
            if len(singbox_final) >= MAX_FINAL_CONFIGS_PER_CORE: break
            if cfg not in singbox_final:
                singbox_final.append(cfg)
    
    # Fill Xray with common configs from Sing-box if needed
    if len(xray_final) < MAX_FINAL_CONFIGS_PER_CORE:
        print("  Xray list is not full. Filling with common configs from Sing-box.")
        common_singbox_configs = [cfg for cfg in singbox_initial if urlparse(cfg).scheme.lower() in COMMON_PROTOCOLS]
        for cfg in common_singbox_configs:
            if len(xray_final) >= MAX_FINAL_CONFIGS_PER_CORE: break
            if cfg not in xray_final:
                xray_final.append(cfg)
    
    print(f"✅ Final Xray configs: {len(xray_final)} / {MAX_FINAL_CONFIGS_PER_CORE}")
    print(f"✅ Final Sing-box configs: {len(singbox_final)} / {MAX_FINAL_CONFIGS_PER_CORE}")

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower().replace('hysteria2', 'hy2').replace('shadowsocks', 'ss')
            grouped[proto].append(cfg)
        return dict(grouped)

    output_data = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 4. Writing output files ---")
    with open(os.path.join(OUTPUT_DIR, OUTPUT_JSON_FILE), 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    with open(os.path.join(OUTPUT_DIR, XRAY_RAW_FALLBACK_FILE), 'w', encoding='utf-8') as f:
        f.write("\n".join(xray_final))
    with open(os.path.join(OUTPUT_DIR, SINGBOX_RAW_FALLBACK_FILE), 'w', encoding='utf-8') as f:
        f.write("\n".join(singbox_final))
    with open(os.path.join(OUTPUT_DIR, CACHE_VERSION_FILE), 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print("✅ All output files written successfully.")

if __name__ == "__main__":
    main()
