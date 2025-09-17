# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import yaml # Only for generate_clash_yaml, which is not used for public output anymore
import socket
import hashlib
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import itertools

# !!! IMPORTANT: Ensure Cloudflare library is installed: pip install cloudflare !!!
import cloudflare # ADDED: Import Cloudflare library

print("INFO: Initializing V2V Scraper v33.1 (Deep Protocol Testing & Flexible Quota)...")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
# OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json") # REMOVED: Will upload to KV
# CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt") # REMOVED: Will upload to KV

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 10000
MIN_TARGET_CONFIGS_PER_CORE = 500  # Minimum configs for each core
MAX_FINAL_CONFIGS_PER_CORE = 1000 # Maximum configs for each core
MAX_TEST_WORKERS = 200
TCP_TIMEOUT = 4  # Increased to 4 seconds for deeper testing
MAX_LATENCY_MS = 5000
MAX_NAME_LENGTH = 40

# --- CLOUDFLARE KV CONFIGURATION --- # ADDED
CF_EMAIL = os.environ.get('CLOUDFLARE_EMAIL') # Optional if using API Token with Account ID
CF_API_TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
CF_KV_NAMESPACE_ID = os.environ.get('CLOUDFLARE_KV_V2V_ID') # Using a more specific name for clarity

KV_LIVE_CONFIGS_KEY = 'all_live_configs'
KV_CACHE_VERSION_KEY = 'cache_version'


# --- HELPER FUNCTIONS (UNCHANGED) ---
def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        return base64.b64decode(content + '===').decode('utf-8', 'ignore')
    except Exception: return ""

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip(): return False
    try:
        parsed = urlparse(config)
        return parsed.scheme in VALID_PROTOCOLS and bool(parsed.hostname or (parsed.scheme == 'vmess' and decode_base64_content(config.replace("vmess://", ""))))
    except Exception: return False

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

# parse_proxy_for_clash and generate_clash_yaml are kept for internal consistency
# but are NOT used for public clash file generation in this script anymore.
# They are included for completeness if needed for other purposes but won't affect KV upload.
def parse_proxy_for_clash(config: str) -> Optional[Dict]:
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

def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]:
    """
    Tests a full protocol handshake for VLESS, VMess, Trojan, SS.
    For Hysteria2/TUIC (UDP-based), it performs a basic UDP port check.
    Returns the config and its latency in milliseconds, or None if the connection fails.
    """
    parsed_url = urlparse(config)
    protocol = parsed_url.scheme
    hostname, port = None, None
    is_tls = False

    try:
        if protocol == 'vmess':
            decoded_data = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname = decoded_data.get('add')
            port = int(decoded_data.get('port', 0))
            is_tls = decoded_data.get('tls') == 'tls'
            # No specific handshake for vmess, just check connection
        elif protocol in ['vless', 'trojan', 'ss']:
            hostname = parsed_url.hostname
            port = int(parsed_url.port) # Ensure port is int
            params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p)
            is_tls = (params.get('security') == 'tls' or protocol == 'trojan' or port == 443) # Trojan implies TLS, port 443 implies TLS
        elif protocol in SINGBOX_ONLY_PROTOCOLS:
            # For UDP-based protocols, perform a basic UDP check
            hostname = parsed_url.hostname
            port = int(parsed_url.port) # Ensure port is int
            if not all([hostname, port]): return None
            
            start_time = time.monotonic()
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                # Send a small dummy packet
                sock.sendto(b'ping', (hostname, port))
                # Wait for a response (if any), indicating the port is active
                # Using select/poll might be more robust than recvfrom directly for just checking "reachability"
                # For simplicity, a non-blocking recvfrom after sendto is used to see if an error occurs
                try:
                    sock.recvfrom(1024) 
                except socket.timeout:
                    pass # It's okay if no response for UDP, just want to see if it's reachable
                except Exception as udp_e:
                    # print(f"DEBUG: UDP check failed for {hostname}:{port}. Reason: {udp_e}")
                    return None
            end_time = time.monotonic()
            latency_ms = int((end_time - start_time) * 1000)
            return config, latency_ms

        if not all([hostname, port]):
            return None

        start_time = time.monotonic()
        
        sock = socket.create_connection((hostname, port), timeout=TCP_TIMEOUT)
        if is_tls:
            context = ssl.create_default_context()
            context.check_hostname = False # We don't verify hostname for testing
            context.verify_mode = ssl.CERT_NONE # Don't verify certificates for testing
            
            with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                # Attempt a read to see if the TLS handshake completes
                ssock.do_handshake() 
                end_time = time.monotonic()
                latency_ms = int((end_time - start_time) * 1000)
                return config, latency_ms
        else:
            # For non-TLS protocols (e.g., plain WS, SS without TLS)
            end_time = time.monotonic()
            latency_ms = int((end_time - start_time) * 1000)
            return config, latency_ms

    except Exception as e:
        # print(f"DEBUG: Failed to test {config[:50]}... Reason: {e}") # Uncomment for debugging
        return None

