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
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qsl, unquote, quote
from collections import defaultdict
from github import Github, Auth, GithubException

# =================================================================================
# === CONFIGURATION ===
# =================================================================================

SOURCES_FILE = "sources.json"
OUTPUT_DIR = "." # تغییر شده: فایل‌ها در ریشه پروژه قرار می‌گیرند
CACHE_VERSION_FILE = "cache_version.txt"
OUTPUT_CLASH_FILE_NAME = "clash_subscription.yaml"
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': 'V2V-Scraper/v8.0-Timestamped',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0'
}

GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 75
GITHUB_FRESHNESS_HOURS = 240
GITHUB_SEARCH_QUERIES = [
    'v2ray subscription', 'vless subscription', 'proxy subscription'
]

MAX_CONFIGS_TO_TEST = 3000
MAX_PING_THRESHOLD = 5000 # آپدیت شد
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10
TCP_TEST_TIMEOUT = 8 # آپدیت شد
MAX_NAME_LENGTH = 40

# آپدیت شد
PROTOCOL_QUOTAS = { 'vless': 0.35, 'vmess': 0.35, 'trojan': 0.15, 'ss': 0.15 }

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# =================================================================================
# === HELPER & PARSING FUNCTIONS ===
# =================================================================================

def _decode_padded_b64(encoded_str):
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

def _is_valid_config_format(config_str):
    try:
        parsed = urlparse(config_str)
        return (parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] and parsed.hostname and len(config_str) > 20 and '://' in config_str)
    except Exception: return False

def shorten_config_name(config_str):
    try:
        if config_str.startswith('vmess://'):
            encoded_part = config_str[8:]
            try:
                vmess_data = json.loads(_decode_padded_b64(encoded_part))
                name = vmess_data.get('ps', '')
                if len(name) > MAX_NAME_LENGTH:
                    vmess_data['ps'] = name[:MAX_NAME_LENGTH-3] + '...'
                    new_json_str = json.dumps(vmess_data, separators=(',', ':'))
                    new_encoded_part = base64.b64encode(new_json_str.encode('utf-8')).decode('utf-8').replace('=', '')
                    return 'vmess://' + new_encoded_part
            except Exception: pass
        else:
            if '#' in config_str:
                base_part, name_part = config_str.split('#', 1)
                decoded_name = unquote(name_part)
                if len(decoded_name) > MAX_NAME_LENGTH:
                    shortened_name = decoded_name[:MAX_NAME_LENGTH-3] + '...'
                    return base_part + '#' + quote(shortened_name)
    except Exception: pass
    return config_str

def parse_subscription_content(content):
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

def fetch_and_parse_url(source):
    try:
        response = requests.get(source['url'], timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        return parse_subscription_content(response.text)
    except (requests.RequestException, Exception): return set()

def get_static_sources():
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            urls = json.load(f).get("static", [])
            # Add a very old timestamp to static sources so they are processed last
            return [{'url': url, 'updated_at': datetime(2000, 1, 1, tzinfo=timezone.utc)} for url in urls]
    except (FileNotFoundError, json.JSONDecodeError): return []

def discover_dynamic_sources():
    if not GITHUB_PAT: return []
    g = Github(auth=Auth.Token(GITHUB_PAT), timeout=20)
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=GITHUB_FRESHNESS_HOURS)
    dynamic_sources = []
    for query in GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
                try:
                    for content_file in repo.get_contents(""):
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md')):
                            dynamic_sources.append({'url': content_file.download_url, 'updated_at': repo.updated_at})
                except GithubException: continue
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
        except GithubException: continue
    return dynamic_sources

def test_config_advanced(config_str):
    try:
        host, port, sni, is_tls = None, None, None, False
        parsed_url = urlparse(config_str)

        if parsed_url.scheme == 'vmess':
            vmess_data = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
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
            except (socket.timeout, socket.error, ssl.SSLError, ConnectionRefusedError): continue
            finally:
                if sock: sock.close()
    except Exception: pass
    return None

# =================================================================================
# === CLASH CONFIG GENERATION ===
# =================================================================================

