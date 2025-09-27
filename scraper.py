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
from github import Github, Auth, BadCredentialsException, RateLimitExceededException, UnknownObjectException
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import yaml # ✅ اضافه شدن PyYAML

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("INFO: V2V Scraper v44.0 (Hybrid Fast-Fetch + Advanced Features)") # ✅ نسخه جدید

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
GITHUB_PAT = os.environ.get('GH_PAT') # ✅ استانداردسازی به حروف بزرگ
CLOUDFLARE_API_TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN') # ✅ استانداردسازی به حروف بزرگ
CLOUDFLARE_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID') # ✅ استانداردسازی به حروف بزرگ
CLOUDFLARE_KV_NAMESPACE_ID = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID') # ✅ استانداردسازی به حروف بزرگ

# --- PERFORMANCE & FILTERING PARAMETERS (Managed in scraper.py) ---
MAX_CONFIGS_TO_TEST = 15000
MIN_TARGET_CONFIGS_PER_CORE = 500
MAX_FINAL_CONFIGS_PER_CORE = 1000
MAX_TEST_WORKERS = 200
TCP_TIMEOUT = 2.5
MAX_LATENCY_MS = 2500
MAX_NAME_LENGTH = 40
GITHUB_SEARCH_LIMIT = 150 # ✅ مقدار پیش‌فرض GitHub search limit (از sources.json حذف شد)
UPDATE_INTERVAL_HOURS = 3 # ✅ مقدار پیش‌فرض update interval (از sources.json حذف شد)

