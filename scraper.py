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

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("v2v scraper v43.0 (Timeout Avoidance Strategy - Reduced GitHub Scope)")

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'v2v-scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT') 

# --- Performance & Filtering Parameters ---
MAX_CONFIGS_TO_TEST = 15000
MIN_TARGET_CONFIGS_PER_CORE = 500
MAX_FINAL_CONFIGS_PER_CORE = 1000
MAX_TEST_WORKERS = 200
TCP_TIMEOUT = 2.5
MAX_LATENCY_MS = 2500
MAX_NAME_LENGTH = 40

# --- Cloudflare KV Configuration ---
CF_API_TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
CF_KV_NAMESPACE_ID = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID')

KV_LIVE_CONFIGS_KEY = 'all_live_configs.json'
KV_CACHE_VERSION_KEY = 'cache_version.txt'

# --- Helper Functions ---
def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        missing_padding = len(content) % 4
        if missing_padding: content += '=' * (4 - missing_padding)
        return base64.b64decode(content).decode('utf-8', 'ignore')
    except Exception: return ""

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip(): return False
    try:
        parsed = urlparse(config)
        scheme = parsed.scheme.lower()
        if scheme not in VALID_PROTOCOLS: return False
        
        if scheme == 'vmess':
            vmess_data_encoded = config.replace("vmess://", "")
            if not vmess_data_encoded: return False
            try:
                decoded_vmess = json.loads(decode_base64_content(vmess_data_encoded))
                return bool(decoded_vmess.get('add')) and bool(decoded_vmess.get('port'))
            except Exception: return False
        
        return bool(parsed.hostname) and bool(parsed.port)
    except Exception: return False

