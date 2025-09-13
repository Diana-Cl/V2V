# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import yaml
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth
from typing import Optional, Set, List, Dict
from collections import defaultdict

print("INFO: Initializing V2V Scraper v28.1 (Robust Clash Generation)...")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 5000
TARGET_CONFIGS_PER_CORE = 500
MAX_TEST_WORKERS = 150
TCP_TIMEOUT = 2.5

# --- HELPER FUNCTIONS ---
def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        return base64.b64decode(content + '===').decode('utf-8', 'ignore')
    except Exception:
        return ""

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip(): return False
    try:
        parsed = urlparse(config)
        return parsed.scheme in VALID_PROTOCOLS and bool(parsed.hostname or (parsed.scheme == 'vmess' and decode_base64_content(config.replace("vmess://", ""))))
    except Exception:
        return False

def test_tcp_connection(config: str) -> Optional[str]:
    try:
        parsed_url = urlparse(config)
        hostname, port = parsed_url.hostname, parsed_url.port
        if not all([hostname, port]) and parsed_url.scheme == 'vmess':
            vmess_data = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname, port = vmess_data.get('add'), int(vmess_data.get('port', 0))
        if not all([hostname, port]): return None
        with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT):
            return config
    except Exception:
        return None

def fetch_from_sources(sources: list, is_github: bool, pat: str = None, limit: int = 0) -> Set[str]:
    all_configs = set()
    if is_github:
        if not pat:
            print("WARNING: GitHub PAT not found. Skipping dynamic search.")
            return set()
        try:
            auth = Auth.Token(pat)
            g = Github(auth=auth, timeout=30)
            query = " OR ".join(VALID_PROTOCOLS) + " extension:txt extension:md -user:mahdibland"
            results = g.search_code(query, order='desc', sort='indexed')
            count = 0
            for content_file in results:
                if count >= limit: break
                try:
                    decoded_content = decode_base64_content(content_file.content).replace('`', '')
                    all_configs.update({line.strip() for line in decoded_content.splitlines() if is_valid_config(line.strip())})
                    count += 1
                except Exception: continue
        except Exception as e:
            print(f"ERROR: GitHub search failed. Reason: {e}")
    else:
        def fetch_url(url):
            try:
                response = requests.get(url, headers=HEADERS, timeout=10)
                response.raise_for_status()
                content = decode_base64_content(response.text)
                return {line.strip() for line in content.splitlines() if line.strip()}
            except requests.RequestException: return set()
        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(fetch_url, url) for url in sources]
            for future in as_completed(futures):
                all_configs.update(future.result())
    
    return {cfg for cfg in all_configs if is_valid_config(cfg)}

def parse_proxy_for_clash(config: str) -> Optional[Dict]:
    try:
        # ✅ FIX: بهبود استخراج نام و جلوگیری از نام‌های خالی
        name_raw = urlparse(config).fragment or f"V2V-{int(time.time() * 1000) % 10000}"
        name = re.sub(r'[\U0001F600-\U0001FAFF\U00002702-\U000027B0\U000024C2-\U0001F251]+', '', name_raw).strip()
        if not name: name = "V2V-Config"
        
        base = {'name': name, 'skip-cert-verify': True}
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme
        
        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            proxy = {**base, 'type': 'vmess', 'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 'alterId': int(decoded.get('aid', 0)), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net'), 'servername': decoded.get('sni') or decoded.get('host')}
            if decoded.get('net') == 'ws': 
                proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host') or decoded.get('add')}}
            return proxy
            
        params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p)
        if protocol == 'vless':
            proxy = {**base, 'type': 'vless', 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type'), 'servername': params.get('sni')}
            if params.get('type') == 'ws': 
                proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host') or parsed_url.hostname}}
            return proxy

        if protocol == 'trojan':
            # ✅ FIX: اطمینان از وجود پسورد در تروجان
            if not parsed_url.username: return None
            return {**base, 'type': 'trojan', 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'sni': params.get('sni')}

        if protocol == 'ss':
            # ✅ FIX: مدیریت هوشمند خطای پسورد در Shadowsocks
            decoded_user = decode_base64_content(parsed_url.username)
            if ':' not in decoded_user: return None
            cipher, password = decoded_user.split(':', 1)
            return {**base, 'type': 'ss', 'server': parsed_url.hostname, 'port': parsed_url.port, 'cipher': cipher, 'password': password}
    except Exception:
        return None
    return None

def generate_clash_yaml(configs: List[str]) -> Optional[str]:
    proxies, unique_check = [], set()
    for config in configs:
        parsed_proxy = parse_proxy_for_clash(config)
        if parsed_proxy:
            # ✅ FIX: کلید یکتاسازی بر اساس سرور، پورت و نوع برای جلوگیری از هرگونه تکرار
            key = f"{parsed_proxy['server']}:{parsed_proxy['port']}:{parsed_proxy['type']}"
            if key not in unique_check:
                proxies.append(parsed_proxy)
                unique_check.add(key)
                
    if not proxies: return None
    
    proxy_names = [p['name'] for p in proxies]
    clash_config = {'proxies': proxies, 'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}, {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', *proxy_names]}], 'rules': ['MATCH,V2V-Select']}
    
    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data): return True
        
    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

