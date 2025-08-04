import requests
import base64
import os
import json
import socket
import time
import yaml
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, unquote

# === CONFIGURATION ===
BASE_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/All_Configs_Sub.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt","https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt","https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt","https://raw.githubusercontent.com/MrPooyaX/V2Ray/main/sub/mix","https://raw.githubusercontent.com/yebekhe/Configura/main/Sub/Normal/Sub.txt","https://raw.githubusercontent.com/soroushmirzaei/V2Ray-configs/main/All-Configs-base64","https://raw.githubusercontent.com/mrvcoder/V2rayCollector/main/sub/mix_base64","https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/all.txt","https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt","https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/All-Configs-for-V2Ray.txt","https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/sub/subscription_base64.txt","https://raw.githubusercontent.com/Argh94/V2RayAutoConfig/main/sub/sub_merge.txt","https://raw.githubusercontent.com/NiREvil/vless/main/sub/vless.txt","https://raw.githubusercontent.com/NiREvil/vless/main/XRAY/vless.txt","https://raw.githubusercontent.com/4n0nymou3/multi-proxy-config-fetcher/main/configs/proxy_configs.txt","https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]
GITHUB_SEARCH_KEYWORDS = ['v2ray subscription', 'vless subscription', 'vmess subscription']
TOP_N_CONFIGS = 500
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_BASE64 = 'configs_base64.txt'
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
        response = requests.get(url, timeout=10, headers={'User-Agent': 'V2V-Scraper/5.0'})
        response.raise_for_status()
        return response.text
    except requests.RequestException:
        return None

def decode_content(content: str) -> list[str]:
    try:
        return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception:
        return content.strip().splitlines()

def discover_github_sources() -> set[str]:
    if not GITHUB_PAT:
        return set()
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
        except requests.RequestException:
            continue
    return discovered_urls

def parse_config(config_url: str) -> tuple[str, int, str] | None:
    try:
        if config_url.startswith('vmess://'):
            decoded_part = base64.b64decode(config_url[8:]).decode()
            data = json.loads(decoded_part)
            remark = data.get('ps', 'V2V-VMess')
            return data.get('add'), int(data.get('port', 0)), remark
        
        parsed_url = urlparse(config_url)
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else parsed_url.hostname
        return parsed_url.hostname, parsed_url.port, remark
    except Exception:
        return None

def tcp_ping(host: str, port: int, timeout: int = 2) -> int | None:
    if not host or not port:
        return None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        start_time = time.time()
        s.connect((host, port))
        end_time = time.time()
        s.close()
        return int((end_time - start_time) * 1000)
    except Exception:
        return None

def test_config_latency(config: str) -> tuple[str, int] | None:
    parsed = parse_config(config)
    if parsed:
        latency = tcp_ping(parsed[0], parsed[1])
        if latency is not None:
            return (config, latency)
    return None

def generate_clash_config(configs_list: list) -> str:
    proxies = []
    for i, config in enumerate(configs_list):
        try:
            parsed = parse_config(config)
            if not parsed: continue
            
            host, port, remark = parsed
            proxy_name = remark if remark and len(remark) < 40 else f"{config.split('://')[0]}-{i+1}"
            proxy = {'name': proxy_name, 'type': config.split('://')[0], 'server': host, 'port': port}
            if config.startswith('vless://'):
                uuid = urlparse(config).username
                proxy.update({'uuid': uuid, 'udp': True, 'tls': True, 'servername': host, 'network': 'ws', 'ws-opts': {'path': "/"}})
            proxies.append(proxy)
        except Exception:
            continue
    clash_config = {
        'port': 7890, 'socks-port': 7891, 'allow-lan': False, 'mode': 'rule', 'log-level': 'info', 'proxies': proxies,
        'proxy-groups': [
            {'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300},
            {'name': 'V2V-Select', 'type': 'select', 'proxies': [p['name'] for p in proxies]}
        ],
        'rules': ['DOMAIN-SUFFIX,ir,DIRECT', 'MATCH,V2V-Auto']
    }
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

def upload_to_gitlab(content: str):
    if not GITLAB_API_TOKEN: return
    headers = {"PRIVATE-TOKEN": GITLAB_API_TOKEN}
    data = {'title': 'V2V Configs Mirror', 'file_name': OUTPUT_FILE_PLAIN, 'content': content, 'visibility': 'public'}
    if GITLAB_SNIPPET_ID:
        url = f"https://gitlab.com/api/v4/snippets/{GITLAB_SNIPPET_ID}"
        response = requests.put(url, headers=headers, data=data)
        if response.status_code == 200: print(f"✅ Successfully updated GitLab snippet: {response.json()['web_url']}")
        else: print(f"❌ Failed to update GitLab snippet: {response.status_code} {response.text}")
    else:
        url = "https://gitlab.com/api/v4/snippets"
        response = requests.post(url, headers=headers, data=data)
        if response.status_code == 201:
            snippet_id = response.json()['id']
            print(f"✅ Successfully created GitLab snippet: {response.json()['web_url']}")
            print(f"📌 IMPORTANT: Add this ID to your GitHub secrets as GITLAB_SNIPPET_ID: {snippet_id}")
        else: print(f"❌ Failed to create GitLab snippet: {response.status_code} {response.text}")

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
    if not all_configs:
        print("No configs found. Aborting."); return
    print("\n⚡️ Testing latency of configs (this may take a while)...")
    working_configs = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        for result in executor.map(test_config_latency, all_configs):
            if result: working_configs.append(result)
    print(f"Found {len(working_configs)} responsive configs.")
    if not working_configs:
        print("No working configs found to save. Aborting."); return
    working_configs.sort(key=lambda x: x[1])
    top_configs = [cfg for cfg, lat in working_configs[:TOP_N_CONFIGS]]
    print(f"🏅 Selected top {len(top_configs)} configs.")
    final_content_plain = "\n".join(top_configs)
    with open(OUTPUT_FILE_PLAIN, 'w', encoding='utf-8') as f: f.write(final_content_plain)
    print(f"💾 Successfully saved plain text configs to {OUTPUT_FILE_PLAIN}")
    final_content_base64 = base64.b64encode(final_content_plain.encode('utf-8')).decode('utf-8')
    with open(OUTPUT_FILE_BASE64, 'w', encoding='utf-8') as f: f.write(final_content_base64)
    print(f"💾 Successfully saved Base64 encoded configs to {OUTPUT_FILE_BASE64}")
    clash_content = generate_clash_config(top_configs)
    with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f: f.write(clash_content)
    print(f"💾 Successfully saved Clash.Meta config to {OUTPUT_FILE_CLASH}")
    upload_to_gitlab(final_content_plain)

if __name__ == "__main__":
    main()
