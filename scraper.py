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
import logging
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qsl, unquote, quote
from collections import defaultdict
from typing import Set, List, Dict, Optional, Tuple

# اضافه کردن logging برای trace بهتر اجرای برنامه
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# =================================================================================
# === CONFIGURATION ===
# =================================================================================

# بهبود: اضافه کردن configuration class برای سازمان بهتر
class Config:
    SOURCES_FILE = "sources.json"
    OUTPUT_DIR = "configs"
    CACHE_VERSION_FILE = "cache_version.txt"
    OUTPUT_CLASH_FILE_NAME = "clash_subscription.yaml"
    VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
    HEADERS = {
        'User-Agent': 'V2V-Scraper/improved-v9.0',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Expires': '0'
    }
    SUBSCRIPTION_UUIDS = {
        'xray_top20': 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7',
        'xray_all': 'f7e8d9c0-b1a2-4567-8901-234567890abc',
        'singbox_top20': '9876543a-bcde-4f01-2345-6789abcdef01',
        'singbox_all': '12345678-9abc-4def-0123-456789abcdef'
    }
    GITHUB_PAT = os.environ.get('GH_PAT')
    GITHUB_SEARCH_LIMIT = 75
    GITHUB_FRESHNESS_HOURS = 240
    GITHUB_SEARCH_QUERIES = [
        'v2ray subscription', 'vless subscription', 'proxy subscription'
    ]
    MAX_CONFIGS_TO_TEST = 3000
    MAX_PING_THRESHOLD = 8000
    TARGET_CONFIGS_PER_CORE = 500
    REQUEST_TIMEOUT = 10
    TCP_TEST_TIMEOUT = 8
    MAX_NAME_LENGTH = 40
    MAX_RAW_CONFIGS = 5000
    PROTOCOL_QUOTAS = {'vless': 0.35, 'vmess': 0.35, 'trojan': 0.15, 'ss': 0.15}

if Config.GITHUB_PAT:
    Config.HEADERS['Authorization'] = f'token {Config.GITHUB_PAT}'

# =================================================================================
# === HELPER & PARSING FUNCTIONS ===
# =================================================================================

def decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        for encoding in ['latin1', 'ascii', 'utf-16', 'cp1252']:
            try:
                return base64.b64decode(padded_str).decode(encoding)
            except Exception:
                continue
        logging.warning("Failed to decode Base64 with any encoding")
        return ""

def is_valid_config_format(config_str: str) -> bool:
    try:
        parsed = urlparse(config_str)
        return (
            parsed.scheme in [p.replace('://', '') for p in Config.VALID_PREFIXES] and
            parsed.hostname and
            len(config_str) > 20 and
            '://' in config_str and
            not any(char in config_str for char in ['<', '>', '&'])
        )
    except Exception:
        return False

def shorten_config_name(config_str: str) -> str:
    try:
        if config_str.startswith('vmess://'):
            encoded_part = config_str[8:]
            try:
                vmess_data = json.loads(decode_padded_b64(encoded_part))
                name = vmess_data.get('ps', '')
                if len(name) > Config.MAX_NAME_LENGTH:
                    vmess_data['ps'] = name[:Config.MAX_NAME_LENGTH-3] + '...'
                    new_json_str = json.dumps(vmess_data, separators=(',', ':'))
                    new_encoded_part = base64.b64encode(new_json_str.encode('utf-8')).decode('utf-8').replace('=', '')
                    return 'vmess://' + new_encoded_part
            except Exception as e:
                logging.debug(f"Error shortening VMess name: {e}")
        else:
            if '#' in config_str:
                base_part, name_part = config_str.split('#', 1)
                decoded_name = unquote(name_part)
                if len(decoded_name) > Config.MAX_NAME_LENGTH:
                    shortened_name = decoded_name[:Config.MAX_NAME_LENGTH-3] + '...'
                    return base_part + '#' + quote(shortened_name)
    except Exception as e:
        logging.debug(f"Error shortening config name: {e}")
    return config_str

