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
import yaml 

# cloudflare library is required: pip install cloudflare
from cloudflare import Cloudflare, APIError

print("INFO: V2V Scraper v45.0 (Finalized Smart Balancing)") # ✅ نسخه نهایی

# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

# Protocol definitions
XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
# ✅ اصلاح شد: اضافه شدن SSR و Naive به عنوان پروتکل‌های انحصاری Sing-box
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic', 'ssr', 'naive'} 
VALID_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {'User-Agent': 'V2V-Scraper/1.0'}

# Environment variables for sensitive data
GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN')
CF_API_TOKEN = os.environ.get('CF_API_TOKEN')
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID')
KV_LIVE_CONFIGS_KEY = "V2V_LIVE_CONFIGS"
KV_CACHE_VERSION_KEY = "V2V_CACHE_VERSION"
CF_NAMESPACE_ID = os.environ.get('CF_NAMESPACE_ID')
GITHUB_SEARCH_LIMIT = int(os.environ.get('GITHUB_SEARCH_LIMIT', 50))

# --- PERFORMANCE & FILTERING PARAMETERS (Managed in scraper.py) ---
MAX_CONFIGS_TO_TEST = 15000
MIN_TARGET_CONFIGS_PER_CORE = 1000  # 🎯 حداقل خروجی
MAX_FINAL_CONFIGS_PER_CORE = 5000   # 🎯 حداکثر خروجی
MAX_TEST_WORKERS = 200
REQUEST_TIMEOUT = 10
FAST_LATENCY_THRESHOLD = 500 #ms
MAX_LATENCY_THRESHOLD = 2500 #ms


# --- 1. Helper Functions ---

def decode_base64_url(data: str) -> str:
    """Decodes base64 URL-safe strings."""
    data = data.replace('-', '+').replace('_', '/')
    padding_needed = len(data) % 4
    if padding_needed:
        data += '=' * (4 - padding_needed)
    try:
        return base64.b64decode(data).decode('utf-8')
    except Exception:
        return ""

def is_valid_config(url: str) -> bool:
    """Checks if a URL has a supported scheme."""
    scheme = urlparse(url).scheme.lower()
    if scheme == 'hysteria2': scheme = 'hy2'
    return scheme in VALID_PROTOCOLS

def fetch_content(url: str) -> Optional[str]:
    """Fetches content from a URL with robust error handling."""
    try:
        response = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        return response.text
    except requests.exceptions.Timeout:
        # print(f"  ❌ Timeout fetching: {url}") # Too verbose
        return None
    except requests.exceptions.RequestException as e:
        # print(f"  ❌ Error fetching {url}: {e}") # Too verbose
        return None

def extract_configs_from_text(text: str) -> Set[str]:
    """Extracts base64/plain configs from text."""
    configs = set()
    lines = text.split('\n')
    
    # 1. Check for plain config lines
    for line in lines:
        line = line.strip()
        if is_valid_config(line):
            configs.add(line)

    # 2. Check for base64 encoded block (often subscription link)
    if len(configs) < 10: # Only try base64 if few configs were found
        try:
            decoded_text = decode_base64_url(text)
            decoded_lines = decoded_text.split('\n')
            for line in decoded_lines:
                line = line.strip()
                if is_valid_config(line):
                    configs.add(line)
        except Exception:
            pass
            
    return configs

def github_search_for_configs(g: Github) -> Set[str]:
    """Searches GitHub for configs."""
    search_queries = [
        f'vless:// language:yaml',
        f'vmess:// language:yaml',
        f'trojan:// language:yaml',
        f'ss:// language:yaml',
        f'hysteria2:// language:yaml',
        f'tuic:// language:yaml',
    ]
    all_configs = set()
    
    for query in search_queries:
        print(f"  Searching GitHub for: {query.split(' ')[0]} (Limit: {GITHUB_SEARCH_LIMIT})")
        try:
            # We are interested in the *contents* of files, not the code directly
            results = g.search.code(query=query, sort='indexed', order='desc')
            for i, result in enumerate(results):
                if i >= GITHUB_SEARCH_LIMIT:
                    break
                
                # Fetch content from the raw URL
                raw_url = result.download_url
                if raw_url:
                    content = fetch_content(raw_url)
                    if content:
                        all_configs.update(extract_configs_from_text(content))
                    
        except RateLimitExceededException:
            print("  ❌ GitHub Rate Limit Exceeded. Stopping GitHub search.")
            break
        except Exception as e:
            print(f"  ❌ Error during GitHub search for {query}: {e}")
            
    return all_configs

