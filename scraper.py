# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import socket
import hashlib
import ssl
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth, BadCredentialsException, RateLimitExceededException, UnknownObjectException
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("v2v scraper v36.2 (optimized query & smart testing) - stable extraction, smart handshake test")

# --- configuration ---
base_dir = os.path.dirname(os.path.abspath(__file__))
sources_file = os.path.join(base_dir, "sources.json")

xray_protocols = {'vless', 'vmess', 'trojan', 'ss'}
singbox_only_protocols = {'hysteria2', 'hy2', 'tuic'}
valid_protocols = xray_protocols.union(singbox_only_protocols)

headers = {'user-agent': 'v2v-scraper/1.0'}
max_configs_to_test = 20000
min_target_configs_per_core = 1000
max_final_configs_per_core = 2000
max_test_workers = 250
tcp_timeout = 4 # seconds
max_latency_ms = 5000 # milliseconds
max_name_length = 40

# --- cloudflare kv configuration keys ---
kv_live_configs_key = 'all_live_configs.json'
kv_cache_version_key = 'cache_version.txt'

# --- helper functions ---
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
        if scheme == 'vmess':
            vmess_data = config.replace("vmess://", "")
            if not vmess_data: return False
            decoded = json.loads(decode_base64_content(vmess_data))
            return bool(decoded.get('add')) and bool(decoded.get('port'))
        
        return scheme in valid_protocols and bool(parsed.hostname) and bool(parsed.port)
    except Exception: return False