def is_potential_base64(s: str) -> bool:
    if not isinstance(s, str):
        return False
    # Check if length is a multiple of 4
    if len(s.replace('\n', '').replace(' ', '')) % 4 != 0:
        return False
    # Heuristic: Base64 strings are usually longer than 16 chars
    if len(s.strip()) < 16:
        return False
    # Check for characters that don't belong in Base64
    if not re.fullmatch(r'[A-Za-z0-9+/=]+', s.replace('\n', '').replace(' ', '')):
        return False
    return True

def parse_subscription_content(content: str) -> Set[str]:
    configs = set()
    original_content = content.strip()
    
    content_variants = {original_content}
    
    # ۱. تلاش برای decode Base64 پیشرفته (شامل scrambled)
    if is_potential_base64(original_content):
        for encoding_attempt in [original_content, original_content.replace('\n', ''), original_content.replace(' ', ''), original_content[::-1]]:
            try:
                decoded = decode_padded_b64(encoding_attempt)
                if decoded and len(decoded) > 10 and decoded != encoding_attempt:
                    content_variants.add(decoded)
            except Exception:
                continue
    
    # ۲. تلاش برای parse JSON arrays
    try:
        json_data = json.loads(original_content)
        if isinstance(json_data, list):
            content_variants.add('\n'.join(str(item) for item in json_data))
        elif isinstance(json_data, dict):
            for key, value in json_data.items():
                if isinstance(value, list):
                    content_variants.add('\n'.join(str(item) for item in value))
                elif isinstance(value, str) and '://' in value:
                    content_variants.add(value)
                elif isinstance(value, dict):
                    for sub_key, sub_value in value.items():
                        if isinstance(sub_value, str) and '://' in sub_value:
                            content_variants.add(sub_value)
    except (json.JSONDecodeError, TypeError):
        logging.debug(f"JSON parse failed for content.")
    
    # ۳. تلاش برای parse YAML
    try:
        yaml_data = yaml.safe_load(original_content)
        if isinstance(yaml_data, dict):
            if 'proxies' in yaml_data and isinstance(yaml_data['proxies'], list):
                for proxy in yaml_data['proxies']:
                    if isinstance(proxy, dict) and proxy.get('server'):
                        pass # Don't parse complex objects, they are handled by other parsers
            for key, value in yaml_data.items():
                if isinstance(value, list):
                    content_variants.add('\n'.join(str(item) for item in value))
                elif isinstance(value, str) and '://' in value:
                    content_variants.add(value)
    except (yaml.YAMLError, TypeError):
        logging.debug(f"YAML parse failed for content.")
    
    # ۴. پاک‌سازی HTML/tags
    if '<' in original_content and '>' in original_content:
        try:
            html_cleaned = re.sub(r'<[^>]+>', '', original_content)
            html_cleaned = html_cleaned.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
            content_variants.add(html_cleaned)
        except Exception as e:
            logging.debug(f"HTML cleanup failed: {e}")
    
    # ۵. URL decode
    try:
        url_decoded = unquote(original_content)
        if url_decoded != original_content:
            content_variants.add(url_decoded)
    except Exception as e:
        logging.debug(f"URL decode failed: {e}")
    
    # ۶. Handling binary
    if isinstance(original_content, bytes):
        try:
            content_variants.add(original_content.decode('utf-8'))
        except UnicodeDecodeError:
            pass
    
    # ۷. جستجو در تمام variant ها با regex قوی‌تر
    for variant in content_variants:
        if not variant: continue
        
        for line in str(variant).split('\n'):
            line = line.strip()
            if any(line.startswith(prefix) for prefix in Config.VALID_PREFIXES):
                if is_valid_config_format(line):
                    configs.add(line)
    
    return configs

def fetch_and_parse_url(source: Dict) -> Set[str]:
    try:
        response = requests.get(source['url'], timeout=Config.REQUEST_TIMEOUT, headers=Config.HEADERS, verify=True)
        response.raise_for_status()
        logging.info(f"Successfully fetched from {source['url']}")
        return parse_subscription_content(response.text)
    except requests.Timeout as e:
        logging.warning(f"Timeout fetching {source['url']}: {e}")
        return set()
    except ssl.SSLError as e:
        logging.error(f"SSL error for {source['url']}: {e}")
        return set()
    except requests.RequestException as e:
        logging.error(f"Request error for {source['url']}: {e}")
        return set()
    except Exception as e:
        logging.error(f"Unexpected error fetching {source['url']}: {e}")
        return set()