def test_single_config(cfg: str) -> Optional[Tuple[str, int]]:
    """Performs a rudimentary Handshake test for initial validation."""
    parsed = urlparse(cfg)
    scheme = parsed.scheme.lower()
    if scheme == 'hysteria2': scheme = 'hy2'
    
    if scheme not in VALID_PROTOCOLS:
        return None

    hostname = parsed.hostname
    port = parsed.port if parsed.port else (443 if scheme in ['vless', 'vmess', 'trojan', 'hy2', 'tuic'] else 80)

    if not hostname or not port:
        return None

    # This is the initial, rudimentary check (Handshake Test) on the scraper's server (Github Actions)
    # The real latency test happens via Cloudflare Worker later on (Phase 2)
    # We only check for a basic TCP/TLS handshake success here.
    sock = None
    context = None
    start_time = time.time()
    latency = None
    
    try:
        sock = socket.create_connection((hostname, port), timeout=5)
        
        # Perform a basic TLS handshake if secure protocols
        if scheme in ['vless', 'vmess', 'trojan', 'hy2', 'tuic', 'ss']: # Most configs use TLS/SSL
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            
            # Note: For Hysteria/TUIC (UDP-based), a TCP/TLS handshake on the port 
            # is often an indicator of availability for control-plane, but not fully accurate.
            # We keep it simple here as the real test is via the CF Worker API.
            wrapped_socket = context.wrap_socket(sock, server_hostname=hostname)
            wrapped_socket.do_handshake()
            wrapped_socket.close()

        latency = int((time.time() - start_time) * 1000)
        if latency <= MAX_LATENCY_THRESHOLD:
            return cfg, latency
            
    except Exception:
        pass # Test failed
    finally:
        if sock:
            sock.close()
            
    return None

# --- 2. Phase 1: Fetching Configs ---

def fetch_all_configs() -> Set[str]:
    """Fetches configs from all sources."""
    print("--- 1. Fetching All Configs ---")
    all_configs = set()
    
    try:
        with open(SOURCES_FILE, 'r') as f:
            sources = json.load(f)
    except FileNotFoundError:
        print(f"❌ Error: {SOURCES_FILE} not found.")
        return all_configs
        
    # --- HTTP/Subscription Fetching ---
    for source in sources.get('subscriptions', []):
        url = source.get('url')
        if not url: continue
        
        content = fetch_content(url)
        if content:
            configs = extract_configs_from_text(content)
            all_configs.update(configs)
            print(f"  Fetched {len(configs)} configs from {source.get('name')}.")

    # --- GitHub Search Fetching (Requires Token) ---
    if GITHUB_TOKEN:
        try:
            auth = Auth.Token(GITHUB_TOKEN)
            g = Github(auth=auth)
            github_configs = github_search_for_configs(g)
            all_configs.update(github_configs)
            print(f"  Fetched {len(github_configs)} configs from GitHub Search.")
        except BadCredentialsException:
             print("  ❌ GitHub Token is invalid. Skipping GitHub search.")
        except Exception as e:
            print(f"  ❌ Error during GitHub search initialization: {e}")
    else:
        print("  ⚠️ GITHUB_TOKEN is not set. Skipping GitHub search.")

    print(f"✅ Total unique configs found: {len(all_configs)}")
    return all_configs

# --- 3. Phase 2: Handshake Test (The Scraper's Test) ---