def fetch_from_sources(sources: List[str], is_github: bool, pat: str = None, limit: int = 0) -> Set[str]:
    all_configs = set()
    if is_github:
        if not pat:
            print("WARNING: GitHub PAT not found for dynamic search. Skipping.")
            return set()
        try:
            gh_auth = Auth.Token(pat)
            g = Github(auth=gh_auth, timeout=30)
            
            # --- Optimized GitHub search strategy ---
            # Search for each protocol across ALL relevant file extensions
            file_extensions_query_part = "extension:txt OR extension:md OR extension:yml OR extension:yaml OR extension:json OR extension:html"
            base_negative_filters = "-user:mahdibland -filename:example -filename:sample -filename:test"
            
            queries_to_run = []
            for proto in valid_protocols:
                queries_to_run.append(f'"{proto}" {file_extensions_query_part} {base_negative_filters}')

            processed_files = set()
            total_files_processed = 0
            
            # A limit for how many files to process for EACH protocol search type
            max_files_per_query_type = 50 

            for i, query in enumerate(queries_to_run):
                if total_files_processed >= limit: 
                    print(f"  Reached global file limit of {limit}, stopping GitHub search.")
                    break
                
                print(f"  Executing GitHub Search ({i+1}/{len(queries_to_run)}): {query}")
                try:
                    # search_code returns an Iterable, which we can iterate over pages
                    results_iterator = g.search_code(q=query, order='desc', sort='indexed', per_page=100) # Fetch 100 results per page
                    
                    current_query_files_processed = 0
                    # Iterate through a few pages to get diverse results
                    # The actual files are processed inside the loop
                    for page_num in range(5): # Check up to 5 pages
                        if total_files_processed >= limit: break
                        if current_query_files_processed >= max_files_per_query_type: break

                        try:
                            page_results = results_iterator.get_page(page_num)
                        except RateLimitExceededException:
                            print(f"    GitHub API rate limit exceeded while fetching page {page_num}. Waiting 60s...")
                            time.sleep(60)
                            page_results = results_iterator.get_page(page_num) # Try fetching page again
                        except Exception as e:
                            print(f"    Error fetching GitHub search page {page_num}: {type(e).__name__}")
                            break # Stop if we can't fetch a page

                        if not page_results:
                            # print(f"    No more results for query on page {page_num}.") # Can be noisy
                            break # No more results for this query on current page

                        for content_file in page_results:
                            if total_files_processed >= limit: break
                            if current_query_files_processed >= max_files_per_query_type: break
                            
                            if content_file.path in processed_files:
                                continue # Skip already processed files
                            
                            processed_files.add(content_file.path)
                            
                            try:
                                # Small delay between fetching content to avoid hammering the API
                                time.sleep(random.uniform(0.1, 0.3)) 

                                decoded_content = content_file.decoded_content.decode('utf-8', 'ignore').replace('`', '')
                                
                                potential_configs = set()
                                lines = decoded_content.splitlines()
                                max_lines_per_file = 1000 # Limit lines per file for performance
                                for line_num, line in enumerate(lines[:max_lines_per_file]):
                                    cleaned_line = line.strip()
                                    if is_valid_config(cleaned_line):
                                        potential_configs.add(cleaned_line)
                                    # Process base64 encoded parts if they look like base64
                                    elif len(cleaned_line) > 20 and len(cleaned_line) < 2000 and re.match(r'^[A-Za-z0-9+/=\s]+$', cleaned_line):
                                        try:
                                            decoded_line = decode_base64_content(cleaned_line)
                                            for sub_line in decoded_line.splitlines()[:50]: # Limit sub-lines from base64 decode
                                                if is_valid_config(sub_line.strip()):
                                                    potential_configs.add(sub_line.strip())
                                        except Exception:
                                            continue # Ignore decoding errors for individual lines
                                
                                if potential_configs:
                                    all_configs.update(potential_configs)
                                    total_files_processed += 1
                                    current_query_files_processed += 1
                                    # print(f"    Processed {content_file.path} -> {len(potential_configs)} configs") # Can be noisy
                                    
                            except UnknownObjectException:
                                # This means the file was deleted after being indexed, skip.
                                continue 
                            except RateLimitExceededException:
                                print(f"    GitHub API rate limit exceeded while fetching content for {content_file.path}. Waiting 60s...")
                                time.sleep(60)
                                continue # Continue to next file after waiting
                            except Exception as e:
                                print(f"    Error processing GitHub file {content_file.path}: {type(e).__name__}: {e}")
                                continue

                except RateLimitExceededException:
                    print("    GitHub API rate limit exceeded during query. Waiting 60s...")
                    time.sleep(60)
                    continue # Retry the same query after waiting
                except Exception as e:
                    print(f"    Error: GitHub search failed for query '{query}'. Reason: {type(e).__name__}: {e}")
                    continue
                
                # Small delay between different protocol queries to be gentle with API
                if i < len(queries_to_run) - 1:
                    time.sleep(random.uniform(1, 3)) 
            
            print(f"  Found {len(all_configs)} configs from {total_files_processed} GitHub files.")

        except BadCredentialsException:
            print("ERROR: GitHub PAT is invalid or lacks necessary scopes.")
        except Exception as e: # Catch all for GitHub operations
            print(f"ERROR: General GitHub operation failed. Reason: {type(e).__name__}: {e}")
    else: # static urls
        print(f"  Fetching from {len(sources)} static urls...")
        def fetch_url(url):
            try:
                time.sleep(random.uniform(0.5, 2.0)) # Delay for static sources
                response = requests.get(url, headers=headers, timeout=10)
                response.raise_for_status() 
                content = response.text
                
                potential_configs = set()
                decoded_full_content = decode_base64_content(content)
                
                max_lines_static = 5000 # Limit lines for static files
                for current_content in [content, decoded_full_content]:
                    if not current_content: continue
                    for line_num, line in enumerate(current_content.splitlines()):
                        if line_num >= max_lines_static: break # Apply limit
                        cleaned_line = line.strip()
                        if is_valid_config(cleaned_line):
                            potential_configs.add(cleaned_line)
                
                return potential_configs
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 429:
                    print(f"    Rate limit hit for {url}. Waiting 60s and retrying...")
                    time.sleep(60) 
                    return fetch_url(url) # Recursive retry
                elif e.response.status_code != 404:
                    print(f"    HTTP error {e.response.status_code} for {url}")
                return set()
            except requests.RequestException: 
                return set()
            except Exception: # Catch all other exceptions during fetch
                return set()

        with ThreadPoolExecutor(max_workers=20) as executor: # Reverted to 20 for faster static fetching
            futures = {executor.submit(fetch_url, url): url for url in sources}
            for future in as_completed(futures):
                result = future.result()
                if result: all_configs.update(result)
        print(f"  Found {len(all_configs)} configs from static sources.")
    return all_configs

