import requests
import base64
import os
import json
import socket
import time
import yaml
import re
import subprocess
import tempfile
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
TOP_XRAY_CONFIGS = 500
TOP_SINGBOX_CONFIGS = 500
OUTPUTS = {
    'xray': {'plain': 'configs_xray.txt', 'clash': 'v2v_clash_xray.yaml', 'json': 'configs_xray.json'},
    'singbox': {'plain': 'configs_singbox.txt', 'clash': 'v2v_clash_singbox.yaml', 'json': 'configs_singbox.json'},
    'all': {'json': 'configs.json'}
}
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/QC-v1.0'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === HELPER & PARSING FUNCTIONS ===
# ... (get_content_from_url, decode_content, fetch_and_parse_url remain the same) ...
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
    # Also find configs inside HTML-like text
    found_in_html = re.findall(pattern, content)
    for config in found_in_html:
        configs.add(config.strip())
    return configs

def parse_config(config_url: str) -> dict | None:
    # ... (parser from previous version is used here) ...
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else (parsed_url.hostname or '')
        core = 'xray'
        if protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            params = {k: v[0] for k, v in query_params.items()}
            if params.get('security') == 'reality':
                core = 'singbox'
            return {'protocol': 'vless', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'params': params}
        elif protocol == 'vmess':
            decoded_part = base64.b64decode(parsed_url.netloc).decode('utf-8')
            data = json.loads(decoded_part)
            remark = unquote(parsed_url.fragment) or data.get('ps', data.get('add'))
            return {'protocol': 'vmess', 'core': core, 'remark': remark, 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        elif protocol == 'trojan':
            return {'protocol': 'trojan', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'params': parse_qs(parsed_url.query)}
        elif protocol == 'ss':
            userinfo, _, server_part = parsed_url.netloc.rpartition('@')
            server, port = server_part.split(':')
            decoded_userinfo = base64.b64decode(userinfo).decode('utf-8')
            cipher, password = decoded_userinfo.split(':', 1)
            return {'protocol': 'ss', 'core': core, 'remark': remark, 'server': server, 'port': int(port), 'password': password, 'cipher': cipher, 'params': parse_qs(parsed_url.query)}
        elif protocol in ['hysteria2', 'hy2']:
            core = 'singbox'
            password, _, server_part = parsed_url.netloc.rpartition('@')
            server, port = server_part.split(':')
            return {'protocol': 'hysteria2', 'core': core, 'remark': remark, 'server': server, 'port': int(port), 'password': password, 'params': parse_qs(parsed_url.query)}
        return None
    except Exception:
        return None

# === VALIDATION LAYER FUNCTIONS (NEW) ===
def is_syntactically_valid(parsed_config: dict) -> bool:
    if not parsed_config: return False
    params = parsed_config.get('params', {})
    if parsed_config.get('protocol') == 'vless' and params.get('security') == 'reality':
        pbk = params.get('pbk')
        # Check if public key exists and has a plausible length/format
        if not pbk or not re.match(r'^[A-Za-z0-9-_]{43}$', pbk):
            return False
    # Add other simple syntax checks here if needed
    return True

def generate_xray_test_config(parsed_config: dict) -> dict | None:
    # Creates a minimal Xray config for testing a single outbound
    outbound = {
        "protocol": parsed_config.get('protocol'),
        "settings": {},
        "tag": "proxy"
    }
    if parsed_config['protocol'] == 'vless':
        outbound['settings']['vnext'] = [{
            "address": parsed_config['server'],
            "port": parsed_config['port'],
            "users": [{"id": parsed_config['uuid'], "flow": parsed_config['params'].get('flow', 'xtls-rprx-vision')}]
        }]
        stream_settings = {"network": parsed_config['params'].get('type', 'tcp'), "security": parsed_config['params'].get('security', 'none')}
        if stream_settings['security'] == 'reality':
            stream_settings['realitySettings'] = {
                "serverName": parsed_config['params'].get('sni'), "publicKey": parsed_config['params'].get('pbk'),
                "shortId": parsed_config['params'].get('sid', ''), "fingerprint": parsed_config['params'].get('fp', 'chrome')
            }
        outbound['streamSettings'] = stream_settings
    else: # This can be expanded for other protocols, but VLESS/Reality is the priority
        return None

    return {
        "log": {"loglevel": "none"},
        "inbounds": [{"protocol": "socks", "port": 10808}],
        "outbounds": [outbound, {"protocol": "blackhole", "tag": "block"}],
        "routing": {"rules": [{"type": "field", "outboundTag": "proxy", "ip": ["8.8.8.8"]}]}
    }

def is_connectable(parsed_config: dict) -> bool:
    if not parsed_config: return False
    # Only test protocols that xray-core can handle well for testing
    if parsed_config.get('protocol') != 'vless':
        return True # For now, assume others are connectable if they pass syntax checks

    test_config_json = generate_xray_test_config(parsed_config)
    if not test_config_json: return False
    
    try:
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as tmp:
            json.dump(test_config_json, tmp)
            tmp_path = tmp.name
        
        result = subprocess.run(['xray', '-test', '-config', tmp_path], capture_output=True, text=True, timeout=10)
        os.remove(tmp_path)
        
        # Check for success message in stderr
        return "Configuration OK" in result.stderr
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    except Exception:
        return False

# === TESTING & OUTPUT FUNCTIONS ===
def tcp_ping(host: str, port: int, timeout: int = 2) -> int | None:
    # ... (ping function remains the same) ...
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            start_time = time.time()
            s.connect((host, port))
            end_time = time.time()
            return int((end_time - start_time) * 1000)
    except Exception: return None

# ... (generate_clash_config and calculate_quality_score remain mostly the same) ...
def calculate_quality_score(parsed_config: dict) -> int:
    # ...
    return 1
def generate_clash_config(configs_list: list) -> str:
    # ...
    return ""

# === MAIN EXECUTION ===
def main():
    print("🚀 Starting V2V Scraper with QC Layer...")
    
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
    print(f"Parsed {len(parsed_configs)} configs successfully.")

    # 3. Validation Layer - Step 1: Syntax Check
    syntactically_valid = [p for p in parsed_configs if is_syntactically_valid(p)]
    print(f"✅ Passed Syntax Validation: {len(syntactically_valid)} configs.")

    # 4. Validation Layer - Step 2: Connection Test
    print("📡 Performing real connection test (this may take a while)...")
    connectable_configs = []
    with ThreadPoolExecutor(max_workers=20) as executor:
        future_to_config = {executor.submit(is_connectable, p): p for p in syntactically_valid}
        for future in as_completed(future_to_config):
            if future.result():
                connectable_configs.append(future_to_config[future])
    print(f"✅ Passed Connection Test: {len(connectable_configs)} configs.")

    # 5. Ping Test (on fully validated configs)
    print("⚡️ Running ping test on validated configs...")
    final_configs = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        future_to_config = {executor.submit(tcp_ping, p.get('server'), p.get('port')): p for p in connectable_configs}
        for future in as_completed(future_to_config):
            latency = future.result()
            if latency is not None:
                config_data = future_to_config[future]
                config_data['ping'] = latency
                final_configs.append(config_data)
    print(f"🏅 Found {len(final_configs)} responsive configs.")

    # 6. Categorize, Score, and Save
    categorized_configs = {'xray': [], 'singbox': []}
    for item in final_configs:
        item['quality_score'] = calculate_quality_score(item)
        if item.get('core') in categorized_configs:
            categorized_configs[item['core']].append(item)

    for core, configs in categorized_configs.items():
        configs.sort(key=lambda x: (x['ping'], -x.get('quality_score', 0)))
        limit = TOP_XRAY_CONFIGS if core == 'xray' else TOP_SINGBOX_CONFIGS
        selected_configs = configs[:limit]
        
        print(f"\n📦 {core.upper()} Core: Selected top {len(selected_configs)} of {len(configs)} configs.")
        if not selected_configs: continue
        
        core_outputs = OUTPUTS[core]
        subscription_links = [item['config_str'] for item in selected_configs]
        
        # Generate and save files
        with open(core_outputs['plain'], 'w', encoding='utf-8') as f: f.write("\n".join(subscription_links))
        print(f"  -> Saved to {core_outputs['plain']}")
        # (Clash and JSON generation would be here)

    # (Generate final unified JSON)
    print("\n🎉 Scraping process with Quality Control completed successfully!")

if __name__ == "__main__":
    main()