def run_scraper_handshake_test(configs: Set[str]) -> List[Tuple[str, int]]:
    """Runs the initial handshake test on the scraper's server."""
    print("\n--- 2. Scraper Handshake Test (Initial Quality Filter) ---")
    
    configs_to_test = list(configs)[:MAX_CONFIGS_TO_TEST]
    print(f"  Testing {len(configs_to_test)} configs using {MAX_TEST_WORKERS} threads...")
    
    fast_configs_with_latency = []
    
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
        future_to_config = {executor.submit(test_single_config, cfg): cfg for cfg in configs_to_test}
        
        for i, future in enumerate(as_completed(future_to_config)):
            result = future.result()
            if result:
                # We only keep configs that passed the initial handshake test.
                fast_configs_with_latency.append(result)
            
            # Print progress every 500 tests
            if (i + 1) % 500 == 0 or (i + 1) == len(configs_to_test):
                print(f"  Progress: {i+1}/{len(configs_to_test)} tested. Live configs found so far: {len(fast_configs_with_latency)}")

    end_time = time.time()
    
    # We only keep the top configs based on low latency (if we have many)
    fast_configs_with_latency.sort(key=lambda item: item[1])
    
    print(f"✅ Scraper Handshake Test completed in {end_time - start_time:.2f} seconds.")
    print(f"✅ Found {len(fast_configs_with_latency)} live configs (Latency < {MAX_LATENCY_THRESHOLD}ms).")
    
    return fast_configs_with_latency

# --- 4. Grouping and Finalizing Configs (Smart Balancing) ---

def get_display_name(p: str) -> str:
    """Gets the standardized uppercase name for protocols."""
    if p in ['vless', 'vmess', 'trojan', 'ss']: return p.upper()
    if p == 'hy2': return 'HYSTERIA2'
    if p == 'tuic': return 'TUIC'
    if p == 'ssr': return 'SSR'
    if p == 'naive': return 'NAIVE'
    return p.upper()

def group_by_protocol_for_output(configs: Set[str]) -> Dict[str, List[str]]:
    """Groups the final set of configs by their standardized protocol name."""
    grouped = defaultdict(list)
    for cfg in configs:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2' # Normalize for internal use
        grouped[get_display_name(proto)].append(cfg)
    return dict(grouped)


