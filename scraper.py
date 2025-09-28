# coding: utf-8

import requests
import base64
import os
import json
import re
import time
import socket
import ssl
import random
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeoutError
from urllib.parse import urlparse, parse_qs
from github import Github, Auth, BadCredentialsException, RateLimitExceededException, UnknownObjectException
from typing import Optional, Set, List, Dict, Tuple
from collections import defaultdict
import yaml
import signal

def timeout_handler(signum, frame):
    print("TIMEOUT: Script exceeded maximum runtime. Exiting gracefully...")
    exit(1)

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(50 * 60)  # 50 minutes

print("INFO: V2V Enhanced Scraper v6.0 (Complete Protocol Coverage)")

# Configuration
# Note: '__file__' is used inside the original script, which is valid in a standalone Python script but requires caution in certain environments.
try:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
except NameError:
    BASE_DIR = os.getcwd()

SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

# Enhanced protocol definitions

XRAY_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks'}
SINGBOX_ONLY_PROTOCOLS = {'hysteria2', 'hy2', 'tuic', 'hysteria'}
ALL_PROTOCOLS = XRAY_PROTOCOLS.union(SINGBOX_ONLY_PROTOCOLS)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/plain, text/html, application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
}

GITHUB_PAT = os.environ.get('GH_PAT')

# Performance parameters

MAX_CONFIGS_TO_TEST = 10000
MIN_CONFIGS_PER_PROTOCOL = 100
MAX_CONFIGS_PER_PROTOCOL = 800
MAX_TEST_WORKERS = 100
TCP_TIMEOUT = 4.0
MAX_LATENCY_MS = 5000
MAX_NAME_LENGTH = 60
GITHUB_SEARCH_LIMIT = max(200, int(os.environ.get('GITHUB_SEARCH_LIMIT', 200)))
MAX_RETRIES = 2

def decode_base64_content(content: str) -> str:
    """Enhanced base64 decoder with multiple encoding attempts."""
    if not isinstance(content, str) or not content.strip():
        return ""

    methods = [
        lambda x: base64.b64decode(x).decode('utf-8', 'ignore'),
        lambda x: base64.urlsafe_b64decode(x + '===').decode('utf-8', 'ignore'),
        lambda x: base64.standard_b64decode(x + '===').decode('utf-8', 'ignore')
    ]

    content = content.strip().replace('\n', '').replace('\r', '').replace(' ', '')

    for method in methods:
        try:
            return method(content)
        except Exception:
            continue

    return ""

def is_valid_config(config: str) -> bool:
    """Enhanced config validation with better protocol detection."""
    if not isinstance(config, str) or not config.strip():
        return False

    config = config.strip()

    if not any(config.startswith(f"{proto}://") for proto in ALL_PROTOCOLS):
        return False

    try:
        parsed = urlparse(config)
        scheme = parsed.scheme.lower()

        if scheme == 'shadowsocks':
            scheme = 'ss'
        elif scheme == 'hysteria':
            scheme = 'hy2'

        if scheme not in ALL_PROTOCOLS:
            return False

        if scheme == 'vmess':
            try:
                vmess_data = config.replace("vmess://", "")
                decoded = json.loads(decode_base64_content(vmess_data))
                return bool(decoded.get('add')) and bool(decoded.get('port')) and bool(decoded.get('id'))
            except:
                return False

        elif scheme in ['vless', 'trojan']:
            return bool(parsed.hostname) and bool(parsed.port) and bool(parsed.username)

        elif scheme == 'ss':
            if '@' in config:
                return bool(parsed.hostname) and bool(parsed.port)
            else:
                try:
                    ss_data = config.replace("ss://", "")
                    if '@' in ss_data:
                        return bool(urlparse("ss://" + ss_data).hostname)
                    decoded = decode_base64_content(ss_data.split('@')[0] if '@' in ss_data else ss_data)
                    return ':' in decoded and len(decoded.split(':')) >= 2
                except:
                    return False

        elif scheme in SINGBOX_ONLY_PROTOCOLS:
            return bool(parsed.hostname) and bool(parsed.port)

        return bool(parsed.hostname) and bool(parsed.port)

    except Exception:
        return False

