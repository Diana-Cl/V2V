# -*- coding: utf-8 -*-

import requests
import base64
import os
import json
import re
import time
import yaml
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qsl, unquote, urlencode, quote
from github import Github, Auth, GithubException
from bs4 import BeautifulSoup

# =================================================================================
# === CONFIGURATION (تنظیمات) ===
# =================================================================================

# --- فایل‌های ورودی و خروجی
SOURCES_FILE = "sources.json"
OUTPUT_JSON_FILE = "all_live_configs.json"
OUTPUT_CLASH_FILE = "clash_subscription.yaml"

# --- تنظیمات عمومی
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')

# --- هدرهای ضد کش برای اطمینان از دریافت محتوای تازه
HEADERS = {
    'User-Agent': 'V2V-Scraper/v5.5-Enhanced',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
}

# --- تنظیمات گیت‌هاب
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 75
GITHUB_FRESHNESS_HOURS = 240  # افزایش به 10 روز
GITHUB_SEARCH_QUERIES = [
    'v2ray subscription', 'vless subscription', 'proxy subscription',
    'vmess config', 'trojan config', 'clash subscription'
]

# --- تنظیمات تست سرعت و کیفیت‌سنجی
SPEED_TEST_API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'
MAX_CONFIGS_TO_TEST = 2500
MAX_PING_THRESHOLD = 3000  # کاهش به 3 ثانیه
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 15

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# =================================================================================
# === HELPER FUNCTIONS (توابع کمکی) ===
# =================================================================================

def _decode_padded_b64(encoded_str: str) -> str:
    """یک رشته Base64 را رمزگشایی می‌کند و در صورت نیاز به آن padding اضافه می‌کند."""
    if not encoded_str:
        return ""
    
    # تمیز کردن رشته از کاراکترهای غیرضروری
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    
    # اضافه کردن padding در صورت نیاز
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        # تلاش با encoding های مختلف
        for encoding in ['latin1', 'ascii', 'utf-16']:
            try:
                return base64.b64decode(padded_str).decode(encoding)
            except Exception:
                continue
        return ""

def _encode_b64(text: str) -> str:
    """یک رشته را به Base64 انکود می‌کند."""
    return base64.b64encode(text.encode('utf-8')).decode('utf-8')

def _is_valid_config_format(config_str: str) -> bool:
    """بررسی معتبر بودن فرمت کانفیگ."""
    try:
        parsed = urlparse(config_str)
        return (
            parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] and
            parsed.hostname and
            len(config_str) > 20 and  # حداقل طول
            '://' in config_str
        )
    except Exception:
        return False

# =================================================================================
# === PARSING ENGINE (موتور پردازشگر فرمت‌های مختلف) ===
# =================================================================================

def parse_subscription_content(content: str) -> set:
    """پردازش محتوای subscription با تشخیص خودکار فرمت."""
    configs = set()
    
    # مرحله 1: تلاش برای decode کل محتوا به عنوان base64
    decoded_content = _decode_padded_b64(content)
    if decoded_content and decoded_content != content:
        content = decoded_content
        print(f"   - محتوای base64 رمزگشایی شد ({len(content)} کاراکتر)")
    
    # مرحله 2: استخراج لینک‌های مستقیم با regex بهبود یافته
    # الگوی پیشرفته‌تر برای تشخیص کانفیگ‌ها
    patterns = [
        r'(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\'"<>\[\]{}()]*',
        r'(?:^|\s)(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\n\r]*',
        r'"(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^"]*"',
        r"'(" + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r")[^']*'"
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, content, re.MULTILINE | re.IGNORECASE)
        for match in matches:
            if isinstance(match, tuple):
                match = match[0] if match[0] else (match[1] if len(match) > 1 else '')
            
            # --- اصلاح سینتکس ---
            clean_match = match.strip().strip('\'"') # روش صحیح برای حذف کوتیشن‌ها
            if clean_match and _is_valid_config_format(clean_match):
                configs.add(clean_match)
    
    # مرحله 3: جستجو در خطوط جداگانه
    lines = content.split('\n')
    for line in lines:
        line = line.strip()
        if any(line.startswith(prefix) for prefix in VALID_PREFIXES):
            if _is_valid_config_format(line):
                configs.add(line)
    
    return configs

