# scraper.py

import json
import base64
import time
from urllib.parse import urlparse
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
GITHUB_SEARCH_LIMIT = 500

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
    """Fetches content from a single URL, with base64 decoding attempt."""
    try:
        if headers is None:
            headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=TEST_TIMEOUT_SEC)
        response.raise_for_status()
        content = response.text
        try:
            # Attempt to decode if it looks like base64
            return base64.b64decode(content).decode('utf-8')
        except (base64.binascii.Error, UnicodeDecodeError):
            return content # Not base64, return as is
    except requests.exceptions.RequestException:
        return None

def fetch_from_static_sources(static_sources: list[str]) -> set[str]:
    """Fetches configs from predefined static URLs."""
    print("  Fetching from static sources...")
    collected = set()
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36'}
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(fetch_url_content, url, headers) for url in static_sources}
        for future in as_completed(futures):
            content = future.result()
            if content:
                for line in content.splitlines():
                    line = line.strip()
                    if any(line.lower().startswith(p + "://") for p in VALID_PROTOCOLS):
                        collected.add(line)
    print(f"  ✅ Found {len(collected)} configs from static sources.")
    return collected

def fetch_from_github(pat: str, search_limit: int) -> set[str]:
    """Fetches configs from GitHub using API search."""
    print("  Fetching from GitHub...")
    collected = set()
    try:
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/vnd.github.v3.raw'}
        if pat:
            headers['Authorization'] = f'token {pat}'
        else:
            print("  ⚠️ GitHub PAT not provided, rate limits will be lower.")
        queries = ['filename:vless', 'filename:vmess', 'filename:trojan', 'filename:ss', 'filename:hy2', 'path:*.txt "vless://"']
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
        print(f"  ⚠️ An error occurred during GitHub fetching: {e}")
    print(f"  ✅ Found {len(collected)} configs from GitHub.")
    return collected

def test_config(config_url: str) -> tuple[str, int] | None:
    """Performs a basic TCP/TLS handshake test on a config URL."""
    try:
        parsed_url = urlparse(config_url)
        hostname = parsed_url.hostname
        port = parsed_url.port
        if not hostname or not port:
            return None
        
        is_tls = 'tls' in parsed_url.query or 'reality' in parsed_url.query or parsed_url.scheme in ['trojan', 'hy2', 'hysteria2']

        start_time = time.monotonic()
        with socket.create_connection((hostname, port), timeout=TEST_TIMEOUT_SEC) as sock:
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                    ssock.do_handshake()
        latency_ms = int((time.monotonic() - start_time) * 1000)
        return config_url, latency_ms
    except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError, Exception):
        return None

# --- main logic ---
def main():
    print("--- 1. Loading sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        static_sources = sources_config.get("static", [])
        print(f"✅ Loaded {len(static_sources)} static sources.")
    except Exception as e:
        print(f"FATAL: Cannot load {SOURCES_FILE}: {e}. Exiting."); return

    print("\n--- 2. Fetching configs ---")
    all_configs = fetch_from_static_sources(static_sources)
    all_configs.update(fetch_from_github(GITHUB_PAT, GITHUB_SEARCH_LIMIT))
    if not all_configs: print("FATAL: No configs found. Exiting."); return
    print(f"📊 Total unique configs collected: {len(all_configs)}")

    print(f"\n--- 3. Testing configs ---")
    live_configs_with_latency = []
    configs_to_test = list(all_configs)[:MAX_CONFIGS_TO_TEST]
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_config, cfg): cfg for cfg in configs_to_test}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: print(f"  Tested {i+1}/{len(configs_to_test)}...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS:
                live_configs_with_latency.append(result)
    if not live_configs_with_latency: print("FATAL: No live configs found. Exiting."); return
    live_configs_with_latency.sort(key=lambda x: x[1])
    print(f"🏆 Found {len(live_configs_with_latency)} live configs with latency <= {MAX_LATENCY_MS}ms.")

    print("\n--- 4. Grouping and finalizing configs ---")
    xray_pool = [cfg for cfg, lat in live_configs_with_latency if urlparse(cfg).scheme.lower() in XRAY_PROTOCOLS]
    singbox_pool = [cfg for cfg, lat in live_configs_with_latency if urlparse(cfg).scheme.lower() in SINGBOX_PROTOCOLS]
    xray_final = xray_pool[:MAX_FINAL_CONFIGS_PER_CORE]
    singbox_final = singbox_pool[:MAX_FINAL_CONFIGS_PER_CORE]
    print(f"✅ Finalized {len(xray_final)} configs for Xray and {len(singbox_final)} for Sing-box.")

    def group_by_protocol(configs: list[str]) -> dict:
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower().replace('hysteria2', 'hy2').replace('shadowsocks', 'ss')
            grouped[proto].append(cfg)
        return dict(grouped)

    output_data = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. Writing local files for upload ---")
    # File for KV and primary fallback
    with open(os.path.join(OUTPUT_DIR, OUTPUT_JSON_FILE), 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote main config to {os.path.join(OUTPUT_DIR, OUTPUT_JSON_FILE)}.")

    # Raw fallback files
    with open(os.path.join(OUTPUT_DIR, XRAY_RAW_FALLBACK_FILE), 'w', encoding='utf-8') as f:
        f.write("\n".join(xray_final))
    print(f"✅ Wrote raw Xray fallback to {os.path.join(OUTPUT_DIR, XRAY_RAW_FALLBACK_FILE)}.")
    
    with open(os.path.join(OUTPUT_DIR, SINGBOX_RAW_FALLBACK_FILE), 'w', encoding='utf-8') as f:
        f.write("\n".join(singbox_final))
    print(f"✅ Wrote raw Sing-box fallback to {os.path.join(OUTPUT_DIR, SINGBOX_RAW_FALLBACK_FILE)}.")
    
    # Cache version file
    with open(os.path.join(OUTPUT_DIR, CACHE_VERSION_FILE), 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print(f"✅ Wrote cache version to {os.path.join(OUTPUT_DIR, CACHE_VERSION_FILE)}.")
    
    print("\n--- Process completed successfully ---")

if __name__ == "__main__":
    main()
