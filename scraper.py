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
from concurrent.futures import ThreadPoolExecutor, as_completed # Corrected Threadpoolexecutor to ThreadPoolExecutor
from urllib.parse import urlparse
from github import Github, Auth # Corrected github to Github, auth to Auth
from typing import Optional, Set, List, Dict, Tuple # Corrected optional, set, list, dict, tuple to Optional, Set, List, Dict, Tuple
from collections import defaultdict

# cloudflare library is required: pip install cloudflare
# Corrected: import specific classes from the cloudflare package and renamed Cloudflare client to avoid conflict
from cloudflare import Cloudflare, APIError # Import Cloudflare client and APIError directly for better usage

print("v2v scraper v35.2 (kv-native, deep protocol testing, fluid quota) - final fix for cloudflare api client")

# --- Configuration ---
base_dir = os.path.dirname(os.path.abspath(__file__))
sources_file = os.path.join(base_dir, "sources.json")

xray_protocols = {'vless', 'vmess', 'trojan', 'ss'}
singbox_only_protocols = {'hysteria2', 'hy2', 'tuic'}
valid_protocols = xray_protocols.union(singbox_only_protocols)

headers = {'User-Agent': 'v2v-scraper/1.0'} # Corrected user-agent to User-Agent (standard header casing)
github_pat = os.environ.get('GH_PAT') # Changed to 'GH_PAT' to match env var in workflow
max_configs_to_test = 10000
min_target_configs_per_core = 500
max_final_configs_per_core = 1000
max_test_workers = 250
tcp_timeout = 5
max_latency_ms = 4000
max_name_length = 40

# --- Cloudflare KV Configuration ---
cf_api_token = os.environ.get('CLOUDFLARE_API_TOKEN') # Changed to 'CLOUDFLARE_API_TOKEN' to match env var in workflow
cf_account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID') # Changed to 'CLOUDFLARE_ACCOUNT_ID' to match env var in workflow
cf_kv_namespace_id = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID') # Changed to 'CLOUDFLARE_KV_NAMESPACE_ID' to match env var in workflow

kv_live_configs_key = 'all_live_configs.json'
kv_cache_version_key = 'cache_version.txt'

# --- Helper Functions ---
def decode_base64_content(content: str) -> str:
    if not isinstance(content, str) or not content.strip(): return ""
    try:
        content = content.strip().replace('\n', '').replace('\r', '')
        missing_padding = len(content) % 4
        if missing_padding: content += '=' * (4 - missing_padding)
        return base64.b64decode(content).decode('utf-8', 'ignore')
    except Exception: return "" # Corrected bare except to Exception

def is_valid_config(config: str) -> bool:
    if not isinstance(config, str) or not config.strip(): return False # Corrected false to False
    try:
        parsed = urlparse(config)
        scheme = parsed.scheme.lower()
        if scheme == 'vmess':
            vmess_data = config.replace("vmess://", "")
            if not vmess_data: return False # Corrected false to False
            decoded = json.loads(decode_base64_content(vmess_data))
            return bool(decoded.get('add')) and bool(decoded.get('port'))
        return scheme in valid_protocols and bool(parsed.hostname) and bool(parsed.port)
    except Exception: return False # Corrected bare except to Exception and false to False

def fetch_from_sources(sources: List[str], is_github: bool, pat: str = None, limit: int = 0) -> Set[str]: # Corrected list, set, none to List, Set, None
    all_configs = set()
    if is_github:
        if not pat:
            print("WARNING: GitHub PAT not found. Skipping dynamic search.") # Corrected warning to WARNING
            return set()
        try:
            # Use pygithub's Auth for GitHub operations
            gh_auth = Auth.Token(pat)
            g = Github(auth=gh_auth, timeout=30) # Corrected github to Github
            query = " or ".join(valid_protocols) + " extension:txt extension:md -user:mahdibland"
            results = g.search_code(query, order='desc', sort='indexed')
            count = 0
            for content_file in results:
                if count >= limit: break
                try:
                    decoded_content = decode_base64_content(content_file.content).replace('`', '')
                    all_configs.update({line.strip() for line in decoded_content.splitlines() if is_valid_config(line.strip())})
                    count += 1
                except Exception: continue # Corrected bare except to Exception
        except Exception as e:
            print(f"ERROR: GitHub search failed. Reason: {e}") # Corrected error to ERROR
    else:
        def fetch_url(url):
            try:
                response = requests.get(url, headers=headers, timeout=10)
                response.raise_for_status()
                content = decode_base64_content(response.text)
                return {line.strip() for line in content.splitlines() if is_valid_config(line.strip())}
            except requests.RequestException: return set() # Corrected requests.requestexception to requests.RequestException
        with ThreadPoolExecutor(max_workers=20) as executor: # Corrected threadpoolexecutor to ThreadPoolExecutor
            futures = [executor.submit(fetch_url, url) for url in sources]
            for future in as_completed(futures):
                all_configs.update(future.result())
    return all_configs