# Cloudflare KV keys
KV_LIVE_CONFIGS_KEY = 'all_live_configs.json'
KV_CACHE_VERSION_KEY = 'cache_version.txt'

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
    except Exception as e:
        # print(f"DEBUG: Base64 decode failed for content snippet: '{content[:50]}...'. Error: {e}")
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
    Uses v25.0's approach of decoding entire content as base64 first.
    """
    all_configs = set()
    print(f"  Fetching from {len(sources)} static URLs...")

    def fetch_url(url):
        try:
            # Add a small random delay to avoid hitting server limits too aggressively
            time.sleep(random.uniform(0.5, 1.5)) 
            response = requests.get(url, headers=HEADERS, timeout=10)
            response.raise_for_status()
            content = response.text # Already a string
            
            potential_configs = set()
            
            # First, try to decode the *entire* response content as a single Base64 string (v25.0 approach)
            decoded_full_content = decode_base64_content(content) 
            
            # Check both raw content and decoded full content for configs
            for current_content in [content, decoded_full_content]:
                if not current_content: continue # Skip if content is empty
                
                # Limit lines to prevent excessive processing for very large files
                for line_num, line in enumerate(current_content.splitlines()):
                    if line_num >= 5000: break # Process max 5000 lines per static file
                    
                    cleaned_line = line.strip()
                    if is_valid_config(cleaned_line):
                        potential_configs.add(cleaned_line)
                    # Also check if a line itself might be a Base64 encoded sub-list
                    elif 20 < len(cleaned_line) < 2000 and re.match(r'^[a-zA-Z0-9+/=\s]+$', cleaned_line):
                        try:
                            decoded_sub_content = decode_base64_content(cleaned_line)
                            for sub_line in decoded_sub_content.splitlines():
                                if is_valid_config(sub_line.strip()):
                                    potential_configs.add(sub_line.strip())
                        except Exception:
                            pass # Not a valid base64 line
            
            return potential_configs
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:
                print(f"    Rate limit hit for {url} (HTTP 429). Waiting 60s and retrying...")
                time.sleep(60)
                return fetch_url(url) # Recursive retry
            elif e.response.status_code != 404: # Ignore 404s, but log other HTTP errors
                print(f"    HTTP Error {e.response.status_code} for {url}. Skipping.")
            return set()
        except requests.RequestException as e:
            print(f"    Network/Request Error for {url}: {e}. Skipping.")
            return set()
        except Exception as e:
            print(f"    General Error fetching/processing {url}: {type(e).__name__}: {e}. Skipping.")
            return set()

    with ThreadPoolExecutor(max_workers=10) as executor: # Keep max_workers low for static sources
        futures = {executor.submit(fetch_url, url) for url in sources}
        for future in as_completed(futures):
            all_configs.update(future.result())
    
    return all_configs

def fetch_from_github(pat: str, limit: int) -> Set[str]:
    """
    Fetches configs by searching public GitHub repositories.
    Uses v25.0's simpler query and direct content decoding.
    """
    if not pat:
        print("WARNING: GitHub PAT not found. Skipping dynamic search.")
        return set()
    
    all_configs = set()
    total_files_processed = 0

    try:
        auth_obj = Auth.Token(pat)
        g = Github(auth=auth_obj, timeout=30)
        
        # Simpler query from v25.0, focusing on common extensions
        query = " OR ".join(VALID_PROTOCOLS) + " extension:txt extension:md extension:yml extension:yaml extension:json extension:html -user:mahdibland"
        
        print(f"  Starting GitHub search with query: '{query}' (limit: {limit})...")
        
        # Results iterator, no explicit page_num loop as in v25.0, rely on 'limit'
        results = g.search_code(query, order='desc', sort='indexed', per_page=100) # per_page for efficient fetching

        for content_file in results:
            if total_files_processed >= limit:
                print(f"  Reached GitHub file limit of {limit}, stopping further search.")
                break

            try:
                # Add a small random delay
                time.sleep(random.uniform(0.1, 0.3)) 

                # Use content_file.content (bytes) and decode manually (v25.0 approach)
                file_content_bytes = content_file.content 
                decoded_content_str = file_content_bytes.decode('utf-8', 'ignore').replace('`', '')
                
                potential_configs = set()
                # Limit lines to prevent excessive processing for very large files
                for line_num, line in enumerate(decoded_content_str.splitlines()):
                    if line_num >= 2000: break # Process max 2000 lines per GitHub file
                    
                    cleaned_line = line.strip()
                    if is_valid_config(cleaned_line):
                        potential_configs.add(cleaned_line)
                    # Also check if a line itself might be a Base64 encoded sub-list
                    elif 20 < len(cleaned_line) < 2000 and re.match(r'^[a-zA-Z0-9+/=\s]+$', cleaned_line):
                        try:
                            decoded_sub_content = decode_base64_content(cleaned_line)
                            for sub_line in decoded_sub_content.splitlines():
                                if is_valid_config(sub_line.strip()):
                                    potential_configs.add(sub_line.strip())
                        except Exception:
                            pass # Not a valid base64 line
                
                if potential_configs:
                    all_configs.update(potential_configs)
                    total_files_processed += 1
                                    
            except UnknownObjectException:
                # File might have been deleted between search and fetch
                continue 
            except RateLimitExceededException:
                print(f"    GitHub API rate limit hit while fetching content for {content_file.path}. Waiting 180s...")
                time.sleep(180)
                continue # Try next file after waiting
            except Exception as e:
                print(f"    Error processing GitHub file {content_file.path}: {type(e).__name__}: {e}. Skipping.")
                continue
        
        print(f"  Finished GitHub search. Found {len(all_configs)} configs from {total_files_processed} unique GitHub files.")
        return all_configs

    except BadCredentialsException:
        print("ERROR: GitHub PAT is invalid or lacks necessary scopes. Please check GH_PAT.")
        return set()
    except RateLimitExceededException:
        print("WARNING: GitHub API rate limit hit during query. Waiting 300s and trying again for the query itself...")
        time.sleep(300)
        return fetch_from_github(pat, limit) # Retry the entire search
    except Exception as e: 
        print(f"ERROR: General GitHub operation failed. Reason: {type(e).__name__}: {e}. Skipping GitHub search.")
        return set()

def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]:
    """
    Performs a TCP/TLS handshake test for the given configuration.
    Expects config to be a string.
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
        
        # Special handling for UDP-based protocols like Hysteria2/TUIC (Sing-box only)
        if protocol in SINGBOX_ONLY_PROTOCOLS:
            # We can't do a full handshake, just check if port is open for UDP
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                try:
                    # Send a dummy packet to check if port is reachable
                    sock.sendto(b'\x00\x00', (hostname, port)) 
                    # Try to receive, but don't fail if no response (UDP is connectionless)
                    sock.recvfrom(1024) 
                except socket.timeout:
                    pass # Timeout is okay for UDP, means no immediate response
                except Exception:
                    return None # Other errors mean it's not working

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
    except Exception as e:
        # print(f"DEBUG: Handshake test failed for {config}. Error: {type(e).__name__}: {e}")
        return None 

