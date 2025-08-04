import requests
import base64
import os
import json
import socket
import time
import yaml
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION ===
BASE_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/All_Configs_Sub.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt","https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt","https://raw.githubusercontent.com/MrPooyaX/V2Ray/main/sub/mix","https://raw.githubusercontent.com/yebekhe/Configura/main/Sub/Normal/Sub.txt","https://raw.githubusercontent.com/soroushmirzaei/V2Ray-configs/main/All-Configs-base64","https://raw.githubusercontent.com/mrvcoder/V2rayCollector/main/sub/mix_base64","https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/all.txt","https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt","https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/All-Configs-for-V2Ray.txt","https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/sub/subscription_base64.txt","https://raw.githubusercontent.com/Argh94/V2RayAutoConfig/main/sub/sub_merge.txt","https://raw.githubusercontent.com/NiREvil/vless/main/sub/vless.txt","https://raw.githubusercontent.com/NiREvil/vless/main/XRAY/vless.txt","https://raw.githubusercontent.com/4n0nymou3/multi-proxy-config-fetcher/main/configs/proxy_configs.txt","https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]
GITHUB_SEARCH_KEYWORDS = ['v2ray subscription', 'vless subscription', 'vmess subscription']
TOP_N_CONFIGS = 500
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_CLASH = 'v2v_clash.yaml'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')

# === SECRET KEYS ===
GITLAB_SNIPPET_ID = os.environ.get('GITLAB_SNIPPET_ID')
GITLAB_API_TOKEN = os.environ.get('GITLAB_API_TOKEN')
GITHUB_PAT = os.environ.get('GH_PAT')
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')

# === HELPER FUNCTIONS ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers={'User-Agent': 'V2V-Scraper/6.0'})
        response.raise_for_status()
        return response.text
    except requests.RequestException: return None

def decode_content(content: str) -> list[str]:
    try: return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception: return content.strip().splitlines()

def parse_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else parsed_url.hostname
        protocol = parsed_url.scheme
        
        if protocol == 'vmess':
            decoded_part = base64.b64decode(parsed_url.netloc).decode()
            data = json.loads(decoded_part)
            return {'protocol': protocol, 'remark': data.get('ps', 'V2V-VMess'), 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        
        query_params = parse_qs(parsed_url.query)
        params = {k: v[0] for k, v in query_params.items()}
        
        return {'protocol': protocol, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'password': parsed_url.password, 'params': params}
    except Exception: return None

def tcp_ping(host: str, port: int, timeout: int = 2) -> int | None:
    if not host or not port: return None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            start_time = time.time()
            s.connect((host, port))
            end_time = time.time()
            return int((end_time - start_time) * 1000)
    except Exception: return None

def test_config_latency(config: str) -> tuple[str, int] | None:
    parsed = parse_config(config)
    if parsed:
        latency = tcp_ping(parsed.get('server'), parsed.get('port'))
        if latency is not None: return (config, latency)
    return None

def generate_clash_config(configs_list: list) -> str:
    proxies = []
    for i, config_str in enumerate(configs_list):
        try:
            parsed = parse_config(config_str)
            if not parsed: continue
            
            proxy = {'name': parsed['remark'] or f"{parsed['protocol']}-{i+1}", 'type': parsed['protocol'], 'server': parsed['server'], 'port': parsed['port']}
            
            if parsed['protocol'] in ['vless', 'vmess']:
                proxy['uuid'] = parsed['uuid']
                proxy.update({'udp': True, 'tls': parsed['params'].get('security') == 'tls', 'servername': parsed['params'].get('sni', parsed['server']), 'network': parsed['params'].get('type', 'ws'), 'ws-opts': {'path': parsed['params'].get('path', '/')}})
            elif parsed['protocol'] in ['trojan', 'ss']:
                proxy['password'] = parsed['uuid'] or parsed['password']
                if parsed['protocol'] == 'ss':
                    proxy['cipher'] = 'auto' # Clash can often auto-detect cipher

            proxies.append(proxy)
        except Exception: continue

    clash_config = {
        'port': 7890, 'socks-port': 7891, 'allow-lan': False, 'mode': 'rule', 'log-level': 'info', 'proxies': proxies,
        'proxy-groups': [
            {'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300},
            {'name': 'V2V-Select', 'type': 'select', 'proxies': [p['name'] for p in proxies]}
        ],
        'rules': ['DOMAIN-SUFFIX,ir,DIRECT', 'MATCH,V2V-Auto']
    }
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

def main():
    print("🚀 Starting V2V Smart Scraper...")
    all_sources = set(BASE_SOURCES)
    all_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(get_content_from_url, all_sources):
            if result:
                for config in decode_content(result):
                    if config.strip().startswith(VALID_PREFIXES): all_configs.add(config.strip())
    print(f"Found {len(all_configs)} unique configs.")
    if not all_configs: print("No configs found. Aborting."); return
    print("\n⚡️ Testing latency of configs...")
    working_configs = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        for result in executor.map(test_config_latency, all_configs):
            if result: working_configs.append(result)
    print(f"Found {len(working_configs)} responsive configs.")
    if not working_configs: print("No working configs found to save. Aborting."); return
    working_configs.sort(key=lambda x: x[1])
    top_configs = [cfg for cfg, lat in working_configs[:TOP_N_CONFIGS]]
    print(f"🏅 Selected top {len(top_configs)} configs.")
    final_content_plain = "\n".join(top_configs)
    with open(OUTPUT_FILE_PLAIN, 'w', encoding='utf-8') as f: f.write(final_content_plain)
    print(f"💾 Successfully saved plain text configs to {OUTPUT_FILE_PLAIN}")
    clash_content = generate_clash_config(top_configs)
    with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f: f.write(clash_content)
    print(f"💾 Successfully saved Clash.Meta config to {OUTPUT_FILE_CLASH}")

if __name__ == "__main__":
    main()
