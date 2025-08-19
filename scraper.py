import requests
import base64
import os
import json
import socket
import time
import yaml
import uuid
import re
import ssl
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed # <-- خطای اصلی اینجا اصلاح شد
from urllib.parse import urlparse, unquote, parse_qs

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
TOP_N_CONFIGS = 1000
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_CLASH = 'v2v_clash.yaml'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')

# === SECRET KEYS ===
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/v4.1-AntiFilter'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === MODULE 1: DECODING & PARSING ===
def safe_b64decode(s: str) -> str:
    padding = '=' * (-len(s) % 4)
    try: return base64.b64decode(s + padding).decode('utf-8')
    except Exception: return ""

def parse_config(config_url: str) -> dict | None:
    try:
        uri = urlparse(config_url)
        if not uri.scheme in [p.replace('://','') for p in VALID_PREFIXES]: return None
        
        remark = unquote(uri.fragment) or uri.hostname
        params = parse_qs(uri.query)
        
        if uri.scheme == 'vmess':
            decoded = safe_b64decode(uri.netloc)
            if not decoded: return None
            data = json.loads(decoded)
            return {'protocol': 'vmess', 'remark': remark, 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        
        # Generic parser for other protocols
        credential = uri.username
        if uri.scheme == 'ss':
             user_info, _, _ = uri.netloc.rpartition('@')
             decoded_user = safe_b64decode(user_info)
             if not decoded_user: return None
             _, credential = decoded_user.split(':', 1)
        
        return {'protocol': uri.scheme, 'remark': remark, 'server': uri.hostname, 'port': uri.port, 'credential': credential, 'params': params}
    except Exception: return None

# === MODULE 2: ADVANCED ANTI-FILTERING TESTS ===
def tcp_ping(host: str, port: int, timeout: int = 1) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout): return True
    except Exception: return False

def tls_handshake(host: str, port: int, sni: str = None, timeout: int = 2) -> int | None:
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
                return int((end_time - start_time) * 1000)
    except Exception: return None

def advanced_config_test(config: dict) -> tuple[dict, int] | None:
    host, port = config.get('server'), config.get('port')
    if not host or not port: return None

    if not tcp_ping(host, port): return None

    is_tls = config.get('params', {}).get('security', [''])[0] in ['tls', 'reality'] or config['protocol'] in ['trojan']
    if is_tls:
        sni = config.get('params', {}).get('sni', [host])[0]
        latency = tls_handshake(host, port, sni)
        if latency: return (config, latency)
    else:
        # For non-TLS, a successful ping is our only metric. Assign a default high latency.
        return (config, 999) 
    return None

# === MODULE 3: CLASH & OUTPUT GENERATION ===
def generate_clash_config_file(configs: list) -> str:
    proxies = []
    # Simplified clash generation for brevity. Use v3's modular generator for full features.
    for p in configs:
        if p.get('protocol') == 'vless':
            proxies.append({'name': p['remark'], 'type': 'vless', 'server': p['server'], 'port': p['port'], 'uuid': p.get('credential'), 'udp': True})
    
    clash_config = {'proxies': proxies,
        'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}],
        'rules': ['MATCH,V2V-Auto']}
    return yaml.dump(clash_config, allow_unicode=True)

# === CORE OPERATIONS & STATE MANAGEMENT ===
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

# (Add full state management functions: load_sources_status, save_sources_status, etc. here from previous versions)

def main():
    print("🚀 Starting V2V Scraper v4.1 (Advanced Anti-Filter Test)...")
    # Full state management logic should be integrated here for a complete script.
    
    all_sources = INITIAL_BASE_SOURCES
    
    print(f"\n🚚 Fetching and parsing from {len(all_sources)} sources...")
    all_parsed_configs = []
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, all_sources):
            if results: all_parsed_configs.extend(results)

    print(f"Found {len(all_parsed_configs)} total configs. Starting advanced testing pipeline...")
    if not all_parsed_configs: print("No configs found. Aborting."); return

    working_configs = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        future_to_config = {executor.submit(advanced_config_test, p): p for p in all_parsed_configs}
        for future in as_completed(future_to_config): # This line will now work
            result = future.result()
            if result: working_configs.append(result)

    print(f"\n✅ Pipeline finished. Found {len(working_configs)} responsive configs after advanced filtering.")
    if not working_configs: print("No working configs survived. Try again later or add more sources."); return

    working_configs.sort(key=lambda x: x[1])
    top_configs_data = working_configs[:TOP_N_CONFIGS]
    
    print(f"\n🏅 Top 5 configs that passed all tests:")
    for config, latency in top_configs_data[:5]:
        print(f"  - {config.get('remark', 'N/A')} ({latency}ms)")

    # Generate output files
    clash_content = generate_clash_config_file([p for p, l in top_configs_data])
    with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f: f.write(clash_content)
    print(f"\n💾 Successfully saved Clash config to {OUTPUT_FILE_CLASH}")

    # A proper reverse parser is needed to generate the plain text file.
    # For now, this is omitted for simplicity as requested.


if __name__ == "__main__":
    main()