def get_static_sources() -> List[Dict]:
    try:
        with open(Config.SOURCES_FILE, 'r', encoding='utf-8') as f:
            urls = json.load(f).get("static", [])
            return [{'url': url, 'updated_at': datetime(2000, 1, 1, tzinfo=timezone.utc)} for url in urls]
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logging.error(f"Error loading static sources: {e}")
        return []

def discover_dynamic_sources() -> List[Dict]:
    if not Config.GITHUB_PAT:
        logging.error("GITHUB_PAT not set, skipping dynamic sources")
        return []
    try:
        from github import Github, Auth, GithubException
        g = Github(auth=Auth.Token(Config.GITHUB_PAT), timeout=20)
    except ImportError as e:
        logging.error(f"PyGithub import failed: {e}")
        return []
    except Exception as e:
        logging.error(f"GitHub auth failed: {e}")
        return []
    
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=Config.GITHUB_FRESHNESS_HOURS)
    dynamic_sources = set()
    backoff_time = 1
    
    for query in Config.GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} lang:yaml OR lang:json', sort='updated', order='desc')
            for repo in repos:
                if len(dynamic_sources) >= Config.GITHUB_SEARCH_LIMIT or repo.updated_at < freshness_threshold:
                    break
                try:
                    for content_file in repo.get_contents(""):
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md', '.yaml', '.json')):
                            dynamic_sources.add((content_file.download_url, repo.updated_at))
                except GithubException as e:
                    if e.status == 403:
                        logging.warning("GitHub rate limit hit, backing off...")
                        time.sleep(backoff_time)
                        backoff_time *= 2
                    else:
                        logging.debug(f"GitHub content error: {e}")
        except GithubException as e:
            logging.error(f"GitHub search error for {query}: {e}")
        except Exception as e:
            logging.error(f"Unexpected GitHub error: {e}")
    
    return [{'url': url, 'updated_at': updated_at} for url, updated_at in dynamic_sources]

def test_config_advanced(config_str: str) -> Optional[Dict]:
    try:
        host, port, sni, is_tls = None, None, None, False
        parsed_url = urlparse(config_str)
        
        if parsed_url.scheme == 'vmess':
            vmess_data = json.loads(decode_padded_b64(config_str.replace("vmess://", "")))
            host, port, is_tls, sni = vmess_data.get('add'), int(vmess_data.get('port', 443)), vmess_data.get('tls') == 'tls', vmess_data.get('sni', host)
        else:
            host, port = parsed_url.hostname, parsed_url.port
            params = dict(parse_qsl(parsed_url.query))
            is_tls = params.get('security') == 'tls' or parsed_url.scheme == 'trojan'
            sni = params.get('sni', host)
        
        if not host or not port: return None
        addr_infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        
        for family, socktype, proto, _, sockaddr in addr_infos:
            sock = None
            try:
                sock = socket.socket(family, socktype, proto)
                sock.settimeout(Config.TCP_TEST_TIMEOUT)
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
                ping = int((end_time - start_time) * 1000)
                if ping < Config.MAX_PING_THRESHOLD:
                    logging.debug(f"Config {config_str[:30]}... tested successfully with ping {ping}ms")
                    return {'config_str': config_str, 'ping': ping}
                return None
            except (socket.timeout, socket.error, ssl.SSLError, ConnectionRefusedError, OSError) as e:
                logging.debug(f"Test failed for {host}:{port}: {e}")
                continue
            finally:
                if sock: sock.close()
    except Exception as e:
        logging.debug(f"Error in advanced test for {config_str[:30]}...: {e}")
    return None

