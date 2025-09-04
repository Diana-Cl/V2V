# -*- coding: utf-8 -*-
"""
V2V Scraper v15.0 - Anti-Anti-Bot Edition
This version spoofs a browser User-Agent and intelligently detects HTML block pages.
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
print("INFO: Initializing configuration...")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yaml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
# Using a standard browser User-Agent to bypass basic anti-bot systems
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0'
}
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_QUERIES = [
    '"vless" "subscription" in:file', '"vmess" "sub" in:file', 'filename:v2ray.txt',
    'filename:clash.yaml "vless"', 'path:.github/workflows "v2ray"', '"trojan" "configs" in:file'
]

# ... (rest of the configuration is unchanged)
MAX_CONFIGS_TO_TEST = 4000
MAX_PING_THRESHOLD = 5000
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10
TCP_TEST_TIMEOUT = 5
MAX_NAME_LENGTH = 45
PROTOCOL_QUOTAS = {'vless': 0.45, 'vmess': 0.45, 'trojan': 0.05, 'ss': 0.05}

if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# --- PARSING & HELPER FUNCTIONS ---
# ... (These functions are unchanged from v12)
def _decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try: return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        for encoding in ['latin1', 'ascii', 'utf-16']:
            try: return base64.b64decode(padded_str).decode(encoding)
            except Exception: continue
        return ""
def _is_valid_config_format(config_str: str) -> bool:
    try:
        parsed = urlparse(config_str)
        return (parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] and parsed.hostname and len(config_str) > 20 and '://' in config_str)
    except Exception: return False
def shorten_config_name(config_str: str) -> str:
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
    configs = set()
    try:
        decoded_content = _decode_padded_b64(content)
        if decoded_content and decoded_content.count("://") > content.count("://"): content = decoded_content
    except Exception: pass
    pattern = r'(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\'"<>\[\]{}()]*'
    matches = re.findall(pattern, content, re.MULTILINE | re.IGNORECASE)
    for match in matches:
        clean_match = match.strip().strip('\'"')
        if _is_valid_config_format(clean_match): configs.add(clean_match)
    return configs
def parse_singbox_json_config(json_content: dict) -> set:
    configs = set()
    if not isinstance(json_content, dict): return configs
    for outbound in json_content.get("outbounds", []):
        try:
            protocol, server, port, uuid, tag = outbound.get("type"), outbound.get("server"), outbound.get("server_port"), outbound.get("uuid"), quote(outbound.get("tag", "tag"))
            if not all([protocol, server, port, uuid]): continue
            if protocol == "vless":
                tls, transport = outbound.get("tls", {}), outbound.get("transport", {})
                params = {"type": transport.get("type", "tcp"), "security": "tls" if tls.get("enabled") else "none", "sni": tls.get("server_name", server), "path": transport.get("path", "/"), "host": transport.get("headers", {}).get("Host", server)}
                query = "&"..join([f"{k}={v}" for k, v in params.items()])
                config_str = f"vless://{uuid}@{server}:{port}?{query}#{tag}"
                if _is_valid_config_format(config_str): configs.add(config_str)
        except Exception: continue
    return configs

# --- CORE LOGIC FUNCTIONS ---
def fetch_and_parse_url(url: str) -> set:
    """
    Fetches content and intelligently handles anti-bot pages.
    """
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()

        # Anti-bot detection logic
        content_type = response.headers.get('Content-Type', '')
        if 'text/html' in content_type:
            # It's likely a block page, not a subscription file.
            print(f"ANTI-BOT [WARNING]: Source {url} returned an HTML page, likely an anti-bot challenge. Skipping.")
            return set()

        content = response.text
        
        # Dispatch to appropriate parser
        if url.endswith((".json", "sing-box.json")):
            try:
                json_data = json.loads(content)
                return parse_singbox_json_config(json_data)
            except json.JSONDecodeError:
                return parse_subscription_content(content)
        else:
            return parse_subscription_content(content)

    except requests.RequestException:
        return set() # Silently ignore failed fetches
    except Exception:
        return set() # Silently ignore other errors

# ... (The rest of the script, including get_static_sources, discover_dynamic_sources, testing, and main logic remains unchanged from v12)
# The full script is provided for completeness.
def get_static_sources() -> list:
    print("INFO: Loading static sources...")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            sources = json.load(f).get("static", [])
            print(f"INFO: Found {len(sources)} static sources.")
            return sources
    except Exception as e:
        print(f"CRITICAL: Could not read static sources file '{SOURCES_FILE}'. Error: {e}")
        return []
def discover_dynamic_sources() -> list:
    print("INFO: Attempting to discover dynamic sources from GitHub...")
    if not GITHUB_PAT:
        print("CRITICAL: Skipping dynamic source discovery because GH_PAT is missing.")
        return []
    dynamic_sources = set()
    try:
        g = Github(auth=Auth.Token(GITHUB_PAT), timeout=30)
        user = g.get_user()
        print(f"INFO: Successfully authenticated to GitHub as user '{user.login}'.")
        freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=240)
        for query in GITHUB_SEARCH_QUERIES:
            print(f"INFO: Searching GitHub for query: '{query}'")
            try:
                repos = g.search_repositories(query=f'{query}', sort='updated', order='desc')
                for repo in repos:
                    if repo.updated_at < freshness_threshold or len(dynamic_sources) >= 75: break
                    try:
                        for content_file in repo.get_contents(""):
                            if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md', '.json', '.yaml', '.yml')):
                                dynamic_sources.add(content_file.download_url)
                    except GithubException: continue
                    if len(dynamic_sources) >= 75: break
            except GithubException as e:
                print(f"WARNING: GitHub API error during search for query '{query}'. Error: {e}")
                continue
        print(f"INFO: Found {len(dynamic_sources)} dynamic sources from GitHub.")
        return list(dynamic_sources)
    except Exception as e:
        print(f"CRITICAL: A fatal error occurred during GitHub dynamic source discovery. Error: {e}")
        return []
def validate_and_categorize_configs(configs: set) -> dict:
    categorized = {'xray': set(), 'singbox_only': set()}
    for cfg in configs:
        if not _is_valid_config_format(cfg): continue
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or query_params.get('security') == 'reality'):
                categorized['singbox_only'].add(cfg)
            else:
                categorized['xray'].add(cfg)
        except Exception:
            categorized['xray'].add(cfg)
    return categorized
def test_config_advanced(config_str: str) -> dict:
    try:
        host, port, sni, is_tls = None, None, None, False
        parsed_url = urlparse(config_str)
        if parsed_url.scheme == 'vmess':
            vmess_data = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
            host, port, is_tls, sni = vmess_data.get('add'), int(vmess_data.get('port', 443)), vmess_data.get('tls') == 'tls', vmess_data.get('sni', vmess_data.get('add'))
        else:
            host, port, params = parsed_url.hostname, parsed_url.port, dict(parse_qsl(parsed_url.query))
            is_tls = params.get('security') == 'tls' or parsed_url.scheme == 'trojan'
            sni = params.get('sni', host)
        if not host or not port: return {'config_str': config_str, 'ping': 9999}
        family, _, _, _, sockaddr = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0]
        sock = None
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(TCP_TEST_TIMEOUT)
            start_time = time.monotonic()
            if is_tls:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(sock, server_hostname=sni) as ssock:
                    ssock.connect(sockaddr)
            else:
                sock.connect(sockaddr)
            end_time = time.monotonic()
            return {'config_str': config_str, 'ping': int((end_time - start_time) * 1000)}
        except Exception:
            return {'config_str': config_str, 'ping': 9999}
        finally:
            if sock: sock.close()
    except Exception:
        return {'config_str': config_str, 'ping': 9999}
def _clash_parse_vless(proxy, url, params):
    if not url.username: return False
    proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
    if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
    return True
def _clash_parse_vmess(proxy, config_str):
    decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
    if not decoded.get('id'): return False
    proxy.update({'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 'alterId': decoded.get('aid', 0), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 'servername': decoded.get('sni', decoded.get('add')), 'skip-cert-verify': True})
    if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
    return True
def _clash_parse_trojan(proxy, url, params):
    if not url.username: return False
    proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})
    return True
def _clash_parse_ss(proxy, url):
    cred = _decode_padded_b64(unquote(url.username)).split(':')
    if len(cred) < 2 or not cred[0] or not cred[1]: return False
    proxy.update({'cipher': cred[0], 'password': cred[1]})
    return True
def generate_clash_subscription(configs: list) -> str | None:
    proxies, used_names = [], set()
    for config_str in configs:
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'): continue
            url = urlparse(config_str)
            if not url.hostname or not url.port or 'reality' in config_str.lower(): continue
            name = unquote(url.fragment) if url.fragment else url.hostname
            original_name, count = name[:50], 1
            while name in used_names: name = f"{original_name}_{count}"; count += 1
            used_names.add(name)
            proxy = {'name': name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            params = dict(parse_qsl(url.query))
            success = False
            if protocol == 'vless': success = _clash_parse_vless(proxy, url, params)
            elif protocol == 'vmess': success = _clash_parse_vmess(proxy, config_str)
            elif protocol == 'trojan': success = _clash_parse_trojan(proxy, url, params)
            elif protocol == 'ss': success = _clash_parse_ss(proxy, url)
            if success: proxies.append(proxy)
        except Exception: continue
    if not proxies: return None
    clash_config = {'proxies': proxies,'proxy-groups': [{'name': 'V2V-Auto','type': 'url-test','proxies': [p['name'] for p in proxies],'url': 'http://www.gstatic.com/generate_204','interval': 300},{'name': 'V2V-Proxies','type': 'select','proxies': ['V2V-Auto'] + [p['name'] for p in proxies]}],'rules': ['MATCH,V2V-Proxies']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, indent=2)
def main():
    print("--- V2V Scraper v15.0 ---")
    start_time = time.time()
    all_sources = list(set(get_static_sources() + discover_dynamic_sources()))
    print(f"INFO: Total unique sources to fetch: {len(all_sources)}")
    if not all_sources: print("CRITICAL: No sources found. Exiting gracefully."); return
    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"INFO: Total unique raw configs found after fetching: {len(raw_configs)}")
    if not raw_configs: print("CRITICAL: No raw configs could be parsed. No output files will be generated."); return
    categorized_configs = validate_and_categorize_configs(raw_configs)
    xray_compatible_set, singbox_only_set = categorized_configs['xray'], categorized_configs['singbox_only']
    print(f"INFO: Categorized configs: {len(xray_compatible_set)} Xray-compatible | {len(singbox_only_set)} Sing-box only")
    all_unique_configs = list(xray_compatible_set.union(singbox_only_set))
    configs_to_test = all_unique_configs[:MAX_CONFIGS_TO_TEST]
    print(f"INFO: Starting to test {len(configs_to_test)} configs...")
    fast_configs_results = []
    with ThreadPoolExecutor(max_workers=50) as executor:
        for result in executor.map(test_config_advanced, configs_to_test):
            if result.get('ping', 9999) < MAX_PING_THRESHOLD:
                fast_configs_results.append(result)
    fast_configs_results.sort(key=lambda x: x['ping'])
    print(f"INFO: Found {len(fast_configs_results)} fast configs after testing.")
    if not fast_configs_results: print("CRITICAL: No fast configs found. No output files will be generated."); return
    def process_and_shorten(results):
        processed = []
        for res in results:
            shortened_config = shorten_config_name(res['config_str']); processed.append({'config': shortened_config, 'ping': res['ping']})
        return processed
    fast_xray_compatible_res = [res for res in fast_configs_results if res['config_str'] in xray_compatible_set]
    fast_singbox_only_res = [res for res in fast_configs_results if res['config_str'] in singbox_only_set]
    grouped_xray_fast = defaultdict(list)
    for res in fast_xray_compatible_res: proto = res['config_str'].split("://")[0]; grouped_xray_fast[proto].append(res)
    balanced_xray_results = []
    for proto, quota_percent in PROTOCOL_QUOTAS.items(): quota_size = int(TARGET_CONFIGS_PER_CORE * quota_percent); balanced_xray_results.extend(grouped_xray_fast.get(proto, [])[:quota_size])
    if len(balanced_xray_results) < TARGET_CONFIGS_PER_CORE:
        existing_configs = {res['config_str'] for res in balanced_xray_results}
        for res in fast_xray_compatible_res:
            if len(balanced_xray_results) >= TARGET_CONFIGS_PER_CORE: break
            if res['config_str'] not in existing_configs:
                balanced_xray_results.append(res)
    final_xray_res = balanced_xray_results[:TARGET_CONFIGS_PER_CORE]
    final_singbox_res = fast_singbox_only_res[:]
    remaining_needed = TARGET_CONFIGS_PER_CORE - len(final_singbox_res)
    if remaining_needed > 0:
        existing_singbox_configs = {res['config_str'] for res in final_singbox_res}
        xray_configs_for_singbox = [res for res in fast_xray_compatible_res if res['config_str'] not in existing_singbox_configs]
        final_singbox_res.extend(xray_configs_for_singbox[:remaining_needed])
    final_singbox_res = final_singbox_res[:TARGET_CONFIGS_PER_CORE]
    final_xray, final_singbox = process_and_shorten(final_xray_res), process_and_shorten(final_singbox_res)
    print("INFO: Preparing to write output files to project root...")
    output_for_frontend = {'xray': final_xray, 'singbox': final_singbox}
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f: json.dump(output_for_frontend, f, ensure_ascii=False, indent=2)
    print(f"SUCCESS: '{OUTPUT_JSON_FILE}' created successfully.")
    clash_configs = [item['config'] for item in final_xray]
    clash_content = generate_clash_subscription(clash_configs)
    if clash_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f: f.write(clash_content)
        print(f"SUCCESS: '{OUTPUT_CLASH_FILE}' created successfully.")
    with open(CACHE_VERSION_FILE, 'w') as f: f.write(str(int(time.time())))
    print(f"SUCCESS: '{CACHE_VERSION_FILE}' created successfully.")
    elapsed_time = time.time() - start_time
    print(f"\n--- Process Completed in {elapsed_time:.2f} seconds ---")
    print(f"Results: | Xray: {len(final_xray)} | Sing-box: {len(final_singbox)} |")
if __name__ == "__main__":
    main()
