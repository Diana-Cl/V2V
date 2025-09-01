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
OUTPUT_DIR = "configs" # تغییر شده: فایل‌ها در پوشه configs قرار می‌گیرند
CACHE_VERSION_FILE = "cache_version.txt"
OUTPUT_CLASH_FILE_NAME = "clash_subscription.yaml"
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': 'V2V-Scraper/v8.0-Timestamped',
    'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0'
}

# UUIDs ثابت برای sub paths (همان‌طور که در frontend تعریف شده)
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
    original_content = content.strip()
    
    # لیست تمام محتوای احتمالی برای بررسی
    content_variants = [original_content]
    
    # 1. تلاش برای decode base64 (چندین روش)
    for encoding_attempt in [original_content, original_content.replace('\n', ''), original_content.replace(' ', '')]:
        try:
            decoded = _decode_padded_b64(encoding_attempt)
            if decoded and len(decoded) > 10 and decoded != encoding_attempt:
                content_variants.append(decoded)
        except Exception:
            continue
    
    # 2. تلاش برای parse JSON arrays
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
    except (json.JSONDecodeError, TypeError):
        pass
    
    # 3. تلاش برای parse YAML
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
    except (yaml.YAMLError, TypeError):
        pass
    
    # 4. پاک‌سازی HTML tags
    if '<' in original_content and '>' in original_content:
        try:
            html_cleaned = re.sub(r'<[^>]+>', '', original_content)
            html_cleaned = html_cleaned.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
            content_variants.append(html_cleaned)
        except Exception:
            pass
    
    # 5. URL decode
    try:
        url_decoded = unquote(original_content)
        if url_decoded != original_content:
            content_variants.append(url_decoded)
    except Exception:
        pass
    
    # 6. جستجو در تمام variant ها
    for variant in content_variants:
        if not variant:
            continue
            
        pattern = r'(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\'"<>\[\]{}()]*'
        matches = re.findall(pattern, str(variant), re.MULTILINE | re.IGNORECASE)
        
        for match in matches:
            clean_match = match.strip().strip('\'"').rstrip(',').rstrip(';')
            if _is_valid_config_format(clean_match):
                configs.add(clean_match)
        
        for line in str(variant).split('\n'):
            line = line.strip()
            if any(line.startswith(prefix) for prefix in VALID_PREFIXES):
                if _is_valid_config_format(line):
                    configs.add(line)
    
    return configs

def fetch_and_parse_url(source):
    try:
        response = requests.get(source['url'], timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        return parse_subscription_content(response.text)
    except (requests.RequestException, Exception): 
        return set()

def get_static_sources():
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            urls = json.load(f).get("static", [])
            return [{'url': url, 'updated_at': datetime(2000, 1, 1, tzinfo=timezone.utc)} for url in urls]
    except (FileNotFoundError, json.JSONDecodeError): 
        return []

def discover_dynamic_sources():
    if not GITHUB_PAT: return []
    g = Github(auth=Auth.Token(GITHUB_PAT), timeout=20)
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=GITHUB_FRESHNESS_HOURS)
    dynamic_sources = []
    for query in GITHUB_SEARCH_QUERIES:
        try:
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: 
                    break
                try:
                    for content_file in repo.get_contents(""):
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md')):
                            dynamic_sources.append({'url': content_file.download_url, 'updated_at': repo.updated_at})
                except GithubException: 
                    continue
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: 
                    break
        except GithubException: 
            continue
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
            except (socket.timeout, socket.error, ssl.SSLError, ConnectionRefusedError): 
                continue
            finally:
                if sock: sock.close()
    except Exception: 
        pass
    return None

# =================================================================================
# === CLASH CONFIG GENERATION ===
# =================================================================================

def parse_config_for_clash(config_str):
    """تبدیل کانفیگ V2Ray به فرمت کلش - بدون خطا و duplicate"""
    try:
        if 'reality' in config_str.lower():
            return None
        
        # استخراج نام
        if '#' in config_str:
            name = unquote(config_str.split('#')[1])
        else:
            name = urlparse(config_str).hostname or 'Unknown'
        
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

