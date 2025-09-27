# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import socket
import ssl
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
# ✅ تغییر: اضافه کردن Auth برای رفع DeprecationWarning
from github import Github, Auth, BadCredentialsException, RateLimitExceededException, UnknownObjectException 
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import yaml 

# ✅ لاگ تمیز شده
print("INFO: V2V Scraper v44.5 (Optimized & Deprecation Fixed)") 

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

# Protocol definitions
XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}

# Environment variables for sensitive data
GITHUB_PAT = os.environ.get('GH_PAT') 

# --- PERFORMANCE & FILTERING PARAMETERS ---
MAX_CONFIGS_TO_TEST = 10000 
MIN_TARGET_CONFIGS_PER_CORE = 1000 
MAX_FINAL_CONFIGS_PER_CORE = 5000  
MAX_TEST_WORKERS = 100 
TCP_TIMEOUT = 8.0 
MAX_LATENCY_MS = 4500 
MAX_NAME_LENGTH = 40
GITHUB_SEARCH_LIMIT = max(50, int(os.environ.get('GITHUB_SEARCH_LIMIT', 150))) 
UPDATE_INTERVAL_HOURS = 3 

# --- HELPER FUNCTIONS (Robust Parsing & Validation) ---

def decode_base64_content(content: str) -> str:
    """Safely decodes base64 content, handling padding and other errors."""
    if not isinstance(content, str) or not content.strip():
        return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        # Add padding if missing
        missing_padding = len(content) % 4
        if missing_padding:
            content += '=' * (4 - missing_padding)
        return base64.b64decode(content).decode('utf-8', 'ignore')
    except Exception:
        return ""

def is_valid_config(config: str) -> bool:
    """More robustly validates the format of a config string."""
    if not isinstance(config, str) or not config.strip():
        return False
    try:
        parsed = urlparse(config)
        scheme = parsed.scheme.lower()
        if scheme not in VALID_PROTOCOLS:
            return False
        
        if scheme == 'vmess':
            vmess_data_encoded = config.replace("vmess://", "")
            if not vmess_data_encoded: return False
            try:
                decoded_vmess = json.loads(decode_base64_content(vmess_data_encoded))
                return bool(decoded_vmess.get('add')) and bool(decoded_vmess.get('port'))
            except Exception: return False
        
        # All other protocols require a hostname and port directly from URL parse
        return bool(parsed.hostname) and bool(parsed.port)
    except Exception:
        return False

# --- SCRAPING & CLASH GENERATION FUNCTIONS ---

def fetch_from_static_sources(sources: List[str]) -> Set[str]:
    """
    Fetches configs from a list of static subscription links.
    """
    all_configs = set()
    print(f"  Fetching from {len(sources)} static URLs...")

    def fetch_url(url):
        try:
            time.sleep(random.uniform(0.5, 1.5)) 
            response = requests.get(url, headers=HEADERS, timeout=10)
            response.raise_for_status()
            content = response.text 
            
            potential_configs = set()
            decoded_full_content = decode_base64_content(content) 
            
            for current_content in [content, decoded_full_content]:
                if not current_content: continue 
                
                for line_num, line in enumerate(current_content.splitlines()):
                    if line_num >= 5000: break
                    
                    cleaned_line = line.strip()
                    if is_valid_config(cleaned_line):
                        potential_configs.add(cleaned_line)
                    elif 20 < len(cleaned_line) < 2000 and re.match(r'^[a-zA-Z0-9+/=\s]+$', cleaned_line):
                        try:
                            decoded_sub_content = decode_base64_content(cleaned_line)
                            for sub_line in decoded_sub_content.splitlines():
                                if is_valid_config(sub_line.strip()):
                                    potential_configs.add(sub_line.strip())
                        except Exception:
                            pass
            
            return potential_configs
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:
                time.sleep(60)
                return fetch_url(url)
            return set()
        except requests.RequestException:
            return set()
        except Exception:
            return set()

    with ThreadPoolExecutor(max_workers=10) as executor: 
        futures = {executor.submit(fetch_url, url) for url in sources}
        for future in as_completed(futures):
            all_configs.update(future.result())
    
    return all_configs