def extract_configs_from_content(content: str) -> Set[str]:
    """Enhanced config extraction with multiple detection methods."""
    configs = set()

    if not content:
        return configs

    # Method 1: Direct protocol detection
    for protocol in ALL_PROTOCOLS:
        pattern = rf'{protocol}://[^\s<>"\'\n\r{{}}|\\`~!@#$%^&*()=+;:,.<>?/\x00-\x1f\x7f-\x9f]+'
        matches = re.findall(pattern, content, re.IGNORECASE | re.MULTILINE)
        for match in matches:
            clean_match = match.strip()
            if len(clean_match) > 20 and is_valid_config(clean_match):
                configs.add(clean_match)

    # Method 2: Base64 blocks detection
    base64_pattern = r'[A-Za-z0-9+/=]{100,}'
    base64_matches = re.findall(base64_pattern, content)

    for b64_block in base64_matches[:30]:
        try:
            decoded = decode_base64_content(b64_block)
            if decoded:
                for line in decoded.splitlines()[:200]:
                    line = line.strip()
                    if len(line) > 20 and is_valid_config(line):
                        configs.add(line)
        except Exception:
            continue

    # Method 3: Line-by-line processing
    for line_num, line in enumerate(content.splitlines()):
        if line_num >= 3000:
            break

        line = line.strip()
        if len(line) > 20 and is_valid_config(line):
            configs.add(line)

        elif 50 < len(line) < 2000 and re.match(r'^[A-Za-z0-9+/=\s]+$', line):
            try:
                decoded_line = decode_base64_content(line)
                if decoded_line:
                    for sub_line in decoded_line.splitlines()[:100]:
                        sub_line = sub_line.strip()
                        if len(sub_line) > 20 and is_valid_config(sub_line):
                            configs.add(sub_line)
            except Exception:
                continue

    return configs

def fetch_from_static_sources(sources: List[str]) -> Set[str]:
    """Enhanced static source fetching."""
    all_configs = set()
    print(f"Fetching from {len(sources)} static sources...")

    def fetch_url_enhanced(url: str, retry_count: int = 0) -> Set[str]:
        if retry_count >= MAX_RETRIES:
            return set()

        try:
            time.sleep(random.uniform(0.5, 2.0))

            response = requests.get(
                url,
                headers=HEADERS,
                timeout=25,
                allow_redirects=True,
                verify=False
            )
            response.raise_for_status()

            content = response.text
            configs = extract_configs_from_content(content)

            if not configs and len(content) > 100:
                decoded_content = decode_base64_content(content)
                configs = extract_configs_from_content(decoded_content)

            if configs:
                print(f"  Found {len(configs)} configs from {url[:80]}...")

            return configs

        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429 and retry_count < MAX_RETRIES:
                wait_time = 45 + retry_count * 30
                print(f"  Rate limited {url[:50]}... waiting {wait_time}s")
                time.sleep(wait_time)
                return fetch_url_enhanced(url, retry_count + 1)
            return set()
        except Exception as e:
            print(f"  Failed {url[:50]}...: {type(e).__name__}")
            return set()

    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_url = {executor.submit(fetch_url_enhanced, url): url for url in sources}

        for future in as_completed(future_to_url, timeout=800):
            try:
                result = future.result(timeout=60)
                all_configs.update(result)
            except Exception as e:
                print(f"  Error in parallel fetch: {type(e).__name__}")
                continue

    return all_configs

def fetch_from_github_enhanced(pat: str, limit: int) -> Set[str]:
    """Enhanced GitHub fetching with multiple search strategies."""
    if not pat:
        print("WARNING: GitHub PAT not found. Skipping GitHub search.")
        return set()

    all_configs = set()
    processed_files = 0

    try:
        g = Github(auth=Auth.Token(pat), timeout=30)

        search_queries = [
            " OR ".join(list(ALL_PROTOCOLS)[:4]) + " extension:txt extension:md -user:mahdibland -user:barry-far -user:Surfboardv2ray",
            "vmess vless trojan shadowsocks extension:yaml extension:yml -user:mahdibland -user:barry-far",
            "subscription proxy v2ray clash sing-box extension:txt -user:mahdibland -user:barry-far",
            "hysteria2 tuic hy2 extension:json extension:conf -user:mahdibland -user:barry-far",
            "vless://wss vmess://wss trojan://tls -user:mahdibland -user:barry-far",
            "ss://Y2hhY2hhMjAtcG9seTEzMDU aes-128-gcm aes-256-gcm -user:mahdibland -user:barry-far"
        ]

        print(f"  Searching GitHub with {len(search_queries)} queries (limit: {limit})...")

        start_time = time.time()
        max_github_time = 1200  # 20 minutes max

        for query_idx, query in enumerate(search_queries):
            if time.time() - start_time > max_github_time or processed_files >= limit:
                break

            try:
                print(f"  Query {query_idx + 1}/{len(search_queries)}: Processing...")
                results = g.search_code(query, order='desc', sort='indexed', per_page=100)

                for content_file in results:
                    if processed_files >= limit or time.time() - start_time > max_github_time:
                        break

                    try:
                        time.sleep(random.uniform(0.2, 0.5))

                        file_content = content_file.content.decode('utf-8', 'ignore')
                        configs = extract_configs_from_content(file_content)

                        if configs:
                            all_configs.update(configs)
                            processed_files += 1

                            if processed_files % 50 == 0:
                                print(f"    Processed {processed_files} files, found {len(all_configs)} configs...")

                    except (UnknownObjectException, RateLimitExceededException) as e:
                        if isinstance(e, RateLimitExceededException):
                            print("  GitHub rate limit hit. Waiting 90s...")
                            time.sleep(90)
                        continue
                    except Exception:
                        continue

            except Exception as e:
                print(f"  Query {query_idx + 1} failed: {type(e).__name__}")
                continue

        print(f"  GitHub search completed: {len(all_configs)} configs from {processed_files} files")
        return all_configs

    except Exception as e:
        print(f"ERROR: GitHub operation failed: {type(e).__name__}")
        return set()