def main():
    print("\n--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_data = json.load(f)
        static_sources = sources_data.get("static", [])
        github_search_limit = sources_data.get("github_search_limit", 50)
        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit: {github_search_limit}.")
    except Exception as e:
        print(f"CRITICAL: Failed to load sources.json. Error: {e}"); return

    print("\n--- 2. Fetching Configs ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_configs = executor.submit(fetch_from_sources, static_sources, is_github=False).result()
        dynamic_configs = executor.submit(fetch_from_sources, [], is_github=True, pat=GITHUB_PAT, limit=github_search_limit).result()
    print(f"✅ Found {len(static_configs)} valid configs from static sources.")
    print(f"✅ Found {len(dynamic_configs)} valid configs from dynamic GitHub search.")

    all_unique_configs = static_configs.union(dynamic_configs)
    print(f"\n📊 Total unique configs found: {len(all_unique_configs)}")
    if not all_unique_configs: print("CRITICAL: No configs found. Exiting."); return

    print(f"\n--- 3. Testing Configs ---")
    live_configs = {result for result in ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS).map(test_tcp_connection, list(all_unique_configs)[:MAX_CONFIGS_TO_TEST]) if result}
    print(f"🏆 Found {len(live_configs)} live configs.")
    if not live_configs: print("CRITICAL: No live configs found. Exiting."); return

    print("\n--- 4. Grouping and Finalizing ---")
    
    all_final_configs = list(live_configs)[:TARGET_CONFIGS_PER_CORE * 2]
    
    xray_pool = {cfg for cfg in all_final_configs if urlparse(cfg).scheme in XRAY_PROTOCOLS}
    singbox_pool = {cfg for cfg in all_final_configs}

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            protocol = urlparse(cfg).scheme
            if protocol == 'hysteria2': protocol = 'hy2'
            grouped[protocol].append(cfg)
        return dict(grouped)

    output_data = {
        "xray": group_by_protocol(list(xray_pool)[:TARGET_CONFIGS_PER_CORE]),
        "singbox": group_by_protocol(list(singbox_pool)[:TARGET_CONFIGS_PER_CORE])
    }

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote grouped configs to {OUTPUT_JSON_FILE}.")

    clash_configs_for_sub = [cfg for cfg in xray_pool if urlparse(cfg).scheme in {'vless', 'vmess', 'trojan', 'ss'}]
    clash_yaml_content = generate_clash_yaml(clash_configs_for_sub[:TARGET_CONFIGS_PER_CORE])
    
    if clash_yaml_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f: f.write(clash_yaml_content)
        print(f"✅ Wrote Clash subscription to {OUTPUT_CLASH_FILE}.")

    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f: f.write(str(int(time.time())))
    print(f"✅ Cache version updated.")
    
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()