# --- testing & selection logic ---
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
        elif protocol in valid_protocols: 
            hostname, port = parsed_url.hostname, int(parsed_url.port)
            query_params = dict(qp.split('=', 1) for qp in parsed_url.query.split('&') if '=' in qp) if parsed_url.query else {}
            is_tls = query_params.get('security') in ['tls', 'xtls'] or protocol in ['trojan', 'tuic', 'hysteria2', 'hy2']
            sni = query_params.get('sni') or hostname
        else: return None

        if not all([hostname, port]): return None

        start_time = time.monotonic()
        if protocol in singbox_only_protocols:
            # UDP test for hysteria2/tuic (sing-box specific)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(tcp_timeout)
                # Sending a small, empty UDP packet. Success means port is open.
                sock.sendto(b'\x00\x00', (hostname, port)) 
        else:
            # TCP/TLS test for other protocols
            with socket.create_connection((hostname, port), timeout=tcp_timeout) as sock:
                if is_tls:
                    context = ssl.create_default_context()
                    context.check_hostname = False # We don't verify hostname in scraper
                    context.verify_mode = ssl.CERT_NONE # We don't verify cert in scraper
                    with context.wrap_socket(sock, server_hostname=sni or hostname) as ssock:
                        ssock.do_handshake()
        latency = int((time.monotonic() - start_time) * 1000)
        return config, latency
    except (socket.timeout, ConnectionRefusedError, OSError): return None
    except Exception: return None # Catch all other errors during handshake for robustness

def select_configs_with_fluid_quota(configs: List[Tuple[str, int]], min_target: int, max_target: int) -> List[str]:
    if not configs: return []
    sorted_configs_with_latency = sorted(configs, key=lambda item: item[1])
    grouped = defaultdict(list)
    for cfg, lat in sorted_configs_with_latency:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2' # Normalize for grouping
        grouped[proto].append(cfg)
    
    final_selected_configs = []
    # Always take a few best configs from each protocol for diversity
    for proto in grouped:
        take_count = min(10, len(grouped[proto])) # Take up to 10 best of each
        final_selected_configs.extend(grouped[proto][:take_count])
        # Remove selected configs from grouped list to avoid re-adding
        grouped[proto] = [cfg for cfg in grouped[proto] if cfg not in final_selected_configs]

    # Fill up to min_target by taking configs in order of best latency, rotating through protocols
    while len(final_selected_configs) < min_target:
        added_this_round = False
        for proto in list(grouped.keys()): # Iterate over a copy of keys as grouped might change
            if grouped[proto]:
                final_selected_configs.append(grouped[proto].pop(0)) # Take the next best from this proto
                added_this_round = True
            if len(final_selected_configs) >= min_target: break
        if not added_this_round: break # Stop if no more configs can be added
    
    # Fill remaining up to max_target with overall best available configs
    current_final_set = set(final_selected_configs)
    all_remaining_from_original_sorted = [cfg for cfg, lat in sorted_configs_with_latency if cfg not in current_final_set]
    configs_to_add = max_target - len(final_selected_configs)
    final_selected_configs.extend(all_remaining_from_original_sorted[:configs_to_add])
    
    return final_selected_configs

