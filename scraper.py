# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import yaml
import socket
import ssl
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, quote, unquote
from collections import defaultdict
from github import Github, Auth
from typing import Optional, Set

print("INFO: Initializing V2V Scraper v25.0 (Production Ready)...")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic'}
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 5000
TARGET_CONFIGS_PER_CORE = 500
MAX_TEST_WORKERS = 150
TCP_TIMEOUT = 2.5

# --- HELPER FUNCTIONS (Robust Parsing) ---

def decode_base64_content(content: str) -> str:
    """Safely decodes base64 content, handling padding and other errors."""
    if not isinstance(content, str) or not content.strip():
        return ""
    try:
        # Normalize the string before decoding
        content = content.strip().replace('\n', '').replace('\r', '')
        return base64.b64decode(content + '===').decode('utf-8', 'ignore')
    except Exception:
        return ""

def is_valid_config(config: str) -> bool:
    """More robustly validates the format of a config string."""
    if not isinstance(config, str) or not config.strip():
        return False
    try:
        # A simple check for the protocol prefix is fast and effective
        if not config.startswith(tuple(p + '://' for p in VALID_PROTOCOLS)):
            return False
        
        # Ensure it's a parseable URL-like structure
        parsed = urlparse(config)
        if parsed.scheme not in VALID_PROTOCOLS:
            return False
        
        # Vmess is a special case as it's pure base64 after the scheme
        if parsed.scheme == 'vmess':
            return bool(decode_base64_content(config.replace("vmess://", "")))
        
        # Other protocols must have a hostname
        return bool(parsed.hostname)
    except Exception:
        return False

def test_tcp_connection(config: str) -> Optional[str]:
    """Tests TCP connection for a config, returns the config if successful."""
    try:
        parsed_url = urlparse(config)
        hostname = parsed_url.hostname
        port = parsed_url.port
        if not hostname or not port:
            if parsed_url.scheme == 'vmess':
                vmess_data = json.loads(decode_base64_content(config.replace("vmess://", "")))
                hostname = vmess_data.get('add')
                port = int(vmess_data.get('port'))
            else:
                return None
        
        # Use a new socket for each thread
        with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT):
            return config
    except Exception:
        return None

# --- SCRAPING FUNCTIONS ---

def fetch_from_static_sources(sources: list) -> Set[str]:
    """Fetches configs from a list of static subscription links."""
    all_configs = set()
    def fetch_url(url):
        try:
            response = requests.get(url, headers=HEADERS, timeout=10)
            response.raise_for_status()
            content = decode_base64_content(response.text)
            return {line.strip() for line in content.splitlines() if line.strip()}
        except requests.RequestException:
            return set()

    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(fetch_url, url) for url in sources]
        for future in as_completed(futures):
            all_configs.update(future.result())
    
    return {cfg for cfg in all_configs if is_valid_config(cfg)}

def fetch_from_github(pat: str, limit: int) -> Set[str]:
    """Fetches configs by searching public GitHub repositories."""
    if not pat:
        print("WARNING: GitHub PAT not found. Skipping dynamic search.")
        return set()
    
    try:
        auth = Auth.Token(pat)
        g = Github(auth=auth, timeout=30)
        query = " OR ".join(VALID_PROTOCOLS) + " extension:txt extension:md -user:mahdibland"
        results = g.search_code(query, order='desc', sort='indexed')
        
        all_configs = set()
        count = 0
        for content_file in results:
            if count >= limit: break
            try:
                decoded_content = decode_base64_content(content_file.content)
                found = {line.strip() for line in decoded_content.splitlines() if is_valid_config(line.strip())}
                all_configs.update(found)
                count += 1
            except Exception:
                continue
        
        return all_configs
    except Exception as e:
        print(f"ERROR: GitHub search failed. Reason: {e}")
        return set()

# --- MAIN LOGIC ---
def main():
    print("\n--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources = json.load(f)
        static_sources = sources.get("static", [])
        github_search_limit = sources.get("github_search_limit", 50)
        print(f"✅ Loaded {len(static_sources)} static sources. GitHub search limit: {github_search_limit}.")
    except Exception as e:
        print(f"CRITICAL: Failed to load sources.json. Error: {e}"); return

    print("\n--- 2. Fetching Configs ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_future = executor.submit(fetch_from_static_sources, static_sources)
        dynamic_future = executor.submit(fetch_from_github, GITHUB_PAT, github_search_limit)
        static_configs = static_future.result()
        print(f"✅ Found {len(static_configs)} valid configs from static sources.")
        dynamic_configs = dynamic_future.result()
        print(f"✅ Found {len(dynamic_configs)} valid configs from dynamic GitHub search.")

    all_unique_configs = static_configs.union(dynamic_configs)
    print(f"\n📊 Total unique configs found before testing: {len(all_unique_configs)}")
    if not all_unique_configs: print("CRITICAL: No configs found. Exiting."); return

    print(f"\n--- 3. Testing Configs (up to {MAX_CONFIGS_TO_TEST}) ---")
    configs_to_test = list(all_unique_configs)[:MAX_CONFIGS_TO_TEST]
    live_configs = set()
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        futures = {executor.submit(test_tcp_connection, c) for c in configs_to_test}
        for future in as_completed(futures):
            result = future.result()
            if result:
                live_configs.add(result)
    print("✅ TCP testing complete.")

    if not live_configs: print("\nCRITICAL: No live configs found. Exiting."); return

    print(f"\n--- 4. Finalizing and Writing Files ---")
    print(f"🏆 Found {len(live_configs)} live configs.")
    
    # --- Smart Categorization Logic ---
    xray_pool = {cfg for cfg in live_configs if urlparse(cfg).scheme in XRAY_PROTOCOLS}
    singbox_only_pool = {cfg for cfg in live_configs if urlparse(cfg).scheme in SINGBOX_ONLY_PROTOCOLS}
    
    xray_final = list(xray_pool)[:TARGET_CONFIGS_PER_CORE]
    xray_used_set = set(xray_final)
    
    singbox_final = list(singbox_only_pool)
    
    needed = TARGET_CONFIGS_PER_CORE - len(singbox_final)
    if needed > 0:
        shared_pool_remaining = xray_pool - xray_used_set
        singbox_final.extend(list(shared_pool_remaining)[:needed])
    singbox_final = singbox_final[:TARGET_CONFIGS_PER_CORE]

    output_data = {"xray": xray_final, "singbox": singbox_final}

    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote {len(xray_final)} Xray and {len(singbox_final)} Sing-box configs to {OUTPUT_JSON_FILE}.")

    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {CACHE_VERSION_FILE}.")
    
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()
