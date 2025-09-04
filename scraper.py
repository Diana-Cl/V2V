# -*- coding: utf-8 -*-
"""
V2V Scraper v9.0 - Refactored & Enhanced
This script scrapes, tests, and categorizes proxy configurations from various sources.
Key Features:
- Discovers sources from a static file and dynamically from GitHub.
- Performs advanced TCP+TLS handshake tests for accurate ping results.
- Categorizes configs for Xray and Sing-box compatibility.
- Balances the final config list based on protocol quotas.
- Generates a JSON output with ping data for front-end use.
- Generates a Clash-compatible subscription file.
- Ensures all outputs are saved to the project root with static names.
"""

import requests
import base64
import os
import json
import re
import time
import yaml
import socket
import ssl
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qsl, unquote, quote
from collections import defaultdict
from github import Github, Auth, GithubException

# --- CONFIGURATION ---
# File paths (ensuring output to the project root)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yaml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

# Scraping & Filtering constants
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': f'V2V-Scraper/v9.0-Final',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0'
}
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 75
GITHUB_FRESHNESS_HOURS = 240
GITHUB_SEARCH_QUERIES = [
    'v2ray subscription', 'vless subscription', 'proxy subscription',
    'vmess config', 'trojan config', 'clash subscription'
]

# Testing & Balancing constants
MAX_CONFIGS_TO_TEST = 4000
MAX_PING_THRESHOLD = 2500
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10
TCP_TEST_TIMEOUT = 5
MAX_NAME_LENGTH = 45

# Protocol distribution quotas for the final list
PROTOCOL_QUOTAS = {
    'vless': 0.45, 'vmess': 0.45,
    'trojan': 0.05, 'ss': 0.05
}

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# --- HELPER & PARSING FUNCTIONS ---

def _decode_padded_b64(encoded_str: str) -> str:
    """Decodes a base64 string, handling padding and multiple text encodings."""
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        # Fallback to other encodings if utf-8 fails
        for encoding in ['latin1', 'ascii', 'utf-16']:
            try: return base64.b64decode(padded_str).decode(encoding)
            except Exception: continue
        return ""

def _is_valid_config_format(config_str: str) -> bool:
    """Performs a basic structural validation on a config string."""
    try:
        parsed = urlparse(config_str)
        return (parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] and parsed.hostname and len(config_str) > 20 and '://' in config_str)
    except Exception: return False

def shorten_config_name(config_str: str) -> str:
    """Shortens the name part (#...) of a config string if it exceeds MAX_NAME_LENGTH."""
    try:
        if '#' not in config_str: return config_str
        base_part, name_part = config_str.split('#', 1)
        decoded_name = unquote(name_part)
        if len(decoded_name) > MAX_NAME_LENGTH:
            shortened_name = decoded_name[:MAX_NAME_LENGTH-3] + '...'
            return base_part + '#' + quote(shortened_name)
        return config_str
    except Exception: return config_str

def parse_subscription_content(content: str) -> set:
    """Parses raw text content to extract valid config strings using regex."""
    configs = set()
    try:
        # Attempt to decode if the whole content is base64 encoded
        decoded_content = _decode_padded_b64(content)
        if decoded_content and decoded_content.count("://") > content.count("://"):
            content = decoded_content
    except Exception: pass

    # Regex to find all valid prefixes
    pattern = r'(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\'"<>\[\]{}()]*'
    matches = re.findall(pattern, content, re.MULTILINE | re.IGNORECASE)
    for match in matches:
        clean_match = match.strip().strip('\'"')
        if _is_valid_config_format(clean_match):
            configs.add(clean_match)
    return configs

def fetch_and_parse_url(url: str) -> set:
    """Fetches content from a URL and parses it for configs."""
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        return parse_subscription_content(response.text)
    except (requests.RequestException, Exception):
        # Silently fail for any request errors
        return set()

def get_static_sources() -> list:
    """Loads static subscription links from the sources.json file."""
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f).get("static", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def discover_dynamic_sources() -> list:
    """Discovers new subscription links by searching GitHub repositories."""
    if not GITHUB_PAT:
        print("Warning: No GitHub PAT found. Skipping dynamic source discovery.")
        return []
    g = Github(auth=Auth.Token(GITHUB_PAT), timeout=20)
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=GITHUB_FRESHNESS_HOURS)
    dynamic_sources = set()
    print("Discovering dynamic sources from GitHub...")
    for query in GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                    break
                try:
                    # Look for text files in the repo's root
                    for content_file in repo.get_contents(""):
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md')):
                            dynamic_sources.add(content_file.download_url)
                except GithubException: continue
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
        except GithubException as e:
            print(f"GitHub API error for query '{query}': {e}")
            continue
    return list(dynamic_sources)

def validate_and_categorize_configs(configs: set) -> dict:
    """Categorizes configs into Xray-compatible and Sing-box only."""
    categorized = {'xray': set(), 'singbox_only': set()}
    for cfg in configs:
        if not _is_valid_config_format(cfg): continue
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            # Hysteria2, TUIC, and VLESS with REALITY are Sing-box only
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or query_params.get('security') == 'reality'):
                categorized['singbox_only'].add(cfg)
            else:
                categorized['xray'].add(cfg)
        except Exception:
            categorized['xray'].add(cfg)
    return categorized

