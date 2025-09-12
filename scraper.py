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
from urllib.parse import urlparse, unquote
from github import Github, Auth
from typing import Optional, Set, List, Dict

print("INFO: Initializing V2V Scraper v26.0 (Integrated & Stable)...")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public") # ✅ تغییر کلیدی ۱: تعریف پوشه public
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")

# ✅ تغییر کلیدی ۲: مسیرهای خروجی مستقیماً به پوشه public اشاره می‌کنند
OUTPUT_JSON_FILE = os.path.join(PUBLIC_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(PUBLIC_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(PUBLIC_DIR, "cache_version.txt")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 5000
TARGET_CONFIGS_PER_CORE = 500
MAX_TEST_WORKERS = 150
TCP_TIMEOUT = 2.5

# (کدهای توابع کمکی مانند decode_base64_content, is_valid_config و ... بدون تغییر باقی می‌مانند)
def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        return base64.b64decode(content + '===').decode('utf-8', 'ignore')
    except Exception: return ""

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip(): return False
    try:
        if not config.startswith(tuple(p + '://' for p in VALID_PROTOCOLS)): return False
        parsed = urlparse(config)
        if parsed.scheme not in VALID_PROTOCOLS: return False
        if parsed.scheme == 'vmess': return bool(decode_base64_content(config.replace("vmess://", "")))
        if parsed.scheme == 'trojan' and not parsed.username: return False
        return bool(parsed.hostname)
    except Exception: return False

def test_tcp_connection(config: str) -> Optional[str]:
    try:
        parsed_url = urlparse(config)
        hostname, port = parsed_url.hostname, parsed_url.port
        if not hostname or not port:
            if parsed_url.scheme == 'vmess':
                vmess_data = json.loads(decode_base64_content(config.replace("vmess://", "")))
                hostname, port = vmess_data.get('add'), int(vmess_data.get('port'))
            else: return None
        with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT): return config
    except Exception: return None

def fetch_from_static_sources(sources: list) -> Set[str]:
    all_configs = set()
    def fetch_url(url):
        try:
            response = requests.get(url, headers=HEADERS, timeout=10)
            response.raise_for_status()
            content = decode_base64_content(response.text)
            return {line.strip() for line in content.splitlines() if line.strip()}
        except requests.RequestException: return set()
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(fetch_url, url) for url in sources]
        for future in as_completed(futures): all_configs.update(future.result())
    return {cfg for cfg in all_configs if is_valid_config(cfg)}

def fetch_from_github(pat: str, limit: int) -> Set[str]:
    if not pat: print("WARNING: GitHub PAT not found. Skipping dynamic search."); return set()
    try:
        auth = Auth.Token(pat)
        g = Github(auth=auth, timeout=30)
        query = " OR ".join(VALID_PROTOCOLS) + " extension:txt extension:md -user:mahdibland"
        results = g.search_code(query, order='desc', sort='indexed')
        all_configs, count = set(), 0
        for content_file in results:
            if count >= limit: break
            try:
                decoded_content = decode_base64_content(content_file.content)
                cleaned_content = decoded_content.replace('`', '')
                found = {line.strip() for line in cleaned_content.splitlines() if is_valid_config(line.strip())}
                all_configs.update(found)
                count += 1
            except Exception: continue
        return all_configs
    except Exception as e: print(f"ERROR: GitHub search failed. Reason: {e}"); return set()

def generate_clash_yaml(configs: List[str]) -> Optional[str]:
    proxies, unique_check = [], set()
    for config in configs:
        try:
            parsed_proxy = parse_proxy_for_clash(config)
            if parsed_proxy:
                key = f"{parsed_proxy['server']}:{parsed_proxy['port']}:{parsed_proxy['name']}"
                if key not in unique_check: proxies.append(parsed_proxy); unique_check.add(key)
        except Exception: continue
    if not proxies: return None
    proxy_names = [p['name'] for p in proxies]
    clash_config = {'proxies': proxies, 'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}, {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', *proxy_names]}], 'rules': ['MATCH,V2V-Select']}
    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data): return True
    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