def fetch_from_github(pat: str, limit: int) -> Set[str]:
    """
    Fetches configs by searching public GitHub repositories using the provided PAT.
    """
    if not pat:
        print("WARNING: GitHub PAT not found. Skipping dynamic search.")
        return set()
    
    all_configs = set()
    total_files_processed = 0

    try:
        # ✅ تغییر: استفاده از Auth.Token برای احراز هویت جدید
        g = Github(auth=Auth.Token(pat), timeout=30) 
        query = " OR ".join(VALID_PROTOCOLS) + " extension:txt extension:md extension:yml extension:yaml extension:json extension:html -user:mahdibland"
        
        results = g.search_code(query, order='desc', sort='indexed', per_page=100)

        for content_file in results:
            if total_files_processed >= limit:
                break

            try:
                time.sleep(random.uniform(0.1, 0.3)) 

                file_content_bytes = content_file.content 
                decoded_content_str = file_content_bytes.decode('utf-8', 'ignore').replace('`', '')
                
                potential_configs = set()
                for line_num, line in enumerate(decoded_content_str.splitlines()):
                    if line_num >= 2000: break 
                    
                    cleaned_line = line.strip()
                    if is_valid_config(cleaned_line):
                        potential_configs.add(cleaned_line)
                    elif 20 < len(cleaned_line) < 2000 and re.match(r'^[a-zA-Z0-9+/=\s]+$', cleaned_line):
                        try:
                            decoded_sub_content = decode_base64_content(cleaned_line)
                            for sub_line in decoded_sub_content.splitlines():
                                if is_valid_config(sub_line.strip()):
                                    potential_configs.add(sub_line.strip())
                        except Exception:
                            pass
                
                if potential_configs:
                    all_configs.update(potential_configs)
                    total_files_processed += 1
                                    
            except UnknownObjectException:
                continue 
            except RateLimitExceededException:
                time.sleep(180)
                continue
            except Exception:
                continue
        
        print(f"  Finished GitHub search. Found {len(all_configs)} configs from {total_files_processed} unique GitHub files.")
        return all_configs

    except BadCredentialsException:
        print("ERROR: GitHub PAT is invalid or lacks necessary scopes. Please check GH_PAT.")
        return set()
    except RateLimitExceededException:
        print("WARNING: GitHub API rate limit hit during query. Skipping further search.")
        return set()
    except Exception as e: 
        print(f"ERROR: General GitHub operation failed. Skipping GitHub search.")
        return set()

def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]:
    """
    Performs a TCP/TLS handshake test for the given configuration.
    """
    try:
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme.lower()
        
        hostname, port, is_tls, sni = None, None, False, None
        
        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname, port = decoded.get('add'), int(decoded.get('port', 0))
            is_tls = decoded.get('tls') in ['tls', 'xtls']
            sni = decoded.get('sni') or decoded.get('host') or hostname
        elif protocol in VALID_PROTOCOLS: 
            hostname, port = parsed_url.hostname, int(parsed_url.port or 0)
            query_params = dict(qp.split('=', 1) for qp in parsed_url.query.split('&') if '=' in qp) if parsed_url.query else {}
            is_tls = query_params.get('security') in ['tls', 'xtls'] or protocol == 'trojan'
            sni = query_params.get('sni') or hostname
        else: return None

        if not all([hostname, port]) or port == 0: return None

        start_time = time.monotonic()
        
        if protocol in SINGBOX_ONLY_PROTOCOLS:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                # استفاده از TCP_TIMEOUT جدید
                sock.settimeout(TCP_TIMEOUT)
                try:
                    sock.sendto(b'\x00\x00', (hostname, port)) 
                    sock.recvfrom(1024) 
                except socket.timeout:
                    pass 
                except Exception:
                    return None 

        else: # TCP-based protocols
            with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT) as sock:
                if is_tls:
                    context = ssl.create_default_context()
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                    with context.wrap_socket(sock, server_hostname=sni or hostname) as ssock:
                        ssock.do_handshake()
        
        latency = int((time.monotonic() - start_time) * 1000)
        return config, latency
    except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError): 
        return None 
    except Exception:
        return None 