def parse_structured_json(content: dict) -> set:
    """پردازش فایل‌های JSON ساختاریافته با پشتیبانی گسترده‌تر."""
    configs = set()
    
    # پردازش Sing-box format
    if 'outbounds' in content and isinstance(content['outbounds'], list):
        for outbound in content['outbounds']:
            try:
                protocol = outbound.get('protocol') or outbound.get('type')
                if not protocol or protocol in ['direct', 'block', 'dns']:
                    continue
                
                config_str = ""
                server = outbound.get('server')
                port = outbound.get('server_port') or outbound.get('port')
                
                if not server or not port:
                    continue
                
                if protocol == 'vless':
                    uuid = outbound.get('uuid')
                    if not uuid:
                        continue
                    name = outbound.get('tag', f"{server}:{port}")
                    params = {'type': outbound.get('transport', {}).get('type', 'tcp')}
                    
                    # TLS settings
                    tls_config = outbound.get('tls', {})
                    if tls_config.get('enabled'):
                        params['security'] = 'tls'
                        params['sni'] = tls_config.get('server_name', server)
                        
                        # Reality support
                        reality_config = tls_config.get('reality', {})
                        if reality_config.get('enabled'):
                            params['security'] = 'reality'
                            params['pbk'] = reality_config.get('public_key', '')
                            params['sid'] = reality_config.get('short_id', '')
                    
                    query_string = urlencode({k: v for k, v in params.items() if v})
                    config_str = f"vless://{uuid}@{server}:{port}?{query_string}#{quote(name)}"

                elif protocol == 'vmess':
                    uuid = outbound.get('uuid')
                    if not uuid:
                        continue
                    name = outbound.get('tag', f"{server}:{port}")
                    transport = outbound.get('transport', {})
                    
                    vmess_data = {
                        "v": "2",
                        "ps": name,
                        "add": server,
                        "port": port,
                        "id": uuid,
                        "aid": outbound.get('alter_id', 0),
                        "net": transport.get('type', 'tcp'),
                        "type": "none",
                        "host": "",
                        "path": "",
                        "tls": "tls" if outbound.get('tls', {}).get('enabled') else "none",
                        "sni": outbound.get('tls', {}).get('server_name', server)
                    }
                    
                    # WebSocket settings
                    if transport.get('type') == 'ws':
                        ws_config = transport.get('websocket', {})
                        vmess_data['path'] = ws_config.get('path', '/')
                        vmess_data['host'] = ws_config.get('headers', {}).get('Host', server)
                    
                    config_str = f"vmess://{_encode_b64(json.dumps(vmess_data, separators=(',', ':')))}"

                elif protocol == 'trojan':
                    password = outbound.get('password')
                    if not password:
                        continue
                    name = outbound.get('tag', f"{server}:{port}")
                    params = {'sni': outbound.get('tls', {}).get('server_name', server)}
                    
                    query_string = urlencode({k: v for k, v in params.items() if v})
                    config_str = f"trojan://{password}@{server}:{port}?{query_string}#{quote(name)}"

                if config_str and _is_valid_config_format(config_str):
                    configs.add(config_str)
            except (KeyError, TypeError, AttributeError):
                continue
    
    # پردازش فرمت‌های دیگر JSON
    if 'configs' in content and isinstance(content['configs'], list):
        for config in content['configs']:
            if isinstance(config, str) and any(config.startswith(p) for p in VALID_PREFIXES):
                if _is_valid_config_format(config):
                    configs.add(config)
    
    # جستجوی عمیق در تمام مقادیر JSON
    def deep_search(obj):
        if isinstance(obj, dict):
            for value in obj.values():
                deep_search(value)
        elif isinstance(obj, list):
            for item in obj:
                deep_search(item)
        elif isinstance(obj, str) and any(obj.startswith(p) for p in VALID_PREFIXES):
            if _is_valid_config_format(obj):
                configs.add(obj)
    
    deep_search(content)
    return configs

