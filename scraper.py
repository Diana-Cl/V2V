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
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qsl, unquote, quote
from collections import defaultdict
from github import Github, Auth, GithubException

# CONFIGURATION
SOURCES_FILE = "sources.json"
OUTPUT_JSON_FILE = "all_live_configs.json"
OUTPUT_CLASH_FILE = "clash_subscription.yaml"
CACHE_VERSION_FILE = "cache_version.txt"
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': 'V2V-Scraper/v8.0-HybridPing',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0'
}

GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 75
GITHUB_FRESHNESS_HOURS = 240
GITHUB_SEARCH_QUERIES = [
    'v2ray subscription', 'vless subscription', 'proxy subscription',
    'vmess config', 'trojan config', 'clash subscription'
]

MAX_CONFIGS_TO_TEST = 4000
MAX_PING_THRESHOLD = 2500
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10
TCP_TEST_TIMEOUT = 5
MAX_NAME_LENGTH = 45

PROTOCOL_QUOTAS = {
    'vless': 0.45, 'vmess': 0.45,
    'trojan': 0.05, 'ss': 0.05
}

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# HELPER & PARSING FUNCTIONS
def _decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
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
        if not '#' in config_str: return config_str
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

def fetch_and_parse_url(url: str) -> set:
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        return parse_subscription_content(response.text)
    except (requests.RequestException, Exception): return set()

def get_static_sources() -> list:
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f: return json.load(f).get("static", [])
    except (FileNotFoundError, json.JSONDecodeError): return []

def discover_dynamic_sources() -> list:
    if not GITHUB_PAT: return []
    g = Github(auth=Auth.Token(GITHUB_PAT), timeout=20)
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=GITHUB_FRESHNESS_HOURS)
    dynamic_sources = set()
    for query in GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
                try:
                    for content_file in repo.get_contents(""):
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md')):
                            dynamic_sources.add(content_file.download_url)
                except GithubException: continue
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
        except GithubException: continue
    return list(dynamic_sources)

def validate_and_categorize_configs(configs: set) -> dict:
    categorized = {'xray': set(), 'singbox_only': set()}
    for cfg in configs:
        if not _is_valid_config_format(cfg): continue
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or query_params.get('security') == 'reality'):
                categorized['singbox_only'].add(cfg)
            else: categorized['xray'].add(cfg)
        except Exception: categorized['xray'].add(cfg)
    return categorized

def generate_clash_subscription(configs: list) -> str | None:
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
            if protocol == 'vless':
                if not url.username: continue
                params = dict(parse_qsl(url.query))
                proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
                if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
            elif protocol == 'vmess':
                decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
                if not decoded.get('id'): continue
                proxy.update({'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 'alterId': decoded.get('aid', 0), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 'servername': decoded.get('sni', decoded.get('add')), 'skip-cert-verify': True})
                if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
            elif protocol == 'trojan':
                if not url.username: continue
                params = dict(parse_qsl(url.query))
                proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})
            elif protocol == 'ss':
                cred = _decode_padded_b64(unquote(url.username)).split(':')
                if len(cred) < 2 or not cred[0] or not cred[1]: continue
                proxy.update({'cipher': cred[0], 'password': cred[1]})
            proxies.append(proxy)
        except Exception: continue
    if not proxies: return None
    return yaml.dump({'proxies': proxies}, allow_unicode=True, sort_keys=False, indent=2)

def test_config_advanced(config_str: str) -> dict:
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
        if not host or not port: return {'config_str': config_str, 'ping': 9999}
        
        addr_infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        for family, socktype, proto, _, sockaddr in addr_infos:
            sock = None
            try:
                sock = socket.socket(family, socktype, proto)
                sock.settimeout(TCP_TEST_TIMEOUT)
                start_time = time.monotonic()
                if is_tls:
                    context = ssl.create_default_context()
                    with context.wrap_socket(sock, server_hostname=sni) as ssock:
                        ssock.connect(sockaddr)
                else:
                    sock.connect(sockaddr)
                end_time = time.monotonic()
                return {'config_str': config_str, 'ping': int((end_time - start_time) * 1000)}
            except Exception: continue
            finally:
                if sock: sock.close()
        return {'config_str': config_str, 'ping': 9999}
    except Exception:
        return {'config_str': config_str, 'ping': 9999}

def main():
    print("--- V2V Scraper v8.0 ---")
    start_time = time.time()
    all_sources = list(set(get_static_sources() + discover_dynamic_sources()))
    print(f"Sources found: {len(all_sources)}")
    if not all_sources: return

    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"Unique raw configs found: {len(raw_configs)}")
    if not raw_configs: return

    categorized_configs = validate_and_categorize_configs(raw_configs)
    xray_compatible_set = categorized_configs['xray']
    singbox_only_set = categorized_configs['singbox_only']
    print(f"Categorized: {len(xray_compatible_set)} Xray | {len(singbox_only_set)} Sing-box only")
    
    all_unique_configs = list(xray_compatible_set.union(singbox_only_set))
    configs_to_test = all_unique_configs[:MAX_CONFIGS_TO_TEST]
    
    print(f"Testing {len(configs_to_test)} configs...")
    fast_configs_results = []
    with ThreadPoolExecutor(max_workers=50) as executor:
        for result in executor.map(test_config_advanced, configs_to_test):
            if result.get('ping', 9999) < MAX_PING_THRESHOLD:
                fast_configs_results.append(result)

    print(f"Fast configs found: {len(fast_configs_results)}")
    fast_configs_results.sort(key=lambda x: x['ping'])
    
    def process_and_shorten(results):
        processed = []
        for res in results:
            shortened_config = shorten_config_name(res['config_str'])
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

    final_xray = process_and_shorten(final_xray_res)
    final_singbox = process_and_shorten(final_singbox_res)

    output_for_frontend = {'xray': final_xray, 'singbox': final_singbox}
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False)
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