def create_clash_yaml(configs, filename):
    """تولید فایل YAML کلش از لیست کانفیگ‌ها"""
    proxies = []
    
    for config_str in configs:
        proxy = parse_config_for_clash(config_str)
        if proxy:
            proxies.append(proxy)
    
    if not proxies:
        print("⚠️  هیچ کانفیگ سازگار با کلش یافت نشد.")
        return
    
    clash_config = {
        'port': 7890,
        'socks-port': 7891,
        'allow-lan': True,
        'mode': 'rule',
        'log-level': 'info',
        'external-controller': '127.0.0.1:9090',
        'proxies': proxies,
        'proxy-groups': [
            {
                'name': 'PROXY',
                'type': 'select',
                'proxies': ['AUTO'] + [p['name'] for p in proxies]
            },
            {
                'name': 'AUTO',
                'type': 'url-test',
                'proxies': [p['name'] for p in proxies],
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
    
    output_path = os.path.join(OUTPUT_DIR, filename)
    with open(output_path, 'w', encoding='utf-8') as f:
        yaml.dump(clash_config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"✅ فایل کلش ساخته شد: {output_path}")

def parse_config_for_clash(config_str):
    """تبدیل کانفیگ V2Ray به فرمت کلش"""
    try:
        if 'reality' in config_str.lower():
            return None  # کلش از Reality پشتیبانی نمی‌کند
        
        # استخراج نام سرور
        if '#' in config_str:
            name = unquote(config_str.split('#')[1])
        else:
            name = urlparse(config_str).hostname
        
        name = name[:MAX_NAME_LENGTH] if len(name) > MAX_NAME_LENGTH else name
        
        proxy = {
            'name': name,
            'skip-cert-verify': True
        }
        
        if config_str.startswith('vmess://'):
            vmess_data = json.loads(_decode_padded_b64(config_str.replace('vmess://', '')))
            proxy.update({
                'type': 'vmess',
                'server': vmess_data['add'],
                'port': int(vmess_data['port']),
                'uuid': vmess_data['id'],
                'alterId': int(vmess_data.get('aid', 0)),
                'cipher': vmess_data.get('scy', 'auto'),
                'tls': vmess_data.get('tls') == 'tls'
            })
            
            if vmess_data.get('net') == 'ws':
                proxy['network'] = 'ws'
                proxy['ws-opts'] = {
                    'path': vmess_data.get('path', '/'),
                    'headers': {'Host': vmess_data.get('host', vmess_data['add'])}
                }
            
            if proxy['tls'] and vmess_data.get('sni'):
                proxy['servername'] = vmess_data['sni']
                
        elif config_str.startswith('vless://'):
            parsed = urlparse(config_str)
            params = dict(parse_qsl(parsed.query))
            proxy.update({
                'type': 'vless',
                'server': parsed.hostname,
                'port': parsed.port,
                'uuid': parsed.username,
                'tls': params.get('security') == 'tls'
            })
            
            if params.get('type') == 'ws':
                proxy['network'] = 'ws'
                proxy['ws-opts'] = {
                    'path': params.get('path', '/'),
                    'headers': {'Host': params.get('host', parsed.hostname)}
                }
            
            if proxy['tls'] and params.get('sni'):
                proxy['servername'] = params['sni']
                
        elif config_str.startswith('trojan://'):
            parsed = urlparse(config_str)
            params = dict(parse_qsl(parsed.query))
            proxy.update({
                'type': 'trojan',
                'server': parsed.hostname,
                'port': parsed.port,
                'password': parsed.username
            })
            
            if params.get('sni'):
                proxy['sni'] = params['sni']
                
        elif config_str.startswith('ss://'):
            parsed = urlparse(config_str)
            try:
                decoded = _decode_padded_b64(parsed.username)
                if ':' in decoded:
                    cipher, password = decoded.split(':', 1)
                else:
                    cipher, password = 'aes-256-gcm', decoded
                
                proxy.update({
                    'type': 'ss',
                    'server': parsed.hostname,
                    'port': parsed.port,
                    'cipher': cipher,
                    'password': password
                })
            except Exception:
                return None
        else:
            return None
            
        return proxy
        
    except Exception:
        return None

# =================================================================================
# === MAIN EXECUTION ===
# =================================================================================

def main():
    start_time = time.time()
    
    # ۱. جمع‌آوری هوشمند و اولویت‌بندی شده
    all_sources = get_static_sources() + discover_dynamic_sources()
    all_sources.sort(key=lambda x: x['updated_at'], reverse=True) # جدیدترین‌ها در ابتدا
    print(f"📡 {len(all_sources)} منبع پیدا شد (با اولویت تازگی).")
    
    # ۲. استخراج و تست سلامت
    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"📦 {len(raw_configs)} کانفیگ خام استخراج شد.")

    print(f"\n🏃‍♂️ تست سلامت پیشرفته {len(raw_configs)} کانفیگ...")
    fast_configs_results = []
    with ThreadPoolExecutor(max_workers=50) as executor:
        for result in executor.map(test_config_advanced, raw_configs):
            if result and result.get('ping', 9999) < MAX_PING_THRESHOLD:
                fast_configs_results.append(result)

    print(f"⚡ {len(fast_configs_results)} کانفیگ سالم یافت شد.")
    fast_configs_results.sort(key=lambda x: x['ping'])
    
    # ۳. دسته‌بندی و انتخاب نهایی
    categorized_healthy = defaultdict(list)
    for res in fast_configs_results:
        cfg = res['config_str']
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or query_params.get('security') == 'reality'):
                categorized_healthy['singbox_only'].append(cfg)
            else:
                categorized_healthy[parsed.scheme].append(cfg)
        except Exception:
            categorized_healthy['unknown'].append(cfg)

    balanced_xray_list = []
    for proto, quota_percent in PROTOCOL_QUOTAS.items():
        quota_size = int(TARGET_CONFIGS_PER_CORE * quota_percent)
        balanced_xray_list.extend(categorized_healthy.get(proto, [])[:quota_size])
    
    if len(balanced_xray_list) < TARGET_CONFIGS_PER_CORE:
        all_fast_xray_uris = [cfg for proto in PROTOCOL_QUOTAS.keys() for cfg in categorized_healthy.get(proto, [])]
        for cfg in all_fast_xray_uris:
            if len(balanced_xray_list) >= TARGET_CONFIGS_PER_CORE: break
            if cfg not in balanced_xray_list:
                balanced_xray_list.append(cfg)
    
    final_xray = [shorten_config_name(cfg) for cfg in balanced_xray_list[:TARGET_CONFIGS_PER_CORE]]
    
    # منطق جدید برای ساخت لیست Sing-Box
    final_singbox = [shorten_config_name(cfg) for cfg in categorized_healthy['singbox_only'][:TARGET_CONFIGS_PER_CORE]]
    if len(final_singbox) < TARGET_CONFIGS_PER_CORE:
        print(f"⚠️  لیست Sing-Box به حد نصاب نرسید ({len(final_singbox)}/{TARGET_CONFIGS_PER_CORE}). در حال تکمیل با کانفیگ‌های XRay...")
        needed = TARGET_CONFIGS_PER_CORE - len(final_singbox)
        xray_fillers = [cfg for cfg in final_xray if cfg not in final_singbox]
        final_singbox.extend(xray_fillers[:needed])

    # ۴. تولید فایل‌های خروجی زمان‌دار (حالا در ریشه)
    timestamp = int(time.time())
    
    output_json_file_name = f"all_live_configs_{timestamp}.json"
    output_json_path = os.path.join(OUTPUT_DIR, output_json_file_name)
    output_for_frontend = {'xray': final_xray, 'singbox': final_singbox}
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False)
    print(f"✅ فایل JSON ساخته شد: {output_json_path}")
    
    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(timestamp))
    print(f"✅ فایل ورژن ساخته شد: {CACHE_VERSION_FILE}")

    # ۵. تولید فایل کلش
    create_clash_yaml(final_xray, OUTPUT_CLASH_FILE_NAME)
    
    elapsed_time = time.time() - start_time
    print(f"\n🎉 فرآیند با موفقیت تکمیل شد در {elapsed_time:.2f} ثانیه.")

if __name__ == "__main__":
    main()