def main():
    start_time = time.time()
    logging.info("Starting V2V scraper script")
    
    sources = get_static_sources()
    sources.extend(discover_dynamic_sources())
    logging.info(f"Found {len(sources)} unique sources.")
    
    all_configs_from_sources = set()
    for source in sources:
        configs = fetch_and_parse_url(source)
        logging.info(f"Fetched {len(configs)} configs from {source['url']}")
        all_configs_from_sources.update(configs)
        if len(all_configs_from_sources) > Config.MAX_RAW_CONFIGS:
            logging.warning(f"Exceeding MAX_RAW_CONFIGS limit. Stopping at {len(all_configs_from_sources)}.")
            break
            
    logging.info(f"Total raw configs: {len(all_configs_from_sources)}")

    tested_configs = []
    if all_configs_from_sources:
        with ThreadPoolExecutor(max_workers=os.cpu_count() * 2) as executor:
            future_to_config = {executor.submit(test_config_advanced, config): config for config in all_configs_from_sources}
            for future in future_to_config:
                result = future.result()
                if result: tested_configs.append(result)
                    
    logging.info(f"Total live configs: {len(tested_configs)}")
    
    xray_configs_raw = []
    singbox_configs_raw = []
    for config in tested_configs:
        config_str = config['config_str']
        
        if any(config_str.startswith(p) for p in ['vless://', 'vmess://', 'trojan://']):
            xray_configs_raw.append(config_str)
            singbox_configs_raw.append(config_str)
        elif any(config_str.startswith(p) for p in ['ss://', 'hysteria2://', 'hy2://', 'tuic://']):
            singbox_configs_raw.append(config_str)
            
    xray_configs = select_best_configs(xray_configs_raw)
    singbox_configs = select_best_configs(singbox_configs_raw)

    logging.info(f"Final Xray configs: {len(xray_configs)}")
    logging.info(f"Final Singbox configs: {len(singbox_configs)}")

    os.makedirs(Config.OUTPUT_DIR, exist_ok=True)
    
    timestamp = str(int(datetime.now().timestamp()))
    
    with open(os.path.join(Config.OUTPUT_DIR, f"all_live_configs_{timestamp}.json"), 'w') as f:
        json.dump({"xray": xray_configs, "singbox": singbox_configs}, f, indent=2)
    logging.info(f"Generated all_live_configs_{timestamp}.json")
    
    with open(os.path.join(Config.OUTPUT_DIR, Config.CACHE_VERSION_FILE), 'w') as f:
        f.write(timestamp)
    logging.info("Generated cache_version.txt")
    
    create_subscription_files(xray_configs, singbox_configs)
    
    clash_configs = [parse_config_for_clash(c) for c in xray_configs]
    clash_configs = [c for c in clash_configs if c]
    create_clash_yaml(clash_configs, os.path.join(Config.OUTPUT_DIR, Config.OUTPUT_CLASH_FILE_NAME))
    
    elapsed_time = time.time() - start_time
    logging.info(f"Script completed successfully in {elapsed_time:.2f} seconds")

def select_best_configs(configs: List[str]) -> List[str]:
    protocol_counts = defaultdict(int)
    final_configs = []
    
    grouped_configs = defaultdict(list)
    for config_str in configs:
        protocol = urlparse(config_str).scheme.lower()
        if protocol in Config.PROTOCOL_QUOTAS:
            grouped_configs[protocol].append(config_str)
        else:
            final_configs.append(config_str)
            
    total_configs = len(configs)
    if total_configs > 0:
        for protocol, quota in Config.PROTOCOL_QUOTAS.items():
            limit = int(total_configs * quota)
            final_configs.extend(grouped_configs[protocol][:limit])
            
    if len(final_configs) < Config.TARGET_CONFIGS_PER_CORE:
        remaining = list(set(configs) - set(final_configs))
        final_configs.extend(remaining[:Config.TARGET_CONFIGS_PER_CORE - len(final_configs)])
        
    return final_configs[:Config.TARGET_CONFIGS_PER_CORE]

