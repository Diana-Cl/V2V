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
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from github import Github, Auth
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("v2v scraper v35.3 (kv-native, deep protocol testing, fluid quota) - final fix")

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json") # <--- این متغیر گلوبال است

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'v2v-scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 10000
MIN_TARGET_CONFIGS_PER_CORE = 500
MAX_FINAL_CONFIGS_PER_CORE = 1000
MAX_TEST_WORKERS = 250
TCP_TIMEOUT = 4
MAX_LATENCY_MS = 5000
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
            print("WARNING: GitHub PAT not found. Skipping dynamic search.")
            return set()
        try:
            gh_auth = Auth.Token(pat)
            g = Github(auth=gh_auth, timeout=30)
            protocol_query = " OR ".join(f'"{p}"' for p in VALID_PROTOCOLS)
            query = f"{protocol_query} extension:txt extension:md -user:mahdibland"
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
                return {line.strip() for line in content.splitlines() if is_valid_config(line.strip())}
            except requests.RequestException: return set()
        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(fetch_url, url) for url in sources]
            for future in as_completed(futures):
                all_configs.update(future.result())
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
            is_tls = decoded.get('tls') == 'tls'
            sni = decoded.get('sni') or decoded.get('host') or hostname
        else:
            hostname, port = parsed_url.hostname, int(parsed_url.port)
            params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p) if parsed_url.query else {}
            is_tls = params.get('security') == 'tls' or protocol == 'trojan'
            sni = params.get('sni') or hostname

        if not all([hostname, port]): return None

        start_time = time.monotonic()
        
        if protocol in SINGBOX_ONLY_PROTOCOLS:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                sock.sendto(b'ping', (hostname, port))
        else: # TCP/TLS
            sock = socket.create_connection((hostname, port), timeout=TCP_TIMEOUT)
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=sni) as ssock:
                    ssock.do_handshake()
            sock.close()
            
        latency = int((time.monotonic() - start_time) * 1000)
        return config, latency
    except Exception:
        return None

def select_configs_with_fluid_quota(configs: List[Tuple[str, int]], min_target: int, max_target: int) -> List[str]:
    if not configs: return []
    grouped = defaultdict(list)
    for cfg, lat in sorted(configs, key=lambda item: item[1]):
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2'
        grouped[proto].append(cfg)
    
    final = []
    # Step 1: Ensure minimum representation
    for proto in grouped:
        take_count = min(10, len(grouped[proto]))
        final.extend(grouped[proto][:take_count])
        grouped[proto] = grouped[proto][take_count:]

    # Step 2: Proportional filling
    total_remaining = sum(len(v) for v in grouped.values())
    if total_remaining > 0:
        while len(final) < min_target:
            added_this_round = False
            for proto in list(grouped.keys()):
                if grouped[proto]:
                    final.append(grouped[proto].pop(0))
                    added_this_round = True
                if len(final) >= min_target: break
            if not added_this_round: break
    
    # Step 3: Fill with the best of the rest
    all_remaining = []
    for configs in grouped.values():
        all_remaining.extend(configs)
    
    # In case configs were sorted by latency initially, all_remaining is already somewhat sorted, but we can re-sort.
    # The configs_with_latency is already sorted by latency.
    all_remaining_from_original = [cfg for cfg, lat in configs if cfg not in final]
    
    final.extend(all_remaining_from_original)
    return final[:max_target]