def select_configs_with_fluid_quota(configs_with_latency: List[Tuple[str, int]], min_target_count: int, max_final_count: int) -> List[str]:
    """
    Selects configs using a fluid, round-robin method to ensure protocol diversity and quality,
    within a specified min/max range.
    """
    if not configs_with_latency:
        return []

    # 1. Group configs by protocol and keep them sorted by latency
    grouped_by_protocol = defaultdict(list)
    for config, latency in sorted(configs_with_latency, key=lambda item: item[1]): # Ensure they are sorted
        protocol = urlparse(config).scheme
        if protocol == 'hysteria2': protocol = 'hy2'
        grouped_by_protocol[protocol].append(config)
    
    # 2. Use a round-robin approach to build the final list
    final_configs = []
    protocol_iterators = {protocol: iter(configs) for protocol, configs in grouped_by_protocol.items()}
    
    # First pass: try to reach min_target_count ensuring diversity
    # This loop ensures we add at least one from each protocol available before hitting min_target
    # and prioritizes filling up to min_target_count
    current_protocol_index = 0
    all_protocols = list(protocol_iterators.keys())
    while len(final_configs) < min_target_count:
        if not all_protocols: break # No protocols left
        protocol = all_protocols[current_protocol_index % len(all_protocols)]
        try:
            next_config = next(protocol_iterators[protocol])
            if next_config not in final_configs: # Ensure no duplicates if iterators overlap
                final_configs.append(next_config)
        except StopIteration:
            # If a protocol is exhausted, remove it from the list for this round
            all_protocols.pop(current_protocol_index % len(all_protocols))
            if not all_protocols: break # All protocols exhausted
            current_protocol_index -= 1 # Adjust index as an item was removed

        current_protocol_index += 1
        if len(final_configs) >= max_final_count: # Safety break if somehow max is hit early
            break

    # Second pass: continue adding up to max_final_count, less strict on diversity after min_target
    if len(final_configs) < max_final_count:
        # Reset iterators or ensure they continue from where they left off
        # A simpler approach is to iterate over all remaining, sorted configs
        remaining_configs = [cfg for cfg, _ in configs_with_latency if cfg not in final_configs]
        for cfg in remaining_configs:
            if len(final_configs) >= max_final_count:
                break
            final_configs.append(cfg)

    return final_configs[:max_final_count]