def parse_structured_yaml(content: dict) -> set:
    """پردازش فایل‌های YAML با پشتیبانی گسترده‌تر."""
    configs = set()
    
    # پردازش Clash format
    if 'proxies' in content and isinstance(content['proxies'], list):
        for proxy in content['proxies']:
            try:
                protocol = proxy.get('type')
                server = proxy.get('server')
                port = proxy.get('port')
                name = proxy.get('name', f"{server}:{port}")
                
                if not all([protocol, server, port]):
                    continue
                
                config_str = ""
                
                if protocol == 'vless':
                    uuid = proxy.get('uuid')
                    if not uuid:
                        continue
                    params = {
                        'type': proxy.get('network', 'tcp'),
                        'sni': proxy.get('servername', server)
                    }
                    if proxy.get('tls'):
                        params['security'] = 'tls'
                    if proxy.get('reality-opts'):
                        params['security'] = 'reality'
                        params['pbk'] = proxy['reality-opts'].get('public-key', '')
                        params['sid'] = proxy['reality-opts'].get('short-id', '')
                    
                    query_string = urlencode({k: v for k, v in params.items() if v})
                    config_str = f"vless://{uuid}@{server}:{port}?{query_string}#{quote(name)}"

                elif protocol == 'vmess':
                    uuid = proxy.get('uuid')
                    if not uuid:
                        continue
                    vmess_data = {
                        "v": "2",
                        "ps": name,
                        "add": server,
                        "port": port,
                        "id": uuid,
                        "aid": proxy.get('alterId', 0),
                        "net": proxy.get('network', 'tcp'),
                        "type": "none",
                        "host": proxy.get('ws-opts', {}).get('headers', {}).get('Host', ''),
                        "path": proxy.get('ws-opts', {}).get('path', ''),
                        "tls": "tls" if proxy.get('tls') else "none",
                        "sni": proxy.get('servername', server)
                    }
                    config_str = f"vmess://{_encode_b64(json.dumps(vmess_data, separators=(',', ':')))}"
                
                elif protocol == 'trojan':
                    password = proxy.get('password')
                    if not password:
                        continue
                    params = {'sni': proxy.get('sni', server)}
                    query_string = urlencode({k: v for k, v in params.items() if v})
                    config_str = f"trojan://{password}@{server}:{port}?{query_string}#{quote(name)}"

                elif protocol == 'ss':
                    password = proxy.get('password')
                    cipher = proxy.get('cipher')
                    if not password or not cipher:
                        continue
                    encoded_auth = _encode_b64(f"{cipher}:{password}")
                    config_str = f"ss://{encoded_auth}@{server}:{port}#{quote(name)}"

                if config_str and _is_valid_config_format(config_str):
                    configs.add(config_str)
            except (KeyError, TypeError, AttributeError):
                continue
    
    # جستجوی عمیق در YAML
    def deep_search_yaml(obj):
        if isinstance(obj, dict):
            for value in obj.values():
                deep_search_yaml(value)
        elif isinstance(obj, list):
            for item in obj:
                deep_search_yaml(item)
        elif isinstance(obj, str) and any(obj.startswith(p) for p in VALID_PREFIXES):
            if _is_valid_config_format(obj):
                configs.add(obj)
    
    deep_search_yaml(content)
    return configs

def parse_html_content(content: str) -> set:
    """استخراج لینک‌های کانفیگ از محتوای HTML با بهبود."""
    configs = set()
    
    # استفاده از BeautifulSoup برای پاک کردن HTML
    soup = BeautifulSoup(content, 'html.parser')
    
    # حذف script و style tags
    for script in soup(["script", "style"]):
        script.decompose()
    
    # استخراج متن خالص
    text_content = soup.get_text(separator='\n')
    
    # اعمال parser اصلی subscription
    configs.update(parse_subscription_content(text_content))
    
    # جستجو در attributes مختلف HTML
    for tag in soup.find_all():
        for attr_value in tag.attrs.values():
            if isinstance(attr_value, str):
                configs.update(parse_subscription_content(attr_value))
            elif isinstance(attr_value, list):
                for value in attr_value:
                    if isinstance(value, str):
                        configs.update(parse_subscription_content(value))
    
    return configs

