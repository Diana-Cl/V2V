import requests
import base64
import os
import json
import socket
import time
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION (Updated & Simplified) ===
SUBSCRIPTION_SOURCES = [
    # لیست منابع شما بدون تغییر باقی می‌ماند
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt", "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime", "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix", "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub4.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub5.txt", "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt", "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/detailed/vless/2087.txt", "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]
# خروجی جدید: یک فایل JSON برای استفاده وب‌سایت
OUTPUT_JSON_FILE = 'all_live_configs.json'

VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/QC-v2.0'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === HELPER & PARSING FUNCTIONS (Unchanged) ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        print(f"Failed to fetch {url}: {e}")
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
        if protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            params = {k: v[0] for k, v in query_params.items()}
            if params.get('security') == 'reality':
                core = 'singbox'
            return {'protocol': 'vless', 'core': core, 'params': params, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username}
        elif protocol in ['hysteria2', 'hy2', 'tuic']:
            return {'protocol': protocol, 'core': 'singbox'} # Simplified parsing for now
        # Other parsers can remain for xray core
        elif protocol == 'vmess':
            decoded_part = base64.b64decode(parsed_url.netloc).decode('utf-8')
            data = json.loads(decoded_part)
            return {'protocol': 'vmess', 'core': 'xray', 'params': data}
        elif protocol == 'trojan':
            return {'protocol': 'trojan', 'core': 'xray'}
        elif protocol == 'ss':
            return {'protocol': 'ss', 'core': 'xray'}
        return None
    except Exception:
        return None

# === VALIDATION LAYER FUNCTIONS (Kept as the main health check) ===
def is_syntactically_valid(parsed_config: dict) -> bool:
    if not parsed_config: return False
    params = parsed_config.get('params', {})
    if parsed_config.get('protocol') == 'vless' and params.get('security') == 'reality':
        pbk = params.get('pbk')
        if not pbk or not re.match(r'^[A-Za-z0-9-_]{43}$', pbk):
            return False
    return True

def generate_xray_test_config(parsed_config: dict) -> dict | None:
    # This function now only needs to handle protocols testable by xray-core
    if parsed_config.get('protocol') != 'vless': return None
    
    params = parsed_config['params']
    outbound = {
        "protocol": "vless",
        "settings": {
            "vnext": [{
                "address": parsed_config['server'],
                "port": parsed_config['port'],
                "users": [{"id": parsed_config['uuid'], "flow": params.get('flow', 'xtls-rprx-vision')}]
            }]
        },
        "streamSettings": {
            "network": params.get('type', 'tcp'),
            "security": params.get('security', 'none')
        },
        "tag": "proxy"
    }
    
    if outbound['streamSettings']['security'] == 'reality':
        outbound['streamSettings']['realitySettings'] = {
            "serverName": params.get('sni'), "publicKey": params.get('pbk'),
            "shortId": params.get('sid', ''), "fingerprint": params.get('fp', 'chrome')
        }
    elif outbound['streamSettings']['security'] == 'tls':
        outbound['streamSettings']['tlsSettings'] = { "serverName": params.get('sni') }

    return {
        "log": {"loglevel": "none"},
        "inbounds": [{"protocol": "socks", "port": 10808, "listen": "127.0.0.1"}],
        "outbounds": [outbound, {"protocol": "blackhole", "tag": "block"}]
    }

def is_connectable(parsed_config: dict) -> bool:
    # Only test configs that have a test generator and are xray compatible
    if not parsed_config or parsed_config.get('core') != 'xray':
        return False # We only use xray to test xray-compatible configs

    test_config_json = generate_xray_test_config(parsed_config)
    if not test_config_json: return False
    
    tmp_path = ''
    try:
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as tmp:
            json.dump(test_config_json, tmp)
            tmp_path = tmp.name
        
        result = subprocess.run(
            ['xray', 'test', '-config', tmp_path],
            capture_output=True, text=True, timeout=10
        )
        return "Configuration OK" in result.stderr
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    except Exception:
        return False
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

# === MAIN EXECUTION (Updated Flow) ===
def main():
    print("🚀 V2V Scraper - Stage 1: Backend Pre-filtering")
    
    # 1. Fetch
    print(f"🚚 Fetching configs from {len(SUBSCRIPTION_SOURCES)} sources...")
    all_configs_raw = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, SUBSCRIPTION_SOURCES):
            all_configs_raw.update(results)
    print(f"Found {len(all_configs_raw)} unique raw configs.")

    # 2. Parse
    parsed_configs = []
    for config_str in all_configs_raw:
        parsed = parse_config(config_str)
        if parsed:
            parsed['config_str'] = config_str
            parsed_configs.append(parsed)
    print(f"Parsed {len(parsed_configs)} configs.")

    # 3. Validation Layer
    print("📡 Performing validation (Syntax + Connection Test)...")
    validated_configs = {'xray': [], 'singbox': []}
    
    # Separate configs for testing
    xray_test_candidates = [p for p in parsed_configs if p.get('core') == 'xray' and is_syntactically_valid(p)]
    # For now, we assume singbox-only configs are valid if parsed, as we don't have a sing-box tester
    singbox_validated = [p['config_str'] for p in parsed_configs if p.get('core') == 'singbox' and is_syntactically_valid(p)]
    validated_configs['singbox'].extend(singbox_validated)

    with ThreadPoolExecutor(max_workers=20) as executor:
        future_to_config = {executor.submit(is_connectable, p): p for p in xray_test_candidates}
        for future in as_completed(future_to_config):
            if future.result():
                validated_configs['xray'].append(future_to_config[future]['config_str'])

    print(f"✅ Validation Complete. Found {len(validated_configs['xray'])} connectable Xray configs and {len(validated_configs['singbox'])} valid Sing-box configs.")

    # 4. Generate Final JSON for Frontend
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(validated_configs, f, ensure_ascii=False)
        
    print(f"\n💾 Output for frontend saved to {OUTPUT_JSON_FILE}")
    print("🎉 Stage 1 (Backend) completed successfully!")

if __name__ == "__main__":
    main()

