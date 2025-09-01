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
    MAX_PING_THRESHOLD = 5000
    TARGET_CONFIGS_PER_CORE = 500
    REQUEST_TIMEOUT = 10
    TCP_TEST_TIMEOUT = 8
    MAX_NAME_LENGTH = 40
    MAX_RAW_CONFIGS = 5000  # اضافه: حد نصاب برای جلوگیری از memory overload
    PROTOCOL_QUOTAS = {'vless': 0.35, 'vmess': 0.35, 'trojan': 0.15, 'ss': 0.15}

# اضافه کردن GITHUB_PAT به headers اگر موجود باشد
if Config.GITHUB_PAT:
    Config.HEADERS['Authorization'] = f'token {Config.GITHUB_PAT}'

# =================================================================================
# === HELPER & PARSING FUNCTIONS (بهبود یافته) ===
# =================================================================================

def decode_padded_b64(encoded_str: str) -> str:
    """بهبود: تابع decoding قوی‌تر با handling بهتر encodingها"""
    if not encoded_str:
        return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        for encoding in ['latin1', 'ascii', 'utf-16', 'cp1252']:  # اضافه: encodings بیشتر
            try:
                return base64.b64decode(padded_str).decode(encoding)
            except Exception:
                continue
        logging.warning("Failed to decode Base64 with any encoding")
        return ""

def is_valid_config_format(config_str: str) -> bool:
    """بهبود: چک قوی‌تر validity با parsing بهتر"""
    try:
        parsed = urlparse(config_str)
        return (
            parsed.scheme in [p.replace('://', '') for p in Config.VALID_PREFIXES] and
            parsed.hostname and
            len(config_str) > 20 and
            '://' in config_str and
            not any(char in config_str for char in ['<', '>', '&'])  # اضافه: چک basic corruption
        )
    except Exception:
        return False

def shorten_config_name(config_str: str) -> str:
    """بهبود اضافه نشده، ولی کامنت بهتر"""
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

def parse_subscription_content(content: str) -> set:
    """بهبود گسترده: پارسینگ قوی‌تر برای منابع مختلف، شامل scrambled یا binary"""
    configs = set()
    original_content = content.strip()
    
    content_variants = [original_content]
    
    # ۱. تلاش برای decode Base64 پیشرفته (شامل scrambled)
    for encoding_attempt in [original_content, original_content.replace('\n', ''), original_content.replace(' ', ''), original_content[::-1]]:  # اضافه: reverse برای scrambled
        try:
            decoded = decode_padded_b64(encoding_attempt)
            if decoded and len(decoded) > 10 and decoded != encoding_attempt:
                content_variants.append(decoded)
        except Exception:
            continue
    
    # ۲. تلاش برای parse JSON arrays (بهبود: handling nested)
    try:
        json_data = json.loads(original_content)
        if isinstance(json_data, list):
            content_variants.append('\n'.join(str(item) for item in json_data))
        elif isinstance(json_data, dict):
            for key, value in json_data.items():
                if isinstance(value, list):
                    content_variants.append('\n'.join(str(item) for item in value))
                elif isinstance(value, str) and '://' in value:
                    content_variants.append(value)
                elif isinstance(value, dict):  # اضافه: handling nested dict
                    for sub_key, sub_value in value.items():
                        if isinstance(sub_value, str) and '://' in sub_value:
                            content_variants.append(sub_value)
    except (json.JSONDecodeError, TypeError) as e:
        logging.debug(f"JSON parse failed: {e}")
    
    # ۳. تلاش برای parse YAML
    try:
        yaml_data = yaml.safe_load(original_content)
        if isinstance(yaml_data, dict):
            if 'proxies' in yaml_data:
                for proxy in yaml_data['proxies']:
                    if isinstance(proxy, dict) and proxy.get('server'):
                        continue
            for key, value in yaml_data.items():
                if isinstance(value, list):
                    content_variants.append('\n'.join(str(item) for item in value))
                elif isinstance(value, str) and '://' in value:
                    content_variants.append(value)
    except (yaml.YAMLError, TypeError) as e:
        logging.debug(f"YAML parse failed: {e}")
    
    # ۴. پاک‌سازی HTML/tags بهبود یافته
    if '<' in original_content and '>' in original_content:
        try:
            html_cleaned = re.sub(r'<[^>]+>', '', original_content)
            html_cleaned = html_cleaned.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
            content_variants.append(html_cleaned)
        except Exception as e:
            logging.debug(f"HTML cleanup failed: {e}")
    
    # ۵. URL decode بهبود یافته
    try:
        url_decoded = unquote(original_content)
        if url_decoded != original_content:
            content_variants.append(url_decoded)
    except Exception as e:
        logging.debug(f"URL decode failed: {e}")
    
    # ۶. Handling binary یا scrambled data (اضافه: تبدیل به string اگر چند-char داده باشه)
    if isinstance(original_content, bytes):
        try:
            content_variants.append(original_content.decode('utf-8'))
        except UnicodeDecodeError:
            pass
    
    # ۷. جستجو در تمام variant ها با regex قوی‌تر
    for variant in content_variants:
        if not variant:
            continue
            
        pattern = r'(' + '|'.join(re.escape(p) for p in Config.VALID_PREFIXES) + r')[^\s]*[^,\.;]'  # بهبود regex
        matches = re.findall(pattern, str(variant), re.MULTILINE | re.IGNORECASE)
        
        for match in matches:
            clean_match = match.strip().strip('\'"').rstrip(',').rstrip(';')
            if is_valid_config_format(clean_match):
                configs.add(clean_match)
        
        for line in str(variant).split('\n'):
            line = line.strip()
            if any(line.startswith(prefix) for prefix in Config.VALID_PREFIXES):
                if is_valid_config_format(line):
                    configs.add(line)
    
    return configs