# --- Cloudflare KV Upload ---
def upload_to_cloudflare_kv(key: str, value: str):
    # Ensure environment variables are loaded for Cloudflare
    cf_api_token = os.environ.get('CLOUDFLARE_API_TOKEN')
    cf_account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    cf_kv_namespace_id = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID')

    if not all([cf_api_token, cf_account_id, cf_kv_namespace_id]):
        raise ValueError("Cloudflare API token, account ID, or KV namespace ID is missing from environment variables.")
    try:
        cf_client = Cloudflare(api_token=cf_api_token)
        cf_client.workers.kv.namespaces.values.put(
            key,
            account_id=cf_account_id,
            namespace_id=cf_kv_namespace_id,
            data=value
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e:
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': code {e.code} - {e.message}")
        raise
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {e}")
        raise

# --- Main Execution ---
def main():
    print("--- 1. LOADING SOURCES ---")
    try:
        # استفاده صحیح از متغیر گلوبال SOURCES_FILE
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f: # <--- اینجا اصلاح شد
            sources = json.load(f)
        print(f"✅ Loaded {len(sources.get('static', []))} static sources. GitHub limit: {sources.get('github_search_limit', 50)}.")
    except Exception as e:
        print(f"FATAL: Cannot load {SOURCES_FILE}: {e}"); return # <--- پیام خطا هم دقیق‌تر شد

    print("\n--- 2. FETCHING CONFIGS ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static = executor.submit(fetch_from_sources, sources.get("static", []), False)
        # GITHUB_PAT هم باید به عنوان یک متغیر محیطی از `os.environ.get('GH_PAT')` خوانده شود.
        # اطمینان حاصل شود که این متغیر در GitHub Actions به درستی تنظیم شده باشد.
        dynamic = executor.submit(fetch_from_sources, [], True, os.environ.get('GH_PAT'), sources.get("github_search_limit", 50))
        all_configs = static.result().union(dynamic.result())
    print(f"📊 Total unique configs found: {len(all_configs)}")
    if not all_configs: print("FATAL: No configs found."); return

    print(f"\n--- 3. PERFORMING DEEP PROTOCOL HANDSHAKE TEST (Max latency: {MAX_LATENCY_MS}ms) ---") # <--- MAX_LATENCY_MS اصلاح شد
    fast_configs = []
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor: # <--- MAX_TEST_WORKERS اصلاح شد
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in list(all_configs)[:MAX_CONFIGS_TO_TEST]} # <--- MAX_CONFIGS_TO_TEST اصلاح شد
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0: print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS: # <--- MAX_LATENCY_MS اصلاح شد
                fast_configs.append(result)
    print(f"🏆 Found {len(fast_configs)} fast configs.")
    if not fast_configs: print("FATAL: No fast configs found."); return

    print("\n--- 4. GROUPING AND FINALIZING WITH FLUID QUOTA ---")
    singbox_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in SINGBOX_ONLY_PROTOCOLS] # <--- SINGBOX_ONLY_PROTOCOLS اصلاح شد
    xray_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in XRAY_PROTOCOLS] # <--- XRAY_PROTOCOLS اصلاح شد
    
    xray_final = select_configs_with_fluid_quota(xray_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE) # <--- CONSTS اصلاح شد
    
    singbox_initial = [cfg for cfg, _ in singbox_pool]
    needed_for_singbox = MAX_FINAL_CONFIGS_PER_CORE - len(singbox_initial) # <--- CONSTS اصلاح شد
    if needed_for_singbox > 0:
        fillers = [cfg for cfg, _ in xray_pool if cfg not in singbox_initial]
        singbox_initial.extend(fillers[:needed_for_singbox])
    singbox_final = singbox_initial[:MAX_FINAL_CONFIGS_PER_CORE] # <--- CONSTS اصلاح شد

    print(f"✅ Selected {len(xray_final)} configs for Xray.")
    print(f"✅ Selected {len(singbox_final)} configs for Sing-Box.")

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. UPLOADING TO CLOUDFLARE KV ---")
    upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json.dumps(output, indent=2, ensure_ascii=False)) # <--- KV_LIVE_CONFIGS_KEY اصلاح شد
    upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time()))) # <--- KV_CACHE_VERSION_KEY اصلاح شد
    
    print("\n--- PROCESS COMPLETED SUCCESSFULLY ---")

if __name__ == "__main__":
    main()