def finalize_and_balance_configs(fast_configs_with_latency: List[Tuple[str, int]]) -> Dict[str, Dict[str, List[str]]]:
    """
    Groups, balances, and finalizes the config lists based on the 1000/5000 rules 
    and Sing-box priority to ensure non-repetition and comprehensive protocol support.
    """
    print("\n--- 3. Finalizing Configs (Smart Balancing) ---")
    
    # Organize live configs by protocol
    live_configs_by_protocol = defaultdict(list)
    for cfg, lat in fast_configs_with_latency:
        proto = urlparse(cfg).scheme.lower()
        if proto == 'hysteria2': proto = 'hy2'
        live_configs_by_protocol[proto].append((cfg, lat))

    # لیست‌های نهایی (استفاده از set برای تضمین عدم تکرار)
    xray_final_set = set()
    singbox_final_set = set()

    # پروتکل‌های مشترک و انحصاری
    shared_protocols = XRAY_PROTOCOLS.intersection(VALID_PROTOCOLS)
    exclusive_singbox_protos = SINGBOX_ONLY_PROTOCOLS

    # 1. تخصیص انحصاری Sing-box
    print(f"  1. Allocating Exclusive Sing-box protocols ({', '.join(get_display_name(p) for p in exclusive_singbox_protos)})...")
    for proto in exclusive_singbox_protos:
        sorted_exclusive = sorted(live_configs_by_protocol[proto], key=lambda item: item[1])
        for cfg, _ in sorted_exclusive:
            if len(singbox_final_set) < MAX_FINAL_CONFIGS_PER_CORE:
                singbox_final_set.add(cfg)

    # 2. تخصیص کانفیگ‌های مشترک (VLESS, VMess, Trojan, SS) با اولویت Sing-box
    print(f"  2. Allocating Shared protocols ({', '.join(get_display_name(p) for p in shared_protocols)}) with Sing-box priority...")

    shared_configs_with_latency = []
    for proto in shared_protocols:
        shared_configs_with_latency.extend(live_configs_by_protocol[proto])

    # مرتب‌سازی کانفیگ‌های مشترک بر اساس تأخیر
    shared_configs_with_latency.sort(key=lambda item: item[1])

    # پر کردن Sing-box تا سقف (5000) با کانفیگ‌های مشترک
    for cfg, _ in shared_configs_with_latency:
        if len(singbox_final_set) < MAX_FINAL_CONFIGS_PER_CORE:
            # اگر کانفیگ در مجموعه نهایی سینگ‌باکس نبود، آن را اضافه می‌کنیم
            singbox_final_set.add(cfg)
        else:
            # اگر سینگ‌باکس پر شد، کانفیگ‌های باقی‌مانده را برای Xray رزرو می‌کنیم
            break # برای صرفه‌جویی در حلقه

    # 3. پر کردن Xray با کانفیگ‌های مشترک باقیمانده و غیر تکراری
    print("  3. Finalizing Xray allocation using remaining shared configs...")
    
    for cfg, _ in shared_configs_with_latency:
        # فقط کانفیگ‌هایی را به Xray اضافه می‌کنیم که:
        # الف) هنوز به سقف 5000 نرسیده است.
        # ب) در لیست نهایی Sing-box استفاده نشده باشد (تضمین عدم تکرار).
        if len(xray_final_set) < MAX_FINAL_CONFIGS_PER_CORE and cfg not in singbox_final_set:
            xray_final_set.add(cfg)
        elif len(xray_final_set) >= MAX_FINAL_CONFIGS_PER_CORE:
            break # اگر Xray هم پر شد، متوقف می‌شویم.
    
    # 4. تضمین حداقل تعداد (Log and Alert)
    if len(xray_final_set) < MIN_TARGET_CONFIGS_PER_CORE:
        print(f"⚠️ WARNING: Xray only found {len(xray_final_set)} live configs (less than {MIN_TARGET_CONFIGS_PER_CORE}).")
    if len(singbox_final_set) < MIN_TARGET_CONFIGS_PER_CORE:
        print(f"⚠️ WARNING: Sing-box only found {len(singbox_final_set)} live configs (less than {MIN_TARGET_CONFIGS_PER_CORE}).")


    print(f"✅ Selected {len(xray_final_set)} configs for Xray core (Min: {MIN_TARGET_CONFIGS_PER_CORE}, Max: {MAX_FINAL_CONFIGS_PER_CORE}).")
    print(f"✅ Selected {len(singbox_final_set)} configs for Sing-box core (Min: {MIN_TARGET_CONFIGS_PER_CORE}, Max: {MAX_FINAL_CONFIGS_PER_CORE}).")

    return {
        "xray": group_by_protocol_for_output(xray_final_set), 
        "singbox": group_by_protocol_for_output(singbox_final_set)
    }

# --- 5. Phase 4: Output and Upload ---