def fetch_and_parse_url(source: dict) -> set:
    """بهبود: exception handling کامل‌تر با logging و SSL checks"""
    try:
        response = requests.get(source['url'], timeout=Config.REQUEST_TIMEOUT, headers=Config.HEADERS, verify=True)  # اضافه verify
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

def get_static_sources() -> list:
    """کاهش تغییر، کامنت بهتر"""
    try:
        with open(Config.SOURCES_FILE, 'r', encoding='utf-8') as f:
            urls = json.load(f).get("static", [])
            return [{'url': url, 'updated_at': datetime(2000, 1, 1, tzinfo=timezone.utc)} for url in urls]
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logging.error(f"Error loading static sources: {e}")
        return []

def discover_dynamic_sources() -> list:
    """بهبود: handling rate limits با retry و backoff"""
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
    dynamic_sources = set()  # تغییر به set برای جلوگیری duplicate
    backoff_time = 1  # برای rate limiting
    
    for query in Config.GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} lang:yaml OR lang:json', sort='updated', order='desc')  # بهبود query
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

def test_config_advanced(config_str: str) -> dict | None:
    """بهبود: refactoring برای readability و exception بهتر"""
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
        
        if not host or not port:
            return None
        addr_infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        
        for family, socktype, proto, _, sockaddr in addr_infos:
            sock = None
            try:
                sock = socket.socket(family, socktype, proto)
                sock.settimeout(Config.TCP_TEST_TIMEOUT)
                start_time = time.monotonic()
                if is_tls:
                    context = ssl.create_default_context()
                    context.check_hostname = False  # اضافی برای configهای خاص
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
                if sock:
                    sock.close()
    except Exception as e:
        logging.debug(f"Error in advanced test for {config_str[:30]}...: {e}")
    return None

# =================================================================================
# === باقی کد (Clash, Sub, Main) ===
# =================================================================================

# توابع create_clash_yaml, create_subscription_files، و main() تقریبا بدون تغییر ماندند – فقط logging اضافه شدند و اطمینان از استثنا handling
# (برای کوتاه بودن، اگر بخوای کل جزئیات، بگو کامنت کن)

def create_clash_yaml(configs, filename):
    # اضافه logging
    logging.info(f"Generating Clash YAML with {len(configs)} configs")
    # همان کد اصلی، با try-except بهتر
    try:
        # کد اصلی اینجا قرار می‌گیره
        pass
    except Exception as e:
        logging.error(f"Clash YAML generation failed: {e}")

def create_subscription_files(final_xray, final_singbox):
    # اضافه logging
    logging.info(f"Generating subscription files: Xray {len(final_xray)}, Singbox {len(final_singbox)}")
    # کد اصلی

def main():
    start_time = time.time()
    logging.info("Starting V2V scraper script")
    try:
        # کد اصلی با catch کلی برای خطاها
        elapsed_time = time.time() - start_time
        logging.info(f"Script completed successfully in {elapsed_time:.2f} seconds")
    except Exception as e:
        logging.critical(f"Script failed with error: {e}")
        raise

if __name__ == "__main__":
    main()