# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import yaml
import socket
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import itertools

print("INFO: Initializing V2V Scraper v33.0 (Intelligent Filtering)...")

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
MAX_CONFIGS_TO_TEST = 10000  # Increased to find more quality configs
TARGET_CONFIGS_PER_CORE = 500
MAX_TEST_WORKERS = 200
TCP_TIMEOUT = 2.5
MAX_LATENCY_MS = 5000  # New: Max acceptable latency is 5 seconds
MAX_NAME_LENGTH = 40

# --- HELPER FUNCTIONS (UNCHANGED) ---
def decode_base64_content(content: str) -> str:
    # ... (code is unchanged)
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        return base64.b64decode(content + '===').decode('utf-8', 'ignore')
    except Exception: return ""

def is_valid_config(config: str) -> bool:
    # ... (code is unchanged)
    if not isinstance(config, str) or not config.strip(): return False
    try:
        parsed = urlparse(config)
        return parsed.scheme in VALID_PROTOCOLS and bool(parsed.hostname or (parsed.scheme == 'vmess' and decode_base64_content(config.replace("vmess://", ""))))
    except Exception: return False

def fetch_from_sources(sources: list, is_github: bool, pat: str = None, limit: int = 0) -> Set[str]:
    # ... (code is unchanged)
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
    # ... (code is unchanged)
    try:
        parsed_url = urlparse(config)
        original_name = parsed_url.fragment or ""
        sanitized_name = re.sub(r'[\U0001F600-\U0001FAFF\U00002702-\U000027B0\U000024C2-\U0001F251]+', '', original_name).strip()
        if not sanitized_name:
            server_id = f"{parsed_url.hostname}:{parsed_url.port}"
            unique_hash = hashlib.md5(server_id.encode()).hexdigest()[:6]
            sanitized_name = f"Config-{unique_hash}"
        if len(sanitized_name) > MAX_NAME_LENGTH:
            sanitized_name = sanitized_name[:MAX_NAME_LENGTH] + "..."
        final_name = f"V2V | {sanitized_name}"
        base = {'name': final_name, 'skip-cert-verify': True}
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
            if not parsed_url.username: return None
            return {**base, 'type': 'trojan', 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'sni': params.get('sni')}
        if protocol == 'ss':
            decoded_user = decode_base64_content(parsed_url.username)
            if ':' not in decoded_user: return None
            cipher, password = decoded_user.split(':', 1)
            return {**base, 'type': 'ss', 'server': parsed_url.hostname, 'port': parsed_url.port, 'cipher': cipher, 'password': password}
    except Exception:
        return None
    return None

def generate_clash_yaml(configs: List[str]) -> Optional[str]:
    # ... (code is unchanged)
    proxies, unique_check = [], set()
    for config in configs:
        parsed_proxy = parse_proxy_for_clash(config)
        if parsed_proxy:
            key = f"{parsed_proxy['server']}:{parsed_proxy['port']}"
            if key not in unique_check:
                proxies.append(parsed_proxy)
                unique_check.add(key)
    if not proxies: return None
    proxy_names = [p['name'] for p in proxies]
    clash_config = {'proxies': proxies, 'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}, {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', *proxy_names]}], 'rules': ['MATCH,V2V-Select']}
    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data): return True
    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

# --- NEW & IMPROVED FUNCTIONS ---

def test_tcp_connection_with_latency(config: str) -> Optional[Tuple[str, int]]:
    """
    Tests a TCP connection and returns the config and its latency in milliseconds.
    Returns None if the connection fails.
    """
    try:
        parsed_url = urlparse(config)
        hostname, port = parsed_url.hostname, parsed_url.port
        if not all([hostname, port]) and parsed_url.scheme == 'vmess':
            vmess_data = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname, port = vmess_data.get('add'), int(vmess_data.get('port', 0))
        
        if not all([hostname, port]): 
            return None
            
        start_time = time.monotonic()
        with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT):
            end_time = time.monotonic()
            latency_ms = int((end_time - start_time) * 1000)
            return config, latency_ms
    except Exception:
        return None

