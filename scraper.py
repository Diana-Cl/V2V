import requests
import base64
import os
import json
import socket
import time
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION ===
SUBSCRIPTION_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt", "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime", "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix", "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub4.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub5.txt", "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt", "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/detailed/vless/2087.txt", "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]
OUTPUT_JSON_FILE = 'all_live_configs.json'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Final-v3.0'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === HELPER & PARSING FUNCTIONS ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except requests.RequestException:
        return None

def decode_content(content: str) -> list[str]:
    try:
        return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception:
        return content.strip().splitlines()

def fetch_and_parse_url(url: str) -> set[str]:
    content = get_content_from_url(url)
    if not content: return set()
    configs = set()
    lines = decode_content(content)
    pattern = r'(' + '|'.join([p.replace('://', r'://[^\s\'"<]+') for p in VALID_PREFIXES]) + ')'
    for line in lines:
        if line.strip().startswith(VALID_PREFIXES):
            configs.add(line.strip())
    found_in_html = re.findall(pattern, content)
    for config in found_in_html:
        configs.add(config.strip())
    return configs

def parse_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        core = 'xray'
        if protocol in ['hysteria2', 'hy2', 'tuic']:
            core = 'singbox'
        elif protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            if query_params.get('security', [''])[0] == 'reality':
                core = 'singbox'

        server, port = None, None
        if protocol == 'vmess':
            # Handle potential padding errors in base64
            netloc = parsed_url.netloc
            padded_netloc = netloc + '=' * (-len(netloc) % 4)
            decoded_part = base64.b64decode(padded_netloc).decode('utf-8')
            data = json.loads(decoded_part)
            server, port = data.get('add'), int(data.get('port', 0))
        elif protocol == 'ss':
            userinfo, _, server_part = parsed_url.netloc.rpartition('@')
            server, port_str = server_part.split(':')
            port = int(port_str)
        else: # Covers vless, trojan, hysteria2, tuic
            server, port = parsed_url.hostname, parsed_url.port
        
        if server and port:
            return {'core': core, 'server': server, 'port': port, 'config_str': config_url}
        return None
    except Exception:
        return None

# === VALIDATION FUNCTION (TCP HEALTH CHECK) ===
def is_connectable(parsed_config: dict, timeout: int = 2) -> tuple[bool, dict]:
    """Performs a simple and fast TCP ping to check if the server port is open."""
    if not parsed_config:
        return False, None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect((parsed_config['server'], parsed_config['port']))
        return True, parsed_config
    except Exception:
        return False, None

# === MAIN EXECUTION (FINALIZED FLOW) ===
def main():
    print("🚀 V2V Scraper - Final Backend Stage")
    
    # 1. Fetch
    print(f"🚚 Fetching configs from {len(SUBSCRIPTION_SOURCES)} sources...")
    all_configs_raw = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, SUBSCRIPTION_SOURCES):
            all_configs_raw.update(results)
    print(f"Found {len(all_configs_raw)} unique raw configs.")

    # 2. Parse
    parsed_configs = []
    with ThreadPoolExecutor(max_workers=50) as executor:
        for result in executor.map(parse_config, all_configs_raw):
            if result:
                parsed_configs.append(result)
    print(f"Successfully parsed {len(parsed_configs)} configs.")
    
    # 3. Validation (Health Check for all configs)
    print(f"📡 Performing connectivity test on all {len(parsed_configs)} candidates...")
    validated_configs = {'xray': [], 'singbox': []}
    
    with ThreadPoolExecutor(max_workers=200) as executor:
        future_to_config = {executor.submit(is_connectable, p): p for p in parsed_configs}
        for future in as_completed(future_to_config):
            is_live, config_data = future.result()
            if is_live and config_data:
                core = config_data.get('core')
                if core in validated_configs:
                    validated_configs[core].append(config_data['config_str'])

    print(f"✅ Validation Complete. Found {len(validated_configs['xray'])} connectable Xray and {len(validated_configs['singbox'])} connectable Sing-box configs.")

    # 4. Generate Final JSON for Frontend (No limits)
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(validated_configs, f, ensure_ascii=False)
        
    print(f"\n💾 Output for frontend saved to {OUTPUT_JSON_FILE}")
    print("🎉 Backend process completed successfully!")

if __name__ == "__main__":
    main()