def test_protocol_connection(config: str) -> Optional[Tuple[str, int, str]]:
    """Enhanced connection testing with protocol-specific handling."""
    try:
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme.lower()

        if protocol == 'shadowsocks':
            protocol = 'ss'
        elif protocol == 'hysteria':
            protocol = 'hy2'

        hostname, port, is_tls, sni = None, None, False, None

        if protocol == 'vmess':
            try:
                decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
                hostname, port = decoded.get('add'), int(decoded.get('port', 0))
                is_tls = decoded.get('tls') in ['tls', 'xtls'] or decoded.get('security') in ['tls', 'xtls']
                sni = decoded.get('sni') or decoded.get('host') or hostname
            except:
                return None

        elif protocol in ['vless', 'trojan']:
            hostname, port = parsed_url.hostname, int(parsed_url.port or 0)
            query_params = parse_qs(parsed_url.query)
            is_tls = any(query_params.get('security', [''])[0] in ['tls', 'xtls'] for _ in [1]) or protocol == 'trojan'
            sni = query_params.get('sni', [hostname])[0] if query_params.get('sni') else hostname

        elif protocol == 'ss':
            if '@' in config:
                hostname, port = parsed_url.hostname, int(parsed_url.port or 0)
            else:
                try:
                    ss_part = config.replace("ss://", "")
                    if '@' in ss_part:
                        _, server_part = ss_part.split('@', 1)
                        if ':' in server_part:
                            hostname, port = server_part.split(':', 1)
                            port = int(port.split('/')[0].split('?')[0].split('#')[0])
                        else:
                            return None
                    else:
                        return None
                except:
                    return None

        elif protocol in SINGBOX_ONLY_PROTOCOLS:
            hostname, port = parsed_url.hostname, int(parsed_url.port or 0)
            query_params = parse_qs(parsed_url.query)
            is_tls = True
            sni = query_params.get('sni', [hostname])[0] if query_params.get('sni') else hostname

        else:
            return None

        if not all([hostname, port]) or port <= 0 or port > 65535:
            return None

        start_time = time.monotonic()

        if protocol in SINGBOX_ONLY_PROTOCOLS:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(TCP_TIMEOUT)
                    sock.connect((hostname, port))
            except Exception:
                return None
        else:
            try:
                with socket.create_connection((hostname, port), timeout=TCP_TIMEOUT) as sock:
                    if is_tls:
                        context = ssl.create_default_context()
                        context.check_hostname = False
                        context.verify_mode = ssl.CERT_NONE
                        context.set_ciphers('HIGH:!DH:!aNULL')

                        with context.wrap_socket(sock, server_hostname=sni or hostname) as ssock:
                            ssock.do_handshake()
            except Exception:
                return None

        latency = int((time.monotonic() - start_time) * 1000)

        if latency <= MAX_LATENCY_MS:
            return config, latency, protocol

        return None

    except Exception:
        return None