def select_configs_with_fluid_quota(configs: List[Tuple[str, int]], min_target: int, max_target: int) -> List[str]:
    """
    Selects a fluid quota of configs based on protocol and latency.
    """
    if not configs: return []
    
    sorted_configs_with_latency = sorted(configs, key=lambda item: item[1])
    
    grouped = defaultdict(list)
    for cfg, lat in sorted_configs_with_latency:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2'
        grouped[proto].append(cfg)
    
    final_selected_configs = []
    current_final_set = set()

    # 1. Prioritize a small number of each protocol type 
    for proto in sorted(grouped.keys()): 
        take_count = min(10, len(grouped[proto]))
        for cfg in grouped[proto][:take_count]:
            if cfg not in current_final_set:
                final_selected_configs.append(cfg)
                current_final_set.add(cfg)
        grouped[proto] = [cfg for cfg in grouped[proto] if cfg not in current_final_set]

    # 2. Fill up to min_target by cycling through remaining configs from all protocols
    iters = {p: iter(c) for p, c in grouped.items()}
    protos_in_play = list(iters.keys())

    while len(final_selected_configs) < min_target and protos_in_play:
        for proto in protos_in_play[:]: 
            try:
                cfg = next(iters[proto])
                if cfg not in current_final_set:
                    final_selected_configs.append(cfg)
                    current_final_set.add(cfg)
            except StopIteration:
                protos_in_play.remove(proto)
            
            if len(final_selected_configs) >= min_target: break

    # 3. Fill up to max_target with any remaining fastest configs
    all_remaining_from_original_sorted = [cfg for cfg, _ in sorted_configs_with_latency if cfg not in current_final_set]
    
    configs_needed_to_reach_max = max_target - len(final_selected_configs)
    final_selected_configs.extend(all_remaining_from_original_sorted[:configs_needed_to_reach_max])
    
    return final_selected_configs

def generate_clash_yaml(configs: List[str]) -> Optional[str]:
    """Generates a Clash Meta compatible YAML string from a list of configs."""
    proxies = []
    unique_check = set()
    
    for config in configs:
        try:
            parsed_proxy = parse_proxy_for_clash(config)
            if parsed_proxy:
                key = f"{parsed_proxy['server']}:{parsed_proxy['port']}:{parsed_proxy['name']}"
                if key not in unique_check:
                    proxies.append(parsed_proxy)
                    unique_check.add(key)
        except Exception:
            continue
            
    if not proxies: return None
    proxy_names = [p['name'] for p in proxies]
    clash_config = {
        'proxies': proxies,
        'proxy-groups': [
            {'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300, 'tolerance': 50},
            {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', *proxy_names]}
        ],
        'rules': ['MATCH,V2V-Select']
    }
    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data): return True
    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

def parse_proxy_for_clash(config: str) -> Optional[Dict]:
    """Parses a single config URI into a Clash proxy dictionary."""
    try:
        name_raw = urlparse(config).fragment or f"V2V-{int(time.time() * 1000) % 10000}"
        name = re.sub(r'[\U0001F600-\U0001FAFF\U00002702-\U000027B0\U000024C2-\U0001F251\W_]+', '', name_raw).strip()
        name = name[:MAX_NAME_LENGTH] 
        if not name: name = f"V2V-Unnamed-{int(time.time() * 1000) % 10000}"

        base = {'name': name, 'skip-cert-verify': True}
        protocol = urlparse(config).scheme.lower()

        # VMess parsing
        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            vmess_proxy = {
                **base, 'type': 'vmess', 'server': decoded.get('add'), 'port': int(decoded.get('port')),
                'uuid': decoded.get('id'), 'alterId': int(decoded.get('aid', 0)), 'cipher': decoded.get('scy', 'auto'),
                'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net'), 'servername': decoded.get('sni') or decoded.get('host')
            }
            if decoded.get('net') == 'ws':
                vmess_proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
            elif decoded.get('net') == 'h2': 
                vmess_proxy['h2-opts'] = {'host': [decoded.get('host', decoded.get('add'))]}
            return vmess_proxy
        
        # Generic URL-parsed protocols (VLESS, Trojan, SS)
        parsed_url = urlparse(config)
        params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p) if parsed_url.query else {}

        if protocol == 'vless':
            vless_proxy = {
                **base, 'type': 'vless', 'server': parsed_url.hostname, 'port': parsed_url.port,
                'uuid': parsed_url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type'),
                'servername': params.get('sni') or parsed_url.hostname
            }
            if params.get('type') == 'ws':
                vless_proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', parsed_url.hostname)}}
            elif params.get('type') == 'h2': 
                vless_proxy['h2-opts'] = {'host': [params.get('host', parsed_url.hostname)]}
            elif params.get('type') == 'grpc': 
                vless_proxy['grpc-opts'] = {'service-name': params.get('serviceName', '')}
            return vless_proxy
            
        if protocol == 'trojan':
            if not parsed_url.username: return None
            return {
                **base, 'type': 'trojan', 'server': parsed_url.hostname, 'port': parsed_url.port, 
                'password': parsed_url.username, 'sni': params.get('sni') or parsed_url.hostname
            }
            
        if protocol == 'ss':
            decoded_user = decode_base64_content(parsed_url.username)
            if not decoded_user or ':' not in decoded_user: return None
            cipher, password = decoded_user.split(':', 1)
            return {
                **base, 'type': 'ss', 'server': parsed_url.hostname, 'port': parsed_url.port, 
                'cipher': cipher, 'password': password
            }
    except Exception:
        return None
        
    return None