def test_config_advanced(config_str: str) -> dict:
    """
    Performs an advanced connectivity test.
    For TLS configs, it completes a full SSL handshake.
    For non-TLS, it completes a TCP handshake.
    Returns the handshake duration as ping.
    """
    try:
        host, port, sni, is_tls = None, None, None, False
        parsed_url = urlparse(config_str)

        if parsed_url.scheme == 'vmess':
            vmess_data = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
            host = vmess_data.get('add')
            port = int(vmess_data.get('port', 443))
            is_tls = vmess_data.get('tls') == 'tls'
            sni = vmess_data.get('sni', host)
        else:
            host = parsed_url.hostname
            port = parsed_url.port
            params = dict(parse_qsl(parsed_url.query))
            is_tls = params.get('security') == 'tls' or parsed_url.scheme == 'trojan'
            sni = params.get('sni', host)

        if not host or not port:
            return {'config_str': config_str, 'ping': 9999}
        
        addr_infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        # Try connecting to the first resolved address
        family, socktype, proto, _, sockaddr = addr_infos[0]
        
        sock = None
        try:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(TCP_TEST_TIMEOUT)
            start_time = time.monotonic()
            
            if is_tls:
                # For TLS, wrap the socket and perform a handshake
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=sni) as ssock:
                    ssock.connect(sockaddr)
            else:
                # For non-TLS, just a standard TCP connect
                sock.connect(sockaddr)
                
            end_time = time.monotonic()
            return {'config_str': config_str, 'ping': int((end_time - start_time) * 1000)}
        except (socket.timeout, ConnectionRefusedError, ssl.SSLError, OSError):
            return {'config_str': config_str, 'ping': 9999}
        finally:
            if sock: sock.close()
            
    except Exception:
        return {'config_str': config_str, 'ping': 9999}


def _clash_parse_vless(proxy, url, params):
    """Helper to parse VLESS params for Clash."""
    if not url.username: return False
    proxy.update({
        'uuid': url.username,
        'tls': params.get('security') == 'tls',
        'network': params.get('type', 'tcp'),
        'servername': params.get('sni', url.hostname),
        'skip-cert-verify': True
    })
    if proxy.get('network') == 'ws':
        proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
    return True

def _clash_parse_vmess(proxy, config_str):
    """Helper to parse VMess params for Clash."""
    decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
    if not decoded.get('id'): return False
    proxy.update({
        'server': decoded.get('add'),
        'port': int(decoded.get('port')),
        'uuid': decoded.get('id'),
        'alterId': decoded.get('aid', 0),
        'cipher': decoded.get('scy', 'auto'),
        'tls': decoded.get('tls') == 'tls',
        'network': decoded.get('net', 'tcp'),
        'servername': decoded.get('sni', decoded.get('add')),
        'skip-cert-verify': True
    })
    if proxy.get('network') == 'ws':
        proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
    return True

def _clash_parse_trojan(proxy, url, params):
    """Helper to parse Trojan params for Clash."""
    if not url.username: return False
    proxy.update({
        'password': url.username,
        'sni': params.get('sni', url.hostname),
        'skip-cert-verify': True
    })
    return True

def _clash_parse_ss(proxy, url):
    """Helper to parse Shadowsocks params for Clash."""
    cred = _decode_padded_b64(unquote(url.username)).split(':')
    if len(cred) < 2 or not cred[0] or not cred[1]: return False
    proxy.update({'cipher': cred[0], 'password': cred[1]})
    return True
    
def generate_clash_subscription(configs: list) -> str | None:
    """Generates a Clash-compatible YAML subscription from a list of configs."""
    proxies = []
    used_names = set()
    for config_str in configs:
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'): continue
            
            url = urlparse(config_str)
            if not url.hostname or not url.port or 'reality' in config_str.lower(): continue
            
            name = unquote(url.fragment) if url.fragment else url.hostname
            original_name, count = name[:50], 1
            while name in used_names:
                name = f"{original_name}_{count}"; count += 1
            used_names.add(name)
            
            proxy = {'name': name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            params = dict(parse_qsl(url.query))
            
            success = False
            if protocol == 'vless': success = _clash_parse_vless(proxy, url, params)
            elif protocol == 'vmess': success = _clash_parse_vmess(proxy, config_str)
            elif protocol == 'trojan': success = _clash_parse_trojan(proxy, url, params)
            elif protocol == 'ss': success = _clash_parse_ss(proxy, url)
                
            if success:
                proxies.append(proxy)
        except Exception:
            # Ignore configs that fail to parse
            continue
            
    if not proxies: return None
    
    # Basic Clash configuration structure
    clash_config = {
        'proxies': proxies,
        'proxy-groups': [
            {
                'name': 'V2V-Auto',
                'type': 'url-test',
                'proxies': [p['name'] for p in proxies],
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300
            },
            {
                'name': 'V2V-Proxies',
                'type': 'select',
                'proxies': ['V2V-Auto'] + [p['name'] for p in proxies]
            }
        ],
        'rules': [
            'MATCH,V2V-Proxies'
        ]
    }
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, indent=2)