def create_clash_yaml(configs: List[Dict], filename: str):
    logging.info(f"Generating Clash YAML with {len(configs)} configs")

    unique_proxies = []
    seen = set()
    for proxy in configs:
        key = f"{proxy['server']}:{proxy['port']}"
        if key not in seen:
            seen.add(key)
            final_name = proxy['name']
            counter = 1
            while any(p['name'] == final_name for p in unique_proxies):
                final_name = f"{proxy['name'].split('_')[0]}_{counter}"
                counter += 1
            proxy['name'] = final_name
            unique_proxies.append(proxy)
    
    clash_config = {
        'port': 7890,
        'socks-port': 7891,
        'allow-lan': True,
        'mode': 'rule',
        'log-level': 'info',
        'external-controller': '127.0.0.1:9090',
        'proxies': unique_proxies,
        'proxy-groups': [
            {
                'name': 'PROXY',
                'type': 'select',
                'proxies': ['AUTO'] + [p['name'] for p in unique_proxies]
            },
            {
                'name': 'AUTO',
                'type': 'url-test',
                'proxies': [p['name'] for p in unique_proxies],
                'url': 'http://www.gstatic.com/generate_204',
                'interval': 300
            }
        ],
        'rules': [
            'DOMAIN-SUFFIX,local,DIRECT',
            'IP-CIDR,127.0.0.0/8,DIRECT',
            'IP-CIDR,172.16.0.0/12,DIRECT',
            'IP-CIDR,192.168.0.0/16,DIRECT',
            'IP-CIDR,10.0.0.0/8,DIRECT',
            'MATCH,PROXY'
        ]
    }
    
    try:
        with open(filename, 'w', encoding='utf-8') as f:
            yaml.dump(clash_config, f, indent=2, sort_keys=False, allow_unicode=True)
        logging.info(f"Clash YAML file generated: {filename}")
    except Exception as e:
        logging.error(f"Failed to generate Clash YAML: {e}")

def parse_config_for_clash(config_str: str) -> Optional[Dict]:
    try:
        if 'reality' in config_str:
            return None
        
        url = urlparse(config_str)
        params = dict(parse_qsl(url.query))
        
        proxy_name = unquote(config_str.split('#')[-1]) if '#' in config_str else url.hostname
        proxy = {'name': proxy_name[:Config.MAX_NAME_LENGTH], 'skip-cert-verify': True}
        
        if url.scheme == 'vmess':
            d = json.loads(base64.b64decode(url.netloc + '==').decode('utf-8'))
            proxy.update({
                'type': 'vmess', 'server': d['add'], 'port': int(d['port']), 'uuid': d['id'],
                'alterId': int(d.get('aid', 0)), 'cipher': d.get('scy', 'auto'),
                'tls': d.get('tls') == 'tls', 'network': d.get('net', 'tcp')
            })
            if proxy['tls']: proxy['servername'] = d.get('sni', proxy['server'])
            if proxy['network'] == 'ws': proxy['ws-opts'] = {'path': d.get('path', '/'), 'headers': {'Host': d.get('host', proxy['server'])}}
            
        elif url.scheme == 'vless':
            proxy.update({
                'type': 'vless', 'server': url.hostname, 'port': int(url.port), 'uuid': url.username,
                'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp')
            })
            if proxy['tls']: proxy['servername'] = params.get('sni', url.hostname)
            if proxy['network'] == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}

        elif url.scheme == 'trojan':
            proxy.update({
                'type': 'trojan', 'server': url.hostname, 'port': int(url.port), 'password': url.username
            })
            if params.get('sni'): proxy['sni'] = params.get('sni')

        elif url.scheme == 'ss':
            try:
                decoded = base64.b64decode(url.username + '==').decode('utf-8')
                [cipher, password] = decoded.split(':', 1)
                proxy.update({'type': 'ss', 'server': url.hostname, 'port': int(url.port), 'cipher': cipher, 'password': password})
            except:
                return None
        else:
            return None
            
        return proxy
    except Exception as e:
        logging.error(f"Failed to parse config for Clash: {e}")
        return None

def create_subscription_files(xray_configs: List[str], singbox_configs: List[str]):
    logging.info("Generating subscription files: Xray %d, Singbox %d", len(xray_configs), len(singbox_configs))
    sub_files_data = {
        Config.SUBSCRIPTION_UUIDS['xray_all']: "\n".join(xray_configs),
        Config.SUBSCRIPTION_UUIDS['xray_top20']: "\n".join(xray_configs[:20]),
        Config.SUBSCRIPTION_UUIDS['singbox_all']: "\n".join(singbox_configs),
        Config.SUBSCRIPTION_UUIDS['singbox_top20']: "\n".join(singbox_configs[:20]),
    }
    
    for uuid, content in sub_files_data.items():
        with open(os.path.join(Config.OUTPUT_DIR, f"sub_{uuid}.txt"), 'w', encoding='utf-8') as f:
            f.write(content)
    
    logging.info("Subscription files generated.")

if __name__ == "__main__":
    main()