def parse_proxy_for_clash(config: str) -> Optional[Dict]:
    try:
        name_raw = urlparse(config).fragment or f"V2V-{int(time.time() * 1000) % 10000}"
        name = re.sub(r'[\U0001F600-\U0001FAFF\U00002702-\U000027B0\U000024C2-\U0001F251]+', '', name_raw).strip()
    except: name = f"V2V-Unnamed-{int(time.time() * 1000) % 10000}"
    base = {'name': name, 'skip-cert-verify': True}
    protocol = urlparse(config).scheme
    try:
        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            vmess_proxy = {**base, 'type': 'vmess', 'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 'alterId': int(decoded.get('aid', 0)), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net'), 'servername': decoded.get('sni') or decoded.get('host')}
            if decoded.get('net') == 'ws': vmess_proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
            return vmess_proxy
        parsed_url = urlparse(config)
        params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p)
        if protocol == 'vless':
            vless_proxy = {**base, 'type': 'vless', 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type'), 'servername': params.get('sni')}
            if params.get('type') == 'ws': vless_proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', parsed_url.hostname)}}
            return vless_proxy
        if protocol == 'trojan':
            if not parsed_url.username: return None
            return {**base, 'type': 'trojan', 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'sni': params.get('sni')}
        if protocol == 'ss':
            decoded_user = decode_base64_content(parsed_url.username)
            cipher, password = decoded_user.split(':', 1)
            return {**base, 'type': 'ss', 'server': parsed_url.hostname, 'port': parsed_url.port, 'cipher': cipher, 'password': password}
    except: return None
    return None

def main():
    print("\n--- 1. Loading Sources ---")
    if not os.path.exists(PUBLIC_DIR): os.makedirs(PUBLIC_DIR); print(f"INFO: Created public directory at {PUBLIC_DIR}")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f: sources = json.load(f)
        static_sources, github_search_limit = sources.get("static", []), sources.get("github_search_limit", 50)
        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit: {github_search_limit}.")
    except Exception as e: print(f"CRITICAL: Failed to load sources.json. Error: {e}"); return

    print("\n--- 2. Fetching Configs ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_future, dynamic_future = executor.submit(fetch_from_static_sources, static_sources), executor.submit(fetch_from_github, GITHUB_PAT, github_search_limit)
        static_configs, dynamic_configs = static_future.result(), dynamic_future.result()
        print(f"✅ Found {len(static_configs)} valid configs from static sources.")
        print(f"✅ Found {len(dynamic_configs)} valid configs from dynamic GitHub search.")

    all_unique_configs = static_configs.union(dynamic_configs)
    print(f"\n📊 Total unique configs found before testing: {len(all_unique_configs)}")
    if not all_unique_configs: print("CRITICAL: No configs found. Exiting."); return

    print(f"\n--- 3. Testing Configs (up to {MAX_CONFIGS_TO_TEST}) ---")
    configs_to_test, live_configs = list(all_unique_configs)[:MAX_CONFIGS_TO_TEST], set()
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_tcp_connection, c) for c in configs_to_test}
        for future in as_completed(futures):
            result = future.result()
            if result: live_configs.add(result)
    print("✅ TCP testing complete.")
    if not live_configs: print("\nCRITICAL: No live configs found. Exiting."); return

    print(f"\n--- 4. Finalizing and Writing Files ---")
    print(f"🏆 Found {len(live_configs)} live configs.")
    
    xray_pool = {cfg for cfg in live_configs if urlparse(cfg).scheme in XRAY_PROTOCOLS}
    singbox_only_pool = {cfg for cfg in live_configs if urlparse(cfg).scheme in SINGBOX_ONLY_PROTOCOLS}
    xray_final, singbox_final = list(xray_pool)[:TARGET_CONFIGS_PER_CORE], list(singbox_only_pool)
    needed_for_singbox = TARGET_CONFIGS_PER_CORE - len(singbox_final)
    if needed_for_singbox > 0:
        shared_pool_remaining = xray_pool - set(xray_final)
        singbox_final.extend(list(shared_pool_remaining)[:needed_for_singbox])
    singbox_final = singbox_final[:TARGET_CONFIGS_PER_CORE]
    output_data = {"xray": xray_final, "singbox": singbox_final}

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f: json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote {len(xray_final)} Xray and {len(singbox_final)} Sing-box configs to {OUTPUT_JSON_FILE}.")

    clash_yaml_content = generate_clash_yaml(xray_final)
    if clash_yaml_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f: f.write(clash_yaml_content)
        print(f"✅ Wrote Clash subscription with {len(xray_final)} configs to {OUTPUT_CLASH_FILE}.")
    else: print("⚠️ Could not generate Clash subscription file.")

    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f: f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {CACHE_VERSION_FILE}.")
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()