def create_clash_yaml(output_data: Dict[str, Dict[str, List[str]]]) -> str:
    """Creates a basic Clash YAML file from the final Xray config set."""
    print("--- 4. Creating Clash YAML ---")
    
    # استفاده از کانفیگ‌های Xray برای تولید Clash YAML (چون Xray و Clash سازگاری بالایی دارند)
    xray_configs = [cfg for sublist in output_data['xray'].values() for cfg in sublist]
    
    if not xray_configs:
        print("  ⚠️ No Xray configs to generate Clash YAML.")
        return ""

    # منطق تبدیل: (این بخش باید مطابق با نیازهای Clash تنظیم شود)
    # از آنجایی که تبدیل مستقیم URL به Node در پایتون پیچیده است، از یک placeholder استفاده می‌شود.
    # در پروژه نهایی، این بخش باید با یک تابع تبدیل قوی (مانند استفاده از یک کتابخانه تبدیل Clash) جایگزین شود.
    
    proxies = []
    for i, cfg_url in enumerate(xray_configs):
        # placeholder for real conversion logic
        proxies.append({
            'name': f'v2v-{i+1}',
            'type': 'url-test',
            # ... بقیه پارامترهای Clash ...
        })

    # یک ساختار پایه Clash برای نمایش فایل نهایی
    clash_config = {
        'port': 7890,
        'socks-port': 7891,
        'allow-lan': False,
        'mode': 'rule',
        'log-level': 'info',
        'external-controller': '127.0.0.1:9090',
        'proxies': proxies[:2000], # Limit proxies for safety
        'proxy-groups': [
            {
                'name': 'v2v-Auto',
                'type': 'url-test',
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300,
                'tolerance': 50,
                'proxies': [p['name'] for p in proxies[:2000]],
            },
            # ... بقیه گروه ها ...
        ],
        'rules': [
            'MATCH,v2v-Auto'
        ]
    }

    try:
        yaml_output = yaml.dump(clash_config, allow_unicode=True, sort_keys=False)
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(yaml_output)
        print(f"✅ Clash YAML generated successfully at {OUTPUT_CLASH_FILE}.")
        return yaml_output
    except Exception as e:
        print(f"❌ Error generating Clash YAML: {e}")
        return ""

def upload_to_cloudflare_kv(key: str, value: str):
    """Uploads data to Cloudflare KV Namespace."""
    if not all([CF_API_TOKEN, CF_ACCOUNT_ID, CF_NAMESPACE_ID]):
        raise ValueError("Cloudflare credentials (CF_API_TOKEN, CF_ACCOUNT_ID, CF_NAMESPACE_ID) are required for KV upload.")
    
    try:
        cf = Cloudflare(api_token=CF_API_TOKEN)
        
        # Cloudflare KV API endpoint for a specific namespace and key
        cf.accounts.workers.kv.namespaces.values.put(
            account_id=CF_ACCOUNT_ID,
            namespace_id=CF_NAMESPACE_ID,
            key=key,
            value=value
        )
    except APIError as e:
        print(f"❌ Cloudflare API Error: {e}")
        raise
    except Exception as e:
        print(f"❌ An unexpected error occurred during Cloudflare KV upload: {e}")
        raise

def main():
    start_time = time.time()
    
    # 1. Fetching
    unique_configs = fetch_all_configs()
    if not unique_configs:
        print("❌ No configs found. Exiting.")
        return

    # 2. Scraper Handshake Test
    fast_configs_with_latency = run_scraper_handshake_test(unique_configs)
    if not fast_configs_with_latency:
        print("❌ No live configs passed the initial handshake test. Exiting.")
        return

    # 3. Finalizing and Balancing Configs
    output_data_for_kv = finalize_and_balance_configs(fast_configs_with_latency)

    # 4. Output and Upload
    
    # Save the full JSON output locally (for use in static sites and debugging)
    json_string_to_upload = json.dumps(output_data_for_kv, indent=2, ensure_ascii=False)
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        f.write(json_string_to_upload)
    print(f"✅ Final JSON output saved locally to {OUTPUT_JSON_FILE}.")
    
    # Generate Clash YAML (for direct download)
    create_clash_yaml(output_data_for_kv)
    
    # Upload to Cloudflare KV
    try:
        print("\n--- 5. Cloudflare KV Upload ---")
        
        print("  Uploading live configs to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_LIVE_CONFIGS_KEY, json_string_to_upload)
        
        print("  Uploading cache version to Cloudflare KV...")
        upload_to_cloudflare_kv(KV_CACHE_VERSION_KEY, str(int(time.time())))
        
        print("\n--- Process Completed Successfully ---")
        
        total_xray = sum(len(configs) for configs in output_data_for_kv["xray"].values())
        total_singbox = sum(len(configs) for configs in output_data_for_kv["singbox"].values())
        print(f"Final Summary (Total time: {time.time() - start_time:.2f}s):")
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
                        print(f"    - SubKey '{subkey}': Type {type(subvalue)}, Count {len(subvalue) if isinstance(subvalue, list) else 0}")
        raise

if __name__ == "__main__":
    main()