def fetch_and_parse_url(url: str) -> set:
    """دانلود و استخراج کانفیگ از یک URL با موتور پردازشگر پیشرفته."""
    try:
        print(f"   - در حال پردازش: {url[:60]}...")
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        response.raise_for_status()
        content = response.text
        
        configs = set()
        content_type = response.headers.get('Content-Type', '').lower()

        # موتور پردازشگر هوشمند با اولویت‌بندی
        
        # 1. تلاش برای پردازش به عنوان JSON
        if 'json' in content_type or content.strip().startswith('{'):
            try:
                json_content = json.loads(content)
                configs.update(parse_structured_json(json_content))
                if configs:
                    print(f"     ✓ {len(configs)} کانفیگ از JSON استخراج شد")
                    return configs
            except json.JSONDecodeError:
                pass

        # 2. تلاش برای پردازش به عنوان YAML
        if any(ext in url.lower() for ext in ['.yaml', '.yml']) or 'yaml' in content_type:
            try:
                yaml_content = yaml.safe_load(content)
                if isinstance(yaml_content, dict):
                    configs.update(parse_structured_yaml(yaml_content))
                    if configs:
                        print(f"     ✓ {len(configs)} کانفیگ از YAML استخراج شد")
                        return configs
            except yaml.YAMLError:
                pass

        # 3. تلاش برای پردازش به عنوان HTML
        if 'html' in content_type or any(tag in content.lower() for tag in ['<html', '<body', '<div']):
            configs.update(parse_html_content(content))
            if configs:
                print(f"     ✓ {len(configs)} کانفیگ از HTML استخراج شد")
                return configs

        # 4. پردازش به عنوان subscription معمولی
        configs.update(parse_subscription_content(content))
        if configs:
            print(f"     ✓ {len(configs)} کانفیگ از subscription استخراج شد")
        else:
            print(f"     ✗ هیچ کانفیگی یافت نشد")
        
        return configs

    except requests.RequestException as e:
        print(f"     ✗ خطای شبکه: {str(e)[:50]}...")
        return set()
    except Exception as e:
        print(f"     ✗ خطای پردازش: {str(e)[:50]}...")
        return set()

# =================================================================================
# === CORE FUNCTIONS (توابع اصلی) ===
# =================================================================================

def get_static_sources() -> list:
    """خواندن منابع ثابت از فایل sources.json"""
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            static_sources = data.get("static", [])
            print(f"📁 {len(static_sources)} منبع ثابت از فایل خوانده شد")
            return static_sources
    except FileNotFoundError:
        print(f"⚠️ فایل {SOURCES_FILE} یافت نشد")
        return []
    except json.JSONDecodeError:
        print(f"⚠️ خطا در خواندن فایل {SOURCES_FILE}")
        return []

def discover_dynamic_sources() -> list:
    """کشف منابع پویا و تازه از GitHub"""
    if not GITHUB_PAT:
        print("⚠️ توکن گیت‌هاب (GH_PAT) یافت نشد. از جستجوی پویا صرف نظر می‌شود.")
        return []
    
    print("🔍 کشف منابع پویا و تازه از GitHub...")
    auth = Auth.Token(GITHUB_PAT)
    g = Github(auth=auth, timeout=20)
    
    freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=GITHUB_FRESHNESS_HOURS)
    dynamic_sources = set()

    for query in GITHUB_SEARCH_QUERIES:
        try:
            print(f"   - جستجوی '{query}'...")
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                    break 
                try:
                    contents = repo.get_contents("")
                    for content_file in contents:
                        if (content_file.type == 'file' and 
                            content_file.name.lower().endswith(('.txt', '.md', '.yaml', '.yml', '.json'))):
                            dynamic_sources.add(content_file.download_url)
                except GithubException:
                    continue
                    
            if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                break
                
        except GithubException as e:
            print(f"   - خطا در جستجوی گیت‌هاب برای '{query}': {e}")
            continue
    
    print(f"✅ {len(dynamic_sources)} منبع پویای تازه کشف شد.")
    return list(dynamic_sources)

