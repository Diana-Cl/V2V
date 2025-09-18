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
import random # <--- اضافه شد: برای تاخیر تصادفی
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth, BadCredentialsException, RateLimitExceededException, UnknownObjectException
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("v2v scraper v36.0 (Final & Coordinated) - Robust, Rate-Limit Aware, Correct GitHub Query, Synced with CI/CD")

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'v2v-scraper/1.0'}
MAX_CONFIGS_TO_TEST = 10000
MIN_TARGET_CONFIGS_PER_CORE = 500
MAX_FINAL_CONFIGS_PER_CORE = 1000
MAX_TEST_WORKERS = 250
TCP_TIMEOUT = 4 # seconds
MAX_LATENCY_MS = 5000 # milliseconds
MAX_NAME_LENGTH = 40

# --- Cloudflare KV Configuration Keys ---
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
        if scheme == 'vmess':
            vmess_data = config.replace("vmess://", "")
            if not vmess_data: return False
            decoded = json.loads(decode_base64_content(vmess_data))
            return bool(decoded.get('add')) and bool(decoded.get('port'))
        
        return scheme in VALID_PROTOCOLS and bool(parsed.hostname) and bool(parsed.port)
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
            
            protocol_query_part = " OR ".join(f'"{p}"' for p in VALID_PROTOCOLS)
            file_type_query_part = "extension:txt OR extension:md"
            
            # --- اصلاح کوئری جستجوی گیت‌هاب (CRITICAL FIX) ---
            size_query_part = "size:100..10000" 
            query = f"({protocol_query_part}) {file_type_query_part} -user:mahdibland -filename:example -filename:sample -filename:test {size_query_part}"
            
            print(f"  GitHub Search Query: {query}")
            results = g.search_code(query, order='desc', sort='indexed')
            
            count = 0
            for content_file in results:
                if count >= limit: break
                try:
                    if content_file.size > 15000: # کمی افزایش محدوده برای اطمینان
                        continue
                    
                    decoded_content = content_file.decoded_content.decode('utf-8', 'ignore').replace('`', '')
                    new_configs = {line.strip() for line in decoded_content.splitlines() if is_valid_config(line.strip())}
                    if new_configs:
                        all_configs.update(new_configs)
                        count += 1
                except UnknownObjectException:
                    continue
                except Exception as e:
                    print(f"    Error processing GitHub file {content_file.path}: {type(e).__name__}")
                    continue
            print(f"  Found {len(all_configs)} configs from {count} GitHub files.")

        except BadCredentialsException:
            print("ERROR: GitHub PAT is invalid or lacks necessary scopes.")
        except RateLimitExceededException:
            print("ERROR: GitHub API rate limit exceeded.")
        except Exception as e:
            print(f"ERROR: GitHub search failed. Reason: {type(e).__name__}: {e}")
    else: # Static URLs
        print(f"  Fetching from {len(sources)} static URLs...")
        def fetch_url(url):
            try:
                time.sleep(random.uniform(0.5, 2.0))
                response = requests.get(url, headers=HEADERS, timeout=10)
                response.raise_for_status() 
                content = decode_base64_content(response.text)
                return {line.strip() for line in content.splitlines() if is_valid_config(line.strip())}
            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 429:
                    print(f"    Rate limit hit for {url}. Waiting 60s and retrying...")
                    time.sleep(60) 
                    return fetch_url(url)
                elif e.response.status_code != 404: # لاگ کردن خطاهای غیر از 404
                    print(f"    HTTP Error {e.response.status_code} for {url}")
                return set()
            except requests.RequestException:
                return set()
            except Exception:
                return set()

        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = {executor.submit(fetch_url, url): url for url in sources}
            for future in as_completed(futures):
                result = future.result()
                if result: all_configs.update(result)
        print(f"  Found {len(all_configs)} configs from static sources.")
    return all_configs

