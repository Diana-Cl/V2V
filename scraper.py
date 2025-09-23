# scraper.py

import json
import base64
import time
import re
from urllib.parse import urlparse, parse_qs, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import socket
import ssl
import os

# --- configuration ---
SOURCES_FILE = 'sources.json'
OUTPUT_DIR = 'output'  # Directory for all generated files
CONFIGS_JSON_FALLBACK = 'configs.json' # Main fallback file for GH Pages
XRAY_RAW_FALLBACK = 'xray_raw_configs.txt'
SINGBOX_RAW_FALLBACK = 'singbox_raw_configs.txt'
CACHE_VERSION_FILE = 'cache_version.txt'

GITHUB_PAT = os.getenv('GH_PAT', '')
GITHUB_SEARCH_LIMIT = int(os.getenv('GITHUB_SEARCH_LIMIT', 500))

# Test parameters
MAX_CONFIGS_TO_TEST = 3000
MAX_LATENCY_MS = 1500
MAX_TEST_WORKERS = 100
TEST_TIMEOUT_SEC = 8

# Final config selection parameters
MAX_FINAL_CONFIGS_PER_CORE = 1000

# Protocols
XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hy2', 'hysteria2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_PROTOCOLS)

# Ensure output directory exists
os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- helpers ---
def fetch_url_content(url: str, headers: dict = None) -> str | None:
    try:
        import requests
        if headers is None:
            headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=TEST_TIMEOUT_SEC)
        response.raise_for_status()
        
        content = response.text
        try:
            # Attempt to decode if it looks like base64
            decoded_content = base64.b64decode(content).decode('utf-8')
            return decoded_content
        except (base64.binascii.Error, UnicodeDecodeError):
            return content # Not base64, return as is
            
    except requests.exceptions.RequestException:
        return None

def fetch_from_sources(sources: list[str]) -> set[str]:
    print("  Fetching from static sources...")
    collected = set()
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36'}
    
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(fetch_url_content, url, headers): url for url in sources}
        for i, future in enumerate(as_completed(futures)):
            content = future.result()
            if content:
                for line in content.splitlines():
                    line = line.strip()
                    if any(line.lower().startswith(p + "://") for p in VALID_PROTOCOLS):
                        collected.add(line)
            if (i + 1) % 10 == 0:
                print(f"  Fetched from {i+1} sources...")
    print(f"  ✅ Found {len(collected)} configs from static sources.")
    return collected

def fetch_from_github(pat: str, search_limit: int) -> set[str]:
    print("  Fetching from GitHub...")
    collected = set()
    try:
        import requests
        headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/vnd.github.v3.raw'
        }
        if pat:
            headers['Authorization'] = f'token {pat}'
        else:
            print("  ⚠️ GitHub PAT not provided. Using unauthenticated requests with lower rate limits.")

        queries = [
            'filename:vless', 'filename:vmess', 'filename:trojan', 'filename:ss', 'filename:hy2', 'filename:tuic',
            'filename:hysteria', 'filename:shadowsocks', 'path:*.txt "vless://"', 'path:*.yaml "vless://"'
        ]
        
        for query in queries:
            if len(collected) >= search_limit:
                print(f"  Reached GitHub search limit ({search_limit}). Stopping.")
                break
            
            api_url = f"https://api.github.com/search/code?q={query}+size:1..10000&per_page=100"
            response = requests.get(api_url, headers=headers, timeout=TEST_TIMEOUT_SEC)
            response.raise_for_status()
            
            items = response.json().get('items', [])
            with ThreadPoolExecutor(max_workers=20) as executor:
                fetch_futures = {}
                for item in items:
                    if len(collected) + len(fetch_futures) >= search_limit: break
                    raw_url = item['html_url'].replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
                    fetch_futures[executor.submit(fetch_url_content, raw_url, headers)] = raw_url

                for future in as_completed(fetch_futures):
                    content = future.result()
                    if content:
                        for line in content.splitlines():
                            line = line.strip()
                            if any(line.lower().startswith(p + "://") for p in VALID_PROTOCOLS):
                                collected.add(line)
        
    except Exception as e:
        print(f"  ⚠️ An error occurred during GitHub fetching: {e}")
    print(f"  ✅ Found {len(collected)} configs from GitHub.")
    return collected

def parse_config_for_test(config_url: str) -> dict | None:
    try:
        if config_url.startswith("vmess://"):
            decoded_vmess = json.loads(base64.b64decode(config_url[8:]).decode('utf-8'))
            return {'host': decoded_vmess.get('add'), 'port': int(decoded_vmess.get('port')), 'tls': decoded_vmess.get('tls') == 'tls', 'protocol': 'vmess'}
        
        url_parsed = urlparse(config_url)
        scheme = url_parsed.scheme.lower()
        query_params = parse_qs(url_parsed.query)

        if scheme in ['vless', 'trojan']:
            return {'host': url_parsed.hostname, 'port': int(url_parsed.port), 'tls': query_params.get('security', [''])[0] in ['tls', 'reality'], 'protocol': scheme}
        elif scheme == 'ss':
            return {'host': url_parsed.hostname, 'port': int(url_parsed.port), 'tls': False, 'protocol': 'ss'}
        elif scheme in ['hy2', 'hysteria2', 'tuic']:
            return {'host': url_parsed.hostname, 'port': int(url_parsed.port), 'tls': False, 'protocol': scheme, 'transport': 'udp'}
        
        return None
    except Exception:
        return None