def balance_protocols(configs_with_info: List[Tuple[str, int, str]], target_total: int) -> List[str]:
    """Enhanced protocol balancing to ensure comprehensive coverage."""
    if not configs_with_info:
        return []

    protocol_groups = defaultdict(list)
    for config, latency, protocol in configs_with_info:
        protocol_groups[protocol].append((config, latency))

    for protocol in protocol_groups:
        protocol_groups[protocol].sort(key=lambda x: x[1])

    selected_configs = []
    used_configs = set()

    # Phase 1: Minimum representation for each protocol
    for protocol in ALL_PROTOCOLS:
        if protocol in protocol_groups:
            count = min(MIN_CONFIGS_PER_PROTOCOL, len(protocol_groups[protocol]))
            for config, latency in protocol_groups[protocol][:count]:
                if config not in used_configs:
                    selected_configs.append(config)
                    used_configs.add(config)

    # Phase 2: Fill remaining slots
    remaining_slots = target_total - len(selected_configs)

    if remaining_slots > 0:
        remaining_pool = []
        for protocol in protocol_groups:
            for config, latency in protocol_groups[protocol]:
                if config not in used_configs:
                    remaining_pool.append((config, latency, protocol))

        remaining_pool.sort(key=lambda x: x[1])

        protocol_counts = defaultdict(int)
        for config in selected_configs:
            proto = urlparse(config).scheme.lower()
            if proto == 'shadowsocks': proto = 'ss'
            elif proto == 'hysteria': proto = 'hy2'
            protocol_counts[proto] += 1

        for config, latency, protocol in remaining_pool:
            if len(selected_configs) >= target_total:
                break

            if protocol_counts[protocol] < MAX_CONFIGS_PER_PROTOCOL:
                selected_configs.append(config)
                used_configs.add(config)
                protocol_counts[protocol] += 1

    return selected_configs[:target_total]

def generate_enhanced_clash_yaml(configs: List[str]) -> Optional[str]:
    """Enhanced Clash YAML generator."""
    proxies = []
    proxy_names = []
    seen_proxies = set()

    for config in configs:
        try:
            proxy = parse_proxy_for_clash_enhanced(config)
            if proxy:
                proxy_id = f"{proxy['server']}:{proxy['port']}:{proxy.get('uuid', proxy.get('password', ''))}"

                if proxy_id not in seen_proxies:
                    proxies.append(proxy)
                    proxy_names.append(proxy['name'])
                    seen_proxies.add(proxy_id)

        except Exception:
            continue

    if not proxies:
        return None

    clash_config = {
        'proxies': proxies,
        'proxy-groups': [
            {
                'name': 'V2V-Auto',
                'type': 'url-test',
                'proxies': proxy_names,
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300,
                'tolerance': 50,
                'timeout': 5000
            },
            {
                'name': 'V2V-Select',
                'type': 'select',
                'proxies': ['V2V-Auto'] + proxy_names
            },
            {
                'name': 'V2V-Fallback',
                'type': 'fallback',
                'proxies': proxy_names,
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300,
                'timeout': 5000
            }
        ],
        'rules': [
            'DOMAIN-SUFFIX,local,DIRECT',
            'IP-CIDR,127.0.0.0/8,DIRECT',
            'IP-CIDR,172.16.0.0/12,DIRECT',
            'IP-CIDR,192.168.0.0/16,DIRECT',
            'IP-CIDR,10.0.0.0/8,DIRECT',
            'GEOIP,IR,DIRECT',
            'MATCH,V2V-Select'
        ]
    }

    class NoAliasDumper(yaml.Dumper):
        def ignore_aliases(self, data):
            return True

    return yaml.dump(clash_config, Dumper=NoAliasDumper, allow_unicode=True, sort_keys=False, indent=2)

