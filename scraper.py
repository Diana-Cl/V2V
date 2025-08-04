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
GITHUB_PAT = os.environ.get('GH_PAT')

# === HELPER FUNCTIONS ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers={'User-Agent': 'V2V-Scraper/Final'})
        response.raise_for_status()
        return response.text
    except requests.RequestException: return None

def decode_content(content: str) -> list[str]:
    try: return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception: return content.strip().splitlines()

def discover_github_sources() -> set[str]:
    if not GITHUB_PAT:
        print("GitHub PAT not found, skipping dynamic discovery.")
        return set()
    print("🔍 Discovering new sources from GitHub...")
    headers = {'Authorization': f'token {GITHUB_PAT}'}
    discovered_urls = set()
    for keyword in GITHUB_SEARCH_KEYWORDS:
        params = {'q': f'"{keyword}" in:readme,description', 'sort': 'updated', 'per_page': 10}
        try:
            response = requests.get("https://api.github.com/search/repositories", headers=headers, params=params, timeout=20)
            response.raise_for_status()
            for repo in response.json().get('items', []):
                for filename in ['sub.txt', 'all.txt', 'vless.txt', 'vmess.txt', 'configs.txt']:
                    discovered_urls.add(f"https://raw.githubusercontent.com/{repo['full_name']}/{repo['default_branch']}/{filename}")
        except requests.RequestException as e:
            print(f"Failed to search GitHub with keyword '{keyword}': {e}")
            continue
    print(f"Discovered {len(discovered_urls)} potential new source URLs.")
    return discovered_urls

def parse_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else parsed_url.hostname
        protocol = parsed_url.scheme
        
        if protocol == 'vmess':
            if len(parsed_url.netloc) % 4 != 0: netloc_padded = parsed_url.netloc + '=' * (4 - len(parsed_url.netloc) % 4)
            else: netloc_padded = parsed_url.netloc
            data = json.loads(base64.b64decode(netloc_padded).decode())
            return {'protocol': protocol, 'remark': data.get('ps', 'V2V-VMess'), 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        
        if protocol == 'ss':
            userinfo, _, server_part = parsed_url.netloc.rpartition('@')
            if len(userinfo) % 4 != 0: userinfo_padded = userinfo + '=' * (4 - len(userinfo) % 4)
            else: userinfo_padded = userinfo
            decoded_userinfo = base64.b64decode(userinfo_padded).decode()
            cipher, password = decoded_userinfo.split(':', 1)
            return {'protocol': protocol, 'remark': remark, 'server': server_part.split(':')[0], 'port': int(server_part.split(':')[1]), 'password': password, 'cipher': cipher}

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
            
            if parsed['protocol'] == 'vless':
                proxy.update({'uuid': parsed['uuid'], 'udp': True, 'tls': parsed['params'].get('security') == 'tls', 'servername': parsed['params'].get('sni', parsed['server']), 'network': parsed['params'].get('type', 'ws'), 'ws-opts': {'path': parsed['params'].get('path', '/')}})
            elif parsed['protocol'] == 'vmess':
                 proxy.update({'uuid': parsed['uuid'], 'alterId': int(parsed['params'].get('aid', 0)), 'cipher': parsed['params'].get('scy', 'auto'), 'udp': True, 'tls': parsed['params'].get('tls') == 'tls', 'servername': parsed['params'].get('sni', parsed['server']), 'network': parsed['params'].get('net', 'ws'), 'ws-opts': {'path': parsed['params'].get('path', '/')}})
            elif parsed['protocol'] == 'trojan':
                proxy['password'] = parsed['password']
                proxy.update({'udp': True, 'sni': parsed['params'].get('sni', parsed['server'])})
            elif parsed['protocol'] == 'ss':
                proxy['password'] = parsed['password']
                proxy['cipher'] = parsed['cipher']
            
            if 'uuid' in proxy or 'password' in proxy:
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
    all_sources.update(discover_github_sources())
    
    print(f"\n🚚 Fetching configs from {len(all_sources)} sources...")
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