# --- cloudflare kv upload ---
def upload_to_cloudflare_kv(key: str, value: str):
    cf_api_token = os.environ.get('CLOUDFLARE_API_TOKEN') # Changed to CLOUDFLARE_API_TOKEN
    cf_account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID') # Changed to CLOUDFLARE_ACCOUNT_ID
    cf_kv_namespace_id = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID') # Changed to CLOUDFLARE_KV_NAMESPACE_ID

    if not all([cf_api_token, cf_account_id, cf_kv_namespace_id]):
        raise ValueError("Cloudflare API credentials or KV namespace ID missing.")
    try:
        cf_client = Cloudflare(api_token=cf_api_token)
        response = cf_client.kv.namespaces.values.update(
            namespace_id=cf_kv_namespace_id,
            key_name=key,
            data=value.encode('utf-8')
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e:
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': Code {e.code} - {e.message}")
        raise
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {type(e).__name__}: {e}")
        raise

# --- main execution ---
def main():
    github_pat = os.environ.get('GH_PAT') # Changed to GH_PAT
    print("--- 1. Loading sources ---")
    try:
        with open(sources_file, 'r', encoding='utf-8') as f:
            sources = json.load(f)
    except Exception as e:
        print(f"FATAL: Cannot load or parse {sources_file}: {e}"); return

    print("\n--- 2. Fetching configs ---")
    all_configs = set()
    # Adjusted github_search_limit to a more reasonable value for combined processing
    github_search_limit = sources.get("github_search_limit", 1000) 
    with ThreadPoolExecutor(max_workers=2) as executor: # Use 2 workers for static/dynamic to run concurrently
        static_future = executor.submit(fetch_from_sources, sources.get("static", []), False)
        dynamic_future = executor.submit(fetch_from_sources, [], True, github_pat, github_search_limit)
        all_configs.update(static_future.result())
        all_configs.update(dynamic_future.result())

    if not all_configs: print("FATAL: No configs found."); return
    print(f"📊 Total unique configs found: {len(all_configs)}")

    print(f"\n--- 3. Performing deep protocol handshake test ---")
    fast_configs = []
    configs_to_test_list = list(all_configs)[:max_configs_to_test] 
    print(f"  Testing {len(configs_to_test_list)} configs...")
    with ThreadPoolExecutor(max_workers=max_test_workers) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in configs_to_test_list}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= max_latency_ms: fast_configs.append(result)

    if not fast_configs: print("FATAL: No fast configs found after testing."); return
    print(f"🏆 Found {len(fast_configs)} fast configs.")

    print("\n--- 4. Grouping and finalizing ---")
    singbox_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in singbox_only_protocols]
    xray_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in xray_protocols]
    
    xray_final = select_configs_with_fluid_quota(xray_pool, min_target_configs_per_core, max_final_configs_per_core)
    
    singbox_final_temp_configs = [cfg for cfg, _ in singbox_pool]
    
    xray_fillers_candidates = sorted([item for item in xray_pool if item[0] not in set(singbox_final_temp_configs)], key=lambda x: x[1])
    
    num_to_fill = max_final_configs_per_core - len(singbox_final_temp_configs)
    if num_to_fill > 0:
        singbox_final_temp_configs.extend([cfg for cfg, _ in xray_fillers_candidates[:num_to_fill]])

    singbox_final = singbox_final_temp_configs[:max_final_configs_per_core]
    
    print(f"✅ Selected {len(xray_final)} configs for Xray & {len(singbox_final)} for Sing-box.")

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. Uploading to Cloudflare KV ---")
    try:
        upload_to_cloudflare_kv(kv_live_configs_key, json.dumps(output, indent=2, ensure_ascii=False))
        upload_to_cloudflare_kv(kv_cache_version_key, str(int(time.time())))
        print("\n--- Process completed successfully ---")
    except Exception as e:
        print(f"❌ FATAL: Could not complete KV upload.")

if __name__ == "__main__":
    main()