def parse_proxy_for_clash_enhanced(config: str) -> Optional[Dict]:
    """Enhanced proxy parser for Clash."""
    try:
        parsed_url = urlparse(config)
        protocol = parsed_url.scheme.lower()

        if protocol == 'shadowsocks':
            protocol = 'ss'
        elif protocol == 'hysteria':
            protocol = 'hy2'

        fragment = parsed_url.fragment or f"V2V-{protocol.upper()}-{random.randint(1000, 9999)}"
        name = re.sub(r'[^\w\-_.]', '', fragment)[:MAX_NAME_LENGTH]
        if not name:
            name = f"V2V-{protocol.upper()}-{random.randint(1000, 9999)}"

        base_proxy = {
            'name': name,
            'server': parsed_url.hostname,
            'port': parsed_url.port,
            'skip-cert-verify': True
        }

        if protocol == 'vmess':
            try:
                decoded = json.loads(decode_base64_content(config.replace("vmess://", "")))
                vmess_proxy = {
                    **base_proxy,
                    'type': 'vmess',
                    'uuid': decoded.get('id'),
                    'alterId': int(decoded.get('aid', 0)),
                    'cipher': decoded.get('scy', 'auto'),
                    'tls': decoded.get('tls') == 'tls',
                    'network': decoded.get('net', 'tcp'),
                    'servername': decoded.get('sni') or decoded.get('host') or parsed_url.hostname
                }

                if decoded.get('net') == 'ws':
                    vmess_proxy['ws-opts'] = {
                        'path': decoded.get('path', '/'),
                        'headers': {'Host': decoded.get('host') or parsed_url.hostname}
                    }
                elif decoded.get('net') == 'h2':
                    vmess_proxy['h2-opts'] = {
                        'host': [decoded.get('host') or parsed_url.hostname],
                        'path': decoded.get('path', '/')
                    }
                elif decoded.get('net') == 'grpc':
                    vmess_proxy['grpc-opts'] = {
                        'service-name': decoded.get('path', '')
                    }

                return vmess_proxy
            except:
                return None

        elif protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            vless_proxy = {
                **base_proxy,
                'type': 'vless',
                'uuid': parsed_url.username,
                'tls': query_params.get('security', [''])[0] == 'tls',
                'network': query_params.get('type', ['tcp'])[0],
                'servername': query_params.get('sni', [parsed_url.hostname])[0]
            }

            net_type = query_params.get('type', ['tcp'])[0]
            if net_type == 'ws':
                vless_proxy['ws-opts'] = {
                    'path': query_params.get('path', ['/'])[0],
                    'headers': {'Host': query_params.get('host', [parsed_url.hostname])[0]}
                }
            elif net_type == 'grpc':
                vless_proxy['grpc-opts'] = {
                    'service-name': query_params.get('serviceName', [''])[0]
                }

            return vless_proxy

        elif protocol == 'trojan':
            return {
                **base_proxy,
                'type': 'trojan',
                'password': parsed_url.username,
                'sni': parse_qs(parsed_url.query).get('sni', [parsed_url.hostname])[0] if parsed_url.query else parsed_url.hostname
            }

        elif protocol == 'ss':
            try:
                if '@' in config:
                    auth_part = parsed_url.username
                    if ':' in base64.b64decode(auth_part + '===').decode('utf-8', 'ignore'):
                        method, password = base64.b64decode(auth_part + '===').decode('utf-8', 'ignore').split(':', 1)
                    else:
                        return None
                else:
                    ss_data = config.replace("ss://", "").split('@')[0]
                    decoded = decode_base64_content(ss_data)
                    if ':' not in decoded:
                        return None
                    method, password = decoded.split(':', 1)

                return {
                    **base_proxy,
                    'type': 'ss',
                    'cipher': method,
                    'password': password
                }
            except:
                return None

        # Note: Clash doesn't support hysteria2/tuic natively, so skip them
        return None

    except Exception:
        return None