def test_config(config_url: str) -> tuple[str, int] | None:
    details = parse_config_for_test(config_url)
    if not details: return None

    host, port, protocol, tls = details.get('host'), details.get('port'), details.get('protocol'), details.get('tls', False)
    if not host or not port: return None

    start_time = time.monotonic()
    try:
        if details.get('transport') == 'udp':
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TEST_TIMEOUT_SEC / 2)
                sock.sendto(b'ping', (host, port))
        else:
            with socket.create_connection((host, port), timeout=TEST_TIMEOUT_SEC) as sock:
                if tls:
                    context = ssl.create_default_context()
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                    with context.wrap_socket(sock, server_hostname=host) as ssock:
                        ssock.do_handshake()
        
        latency_ms = int((time.monotonic() - start_time) * 1000)
        return config_url, latency_ms
    except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError, Exception):
        return None

def main():
    print("--- 1. Loading sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        static_sources = sources_config.get("static", [])
        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit: {GITHUB_SEARCH_LIMIT}.")
    except Exception as e:
        print(f"FATAL: Cannot load {SOURCES_FILE}: {e}. Exiting."); return

    print("\n--- 2. Fetching configs ---")
    all_configs = set()
    all_configs.update(fetch_from_sources(static_sources))
    all_configs.update(fetch_from_github(GITHUB_PAT, GITHUB_SEARCH_LIMIT))
    
    if not all_configs: 
        print("FATAL: No configs found. Exiting."); return
    print(f"📊 Total unique configs collected: {len(all_configs)}")

    print(f"\n--- 3. Testing configs ---")
    live_configs = []
    configs_to_test = list(all_configs)[:MAX_CONFIGS_TO_TEST]
    print(f"  Testing {len(configs_to_test)} configs with {MAX_TEST_WORKERS} workers...")
    
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_config, cfg): cfg for cfg in configs_to_test}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: print(f"  Tested {i+1}/{len(configs_to_test)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS:
                live_configs.append(result)

    if not live_configs: 
        print("FATAL: No live configs found after testing. Exiting."); return
    live_configs.sort(key=lambda x: x[1])
    print(f"🏆 Found {len(live_configs)} live configs with latency <= {MAX_LATENCY_MS}ms.")

    print("\n--- 4. Grouping and finalizing configs ---")
    xray_pool = [cfg for cfg in live_configs if urlparse(cfg[0]).scheme.lower() in XRAY_PROTOCOLS]
    singbox_pool = [cfg for cfg in live_configs if urlparse(cfg[0]).scheme.lower() in SINGBOX_PROTOCOLS]
    
    xray_final_urls = [cfg[0] for cfg in xray_pool[:MAX_FINAL_CONFIGS_PER_CORE]]
    singbox_final_urls = [cfg[0] for cfg in singbox_pool[:MAX_FINAL_CONFIGS_PER_CORE]]

    print(f"✅ Finalized {len(xray_final_urls)} configs for Xray.")
    print(f"✅ Finalized {len(singbox_final_urls)} configs for Sing-box.")

    def group_by_protocol(configs: list[str]) -> dict:
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            if proto == 'shadowsocks': proto = 'ss'
            grouped[proto].append(cfg)
        return dict(grouped)

    output_data_for_kv = {
        "xray": group_by_protocol(xray_final_urls), 
        "singbox": group_by_protocol(singbox_final_urls)
    }

    print("\n--- 5. Writing local files for upload ---")
    with open(os.path.join(OUTPUT_DIR, 'all_live_configs.json'), 'w', encoding='utf-8') as f:
        json.dump(output_data_for_kv, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote KV data to {os.path.join(OUTPUT_DIR, 'all_live_configs.json')}.")

    with open(os.path.join(OUTPUT_DIR, CONFIGS_JSON_FALLBACK), 'w', encoding='utf-8') as f:
        json.dump(output_data_for_kv, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote fallback data to {os.path.join(OUTPUT_DIR, CONFIGS_JSON_FALLBACK)}.")
    
    with open(os.path.join(OUTPUT_DIR, XRAY_RAW_FALLBACK), 'w', encoding='utf-8') as f:
        f.write("\n".join(xray_final_urls))
    print(f"✅ Wrote raw Xray fallback to {os.path.join(OUTPUT_DIR, XRAY_RAW_FALLBACK)}.")
    
    with open(os.path.join(OUTPUT_DIR, SINGBOX_RAW_FALLBACK), 'w', encoding='utf-8') as f:
        f.write("\n".join(singbox_final_urls))
    print(f"✅ Wrote raw Sing-box fallback to {os.path.join(OUTPUT_DIR, SINGBOX_RAW_FALLBACK)}.")
    
    with open(os.path.join(OUTPUT_DIR, CACHE_VERSION_FILE), 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {os.path.join(OUTPUT_DIR, CACHE_VERSION_FILE)}.")
    
    print("\n--- Process completed successfully ---")

if __name__ == "__main__":
    main()
