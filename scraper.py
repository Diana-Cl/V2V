import requests
import base64
import os
import json
import re
import time
import yaml
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, unquote

# === CONFIGURATION ===
BASE_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt",
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://robin.nscl.ir/"
]
OUTPUT_JSON_FILE = 'all_live_configs.json'
OUTPUT_CLASH_FILE = 'best_clash.yaml'
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Collector/2.0'}
TARGET_CONFIGS_PER_CORE = 500
TOP_CLASH_CONFIGS_COUNT = 100
GITHUB_SEARCH_QUERIES = ['"vless://" "vmess://" path:*.txt', '"v2ray" "subscription" path:*.txt']

def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except Exception:
        return None

def fetch_and_parse_url(url: str) -> set[str]:
    content = get_content_from_url(url)
    if not content: return set()
    try:
        content = base64.b64decode(content).decode('utf-8')
    except: pass
    return set(re.findall(r'(vless|vmess|trojan|ss|wg)://[^\s\'"<]+', content))

def search_github_for_fresh_sources() -> set[str]:
    if not GITHUB_PAT:
        print("GitHub PAT not found. Skipping dynamic search.")
        return set()
    print("Searching GitHub for fresh dynamic sources...")
    fresh_configs = set()
    headers = {'Authorization': f'token {GITHUB_PAT}', 'Accept': 'application/vnd.github.v3.text-match+json'}
    for query in GITHUB_SEARCH_QUERIES:
        try:
            url = f"https://api.github.com/search/code?q={query}&sort=indexed&order=desc&per_page=100"
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code == 200:
                items = response.json().get('items', [])
                for item in items:
                    if item.get('repository', {}).get('fork'): continue
                    download_url = item.get('html_url', '').replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
                    fresh_configs.update(fetch_and_parse_url(download_url))
            else:
                print(f"GitHub API search failed with status: {response.status_code}")
                print(response.text)
            time.sleep(5) 
        except Exception as e:
            print(f"Error during GitHub search: {e}")
            continue
    print(f"Found {len(fresh_configs)} configs from dynamic sources.")
    return fresh_configs

def generate_clash_config_from_urls(configs: list) -> str:
    proxies = []
    for config_str in configs:
        try:
            url = urlparse(config_str)
            if 'reality' in url.query.lower(): continue
            name = unquote(url.fragment) if url.fragment else url.hostname
            proxy = {'name': name, 'server': url.hostname, 'port': int(url.port)}
            if url.scheme == 'vmess':
                decoded = json.loads(base64.b64decode(config_str.replace("vmess://", "")).decode('utf-8'))
                proxy.update({'type': 'vmess', 'uuid': decoded['id'], 'alterId': decoded['aid'], 'cipher': 'auto', 'server': decoded['add'], 'port': int(decoded['port']), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp')})
            elif url.scheme in ['vless', 'trojan']:
                proxy.update({'type': url.scheme, 'uuid' if url.scheme == 'vless' else 'password': url.username, 'tls': 'security=tls' in url.query})
            elif url.scheme == 'ss':
                cred = base64.b64decode(unquote(url.username)).decode().split(':')
                proxy.update({'type': 'ss', 'cipher': cred[0], 'password': cred[1]})
            else: continue
            proxies.append(proxy)
        except Exception: continue
    clash_config = {'proxies': proxies, 'proxy-groups': [{'name': 'V2V-Auto', 'type': 'select', 'proxies': [p['name'] for p in proxies]}], 'rules': ['MATCH,V2V-Auto']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, indent=2)

def main():
    print("V2V Collector Final Architecture")
    with ThreadPoolExecutor(max_workers=30) as executor:
        static_configs_sets = executor.map(fetch_and_parse_url, BASE_SOURCES)
    all_static_configs = set.union(*static_configs_sets)
    print(f"Found {len(all_static_configs)} configs from static sources.")

    dynamic_configs = search_github_for_fresh_sources()
    all_configs_combined = all_static_configs | dynamic_configs
    print(f"Total unique configs after enrichment: {len(all_configs_combined)}")

    final_configs = {'xray': [], 'singbox': []}
    for cfg in all_configs_combined:
        protocol = cfg.split('://')[0]
        if 'reality' in cfg or protocol == 'wg':
             final_configs['singbox'].append({'config_str': cfg})
        else:
             final_configs['xray'].append({'config_str': cfg})
    
    final_configs['xray'] = final_configs['xray'][:TARGET_CONFIGS_PER_CORE]
    final_configs['singbox'] = final_configs['singbox'][:TARGET_CONFIGS_PER_CORE]
    
    if final_configs['xray']:
        print(f"Generating Clash file from a sample of {TOP_CLASH_CONFIGS_COUNT} raw configs...")
        sample_for_clash = random.sample(final_configs['xray'], min(len(final_configs['xray']), TOP_CLASH_CONFIGS_COUNT))
        clash_content = generate_clash_config_from_urls([c['config_str'] for c in sample_for_clash])
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f: f.write(clash_content)

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    
    print("Process completed successfully.")
    print(f"Saved {len(final_configs['xray'])} xray configs and {len(final_configs['singbox'])} singbox configs.")

if __name__ == "__main__":
    main()