def main():
    tested_configs: List[Tuple[str, int, str]] = [] # Explicitly define for safety
    try:
        print("--- 1. Loading Sources ---")
        try:
            with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
                sources_config = json.load(f)

            static_sources = sources_config.get("static", [])
            print(f"Loaded {len(static_sources)} static sources. GitHub limit: {GITHUB_SEARCH_LIMIT}")
        except Exception as e:
            print(f"FATAL: Cannot load {SOURCES_FILE}: {e}")
            return

        print("\n--- 2. Enhanced Config Fetching ---")
        all_configs = set()

        with ThreadPoolExecutor(max_workers=2) as executor:
            static_future = executor.submit(fetch_from_static_sources, static_sources)
            github_future = executor.submit(fetch_from_github_enhanced, GITHUB_PAT, GITHUB_SEARCH_LIMIT)

            try:
                static_configs = static_future.result(timeout=1200)  # 20 minutes
                github_configs = github_future.result(timeout=1500)  # 25 minutes

                all_configs.update(static_configs)
                all_configs.update(github_configs)

                print(f"Static sources: {len(static_configs)} configs")
                print(f"GitHub sources: {len(github_configs)} configs")

            except FutureTimeoutError:
                print("Timeout during fetching, using partial results...")
                if static_future.done():
                    all_configs.update(static_future.result())
                if github_future.done():
                    all_configs.update(github_future.result())

        if not all_configs:
            print("FATAL: No configs found!")
            return

        print(f"Total unique configs collected: {len(all_configs)}")

        print("\n--- 3. Enhanced Config Testing ---")
        configs_to_test = list(all_configs)[:MAX_CONFIGS_TO_TEST]

        print(f"Testing {len(configs_to_test)} configs...")

        with ThreadPoolExecutor(max_workers=MAX_TEST_WORKERS) as executor:
            futures = {executor.submit(test_protocol_connection, config): config for config in configs_to_test}

            completed = 0
            for future in as_completed(futures, timeout=1800):  # 30 minutes
                try:
                    result = future.result(timeout=10)
                    if result:
                        tested_configs.append(result)

                    completed += 1
                    if completed % 500 == 0:
                        print(f"    Tested {completed}/{len(configs_to_test)} (found {len(tested_configs)} working)")

                except Exception:
                    pass

        if not tested_configs:
            print("FATAL: No working configs found!")
            return

        print(f"Found {len(tested_configs)} working configs")

        print("\n--- 4. Enhanced Protocol Selection ---")

        xray_configs = [(cfg, lat, proto) for cfg, lat, proto in tested_configs if proto in XRAY_PROTOCOLS]
        singbox_configs = [(cfg, lat, proto) for cfg, lat, proto in tested_configs if proto in ALL_PROTOCOLS]

        target_xray = min(5000, max(2000, len(xray_configs)))
        target_singbox = min(5000, max(2000, len(singbox_configs)))

        selected_xray = balance_protocols(xray_configs, target_xray)
        selected_singbox = balance_protocols(singbox_configs, target_singbox)

        print(f"Selected {len(selected_xray)} Xray configs, {len(selected_singbox)} Sing-box configs")

        def group_by_protocol(configs: List[str]) -> Dict[str, List[str]]:
            grouped = defaultdict(list)
            for config in configs:
                protocol = urlparse(config).scheme.lower()
                if protocol == 'shadowsocks':
                    protocol = 'ss'
                elif protocol == 'hysteria':
                    protocol = 'hy2'
                grouped[protocol].append(config)
            return dict(grouped)

        xray_grouped = group_by_protocol(selected_xray)
        singbox_grouped = group_by_protocol(selected_singbox)

        # Ensure all protocols have entries (even empty)
        for protocol in XRAY_PROTOCOLS:
            if protocol not in xray_grouped:
                xray_grouped[protocol] = []

        for protocol in ALL_PROTOCOLS:
            if protocol not in singbox_grouped:
                singbox_grouped[protocol] = []

        final_output = {
            "xray": xray_grouped,
            "singbox": singbox_grouped
        }

        print("\nProtocol Distribution:")
        print("Xray:")
        for proto, configs in xray_grouped.items():
            print(f"  {proto}: {len(configs)} configs")
        print("Sing-box:")
        for proto, configs in singbox_grouped.items():
            print(f"  {proto}: {len(configs)} configs")

        print("\n--- 5. Writing Enhanced Output Files ---")

        with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
            json.dump(final_output, f, indent=2, ensure_ascii=False)
        print(f"Wrote {OUTPUT_JSON_FILE}")

        clash_yaml = generate_enhanced_clash_yaml(selected_xray)
        if clash_yaml:
            with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
                f.write(clash_yaml)
            print(f"Wrote {OUTPUT_CLASH_FILE}")
        else:
            print("Could not generate Clash YAML - creating minimal version")
            with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
                f.write("proxies: []\nproxy-groups: []\nrules: []\n")

        with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
            f.write(str(int(time.time())))
        print(f"Updated {CACHE_VERSION_FILE}")

        print("\n=== ENHANCED SCRAPING COMPLETED SUCCESSFULLY ===")

        total_xray = sum(len(v) for v in xray_grouped.values())
        total_singbox = sum(len(v) for v in singbox_grouped.values())
        print(f"Final Results: Xray={total_xray}, Sing-box={total_singbox}, Total={total_xray + total_singbox}")

        empty_xray = [p for p, configs in xray_grouped.items() if not configs]
        empty_singbox = [p for p, configs in singbox_grouped.items() if not configs]

        if empty_xray:
            print(f"WARNING: Empty Xray protocols: {empty_xray}")
        if empty_singbox:
            print(f"WARNING: Empty Sing-box protocols: {empty_singbox}")

        if not empty_xray and not empty_singbox:
            print("SUCCESS: All protocols have configurations!")

    except Exception as e:
        print(f"FATAL ERROR in main(): {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        signal.alarm(0)

if __name__ == "__main__":
    main()