def select_configs_with_fluid_quota(configs: List[Tuple[str, int]], min_target: int, max_target: int) -> List[str]:
    """
    Selects a fluid quota of configs based on protocol and latency.
    Prioritizes specific protocols and then fills up with remaining fast configs.
    """
    if not configs: return []
    
    # Sort all configs by latency first (ascending)
    sorted_configs_with_latency = sorted(configs, key=lambda item: item[1])
    
    # Group configs by protocol
    grouped = defaultdict(list)
    for cfg, lat in sorted_configs_with_latency:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2' # Normalize hysteria2
        grouped[proto].append(cfg)
    
    final_selected_configs = []
    current_final_set = set() # To ensure uniqueness

    # 1. Prioritize a small number of each protocol type (e.g., top 10 per protocol)
    for proto in sorted(grouped.keys()): # Iterate consistently
        take_count = min(10, len(grouped[proto]))
        for cfg in grouped[proto][:take_count]:
            if cfg not in current_final_set:
                final_selected_configs.append(cfg)
                current_final_set.add(cfg)
        # Remove selected configs from their groups
        grouped[proto] = [cfg for cfg in grouped[proto] if cfg not in current_final_set]

    # 2. Fill up to min_target by cycling through remaining configs from all protocols
    iters = {p: iter(c) for p, c in grouped.items()}
    protos_in_play = list(iters.keys()) # Copy for safe modification

    while len(final_selected_configs) < min_target and protos_in_play:
        for proto in protos_in_play[:]: # Iterate over a copy to allow modification
            try:
                cfg = next(iters[proto])
                if cfg not in current_final_set:
                    final_selected_configs.append(cfg)
                    current_final_set.add(cfg)
            except StopIteration:
                protos_in_play.remove(proto) # No more configs for this protocol
            
            if len(final_selected_configs) >= min_target: break # Stop if min_target reached

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
                # Use a combination of server, port, and name to ensure uniqueness
                key = f"{parsed_proxy['server']}:{parsed_proxy['port']}:{parsed_proxy['name']}"
                if key not in unique_check:
                    proxies.append(parsed_proxy)
                    unique_check.add(key)
        except Exception:
            continue # Skip malformed configs
            
    if not proxies:
        return None

    proxy_names = [p['name'] for p in proxies]
    
    # Ensure URL is correct and interval is reasonable
    clash_config = {
        'proxies': proxies,
        'proxy-groups': [
            {'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300, 'tolerance': 50},
            {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto', *proxy_names]}
        ],
        'rules': ['MATCH,V2V-Select']
    }
    
    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data):
            return True

    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

def parse_proxy_for_clash(config: str) -> Optional[Dict]:
    """Parses a single config URI into a Clash proxy dictionary."""
    try:
        # Generate a unique and clean name
        name_raw = urlparse(config).fragment or f"V2V-{int(time.time() * 1000) % 10000}"
        # Remove emojis and special characters, limit length
        name = re.sub(r'[\U0001F600-\U0001FAFF\U00002702-\U000027B0\U000024C2-\U0001F251\W_]+', '', name_raw).strip()
        name = name[:MAX_NAME_LENGTH] # Truncate name if too long
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
            elif decoded.get('net') == 'h2': # HTTP/2
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
            elif params.get('type') == 'h2': # HTTP/2
                vless_proxy['h2-opts'] = {'host': [params.get('host', parsed_url.hostname)]}
            elif params.get('type') == 'grpc': # gRPC
                vless_proxy['grpc-opts'] = {'service-name': params.get('serviceName', '')}
            return vless_proxy
            
        if protocol == 'trojan':
            if not parsed_url.username: return None # Trojan requires password
            return {
                **base, 'type': 'trojan', 'server': parsed_url.hostname, 'port': parsed_url.port, 
                'password': parsed_url.username, 'sni': params.get('sni') or parsed_url.hostname
            }
            
        if protocol == 'ss':
            # Shadowsocks userinfo is base64(cipher:password)
            decoded_user = decode_base64_content(parsed_url.username)
            if not decoded_user or ':' not in decoded_user: return None
            cipher, password = decoded_user.split(':', 1)
            return {
                **base, 'type': 'ss', 'server': parsed_url.hostname, 'port': parsed_url.port, 
                'cipher': cipher, 'password': password
            }
    except Exception as e:
        # print(f"DEBUG: Error parsing config for Clash: {config}. Error: {type(e).__name__}: {e}")
        return None
        
    return None

def upload_to_cloudflare_kv(key: str, value: str):
    """
    Uploads a string value to a Cloudflare KV namespace.
    The value is expected to be a string and will be encoded to UTF-8 bytes before upload.
    """
    if not all([CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID]):
        print("FATAL: Cloudflare KV credentials not fully set. Skipping KV upload.")
        raise ValueError("Cloudflare API Token, Account ID, or KV Namespace ID is missing from environment variables.")
    
    if not isinstance(value, str):
        print(f"CRITICAL ERROR: Attempted to upload non-string value for KV key '{key}'. Type: {type(value).__name__}.")
        raise TypeError(f"KV value for '{key}' must be a string, but received type {type(value).__name__}.")

    try:
        cf_client = Cloudflare(api_token=CLOUDFLARE_API_TOKEN, timeout=60)
        
        cf_client.kv.namespaces.values.update(
            account_id=CLOUDFLARE_ACCOUNT_ID,
            namespace_id=CLOUDFLARE_KV_NAMESPACE_ID,
            key_name=key,
            value=value.encode('utf-8'), # Encoded to bytes for KV storage
            metadata={}
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e:
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': Code {e.code} - {e.message}")
        if e.code == 10000:
            print("  HINT: Ensure the CLOUDFLARE_API_TOKEN has 'Worker KV Storage Write' permission.")
        if e.code == 10014:
            print("  HINT: Double-check that CLOUDFLARE_KV_NAMESPACE_ID is correct.")
        raise
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {type(e).__name__}: {e}")
        raise

def clean_for_json(obj):
    """
    Recursively cleans a Python object to ensure all components are JSON-serializable.
    Specifically converts bytes to strings and ensures dictionary keys are strings.
    """
    if isinstance(obj, bytes):
        return obj.decode('utf-8', 'ignore')
    elif isinstance(obj, dict):
        cleaned_dict = {}
        for k, v in obj.items():
            # Ensure key is a string after recursive cleaning
            cleaned_key = clean_for_json(k)
            if not isinstance(cleaned_key, str):
                cleaned_key = str(cleaned_key) 
            cleaned_dict[cleaned_key] = clean_for_json(v)
        return cleaned_dict
    elif isinstance(obj, (list, tuple, set)):
        return [clean_for_json(item) for item in obj]
    elif isinstance(obj, (int, float, str, bool)) or obj is None:
        return obj
    else:
        print(f"WARNING: Found unexpected type '{type(obj).__name__}' during JSON cleaning. Converting to string.")
        return str(obj)

# --- MAIN LOGIC ---
def main():
    print("--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        
        static_sources = sources_config.get("static", [])
        # github_search_limit و update_interval_hours اکنون از متغیرهای ثابت بالا استفاده می‌کنند.
        # نیازی به خواندن آنها از sources_config نیست.

        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit set to: {GITHUB_SEARCH_LIMIT}.")
    except Exception as e:
        print(f"FATAL: Cannot load or parse {SOURCES_FILE}: {e}. Exiting.")
        return

    print("\n--- 2. Fetching Configs ---")
    all_collected_configs = set()
    with ThreadPoolExecutor(max_workers=2) as executor: # Use fewer workers for overall fetching coordination
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
    # Limit the number of configs to test to prevent excessively long runs
    configs_to_test_list = list(all_collected_configs)[:MAX_CONFIGS_TO_TEST] 
    print(f"  Testing {len(configs_to_test_list)} configs with {MAX_TEST_WORKERS} workers...")
    
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in configs_to_test_list}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: # Progress update every 500 tests
                print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS: # Filter by max latency
                fast_configs_with_latency.append(result)

    if not fast_configs_with_latency: 
        print("FATAL: No fast configs found after testing. Exiting.")
        return
    print(f"🏆 Found {len(fast_configs_with_latency)} fast configs.")

    print("\n--- 4. Grouping and Finalizing Configs (Non-Overlapping) ---")
    # Sort all fast configs by latency once (fastest first)
    all_fastest_configs_sorted = sorted(fast_configs_with_latency, key=lambda item: item[1])
    
    # 1. Select the Sing-box list (supports all VALID_PROTOCOLS) from the top of the overall fastest list.
    # The input pool to fluid quota needs to be (config, latency) tuples, but only containing VALID_PROTOCOLS.
    singbox_eligible_pool = [(c, l) for c, l in all_fastest_configs_sorted if urlparse(c).scheme.lower() in VALID_PROTOCOLS]
    singbox_final_selected = select_configs_with_fluid_quota(singbox_eligible_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    
    # 2. Filter the pool for Xray by removing selected Sing-box configs (ensuring non-overlap).
    singbox_selected_set = set(singbox_final_selected)
    
    # The Xray pool must contain only XRAY_PROTOCOLS AND must exclude already selected Sing-box configs.
    # It must also maintain the sorted order to ensure the fastest *remaining* configs are considered first.
    xray_eligible_pool_non_overlapping = [
        (c, l) for c, l in all_fastest_configs_sorted
        if c not in singbox_selected_set and urlparse(c).scheme.lower() in XRAY_PROTOCOLS
    ]
    
    # Now select the Xray list from the non-overlapping remaining pool
    xray_final_selected = select_configs_with_fluid_quota(xray_eligible_pool_non_overlapping, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    
    # End of Modification
    
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

    output_data_for_kv = {
        "xray": group_by_protocol_for_output(xray_final_selected), 
        "singbox": group_by_protocol_for_output(singbox_final_selected)
    }

    print("\n--- 5. Writing Local Files ---")
    # Writing all_live_configs.json
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data_for_kv, f, indent=2, ensure_ascii=False)
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

    print("\n--- 6. Uploading to Cloudflare KV ---")
    try:
        print("  Cleaning data structure for JSON serialization...")
        cleaned_output_data = clean_for_json(output_data_for_kv)
        
        print("  Testing JSON serialization...")
        json_string_to_upload = json.dumps(cleaned_output_data, indent=2, ensure_ascii=False)
        print(f"  JSON serialization successful. Data size: {len(json_string_to_upload)} characters")
        
        print("  Uploading live configs to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json_string_to_upload)
        
        print("  Uploading cache version to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time())))
        
        print("\n--- Process Completed Successfully ---")
        
        total_xray = sum(len(configs) for configs in output_data_for_kv["xray"].values())
        total_singbox = sum(len(configs) for configs in output_data_for_kv["singbox"].values())
        print(f"Final Summary:")
        print(f"   - Xray configs: {total_xray}")
        print(f"   - Sing-box configs: {total_singbox}")
        
    except ValueError as e:
        print(f"❌ FATAL: Cloudflare KV upload skipped due to missing credentials: {e}")
        raise
    except Exception as e:
        print(f"❌ FATAL: Could not complete Cloudflare KV upload: {type(e).__name__}: {e}")
        # Add debug info for KV upload failure
        print("\nDEBUG INFO (KV upload failure):")
        print(f"  Output data type: {type(output_data_for_kv)}")
        if isinstance(output_data_for_kv, dict):
            for key, value in output_data_for_kv.items():
                print(f"  - Key '{key}': Type {type(value)}")
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        print(f"    - SubKey '{subkey}': Type {type(subvalue)} (length: {len(subvalue) if hasattr(subvalue, '__len__') else 'n/a'})")
        raise

if __name__ == "__main__":
    main()