# --- CLOUDFLARE KV UPLOAD FUNCTION --- # ADDED
def upload_to_cloudflare_kv(key: str, value: str):
    if not all([CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID]):
        print("WARNING: Cloudflare KV credentials not fully set (API Token, Account ID, KV Namespace ID). Skipping KV upload.")
        return
    
    try:
        cf = Cloudflare.Cloudflare(token=CF_API_TOKEN)
        
        # Ensure the KV namespace ID is correct
        # You can find this ID in your Cloudflare dashboard under Workers -> KV -> your_kv_namespace -> Settings
        # Based on your screenshot, CF_KV_NAMESPACE_ID should be 'a71ebd79ab2e4c3883e1303e16141537'
        
        cf.workers.kv_namespace.put(
            account_id=CF_ACCOUNT_ID, 
            namespace_id=CF_KV_NAMESPACE_ID, 
            key=key, 
            value=value
        )
        print(f"✅ Successfully uploaded key '{key}' to Cloudflare KV (Namespace: {CF_KV_NAMESPACE_ID}).")
    except Cloudflare.exceptions.CloudflareAPIError as e:
        print(f"ERROR: Cloudflare API Error when uploading '{key}' to KV: {e.code} - {e.message}")
    except Exception as e:
        print(f"ERROR: Failed to upload key '{key}' to Cloudflare KV: {e}")


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

    print(f"\n--- 3. Performing Deep Protocol Handshake Test and Filtering (Max: {MAX_LATENCY_MS}ms) ---")
    fast_configs_with_latency = []
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        # Use test_full_protocol_handshake instead of test_tcp_connection_with_latency
        future_to_config = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in list(all_unique_configs)[:MAX_CONFIGS_TO_TEST]}
        for future in as_completed(future_to_config):
            result = future.result()
            if result:
                config, latency = result
                if latency <= MAX_LATENCY_MS:
                    fast_configs_with_latency.append((config, latency))
    
    # Sort all fast configs globally by latency
    fast_configs_with_latency.sort(key=lambda item: item[1])
    print(f"🏆 Found {len(fast_configs_with_latency)} fast and functional configs.")
    if not fast_configs_with_latency: print("CRITICAL: No fast and functional configs found. Exiting."); return

    print("\n--- 4. Grouping and Finalizing with Fluid Quota (Min 500, Max 1000 per core) ---")
    
    # Separate pools based on the globally sorted list
    singbox_only_pool = [(cfg, lat) for cfg, lat in fast_configs_with_latency if urlparse(cfg).scheme in SINGBOX_ONLY_PROTOCOLS]
    xray_compatible_pool = [(cfg, lat) for cfg, lat in fast_configs_with_latency if urlparse(cfg).scheme in XRAY_PROTOCOLS]

    # Select final configs using the new fluid quota logic
    xray_final = select_configs_with_fluid_quota(xray_compatible_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    
    # For Sing-box, prioritize its own protocols, then backfill with fast Xray configs
    singbox_final_sb_only = [cfg for cfg, lat in singbox_only_pool]
    # Backfill if needed, up to MAX_FINAL_CONFIGS_PER_CORE
    # We use a set for xray_fillers to avoid duplicates with singbox_final_sb_only
    xray_filler_set = {cfg for cfg, lat in xray_compatible_pool if cfg not in singbox_final_sb_only}
    xray_fillers = list(xray_filler_set) # Convert back to list for slicing

    needed_for_singbox = MAX_FINAL_CONFIGS_PER_CORE - len(singbox_final_sb_only)
    if needed_for_singbox > 0:
        singbox_final_sb_only.extend(xray_fillers[:needed_for_singbox])
    singbox_final = singbox_final_sb_only[:MAX_FINAL_CONFIGS_PER_CORE] # Final trim


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

    # --- 5. Uploading to Cloudflare KV --- # ADDED / MODIFIED SECTION
    print("\n--- 5. Uploading to Cloudflare KV ---")
    current_timestamp = str(int(time.time()))

    # Upload all_live_configs JSON
    upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json.dumps(output_data, indent=2, ensure_ascii=False))

    # Upload cache_version
    upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, current_timestamp)
    
    # Local file writing removed
    # with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
    #     json.dump(output_data, f, indent=2, ensure_ascii=False)
    # print(f"✅ Wrote grouped configs to {OUTPUT_JSON_FILE}.")

    # with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f: f.write(str(int(time.time())))
    # print(f"✅ Cache version updated.")
    
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()