def create_clash_yaml(configs, filename):
    """تولید فایل YAML کلش کاملاً استاندارد و بدون duplicate"""
    if not configs:
        print("⚠️  هیچ کانفیگی برای ساخت کلش یافت نشد.")
        return
        
    proxies = []
    seen_servers = set()  # حذف duplicate بر اساس server:port
    
    for config_str in configs:
        proxy = parse_config_for_clash(config_str)
        if proxy:
            server_key = f"{proxy['server']}:{proxy['port']}"
            if server_key not in seen_servers:
                seen_servers.add(server_key)
                
                # اطمینان از منحصر به فرد بودن نام
                original_name = proxy['name']
                counter = 1
                while any(p['name'] == proxy['name'] for p in proxies):
                    proxy['name'] = f"{original_name}_{counter}"
                    counter += 1
                
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
    
    try:
        output_path = os.path.join(OUTPUT_DIR, filename)
        with open(output_path, 'w', encoding='utf-8') as f:
            yaml.dump(clash_config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        print(f"✅ فایل کلش با {len(proxies)} پروکسی بدون تکرار ساخته شد: {output_path}")
    except Exception as e:
        print(f"❌ خطا در ساخت فایل کلش: {e}")

# =================================================================================
# === SUB FILES GENERATION ===
# =================================================================================

def create_subscription_files(final_xray, final_singbox):
    """ساخت فایل‌های subscription با UUIDs ثابت در configs"""
    
    # اطمینان از وجود پوشه configs
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # تولید فایل‌های sub برای xray
    xray_top20 = final_xray[:20]
    
    # فایل xray top 20
    xray_top20_content = '\n'.join(xray_top20)
    xray_top20_encoded = base64.b64encode(xray_top20_content.encode('utf-8')).decode('utf-8')
    with open(os.path.join(OUTPUT_DIR, f"sub_{SUBSCRIPTION_UUIDS['xray_top20']}.txt"), 'w', encoding='utf-8') as f:
        f.write(xray_top20_encoded)
    
    # فایل xray all
    xray_all_content = '\n'.join(final_xray)
    xray_all_encoded = base64.b64encode(xray_all_content.encode('utf-8')).decode('utf-8')
    with open(os.path.join(OUTPUT_DIR, f"sub_{SUBSCRIPTION_UUIDS['xray_all']}.txt"), 'w', encoding='utf-8') as f:
        f.write(xray_all_encoded)
    
    # تولید فایل‌های sub برای singbox
    singbox_top20 = final_singbox[:20]
    
    # فایل singbox top 20
    singbox_top20_content = '\n'.join(singbox_top20)
    singbox_top20_encoded = base64.b64encode(singbox_top20_content.encode('utf-8')).decode('utf-8')
    with open(os.path.join(OUTPUT_DIR, f"sub_{SUBSCRIPTION_UUIDS['singbox_top20']}.txt"), 'w', encoding='utf-8') as f:
        f.write(singbox_top20_encoded)
    
    # فایل singbox all
    singbox_all_content = '\n'.join(final_singbox)
    singbox_all_encoded = base64.b64encode(singbox_all_content.encode('utf-8')).decode('utf-8')
    with open(os.path.join(OUTPUT_DIR, f"sub_{SUBSCRIPTION_UUIDS['singbox_all']}.txt"), 'w', encoding='utf-8') as f:
        f.write(singbox_all_encoded)
    
    print(f"✅ فایل‌های subscription با UUIDs ثابت ساخته شدند:")
    print(f"   - Xray Top 20: {OUTPUT_DIR}/sub_{SUBSCRIPTION_UUIDS['xray_top20']}.txt")
    print(f"   - Xray All: {OUTPUT_DIR}/sub_{SUBSCRIPTION_UUIDS['xray_all']}.txt")
    print(f"   - Singbox Top 20: {OUTPUT_DIR}/sub_{SUBSCRIPTION_UUIDS['singbox_top20']}.txt")
    print(f"   - Singbox All: {OUTPUT_DIR}/sub_{SUBSCRIPTION_UUIDS['singbox_all']}.txt")

# =================================================================================
# === MAIN EXECUTION ===
# =================================================================================

def main():
    start_time = time.time()
    
    # ۱. جمع‌آوری هوشمند
    all_sources = get_static_sources() + discover_dynamic_sources()
    all_sources.sort(key=lambda x: x['updated_at'], reverse=True)
    print(f"📡 {len(all_sources)} منبع پیدا شد (با اولویت تازگی).")
    
    # ۲. استخراج و تست
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
    
    # ۳. دسته‌بندی
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

    # ساخت لیست Xray متعادل
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
    
    # ساخت لیست Sing-Box
    final_singbox = [shorten_config_name(cfg) for cfg in categorized_healthy['singbox_only'][:TARGET_CONFIGS_PER_CORE]]
    if len(final_singbox) < TARGET_CONFIGS_PER_CORE:
        print(f"⚠️  لیست Sing-Box به حد نصاب نرسید ({len(final_singbox)}/{TARGET_CONFIGS_PER_CORE}). در حال تکمیل با کانفیگ‌های XRay...")
        needed = TARGET_CONFIGS_PER_CORE - len(final_singbox)
        xray_fillers = [cfg for cfg in final_xray if cfg not in final_singbox]
        final_singbox.extend(xray_fillers[:needed])

    # ۴. تولید فایل‌های خروجی
    timestamp = int(time.time())
    
    # اطمینان از وجود پوشه configs
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # فایل JSON اصلی
    output_json_file_name = f"all_live_configs_{timestamp}.json"
    output_json_path = os.path.join(OUTPUT_DIR, output_json_file_name)
    output_for_frontend = {'xray': final_xray, 'singbox': final_singbox}
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False)
    print(f"✅ فایل JSON ساخته شد: {output_json_path}")
    
    # فایل cache version در ریشه
    with open(CACHE_VERSION_FILE, 'w', encoding='utf-8') as f:
        f.write(str(timestamp))
    print(f"✅ فایل ورژن ساخته شد: {CACHE_VERSION_FILE}")

    # ۵. تولید فایل‌های subscription با UUIDs ثابت
    create_subscription_files(final_xray, final_singbox)

    # ۶. تولید فایل کلش استاندارد
    create_clash_yaml(final_xray, OUTPUT_CLASH_FILE_NAME)
    
    elapsed_time = time.time() - start_time
    print(f"\n🎉 فرآیند با موفقیت تکمیل شد در {elapsed_time:.2f} ثانیه.")

if __name__ == "__main__":
    main()