def test_config_via_api(config_str: str) -> dict:
    """تست پینگ یک کانفیگ از طریق API خارجی."""
    try:
        parsed = urlparse(config_str)
        host = parsed.hostname
        port = parsed.port
        
        if parsed.scheme == 'vmess':
            try:
                decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
                host, port = decoded.get('add'), int(decoded.get('port', 443))
            except Exception:
                return {'config_str': config_str, 'ping': 9999}
        
        if not host:
            return {'config_str': config_str, 'ping': 9999}
            
        if not port:
            port = {'ss': 8443, 'trojan': 443, 'vless': 443, 'hysteria2': 443, 'hy2': 443, 'tuic': 443}.get(parsed.scheme, 443)
            
        response = requests.post(
            SPEED_TEST_API_ENDPOINT, 
            json={'host': host, 'port': port}, 
            headers={'Content-Type': 'application/json'}, 
            timeout=REQUEST_TIMEOUT
        )
        
        if response.status_code == 200:
            result = response.json()
            ping = result.get('ping', 9999)
            return {'config_str': config_str, 'ping': ping}
        else:
            return {'config_str': config_str, 'ping': 9999}
            
    except Exception:
        return {'config_str': config_str, 'ping': 9999}

def validate_and_categorize_configs(configs: set) -> dict:
    """کانفیگ‌ها را بر اساس هسته مورد نیاز (Xray یا Sing-box) دسته‌بندی می‌کند."""
    categorized = {'xray': set(), 'singbox_only': set()}
    
    for cfg in configs:
        if not _is_valid_config_format(cfg):
            continue
            
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            
            # کانفیگ‌های مخصوص Sing-box
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or 
                query_params.get('security') == 'reality'):
                categorized['singbox_only'].add(cfg)
            else:
                categorized['xray'].add(cfg)
        except Exception:
            # در صورت خطا، به Xray اضافه کن
            categorized['xray'].add(cfg)
            
    return categorized

def generate_clash_subscription(configs: list) -> str | None:
    """یک فایل اشتراک با فرمت YAML برای کلاینت‌های Clash تولید می‌کند."""
    proxies = []
    used_names = set()
    
    for config_str in configs:
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'): 
                continue
            
            url = urlparse(config_str)
            if not url.hostname or not url.port:
                continue
                
            # فیلتر کردن Reality configs
            if 'reality' in config_str.lower():
                continue

            name = unquote(url.fragment) if url.fragment else url.hostname
            original_name = name[:30]  # محدود کردن طول نام
            count = 1
            while name in used_names:
                name = f"{original_name}_{count}"
                count += 1
            used_names.add(name)

            proxy = {
                'name': name, 
                'type': protocol, 
                'server': url.hostname, 
                'port': int(url.port)
            }
            
            if protocol == 'vless':
                if not url.username:
                    continue
                params = dict(parse_qsl(url.query))
                proxy.update({
                    'uuid': url.username,
                    'tls': params.get('security') == 'tls',
                    'network': params.get('type', 'tcp'),
                    'servername': params.get('sni', url.hostname),
                    'skip-cert-verify': True
                })
                
                if proxy.get('network') == 'ws': 
                    proxy['ws-opts'] = {
                        'path': params.get('path', '/'),
                        'headers': {'Host': params.get('host', url.hostname)}
                    }
                    
            elif protocol == 'vmess':
                try:
                    decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
                    if not decoded.get('id'):
                        continue
                        
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
                        proxy['ws-opts'] = {
                            'path': decoded.get('path', '/'),
                            'headers': {'Host': decoded.get('host', decoded.get('add'))}
                        }
                except Exception:
                    continue
                    
            elif protocol == 'trojan':
                if not url.username:
                    continue
                params = dict(parse_qsl(url.query))
                proxy.update({
                    'password': url.username,
                    'sni': params.get('sni', url.hostname),
                    'skip-cert-verify': True
                })
                
            elif protocol == 'ss':
                try:
                    cred = _decode_padded_b64(unquote(url.username)).split(':')
                    if len(cred) < 2 or not cred[0] or not cred[1]:
                        continue
                    proxy.update({
                        'cipher': cred[0], 
                        'password': cred[1]
                    })
                except Exception:
                    continue
            
            proxies.append(proxy)
            
        except Exception:
            continue
    
    if not proxies:
        return None
    
    clash_config = {'proxies': proxies}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

