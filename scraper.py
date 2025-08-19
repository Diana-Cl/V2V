import requests
import base64
import os
import json
import socket
import time
import yaml
import uuid
import re
import ssl # <-- ماژول اضافه شده برای تست پیشرفته TLS
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, unquote

# === CONFIGURATION ===
INITIAL_BASE_SOURCES = [
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/soroushmirzaei/V2Ray-configs/main/All-Configs-base64",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://robin.nscl.ir",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html"
]
SOURCES_STATUS_FILE = 'sources_status.json'
FAILED_SOURCES_LOG = 'failed_sources.log'
INACTIVE_DAYS_THRESHOLD = 30
GITHUB_SEARCH_KEYWORDS = ['vless reality subscription', 'hysteria2 subscription', 'tuic subscription']
TOP_N_CONFIGS = 1000 # افزایش تعداد برای شانس بیشتر
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_CLASH = 'v2v_clash.yaml'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')

# === SECRET KEYS ===
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/v4.0-AntiFilter'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === (REFACTOR) MODULE 1: DECODING & PARSING (UNCHANGED) ===
def safe_b64decode(s: str) -> str:
    padding = '=' * (-len(s) % 4)
    try: return base64.b64decode(s + padding).decode('utf-8')
    except Exception: return ""

def parse_config(config_url: str) -> dict | None:
    try:
        uri = urlparse(config_url)
        if uri.scheme == 'vmess':
            decoded = safe_b64decode(uri.netloc)
            if not decoded: return None
            data = json.loads(decoded)
            return {'protocol': 'vmess', 'remark': unquote(uri.fragment) or data.get('ps'), 'server': data.get('add'), 'port': int(data.get('port', 0)), 'params': data}
        # Simplified parser for brevity. A full parser like in v3 should be used for full protocol support.
        return {'protocol': uri.scheme, 'remark': unquote(uri.fragment), 'server': uri.hostname, 'port': uri.port, 'params': {}}
    except Exception: return None

# === (REFACTOR) MODULE 2: ADVANCED ANTI-FILTERING TESTS ===
def tcp_ping(host: str, port: int, timeout: int = 1) -> bool:
    """Stage 1: Quick check if the port is open."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False

def tls_handshake(host: str, port: int, sni: str = None, timeout: int = 2) -> int | None:
    """Stage 2: Smarter test to check for DPI/Firewall interference."""
    if not sni: sni = host
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=sni) as ssock:
                start_time = time.time()
                ssock.do_handshake()
                end_time = time.time()
                # Check certificate if available
                # cert = ssock.getpeercert() 
                return int((end_time - start_time) * 1000)
    except (ssl.SSLError, socket.timeout, ConnectionRefusedError, OSError):
        return None

def advanced_config_test(config: dict) -> tuple[dict, int] | None:
    """The new two-stage testing pipeline."""
    host = config.get('server')
    port = config.get('port')
    if not host or not port:
        return None

    # --- STAGE 1: TCP PING ---
    if not tcp_ping(host, port):
        return None # Fail fast if port is not even open

    # --- STAGE 2: TLS HANDSHAKE (FOR TLS-ENABLED CONFIGS) ---
    # This logic should be expanded based on config params to detect if it's a TLS connection
    is_tls = config['protocol'] in ['vless', 'trojan'] or (config['protocol'] == 'vmess' and config.get('params', {}).get('tls') == 'tls')

    if is_tls:
        sni = config.get('params', {}).get('sni', host)
        latency = tls_handshake(host, port, sni)
        if latency:
            return (config, latency)
    else: # For non-TLS configs, we rely on the ping and assume it's OK for now
          # A more advanced test for non-TLS would be needed for higher accuracy
        return (config, 999) # Assign a high latency to non-TLS for now

    return None

# === CORE OPERATIONS (UNCHANGED) ===
# Functions like get_content_from_url, state management, Clash generation, etc.
# These functions are simplified here to focus on the testing logic.
# Use the full functions from v3 for a complete script.
def get_content_from_url(url: str):
    try:
        r = requests.get(url, timeout=10, headers=HEADERS)
        r.raise_for_status()
        return r.text
    except Exception: return None

def fetch_and_parse_url(url: str) -> list[dict] | None:
    content = get_content_from_url(url)
    if not content: return None
    decoded = safe_b64decode(content) or content
    lines = decoded.strip().splitlines()
    parsed = [parse_config(line) for line in lines if line]
    return [p for p in parsed if p]


def main():
    print("🚀 Starting V2V Scraper v4.0 (Advanced Anti-Filter Test)...")
    # State management logic should be here...
    
    # For demonstration, we use a small, fixed list of sources
    all_sources = INITIAL_BASE_SOURCES 
    
    print(f"\n🚚 Fetching and parsing from {len(all_sources)} sources...")
    all_parsed_configs = []
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, all_sources):
            if results: all_parsed_configs.extend(results)

    print(f"Found {len(all_parsed_configs)} total configs. Starting advanced testing pipeline...")
    if not all_parsed_configs: print("No configs found. Aborting."); return

    # --- THE NEW TESTING PIPELINE IN ACTION ---
    working_configs = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        future_to_config = {executor.submit(advanced_config_test, p): p for p in all_parsed_configs}
        for future in as_completed(future_to_config):
            result = future.result()
            if result:
                working_configs.append(result)

    print(f"\n✅ Pipeline finished. Found {len(working_configs)} responsive configs after advanced filtering.")
    if not working_configs: print("No working configs survived the filter. Try again later or add more sources."); return

    working_configs.sort(key=lambda x: x[1]) # Sort by latency
    top_configs_parsed = [p for p, lat in working_configs[:TOP_N_CONFIGS]]

    # Generate output files (logic from previous versions)
    # For now, just print the top 5 successful configs
    print(f"\n🏅 Top 5 configs that passed all tests:")
    for config, latency in working_configs[:5]:
        print(f"  - {config.get('remark', 'N/A')} ({latency}ms)")

    # Here you would generate the Clash and plain text files
    # clash_content = generate_clash_config_file(top_configs_parsed)
    # with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f: f.write(clash_content)
    # print(f"\n💾 Successfully saved advanced Clash config to {OUTPUT_FILE_CLASH}")


if __name__ == "__main__":
    # Note: This is a conceptual implementation of the testing logic.
    # It should be integrated into the full v3 script for all features.
    main()