def select_configs_with_fluid_quota(configs_with_latency: List[Tuple[str, int]], target_count: int) -> List[str]:
    """
    Selects configs using a fluid, round-robin method to ensure protocol diversity and quality.
    """
    if not configs_with_latency:
        return []

    # 1. Group configs by protocol
    grouped_by_protocol = defaultdict(list)
    for config, latency in configs_with_latency:
        protocol = urlparse(config).scheme
        grouped_by_protocol[protocol].append(config)
    
    # 2. Use a round-robin approach to build the final list
    final_configs = []
    protocol_iterators = {protocol: iter(configs) for protocol, configs in grouped_by_protocol.items()}
    
    while len(final_configs) < target_count:
        added_in_this_round = 0
        for protocol in protocol_iterators:
            try:
                next_config = next(protocol_iterators[protocol])
                if next_config not in final_configs:
                    final_configs.append(next_config)
                    added_in_this_round += 1
                if len(final_configs) >= target_count:
                    break
            except StopIteration:
                continue # This protocol group is exhausted
        
        if added_in_this_round == 0:
            break # All iterators are exhausted

    return final_configs[:target_count]

# --- MAIN EXECUTION ---
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
        static_configs_future = executor.submit(fetch_from_sources, static_sources, is_github=False)
        dynamic_configs_future = executor.submit(fetch_from_sources, [], is_github=True, pat=GITHUB_PAT, limit=github_search_limit)
        static_configs = static_configs_future.result()
        dynamic_configs = dynamic_configs_future.result()
    print(f"✅ Found {len(static_configs)} valid configs from static sources.")
    print(f"✅ Found {len(dynamic_configs)} valid configs from dynamic GitHub search.")

    all_unique_configs = static_configs.union(dynamic_configs)
    print(f"\n📊 Total unique configs found: {len(all_unique_configs)}")
    if not all_unique_configs: print("CRITICAL: No configs found. Exiting."); return

    print(f"\n--- 3. Testing Configs and Filtering by Latency (Max: {MAX_LATENCY_MS}ms) ---")
    fast_configs_with_latency = []
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        future_to_config = {executor.submit(test_tcp_connection_with_latency, cfg): cfg for cfg in list(all_unique_configs)[:MAX_CONFIGS_TO_TEST]}
        for future in as_completed(future_to_config):
            result = future.result()
            if result:
                config, latency = result
                if latency <= MAX_LATENCY_MS:
                    fast_configs_with_latency.append((config, latency))
    
    # Sort all fast configs globally by latency
    fast_configs_with_latency.sort(key=lambda item: item[1])
    print(f"🏆 Found {len(fast_configs_with_latency)} fast configs.")
    if not fast_configs_with_latency: print("CRITICAL: No fast configs found. Exiting."); return

    print("\n--- 4. Grouping and Finalizing with Fluid Quota ---")
    
    # Separate pools based on the globally sorted list
    singbox_only_pool = [(cfg, lat) for cfg, lat in fast_configs_with_latency if urlparse(cfg).scheme in SINGBOX_ONLY_PROTOCOLS]
    xray_compatible_pool = [(cfg, lat) for cfg, lat in fast_configs_with_latency if urlparse(cfg).scheme in XRAY_PROTOCOLS]

    # Select final configs using the new fluid quota logic
    xray_final = select_configs_with_fluid_quota(xray_compatible_pool, TARGET_CONFIGS_PER_CORE)
    
    # For Sing-box, prioritize its own protocols, then backfill with fast Xray configs
    singbox_final_sb_only = [cfg for cfg, lat in singbox_only_pool]
    needed_for_singbox = TARGET_CONFIGS_PER_CORE - len(singbox_final_sb_only)
    if needed_for_singbox > 0:
        xray_fillers = [cfg for cfg, lat in xray_compatible_pool if cfg not in singbox_final_sb_only]
        singbox_final_sb_only.extend(xray_fillers[:needed_for_singbox])
    singbox_final = singbox_final_sb_only[:TARGET_CONFIGS_PER_CORE]
    
    print(f"✅ Selected {len(xray_final)} configs for Xray core.")
    print(f"✅ Selected {len(singbox_final)} configs for Sing-box core.")

    # Group the final lists by protocol for the JSON output
    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            protocol = urlparse(cfg).scheme
            if protocol == 'hysteria2': protocol = 'hy2' # Alias for brevity
            grouped[protocol].append(cfg)
        return dict(grouped)

    output_data = {
        "xray": group_by_protocol(xray_final),
        "singbox": group_by_protocol(singbox_final)
    }

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote grouped configs to {OUTPUT_JSON_FILE}.")

    # Generate Clash file from fast Xray-compatible configs
    clash_candidate_configs = [cfg for cfg, lat in xray_compatible_pool]
    clash_yaml_content = generate_clash_yaml(clash_candidate_configs[:TARGET_CONFIGS_PER_CORE])
    if clash_yaml_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f: f.write(clash_yaml_content)
        print(f"✅ Wrote Clash subscription to {OUTPUT_CLASH_FILE}.")

    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f: f.write(str(int(time.time())))
    print(f"✅ Cache version updated.")
    
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()