# --- Testing & Selection Logic ---
def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]: # Corrected optional to Optional
    try:
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme.lower()
        is_udp = protocol in singbox_only_protocols or protocol == 'hysteria2'

        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname, port = decoded.get('add'), int(decoded.get('port', 0))
            is_tls = decoded.get('tls') == 'tls'
        else:
            hostname, port = parsed_url.hostname, int(parsed_url.port) # Added int() for port to ensure type
            # Check for parsed_url.query before splitting
            params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p) if parsed_url.query else {}
            is_tls = params.get('security') == 'tls' or protocol == 'trojan'

        if not all([hostname, port]): return None # Corrected none to None

        start_time = time.monotonic()
        if is_udp:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock: # Corrected socket.af_inet to socket.AF_INET and socket.sock_dgram to socket.SOCK_DGRAM
                sock.settimeout(tcp_timeout)
                # For UDP, just send a small packet and wait a bit, no real handshake
                sock.sendto(b'ping', (hostname, port))
                # Try to recvfrom, but don't fail if no data (e.g., firewall drop, no response)
                try:
                    sock.recvfrom(1024)
                except socket.timeout:
                    pass # It's okay, means server is up but not responding to simple ping
        else: # TCP/TLS
            sock = socket.create_connection((hostname, port), timeout=tcp_timeout)
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False # Corrected false to False
                context.verify_mode = ssl.CERT_NONE # Corrected ssl.cert_none to ssl.CERT_NONE
                sni = hostname
                # Check if 'params' or 'decoded' exists before accessing them
                if 'params' in locals() and 'sni' in locals().get('params', {}): sni = params['sni']
                elif protocol == 'vmess' and 'decoded' in locals() and 'sni' in locals().get('decoded', {}): sni = decoded['sni']
                with context.wrap_socket(sock, server_hostname=sni) as ssock:
                    ssock.do_handshake()
            # For non-TLS TCP, just ensure connection is established.
            # No need to recv(1, socket.MSG_PEEK) as create_connection already confirms connection.
            sock.close() # Ensure socket is closed for non-TLS TCP
        latency = int((time.monotonic() - start_time) * 1000)
        return config, latency
    except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError): # Corrected connectionrefusederror, ssl.sslerror, oserror
        return None # Corrected none to None
    except Exception: # Corrected bare except to Exception
        return None # Corrected none to None

def select_configs_with_fluid_quota(configs: List[Tuple[str, int]], min_target: int, max_target: int) -> List[str]: # Corrected list to List
    if not configs: return []
    grouped = defaultdict(list)
    for cfg, lat in sorted(configs, key=lambda item: item[1]):
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2'
        grouped[proto].append(cfg)
    
    final = []
    iters = {p: iter(c) for p, c in grouped.items()}
    protos = list(iters.keys())
    
    while len(final) < min_target and protos:
        for proto in protos[:]:
            try:
                cfg = next(iters[proto])
                if cfg not in final: final.append(cfg)
            except StopIteration: # Corrected stopiteration to StopIteration
                protos.remove(proto)
    
    remaining_sorted = [cfg for cfg, _ in configs if cfg not in final]
    final.extend(remaining_sorted)
    return final[:max_target]

