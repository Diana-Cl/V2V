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
from typing import Optional # <--- این خط برای رفع خطا اضافه شده است

print("INFO: Initializing V2V Scraper v23.1...")

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

VALID_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'tuic'}
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 4000
TARGET_CONFIGS_PER_CORE = 500
MAX_TEST_WORKERS = 100
TCP_TIMEOUT = 3

# --- HELPER FUNCTIONS ---

def is_valid_config(config: str) -> bool:
    """Quickly validates the format of a config string."""
    try:
        return urlparse(config).scheme in VALID_PROTOCOLS
    except (ValueError, IndexError):
        return False

def decode_base64_content(content: str) -> str:
    """Decodes base64 content, handling padding errors."""
    try:
        return base64.b64decode(content + '===').decode('utf-8')
    except Exception:
        return ""

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
        
        with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT):
            return config
    except (socket.timeout, socket.error, json.JSONDecodeError, ValueError, TypeError):
        return None

# --- SCRAPING FUNCTIONS ---

def fetch_from_static_sources(sources: list) -> set:
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
        future_to_url = {executor.submit(fetch_url, url): url for url in sources}
        for future in as_completed(future_to_url):
            configs_from_url = future.result()
            if configs_from_url:
                all_configs.update(configs_from_url)
    
    return {cfg for cfg in all_configs if is_valid_config(cfg)}

def fetch_from_github(pat: str, limit: int) -> set:
    """Fetches configs by searching public GitHub repositories."""
    if not pat:
        print("WARNING: GitHub PAT not found. Skipping dynamic search.")
        return set()
    
    try:
        auth = Auth.Token(pat)
        g = Github(auth=auth)
        query = "vless OR vmess OR trojan OR ss OR hysteria2 OR hy2 OR tuic extension:txt extension:md -user:mahdibland"
        results = g.search_code(query, order='desc', sort='indexed')
        
        all_configs = set()
        count = 0
        for content_file in results:
            if count >= limit:
                break
            try:
                decoded_content = decode_base64_content(content_file.content)
                found_configs = {line.strip() for line in decoded_content.splitlines() if line.strip().startswith(tuple(p + '://' for p in VALID_PROTOCOLS))}
                all_configs.update(found_configs)
                count += 1
            except Exception:
                continue # Ignore files that fail to decode or process
        
        return {cfg for cfg in all_configs if is_valid_config(cfg)}
    except Exception as e:
        print(f"ERROR: GitHub search failed. Reason: {e}")
        return set()

# --- MAIN LOGIC ---
def main():
    """Main function to run the scraper, test configs, and write output files."""
    print("\n--- 1. Loading Sources ---")
    try:
        with open(SOURCES_FILE, 'r') as f:
            sources = json.load(f)
        static_sources = sources.get("static", [])
        github_search_limit = sources.get("github_search_limit", 50)
        print(f"✅ Loaded {len(static_sources)} static sources and set GitHub search limit to {github_search_limit}.")
    except Exception as e:
        print(f"CRITICAL: Failed to load sources.json. Error: {e}")
        return

    print("\n--- 2. Fetching Configs ---")
    with ThreadPoolExecutor(max_workers=2) as executor:
        static_future = executor.submit(fetch_from_static_sources, static_sources)
        dynamic_future = executor.submit(fetch_from_github, GITHUB_PAT, github_search_limit)
        
        static_configs = static_future.result()
        print(f"✅ Found {len(static_configs)} configs from static sources.")
        
        dynamic_configs = dynamic_future.result()
        print(f"✅ Found {len(dynamic_configs)} configs from dynamic GitHub search.")

    all_unique_configs = static_configs.union(dynamic_configs)
    print(f"\n📊 Total unique configs found before testing: {len(all_unique_configs)}")

    if not all_unique_configs:
        print("CRITICAL: No configs found. Exiting process.")
        return

    print(f"\n--- 3. Testing Configs (up to {MAX_CONFIGS_TO_TEST}) ---")
    configs_to_test = list(all_unique_configs)[:MAX_CONFIGS_TO_TEST]
    live_configs = set()
    
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        future_to_config = {executor.submit(test_tcp_connection, config): config for config in configs_to_test}
        for i, future in enumerate(as_completed(future_to_config)):
            result = future.result()
            if result:
                live_configs.add(result)
            # Print progress
            print(f"\rTesting progress: {i + 1}/{len(configs_to_test)} | Live: {len(live_configs)}", end="")
    print("\n✅ TCP testing complete.")

    if not live_configs:
        print("\nCRITICAL: No live configs found after testing. Exiting without updating files.")
        return

    print(f"\n--- 4. Finalizing and Writing Files ---")
    print(f"🏆 Found {len(live_configs)} live configs.")
    
    # Categorize configs
    categorized = defaultdict(list)
    for config in live_configs:
        protocol = urlparse(config).scheme
        if protocol in ('hysteria2', 'hy2', 'tuic'):
            categorized['singbox'].append(config)
        elif protocol in ('vless', 'vmess', 'trojan', 'ss'):
            categorized['xray'].append(config)
    
    xray_final = categorized['xray'][:TARGET_CONFIGS_PER_CORE]
    singbox_final = categorized['singbox'][:TARGET_CONFIGS_PER_CORE]

    output_data = {
        "xray": xray_final,
        "singbox": singbox_final
    }

    # Write JSON file
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    print(f"✅ Successfully wrote {len(xray_final)} Xray and {len(singbox_final)} Sing-box configs to {OUTPUT_JSON_FILE}.")

    # Write cache version file
    with open(CACHE_VERSION_FILE, 'w') as f:
        f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {CACHE_VERSION_FILE}.")
    
    print("\n--- Process Completed ---")

if __name__ == "__main__":
    main()


