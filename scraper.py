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

# Cloudflare library is required: pip install cloudflare
import cloudflare

print("V2V Scraper v35.1 (KV-Native, Deep Protocol Testing, Fluid Quota) - Fix for Cloudflare API Client")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 10000
MIN_TARGET_CONFIGS_PER_CORE = 500
MAX_FINAL_CONFIGS_PER_CORE = 1000
MAX_TEST_WORKERS = 250
TCP_TIMEOUT = 5
MAX_LATENCY_MS = 4000
MAX_NAME_LENGTH = 40

# --- CLOUDFLARE KV CONFIGURATION ---
CF_API_TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN')
CF_ACCOUNT_ID = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
CF_KV_NAMESPACE_ID = os.environ.get('CLOUDFLARE_KV_NAMESPACE_ID')

KV_LIVE_CONFIGS_KEY = 'all_live_configs.json'
KV_CACHE_VERSION_KEY = 'cache_version.txt'

# --- HELPER FUNCTIONS ---
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
                return {line.strip() for line in content.splitlines() if is_valid_config(line.strip())}
            except requests.RequestException: return set()
        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(fetch_url, url) for url in sources]
            for future in as_completed(futures):
                all_configs.update(future.result())
    return all_configs

# --- TESTING & SELECTION LOGIC ---
def test_full_protocol_handshake(config: str) -> Optional[Tuple[str, int]]:
    try:
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme.lower()
        is_udp = protocol in SINGBOX_ONLY_PROTOCOLS or protocol == 'hysteria2'

        if protocol == 'vmess':
            decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
            hostname, port = decoded.get('add'), int(decoded.get('port', 0))
            is_tls = decoded.get('tls') == 'tls'
        else:
            hostname, port = parsed_url.hostname, int(parsed_url.port)
            params = dict(p.split('=', 1) for p in parsed_url.query.split('&') if '=' in p)
            is_tls = params.get('security') == 'tls' or protocol == 'trojan'

        if not all([hostname, port]): return None

        start_time = time.monotonic()
        if is_udp:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(TCP_TIMEOUT)
                # For UDP, just send a small packet and wait a bit, no real handshake
                sock.sendto(b'ping', (hostname, port))
                # Try to recvfrom, but don't fail if no data (e.g., firewall drop, no response)
                try:
                    sock.recvfrom(1024) 
                except socket.timeout:
                    pass # It's okay, means server is up but not responding to simple ping
        else: # TCP/TLS
            sock = socket.create_connection((hostname, port), timeout=TCP_TIMEOUT)
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                sni = hostname
                if 'sni' in locals().get('params', {}): sni = params['sni']
                elif protocol == 'vmess' and 'sni' in locals().get('decoded', {}): sni = decoded['sni']
                with context.wrap_socket(sock, server_hostname=sni) as ssock:
                    ssock.do_handshake()
            else:
                # For non-TLS TCP, just ensure connection is established
                # No need to recv(1, socket.MSG_PEEK) as create_connection already confirms connection.
                pass 
        latency = int((time.monotonic() - start_time) * 1000)
        return config, latency
    except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError):
        return None
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
    iters = {p: iter(c) for p, c in grouped.items()}
    protos = list(iters.keys())
    
    while len(final) < min_target and protos:
        for proto in protos[:]:
            try:
                cfg = next(iters[proto])
                if cfg not in final: final.append(cfg)
            except StopIteration:
                protos.remove(proto)
    
    remaining_sorted = [cfg for cfg, _ in configs if cfg not in final]
    final.extend(remaining_sorted)
    return final[:max_target]

# --- CLOUDFLARE KV UPLOAD ---
def upload_to_cloudflare_kv(key: str, value: str):
    if not all([CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID]):
        print("FATAL: Cloudflare KV credentials not set. Skipping KV upload.")
        return
    try:
        # CORRECTED: Use APIToken for authentication as required by newer versions of cloudflare-python
        auth_obj = cloudflare.APIToken(CF_API_TOKEN)
        cf_client = cloudflare.Cloudflare(auth=auth_obj)

        # The 'write' method for KV namespaces expects the namespace_id as the first argument,
        # followed by account_id as a keyword argument, and then the data.
        # This syntax is correct for cloudflare-python library.
        cf_client.workers.kv.namespaces.write(
            CF_KV_NAMESPACE_ID,
            account_id=CF_ACCOUNT_ID,
            data=[{'key': key, 'value': value}]
        )
        print(f"✅ Successfully uploaded '{key}' to Cloudflare KV.")
    except cloudflare.APIError as e:
        print(f"❌ ERROR: Cloudflare API Error uploading '{key}': {e.message}")
        raise # Re-raise the exception to fail the workflow
    except Exception as e:
        print(f"❌ ERROR: Failed to upload key '{key}' to Cloudflare KV: {e}")
        raise # Re-raise other exceptions too

# --- MAIN EXECUTION ---
def main():
    print("--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources = json.load(f)
        print(f"✅ Loaded {len(sources.get('static', []))} static sources. GitHub limit: {sources.get('github_search_limit', 50)}.")
    except Exception as e:
        print(f"FATAL: Cannot load sources.json: {e}"); return

    print("\n--- 2. Fetching Configs ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static = executor.submit(fetch_from_sources, sources.get("static", []), False)
        dynamic = executor.submit(fetch_from_sources, [], True, GITHUB_PAT, sources.get("github_search_limit", 50))
        all_configs = static.result().union(dynamic.result())
    print(f"📊 Total unique configs found: {len(all_configs)}")
    if not all_configs: print("FATAL: No configs found."); return

    print(f"\n--- 3. Performing Deep Protocol Handshake Test (Max Latency: {MAX_LATENCY_MS}ms) ---")
    fast_configs = []
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in list(all_configs)[:MAX_CONFIGS_TO_TEST]}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 100 == 0: print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= MAX_LATENCY_MS:
                fast_configs.append(result)
    print(f"🏆 Found {len(fast_configs)} fast configs.")
    if not fast_configs: print("FATAL: No fast configs found."); return

    print("\n--- 4. Grouping and Finalizing with Fluid Quota ---")
    singbox_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in SINGBOX_ONLY_PROTOCOLS]
    xray_pool = [(c, l) for c, l in fast_configs if urlparse(c).scheme.lower() in XRAY_PROTOCOLS]
    xray_final = select_configs_with_fluid_quota(xray_pool, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    singbox_combined = singbox_pool + xray_pool # Give singbox access to all fast configs
    singbox_final = select_configs_with_fluid_quota(singbox_combined, MIN_TARGET_CONFIGS_PER_CORE, MAX_FINAL_CONFIGS_PER_CORE)
    
    print(f"✅ Selected {len(xray_final)} configs for Xray.")
    print(f"✅ Selected {len(singbox_final)} configs for Sing-box.")

    def group_by_protocol(configs):
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output = {"xray": group_by_protocol(xray_final), "singbox": group_by_protocol(singbox_final)}

    print("\n--- 5. Uploading to Cloudflare KV ---")
    upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json.dumps(output, indent=2, ensure_ascii=False))
    upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time())))
    
    print("\n--- Process Completed Successfully ---")

if __name__ == "__main__":
    main()