# --- Cloudflare KV Upload ---
def upload_to_cloudflare_kv(key: str, value: str):
    if not all([cf_api_token, cf_account_id, cf_kv_namespace_id]):
        print("FATAL: Cloudflare KV credentials not set. Skipping KV upload.") # Corrected fatal to FATAL
        raise ValueError("Cloudflare API token, account ID, or KV namespace ID is missing from environment variables.")
    try:
        # Initialize Cloudflare client directly with the API Token
        cf_client = Cloudflare(api_token=cf_api_token)

        # Access the KV namespace service and use .put for single key-value update
        cf_client.workers.kv.namespaces.put(
            account_id=cf_account_id,
            namespace_id=cf_kv_namespace_id,
            key=key,
            value=value # Pass the string value directly
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except APIError as e: # Use APIError from cloudflare package
        print(f"❌ ERROR: Cloudflare API error uploading '{key}': code {e.code} - {e.message}") # Corrected error to ERROR
        if e.code == 10000:
            print("HINT: Ensure the CLOUDFLARE_API_TOKEN has 'Worker KV Storage Write' permission and is scoped to the correct account.")
        if e.code == 10014:
            print("HINT: Double-check that CLOUDFLARE_KV_NAMESPACE_ID is correct for your KV namespace and within the specified account.")
        raise # Re-raise the exception to fail the workflow cleanly
    except Exception as e: # Corrected bare except to Exception
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {e}") # Corrected error to ERROR
        raise # Re-raise other exceptions too

# --- Main Execution ---
def main():
    print("--- 1. LOADING SOURCES ---") # Corrected loading to LOADING
    try:
        with open(sources_file, 'r', encoding='utf-8') as f:
            sources = json.load(f)
        print(f"✅ Loaded {len(sources.get('static', []))} static sources. GitHub limit: {sources.get('github_search_limit', 50)}.") # Corrected loaded, github to Loaded, GitHub
    except Exception as e: # Corrected bare except to Exception
        print(f"FATAL: Cannot load sources.json: {e}"); return # Corrected fatal to FATAL

    print("\n--- 2. FETCHING CONFIGS ---") # Corrected fetching to FETCHING
    with ThreadPoolExecutor(max_workers=2) as executor: # Corrected threadpoolexecutor to ThreadPoolExecutor
        static = executor.submit(fetch_from_sources, sources.get("static", []), False) # Corrected false to False
        dynamic = executor.submit(fetch_from_sources, [], True, github_pat, sources.get("github_search_limit", 50)) # Corrected true to True
        all_configs = static.result().union(dynamic.result())
    print(f"📊 Total unique configs found: {len(all_configs)}")
    if not all_configs: print("FATAL: No configs found."); return # Corrected fatal to FATAL

    print(f"\n--- 3. PERFORMING DEEP PROTOCOL HANDSHAKE TEST (Max latency: {max_latency_ms}ms) ---") # Corrected performing to PERFORMING
    fast_configs = []
    with ThreadPoolExecutor(max_workers=max_test_workers) as executor: # Corrected threadpoolexecutor to ThreadPoolExecutor
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in list(all_configs)[:max_configs_to_test]}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 100 == 0: print(f"  Tested {i+1}/{len(futures)} configs...") # Corrected tested to Tested
            result = future.result()
            if result and result[1] <= max_latency_ms:
                fast_configs.append(result)
    print(f"🏆 Found {len(fast_configs)} fast configs.") # Corrected found to Found
    if not fast_configs: print("FATAL: No fast configs found."); return # Corrected fatal to FATAL

    print("\n--- 4. GROUPING AND FINALIZING WITH FLUID QUOTA ---") # Corrected grouping to GROUPING
    singbox_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in singbox_only_protocols]
    xray_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in xray_protocols]
    xray_final = select_configs_with_fluid_quota(xray_pool, min_target_configs_per_core, max_final_configs_per_core)
    singbox_combined = singbox_pool + xray_pool # Give singbox access to all fast configs
    singbox_final = select_configs_with_fluid_quota(singbox_combined, min_target_configs_per_core, max_final_configs_per_core)
    
    print(f"✅ Selected {len(xray_final)} configs for Xray.") # Corrected selected, xray to Selected, Xray
    print(f"✅ Selected {len(singbox_final)} configs for Sing-Box.") # Corrected selected, sing-box to Selected, Sing-Box

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. UPLOADING TO CLOUDFLARE KV ---") # Corrected uploading to UPLOADING
    upload_to_cloudflare_kv(kv_live_configs_key, json.dumps(output, indent=2, ensure_ascii=False)) # Corrected false to False
    upload_to_cloudflare_kv(kv_cache_version_key, str(int(time.time())))
    
    print("\n--- PROCESS COMPLETED SUCCESSFULLY ---") # Corrected process to PROCESS

if __name__ == "__main__":
    main()