# --- MAIN LOGIC ---
def main():
    print("--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        
        static_sources = sources_config.get("static", [])

        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit set to: {GITHUB_SEARCH_LIMIT}.")
    except Exception as e:
        print(f"FATAL: Cannot load or parse {SOURCES_FILE}: {e}. Exiting.")
        return

    print("\n--- 2. Fetching Configs ---")
    all_collected_configs = set()
    with ThreadPoolExecutor(max_workers=2) as executor: 
        static_future = executor.submit(fetch_from_static_sources, static_sources)
        dynamic_future = executor.submit(fetch_from_github, GITHUB_PAT, GITHUB_SEARCH_LIMIT)
        
        all_collected_configs.update(static_future.result())
        all_collected_configs.update(dynamic_future.result())
    
    if not all_collected_configs: 
        print("FATAL: No configs found after fetching from all sources. Exiting.")
        return
    print(f"📊 Total unique configs collected: {len(all_collected_configs)}")

    print(f"\n--- 3. Performing Deep Protocol Handshake Test ---")
    fast_configs_with_latency = []
    configs_to_test_list = list(all_collected_configs)[:MAX_CONFIGS_TO_TEST] 
    print(f"  Testing {len(configs_to_test_list)} configs with {MAX_TEST_WORKERS} workers...")
    
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in configs_to_test_list}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: 
                print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS: 
                fast_configs_with_latency.append(result)

    if not fast_configs_with_latency: 
        print("FATAL: No fast configs found after testing. Exiting.")
        return
    print(f"🏆 Found {len(fast_configs_with_latency)} fast configs.")

    print("\n--- 4. Grouping and Finalizing Configs (Non-Overlapping) ---")
    
    all_fastest_configs_sorted = sorted(fast_configs_with_latency, key=lambda item: item[1])
    
    # 2. Select the Sing-box list (supports all VALID_PROTOCOLS)
    singbox_eligible_pool = [(c, l) for c, l in all_fastest_configs_sorted if urlparse(c).scheme.lower() in VALID_PROTOCOLS]
    singbox_final_selected = select_configs_with_fluid_quota(
        singbox_eligible_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE
    )
    
    # 3. Filter the pool for Xray by excluding selected Sing-box configs (ensuring non-overlap).
    singbox_selected_set = set(singbox_final_selected)
    
    xray_eligible_pool_non_overlapping = [
        (c, l) for c, l in all_fastest_configs_sorted
        if c not in singbox_selected_set and urlparse(c).scheme.lower() in XRAY_PROTOCOLS
    ]
    
    # 4. Now select the Xray list from the non-overlapping remaining pool
    xray_final_selected = select_configs_with_fluid_quota(
        xray_eligible_pool_non_overlapping, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE
    )
    
    print(f"✅ Selected {len(xray_final_selected)} unique configs for Xray core.")
    print(f"✅ Selected {len(singbox_final_selected)} unique configs for Sing-box core.")


    # Helper to group by protocol for JSON output structure
    def group_by_protocol_for_output(configs: List[str]) -> Dict[str, List[str]]:
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2' # Normalize
            grouped[proto].append(cfg)
        return dict(grouped)

    final_output_data = {
        "xray": group_by_protocol_for_output(xray_final_selected), 
        "singbox": group_by_protocol_for_output(singbox_final_selected)
    }

    print("\n--- 5. Writing Local Files ---")
    # Writing all_live_configs.json
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote combined configs to {OUTPUT_JSON_FILE}.")

    # Writing clash_subscription.yml (using Xray configs for Clash Meta)
    clash_yaml_content = generate_clash_yaml(xray_final_selected)
    if clash_yaml_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_yaml_content)
        print(f"✅ Wrote Clash subscription with {len(xray_final_selected)} configs to {OUTPUT_CLASH_FILE}.")
    else:
        print("⚠️ Could not generate Clash subscription file (no compatible Xray configs found).")

    # Writing cache_version.txt
    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {CACHE_VERSION_FILE}.")

    print("\n--- Process Completed Successfully (Files Ready for Commit/Deploy) ---")
    
    total_xray = sum(len(configs) for configs in final_output_data["xray"].values())
    total_singbox = sum(len(configs) for configs in final_output_data["singbox"].values())
    print(f"Final Summary:")
    print(f"   - Xray configs: {total_xray}")
    print(f"   - Sing-box configs: {total_singbox}")

if __name__ == "__main__":
    main()