# --- MAIN EXECUTION ---
def main():
    print("--- V2V Scraper v9.0 ---")
    start_time = time.time()
    
    # 1. Fetch all raw configs from static and dynamic sources
    all_sources = list(set(get_static_sources() + discover_dynamic_sources()))
    print(f"Sources found: {len(all_sources)}")
    if not all_sources: return

    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"Unique raw configs found: {len(raw_configs)}")
    if not raw_configs: return

    # 2. Categorize configs for different cores (Xray vs. Sing-box)
    categorized_configs = validate_and_categorize_configs(raw_configs)
    xray_compatible_set = categorized_configs['xray']
    singbox_only_set = categorized_configs['singbox_only']
    print(f"Categorized: {len(xray_compatible_set)} Xray-compatible | {len(singbox_only_set)} Sing-box only")
    
    # 3. Test a subset of configs for connectivity and speed
    all_unique_configs = list(xray_compatible_set.union(singbox_only_set))
    configs_to_test = all_unique_configs[:MAX_CONFIGS_TO_TEST]
    
    print(f"Testing {len(configs_to_test)} configs using advanced handshake test...")
    fast_configs_results = []
    with ThreadPoolExecutor(max_workers=50) as executor:
        for result in executor.map(test_config_advanced, configs_to_test):
            if result.get('ping', 9999) < MAX_PING_THRESHOLD:
                fast_configs_results.append(result)

    fast_configs_results.sort(key=lambda x: x['ping'])
    print(f"Fast configs found: {len(fast_configs_results)}")
    
    # 4. Prepare final lists, balancing protocols for Xray core
    def process_and_shorten(results):
        processed = []
        for res in results:
            shortened_config = shorten_config_name(res['config_str'])
            # This structure is now ready for the frontend's hybrid test
            processed.append({'config': shortened_config, 'ping': res['ping']})
        return processed

    fast_xray_compatible_res = [res for res in fast_configs_results if res['config_str'] in xray_compatible_set]
    fast_singbox_only_res = [res for res in fast_configs_results if res['config_str'] in singbox_only_set]
    
    grouped_xray_fast = defaultdict(list)
    for res in fast_xray_compatible_res:
        proto = res['config_str'].split("://")[0]
        grouped_xray_fast[proto].append(res)

    balanced_xray_results = []
    for proto, quota_percent in PROTOCOL_QUOTAS.items():
        quota_size = int(TARGET_CONFIGS_PER_CORE * quota_percent)
        balanced_xray_results.extend(grouped_xray_fast.get(proto, [])[:quota_size])
    
    # Fill remaining slots if quotas weren't met
    if len(balanced_xray_results) < TARGET_CONFIGS_PER_CORE:
        existing_configs = {res['config_str'] for res in balanced_xray_results}
        for res in fast_xray_compatible_res:
            if len(balanced_xray_results) >= TARGET_CONFIGS_PER_CORE: break
            if res['config_str'] not in existing_configs:
                balanced_xray_results.append(res)

    final_xray_res = balanced_xray_results[:TARGET_CONFIGS_PER_CORE]
    
    # 5. Prepare the Sing-box list (includes its own specific configs + fast Xray configs)
    final_singbox_res = fast_singbox_only_res[:]
    remaining_needed = TARGET_CONFIGS_PER_CORE - len(final_singbox_res)
    if remaining_needed > 0:
        existing_singbox_configs = {res['config_str'] for res in final_singbox_res}
        xray_configs_for_singbox = [res for res in fast_xray_compatible_res if res['config_str'] not in existing_singbox_configs]
        final_singbox_res.extend(xray_configs_for_singbox[:remaining_needed])
    final_singbox_res = final_singbox_res[:TARGET_CONFIGS_PER_CORE]

    final_xray = process_and_shorten(final_xray_res)
    final_singbox = process_and_shorten(final_singbox_res)

    # 6. Write output files to the project root
    output_for_frontend = {'xray': final_xray, 'singbox': final_singbox}
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False, indent=2)
    print(f"'{OUTPUT_JSON_FILE}' created successfully.")

    clash_configs = [item['config'] for item in final_xray]
    clash_content = generate_clash_subscription(clash_configs)
    if clash_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_content)
        print(f"'{OUTPUT_CLASH_FILE}' created successfully.")
    
    with open(CACHE_VERSION_FILE, 'w') as f:
        f.write(str(int(time.time())))
    print(f"'{CACHE_VERSION_FILE}' created successfully.")

    elapsed_time = time.time() - start_time
    print(f"\n--- Process Completed in {elapsed_time:.2f} seconds ---")
    print(f"Results: | Xray: {len(final_xray)} | Sing-box: {len(final_singbox)} |")
    print("-------------------------------------------------")

if __name__ == "__main__":
    main()