def main():
    print(f"🚀 V2V Scraper v5.5 - شروع فرآیند با موتور پردازشگر پیشرفته...")
    start_time = time.time()
    
    # تست اولیه API
    print("\n🧪 تست API تست سرعت...")
    test_result = test_config_via_api("vless://test@1.1.1.1:443")
    if test_result['ping'] == 9999:
        print("⚠️ API تست سرعت در دسترس نیست، کانفیگ‌ها بدون تست سرعت ذخیره خواهند شد")
        use_speed_test = False
    else:
        print(f"✅ API تست سرعت فعال است (تست ping: {test_result['ping']}ms)")
        use_speed_test = True
    
    # جمع‌آوری منابع
    static_sources = get_static_sources()
    dynamic_sources = discover_dynamic_sources()
    all_sources = list(set(static_sources + dynamic_sources))
    print(f"📡 مجموع منابع جمع‌آوری شده: {len(all_sources)} ({len(static_sources)} ثابت + {len(dynamic_sources)} پویا)")
    
    if not all_sources:
        print("❌ هیچ منبعی یافت نشد. لطفاً فایل sources.json را بررسی کنید.")
        with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f: 
            json.dump({'xray': [], 'singbox': []}, f)
        return
    
    print("\n🚚 در حال دانلود و استخراج کانفیگ‌ها...")
    raw_configs = set()
    
    # پردازش با thread pool
    with ThreadPoolExecutor(max_workers=25) as executor:
        future_to_url = {executor.submit(fetch_and_parse_url, url): url for url in all_sources}
        
        for future in as_completed(future_to_url):
            url = future_to_url[future]
            try:
                result = future.result()
                raw_configs.update(result)
            except Exception as e:
                print(f"   - خطا در پردازش {url[:50]}: {str(e)[:30]}")
    
    print(f"\n📦 {len(raw_configs)} کانفیگ خام منحصر به فرد استخراج شد.")

    if not raw_configs:
        print("❌ هیچ کانفیگی یافت نشد. بررسی منابع یا فرمت‌های جدید لازم است.")
        with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f: 
            json.dump({'xray': [], 'singbox': []}, f)
        return

    print("\n🔬 در حال اعتبارسنجی و دسته‌بندی...")
    categorized_configs = validate_and_categorize_configs(raw_configs)
    xray_compatible_set = categorized_configs['xray']
    singbox_compatible_set = categorized_configs['singbox_only']
    all_unique_configs = list(xray_compatible_set.union(singbox_compatible_set))
    
    print(f"✅ دسته‌بندی: {len(xray_compatible_set)} کانفیگ Xray | {len(singbox_compatible_set)} کانفیگ فقط Sing-box")
    
    # انتخاب کانفیگ‌ها برای تست
    configs_to_test = all_unique_configs
    if len(all_unique_configs) > MAX_CONFIGS_TO_TEST:
        print(f"⚠️ تعداد کل کانفیگ‌ها ({len(all_unique_configs)}) زیاد است. {MAX_CONFIGS_TO_TEST} عدد برای تست انتخاب می‌شود.")
        configs_to_test = all_unique_configs[:MAX_CONFIGS_TO_TEST]

    final_xray = []
    final_singbox = []

    if use_speed_test:
        print(f"\n🏃‍♂️ در حال تست سرعت {len(configs_to_test)} کانفیگ...")
        
        fast_configs_results = []
        with ThreadPoolExecutor(max_workers=20) as executor:
            future_to_config = {executor.submit(test_config_via_api, cfg): cfg for cfg in configs_to_test}
            completed = 0
            
            for future in as_completed(future_to_config):
                completed += 1
                if completed % 100 == 0:
                    print(f"   - پیشرفت: {completed}/{len(configs_to_test)} تست شد")
                
                try:
                    result = future.result()
                    if result['ping'] < MAX_PING_THRESHOLD:
                        fast_configs_results.append(result)
                except Exception:
                    continue

        print(f"⚡ {len(fast_configs_results)} کانفیگ سریع (زیر {MAX_PING_THRESHOLD}ms) یافت شد.")
        
        if not fast_configs_results:
            print("⚠️ هیچ کانفیگ سریعی یافت نشد. از کانفیگ‌های موجود استفاده می‌شود.")
            # اگر هیچ کانفیگ سریعی نیست، از اولین‌ها استفاده کن
            final_xray = list(xray_compatible_set)[:TARGET_CONFIGS_PER_CORE]
            final_singbox = all_unique_configs[:TARGET_CONFIGS_PER_CORE]
        else:
            # مرتب‌سازی بر اساس سرعت
            fast_configs_results.sort(key=lambda x: x['ping'])
            
            # تفکیک بر اساس سازگاری
            for result in fast_configs_results:
                if len(final_xray) < TARGET_CONFIGS_PER_CORE and result['config_str'] in xray_compatible_set:
                    final_xray.append(result['config_str'])
                if len(final_singbox) < TARGET_CONFIGS_PER_CORE:
                    final_singbox.append(result['config_str'])
                
                # اگر هر دو لیست پر شد، متوقف شو
                if len(final_xray) >= TARGET_CONFIGS_PER_CORE and len(final_singbox) >= TARGET_CONFIGS_PER_CORE:
                    break
    else:
        # بدون تست سرعت
        print(f"\n📝 انتخاب کانفیگ‌ها بدون تست سرعت...")
        final_xray = list(xray_compatible_set)[:TARGET_CONFIGS_PER_CORE]
        final_singbox = all_unique_configs[:TARGET_CONFIGS_PER_CORE]

    print("\n💾 در حال تولید فایل‌های خروجی نهایی...")
    
    # تولید فایل JSON برای فرانت‌اند
    output_for_frontend = {
        'xray': final_xray,
        'singbox': final_singbox,
        'timestamp': int(time.time()),
        'total_found': len(raw_configs),
        'speed_tested': use_speed_test
    }
    
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False, indent=2)
    print(f"✅ فایل '{OUTPUT_JSON_FILE}' با موفقیت ساخته شد.")
    
    # تولید فایل Clash
    if final_xray:
        clash_content = generate_clash_subscription(final_xray)
        if clash_content:
            with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
                f.write(clash_content)
            print(f"✅ فایل '{OUTPUT_CLASH_FILE}' با موفقیت ساخته شد.")
        else:
            print(f"⚠️ نتوانست فایل Clash معتبری تولید کند.")
    else:
        print(f"⚠️ هیچ کانفیگ Xray برای تولید فایل Clash یافت نشد.")

    elapsed_time = time.time() - start_time
    print("\n🎉 فرآیند با موفقیت تکمیل شد!")
    print("="*50)
    print("📊 خلاصه نتایج:")
    print(f"   - منابع پردازش شده: {len(all_sources)}")
    print(f"   - کانفیگ خام یافت شده: {len(raw_configs)}")
    print(f"   - Xray کانفیگ نهایی: {len(final_xray)}")
    print(f"   - Sing-box کانفیگ نهایی: {len(final_singbox)}")
    print(f"   - تست سرعت: {'فعال' if use_speed_test else 'غیرفعال'}")
    print(f"   - مدت زمان اجرا: {elapsed_time:.2f} ثانیه")
    print("="*50)

if __name__ == "__main__":
    main()