def fetch_from_sources(sources: List[str], is_github: bool, pat: str = None, limit: int = 0) -> Set[str]:
    all_configs = set()
    if is_github:
        if not pat: 
            print("WARNING: GitHub PAT not found. Skipping dynamic search.")
            return set()
        try:
            gh_auth = Auth.Token(pat)
            g = Github(auth=gh_auth, timeout=30)
            
            file_extensions_part = "extension:txt OR extension:md OR extension:yml OR extension:yaml OR extension:json OR extension:html OR extension:log"
            base_negative_filters = "-user:mahdibland -filename:example -filename:sample -filename:test"
            
            queries_to_run = []
            for proto in VALID_PROTOCOLS:
                queries_to_run.append(f'"{proto}://" {file_extensions_part} {base_negative_filters}')
                if proto in XRAY_PROTOCOLS:
                     queries_to_run.append(f'"{proto}://" {base_negative_filters} path:/')

            processed_files = set()
            total_files_processed = 0
            MAX_FILES_PER_GITHUB_QUERY = 50

            print(f"  Starting GitHub search across {len(queries_to_run)} comprehensive queries...")
            for i, query in enumerate(queries_to_run):
                if total_files_processed >= limit: 
                    print(f"  Reached global GitHub file limit of {limit}, stopping further search.")
                    break
                
                print(f"  Executing GitHub Search ({i+1}/{len(queries_to_run)} for {query.split(' ')[0].replace('"', '')})...")
                try:
                    results_iterator = g.search_code(q=query, order='desc', sort='indexed', per_page=100)
                    
                    current_query_files_processed = 0
                    # ✅ MODIFIED: Fetch up to 2 pages instead of 3 to reduce runtime
                    for page_num in range(2): 
                        if total_files_processed >= limit or current_query_files_processed >= MAX_FILES_PER_GITHUB_QUERY: break

                        try:
                            page_results = results_iterator.get_page(page_num)
                        except RateLimitExceededException:
                            print(f"    GitHub API rate limit hit while fetching page {page_num}. Waiting 180s...")
                            time.sleep(180)
                            page_results = results_iterator.get_page(page_num)
                        except Exception as e:
                            print(f"    Error fetching GitHub search page {page_num}: {type(e).__name__}. Skipping to next page/query.")
                            break 

                        if not page_results: break

                        for content_file in page_results:
                            if total_files_processed >= limit or current_query_files_processed >= MAX_FILES_PER_GITHUB_QUERY: break
                            
                            if content_file.path in processed_files: continue
                            processed_files.add(content_file.path)
                            
                            try:
                                time.sleep(random.uniform(0.1, 0.3)) 
                                
                                decoded_content = content_file.decoded_content.decode('utf-8', 'ignore').replace('`', '')
                                
                                potential_configs = set()
                                max_lines_per_file = 2000 
                                for line_num, line in enumerate(decoded_content.splitlines()[:max_lines_per_file]):
                                    cleaned_line = line.strip()
                                    if is_valid_config(cleaned_line):
                                        potential_configs.add(cleaned_line)
                                    elif 20 < len(cleaned_line) < 2000 and re.match(r'^[A-Za-z0-9+/=\s]+$', cleaned_line):
                                        try:
                                            decoded_sub_content = decode_base64_content(cleaned_line)
                                            for sub_line in decoded_sub_content.splitlines()[:100]: 
                                                if is_valid_config(sub_line.strip()):
                                                    potential_configs.add(sub_line.strip())
                                        except Exception: continue
                                
                                if potential_configs:
                                    all_configs.update(potential_configs)
                                    total_files_processed += 1
                                    current_query_files_processed += 1
                                    
                            except UnknownObjectException:
                                continue 
                            except RateLimitExceededException:
                                print(f"    GitHub API rate limit hit while fetching content for {content_file.path}. Waiting 180s...")
                                time.sleep(180)
                                continue 
                            except Exception as e:
                                print(f"    Error processing GitHub file {content_file.path}: {type(e).__name__}: {e}. Skipping.")
                                continue

                except RateLimitExceededException:
                    print("    GitHub API rate limit hit during query execution. Waiting 180s and retrying query...")
                    time.sleep(180)
                    continue 
                except Exception as e:
                    print(f"    ERROR: GitHub search failed for query '{query}'. Reason: {type(e).__name__}: {e}. Skipping query.")
                    continue
                
                if i < len(queries_to_run) - 1:
                    time.sleep(random.uniform(2, 5)) 
            
            print(f"  Finished GitHub search. Found {len(all_configs)} configs from {total_files_processed} unique GitHub files.")

        except BadCredentialsException:
            print("ERROR: GitHub PAT is invalid or lacks necessary scopes. Please check GH_PAT.")
        except Exception as e: 
            print(f"ERROR: General GitHub operation failed. Reason: {type(e).__name__}: {e}. Skipping GitHub search.")
    
    else: # Fetching from static URLs
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
                    for line_num, line in enumerate(current_content.splitlines()[:5000]):
                        cleaned_line = line.strip()
                        if is_valid_config(cleaned_line):
                            potential_configs.add(cleaned_line)
                
                return potential_configs
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 429:
                    print(f"    Rate limit hit for {url} (HTTP 429). Waiting 60s and retrying...")
                    time.sleep(60) 
                    return fetch_url(url)
                elif e.response.status_code != 404:
                    print(f"    HTTP error {e.response.status_code} for {url}. Skipping.")
                return set()
            except requests.RequestException as e:
                print(f"    Network/Request error for {url}: {e}. Skipping.")
                return set()
            except Exception as e:
                print(f"    General error fetching/processing {url}: {e}. Skipping.")
                return set()

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {executor.submit(fetch_url, url): url for url in sources}
            for future in as_completed(futures):
                result = future.result()
                if result: all_configs.update(result)
        print(f"  Finished fetching from static sources. Found {len(all_configs)} configs.")
    
    return all_configs

def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]:
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
                sock.settimeout(TCP_TIMEOUT)
                sock.sendto(b'\x00\x00', (hostname, port)) 
                try:
                    sock.recvfrom(1024) 
                except socket.timeout:
                    pass
        else:
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
    if not configs: return []
    
    sorted_configs_with_latency = sorted(configs, key=lambda item: item[1])
    
    grouped = defaultdict(list)
    for cfg, lat in sorted_configs_with_latency:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2'
        grouped[proto].append(cfg)
    
    final_selected_configs = []
    
    for proto in grouped:
        take_count = min(10, len(grouped[proto]))
        final_selected_configs.extend(grouped[proto][:take_count])
        grouped[proto] = [cfg for cfg in grouped[proto] if cfg not in final_selected_configs]

    current_final_set = set(final_selected_configs)
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
    
    all_remaining_from_original_sorted = [cfg for cfg, _ in sorted_configs_with_latency if cfg not in current_final_set]
    
    configs_needed_to_reach_max = max_target - len(final_selected_configs)
    final_selected_configs.extend(all_remaining_from_original_sorted[:configs_needed_to_reach_max])
    
    return final_selected_configs

def upload_to_cloudflare_kv(key: str, value: str):
    if not all([CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID]):
        print("FATAL: Cloudflare KV credentials not fully set. Skipping KV upload.")
        raise ValueError("Cloudflare API token, account ID, or KV namespace ID is missing from environment variables.")
    try:
        cf_client = Cloudflare(api_token=CF_API_TOKEN, timeout=60)
        
        cf_client.kv.namespaces.values.update(
            account_id=CF_ACCOUNT_ID,
            namespace_id=CF_KV_NAMESPACE_ID,
            key_name=key,
            value=value.encode('utf-8'),
            metadata={}
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e:
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': code {e.code} - {e.message}")
        if e.code == 10000:
            print("HINT: Ensure the CLOUDFLARE_API_TOKEN has 'Worker KV Storage Write' permission.")
        if e.code == 10014:
            print("HINT: Double-check that CLOUDFLARE_KV_NAMESPACE_ID is correct.")
        raise
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {type(e).__name__}: {e}")
        raise

def clean_for_json(obj):
    if isinstance(obj, bytes):
        return obj.decode('utf-8', 'ignore')
    elif isinstance(obj, dict):
        return {str(clean_for_json(k)): clean_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple, Set)):
        return [clean_for_json(item) for item in obj]
    elif isinstance(obj, (int, float, str, bool)) or obj is None:
        return obj
    else:
        return str(obj)

