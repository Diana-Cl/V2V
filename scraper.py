import requests
import base64
import os
import json
import re
import time
import yaml
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION ===
BASE_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt", "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime", "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html"
]
OUTPUT_JSON_FILE = 'all_live_configs.json'
OUTPUT_CLASH_FILE = 'best_clash.yaml'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'wg://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Final-Resilient'}
TARGET_CONFIGS_PER_CORE = 500
MAX_PING_THRESHOLD = 1500  # Increased for more tolerance
REQUEST_TIMEOUT = 8        # Increased for more tolerance
API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'
MAX_RAW_CONFIGS_TO_TEST = 2000
TOP_CLASH_CONFIGS_COUNT = 100

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
    except:
        pass
    return set(re.findall(r'(vless|vmess|trojan|ss|wg)://[^\s\'"<]+', content))

def parse_server_details(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        if parsed_url.scheme == 'vmess':
            decoded = json.loads(base64.b64decode(config_url.replace("vmess://", "")).decode('utf-8'))
            return {'host': decoded.get('add'), 'port': int(decoded.get('port', 0))}
        if parsed_url.hostname:
            return {'host': parsed_url.hostname, 'port': parsed_url.port or 443}
        return None
    except Exception:
        return None

def test_config_via_vercel_api(config_url: str) -> dict:
    server_details = parse_server_details(config_url)
    if not server_details: return {'ping': 9999}
    try:
        # Using the increased REQUEST_TIMEOUT here
        response = requests.post(API_ENDPOINT, json=server_details, headers={'Content-Type': 'application/json'}, timeout=REQUEST_TIMEOUT)
        return {'config_str': config_url, 'ping': response.json().get('ping', 9999)}
    except Exception:
        return {'config_str': config_url, 'ping': 9999}

def validate_and_categorize_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme
        core = 'xray' if protocol in ['vless', 'vmess', 'trojan', 'ss'] else 'singbox'
        if protocol == 'vless' and 'reality' in parsed_url.query:
            core = 'singbox'
        return {'core': core, 'config_str': config_url}
    except Exception:
        return None

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
    print("V2V Scraper Final Version (Resilient)")
    with ThreadPoolExecutor(max_workers=20) as executor:
        config_sets = executor.map(fetch_and_parse_url, BASE_SOURCES)
    all_configs_raw = set.union(*config_sets)
    print(f"Found {len(all_configs_raw)} raw configs.")

    categorized_configs = {'xray': [], 'singbox': []}
    for cfg in all_configs_raw:
        cat = validate_and_categorize_config(cfg)
        if cat: categorized_configs[cat['core']].append(cat['config_str'])

    final_configs = {'xray': [], 'singbox': []}
    for core_name, configs in categorized_configs.items():
        if not configs: continue
        
        configs_to_test = random.sample(configs, min(len(configs), MAX_RAW_CONFIGS_TO_TEST))
        print(f"Testing {len(configs_to_test)} {core_name} configs...")
        
        with ThreadPoolExecutor(max_workers=30) as executor:
            tested_configs = list(executor.map(test_config_via_vercel_api, configs_to_test))

        live_configs = [c for c in tested_configs if c['ping'] < MAX_PING_THRESHOLD]
        live_configs.sort(key=lambda x: x['ping'])
        final_configs[core_name] = live_configs[:TARGET_CONFIGS_PER_CORE]
        print(f"Found {len(final_configs[core_name])} live {core_name} configs.")

    if final_configs['xray']:
        print(f"Generating Clash file from top {TOP_CLASH_CONFIGS_COUNT} configs...")
        top_xray_configs = [cfg['config_str'] for cfg in final_configs['xray'][:TOP_CLASH_CONFIGS_COUNT]]
        clash_content = generate_clash_config_from_urls(top_xray_configs)
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_content)

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    print("Process completed successfully.")

if __name__ == "__main__":
    main()