# --- Testing & Selection Logic ---
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
            hostname, port = parsed_url.hostname, int(parsed_url.port)
            query_params = dict(qp.split('=', 1) for qp in parsed_url.query.split('&') if '=' in qp) if parsed_url.query else {}
            is_tls = query_params.get('security') in ['tls', 'xtls'] or protocol in ['trojan', 'tuic', 'hysteria2', 'hy2']
            sni = query_params.get('sni') or hostname
        else: return None

        if not all([hostname, port]): return None

        start_time = time.monotonic()
        if protocol in SINGBOX_ONLY_PROTOCOLS:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                sock.sendto(b'\x00\x00', (hostname, port)) # A minimal UDP packet
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
    except (socket.timeout, ConnectionRefusedError, OSError):
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

    while len(final_selected_configs) < min_target:
        added_this_round = False
        for proto in list(grouped.keys()):
            if grouped[proto]:
                final_selected_configs.append(grouped[proto].pop(0))
                added_this_round = True
            if len(final_selected_configs) >= min_target: break
        if not added_this_round: break
    
    current_final_set = set(final_selected_configs)
    all_remaining_from_original_sorted = [cfg for cfg, lat in sorted_configs_with_latency if cfg not in current_final_set]
    configs_to_add = max_target - len(final_selected_configs)
    final_selected_configs.extend(all_remaining_from_original_sorted[:configs_to_add])
    return final_selected_configs

# --- Cloudflare KV Upload ---
def upload_to_cloudflare_kv(key: str, value: str):
    cf_api_token = os.environ.get('CLOUDFLARE_API_TOKEN')
    cf_account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    cf_kv_namespace_id = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID')

    if not all([cf_api_token, cf_account_id, cf_kv_namespace_id]):
        raise ValueError("Cloudflare API credentials or KV Namespace ID missing.")
    try:
        cf_client = Cloudflare(api_token=cf_api_token)
        response = cf_client.kv.namespaces.values.update(
            namespace_id=cf_kv_namespace_id,
            key_name=key, # <-- سینتکس صحیح برای کتابخانه جدید کلودفلر
            data=value.encode('utf-8')
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e:
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': code {e.code} - {e.message}")
        raise
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {type(e).__name__}: {e}")
        raise

# --- Main Execution ---
def main():
    github_pat = os.environ.get('GH_PAT')
    print("--- 1. LOADING SOURCES ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources = json.load(f)
    except Exception as e:
        print(f"FATAL: Cannot load or parse {SOURCES_FILE}: {e}"); return

    print("\n--- 2. FETCHING CONFIGS ---")
    all_configs = set()
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_future = executor.submit(fetch_from_sources, sources.get("static", []), False)
        dynamic_future = executor.submit(fetch_from_sources, [], True, github_pat, sources.get("github_search_limit", 50))
        all_configs.update(static_future.result())
        all_configs.update(dynamic_future.result())

    if not all_configs: print("FATAL: No configs found."); return
    print(f"📊 Total unique configs found: {len(all_configs)}")

    print(f"\n--- 3. PERFORMING DEEP PROTOCOL HANDSHAKE TEST ---")
    fast_configs = []
    configs_to_test_list = list(all_configs)[:MAX_CONFIGS_TO_TEST]
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in configs_to_test_list}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS: fast_configs.append(result)

    if not fast_configs: print("FATAL: No fast configs found after testing."); return
    print(f"🏆 Found {len(fast_configs)} fast configs.")

    print("\n--- 4. GROUPING AND FINALIZING ---")
    singbox_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in SINGBOX_ONLY_PROTOCOLS]
    xray_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in XRAY_PROTOCOLS]
    
    xray_final = select_configs_with_fluid_quota(xray_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    singbox_final_temp_configs = [cfg for cfg, _ in singbox_pool]
    if len(singbox_final_temp_configs) < MAX_FINAL_CONFIGS_PER_CORE:
        xray_fillers_candidates = [cfg for cfg, _ in xray_pool if cfg not in singbox_final_temp_configs]
        num_to_fill = MAX_FINAL_CONFIGS_PER_CORE - len(singbox_final_temp_configs)
        singbox_final_temp_configs.extend(xray_fillers_candidates[:num_to_fill])
    singbox_final = singbox_final_temp_configs[:MAX_FINAL_CONFIGS_PER_CORE]
    
    print(f"✅ Selected {len(xray_final)} configs for Xray & {len(singbox_final)} for Sing-Box.")

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. UPLOADING TO CLOUDFLARE KV ---")
    try:
        upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json.dumps(output, indent=2, ensure_ascii=False))
        upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time())))
        print("\n--- PROCESS COMPLETED SUCCESSFULLY ---")
    except Exception as e:
        print(f"❌ FATAL: Could not complete KV upload.")

if __name__ == "__main__":
    main()