def main():
    print("--- 1. LOADING SOURCES ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        
        static_sources = sources_config.get("static", [])
        # ✅ MODIFIED: Use the reduced GitHub search limit
        github_search_limit = sources_config.get("github_search_limit", 300)

        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit set to: {github_search_limit}.")
    except Exception as e:
        print(f"FATAL: Cannot load or parse {SOURCES_FILE}: {e}. Exiting.")
        return

    print("\n--- 2. FETCHING CONFIGS ---")
    all_collected_configs = set()
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_future = executor.submit(fetch_from_sources, static_sources, False)
        dynamic_future = executor.submit(fetch_from_sources, [], True, GITHUB_PAT, github_search_limit)
        
        all_collected_configs.update(static_future.result())
        all_collected_configs.update(dynamic_future.result())
    
    if not all_collected_configs: 
        print("FATAL: No configs found after fetching from all sources. Exiting.")
        return
    print(f"📊 Total unique configs collected: {len(all_collected_configs)}")

    print(f"\n--- 3. PERFORMING DEEP PROTOCOL HANDSHAKE TEST ---")
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

    print("\n--- 4. GROUPING AND FINALIZING CONFIGS ---")
    xray_eligible_pool = [(c, l) for c, l in fast_configs_with_latency if urlparse(c).scheme.lower() in XRAY_PROTOCOLS]
    singbox_eligible_pool = [(c, l) for c, l in fast_configs_with_latency if urlparse(c).scheme.lower() in VALID_PROTOCOLS]

    xray_final_selected = select_configs_with_fluid_quota(xray_eligible_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    singbox_final_selected = select_configs_with_fluid_quota(singbox_eligible_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    
    print(f"✅ Selected {len(xray_final_selected)} configs for Xray core.")
    print(f"✅ Selected {len(singbox_final_selected)} configs for Sing-box core.")

    def group_by_protocol_for_output(configs: List[str]) -> Dict[str, List[str]]:
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output_data_for_kv = {
        "xray": group_by_protocol_for_output(xray_final_selected), 
        "singbox": group_by_protocol_for_output(singbox_final_selected)
    }

    print("\n--- 5. UPLOADING TO CLOUDFLARE KV ---")
    try:
        print("  Cleaning data structure for JSON serialization...")
        cleaned_output_data = clean_for_json(output_data_for_kv)
        
        print("  Testing JSON serialization...")
        try:
            json_string_to_upload = json.dumps(cleaned_output_data, indent=2, ensure_ascii=False)
            print(f"  JSON serialization successful. Data size: {len(json_string_to_upload)} characters")
        except Exception as json_error:
            print(f"  JSON serialization failed with ensure_ascii=False: {json_error}")
            try:
                json_string_to_upload = json.dumps(cleaned_output_data, indent=2, ensure_ascii=True)
                print(f"  JSON serialization with ASCII fallback successful.")
            except Exception as json_error2:
                print(f"  Even ASCII JSON serialization failed: {json_error2}")
                raise json_error2
        
        print("  Uploading live configs to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json_string_to_upload)
        
        print("  Uploading cache version to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time())))
        
        print("\n--- PROCESS COMPLETED SUCCESSFULLY ---")
        
        total_xray = sum(len(configs) for configs in output_data_for_kv["xray"].values())
        total_singbox = sum(len(configs) for configs in output_data_for_kv["singbox"].values())
        print(f"Final Summary:")
        print(f"   - Xray Configs: {total_xray}")
        print(f"   - Sing-box Configs: {total_singbox}")
        
    except ValueError as e:
        print(f"❌ FATAL: Cloudflare KV upload skipped due to missing credentials: {e}")
        raise
    except Exception as e:
        print(f"❌ FATAL: Could not complete Cloudflare KV upload: {type(e).__name__}: {e}")
        
        print("\nDebug Info:")
        print(f"  Output data type: {type(output_data_for_kv)}")
        if isinstance(output_data_for_kv, dict):
            for key, value in output_data_for_kv.items():
                print(f"  - {key}: {type(value)}")
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        print(f"    - {subkey}: {type(subvalue)} (length: {len(subvalue) if hasattr(subvalue, '__len__') else 'n/a'})")
        
        raise

if __name__ == "__main__":
    main()

