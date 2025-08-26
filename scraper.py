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
    'User-Agent': 'V2V-Scraper/v5.4-MultiFormat',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
}

# --- تنظیمات گیت‌هاب
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 50
GITHUB_FRESHNESS_HOURS = 120 # (5 روز)
GITHUB_SEARCH_QUERIES = ['v2ray subscription', 'vless subscription', 'proxy subscription']

# --- تنظیمات تست سرعت و کیفیت‌سنجی
SPEED_TEST_API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'
MAX_CONFIGS_TO_TEST = 2000
MAX_PING_THRESHOLD = 5000 # (5 ثانیه)
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# =================================================================================
# === HELPER FUNCTIONS (توابع کمکی) ===
# =================================================================================

def _decode_padded_b64(encoded_str: str) -> str:
    """یک رشته Base64 را رمزگشایی می‌کند و در صورت نیاز به آن padding اضافه می‌کند."""
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except Exception:
        return ""

def _encode_b64(text: str) -> str:
    """یک رشته را به Base64 انکود می‌کند."""
    return base64.b64encode(text.encode('utf-8')).decode('utf-8')

# =================================================================================
# === PARSING ENGINE (موتور پردازشگر فرمت‌های مختلف) ===
# =================================================================================

def parse_structured_json(content: dict) -> set:
    """پردازش فایل‌های JSON ساختاریافته (مانند کانفیگ Sing-box) برای تمام پروتکل‌ها."""
    configs = set()
    if 'outbounds' not in content or not isinstance(content['outbounds'], list):
        return configs
        
    for outbound in content['outbounds']:
        try:
            protocol = outbound.get('protocol') or outbound.get('type')
            if not protocol: continue
            
            config_str = ""
            if protocol == 'vless':
                server, port, uuid = outbound.get('server'), outbound.get('server_port'), outbound.get('uuid')
                if not all([server, port, uuid]): continue
                name = outbound.get('tag', server)
                params = { 'type': outbound.get('transport', {}).get('type', 'tcp') }
                if outbound.get('tls', {}).get('enabled'):
                    tls_settings = outbound['tls']
                    params['security'] = 'tls'
                    params['sni'] = tls_settings.get('server_name', server)
                    if tls_settings.get('reality', {}).get('enabled'):
                        params['security'] = 'reality'
                        params['pbk'] = tls_settings['reality']['public_key']
                        params['sid'] = tls_settings['reality'].get('short_id', '')
                query_string = urlencode({k: v for k, v in params.items() if v})
                config_str = f"vless://{uuid}@{server}:{port}?{query_string}#{quote(name)}"

            elif protocol == 'vmess':
                server, port, uuid = outbound.get('server'), outbound.get('server_port'), outbound.get('uuid')
                if not all([server, port, uuid]): continue
                name = outbound.get('tag', server)
                vmess_data = {
                    "v": "2", "ps": name, "add": server, "port": port, "id": uuid,
                    "aid": outbound.get('alter_id', 0), "net": outbound.get('transport', {}).get('type', 'tcp'),
                    "type": "none", "host": "", "path": "", "tls": "none", "sni": ""
                }
                config_str = f"vmess://{_encode_b64(json.dumps(vmess_data, separators=(',', ':')))}"

            if config_str:
                configs.add(config_str)
        except (KeyError, TypeError):
            continue
    return configs

def parse_structured_yaml(content: dict) -> set:
    """پردازش فایل‌های YAML (مانند کانفیگ Clash) و تبدیل آن‌ها به لینک استاندارد."""
    configs = set()
    if 'proxies' not in content or not isinstance(content['proxies'], list):
        return configs

    for proxy in content['proxies']:
        try:
            protocol = proxy.get('type')
            server, port, name = proxy.get('server'), proxy.get('port'), proxy.get('name')
            if not all([protocol, server, port, name]): continue
            
            config_str = ""
            if protocol == 'vless':
                uuid = proxy.get('uuid')
                if not uuid: continue
                params = {'type': proxy.get('network', 'tcp'), 'sni': proxy.get('servername', server)}
                if proxy.get('tls'): params['security'] = 'tls'
                query_string = urlencode({k: v for k, v in params.items() if v})
                config_str = f"vless://{uuid}@{server}:{port}?{query_string}#{quote(name)}"

            elif protocol == 'vmess':
                uuid = proxy.get('uuid')
                if not uuid: continue
                vmess_data = {
                    "v": "2", "ps": name, "add": server, "port": port, "id": uuid,
                    "aid": proxy.get('alterId', 0), "net": proxy.get('network', 'tcp'),
                    "type": "none", "host": proxy.get('ws-opts', {}).get('headers', {}).get('Host', ''),
                    "path": proxy.get('ws-opts', {}).get('path', ''), "tls": "tls" if proxy.get('tls') else "none",
                    "sni": proxy.get('servername', server)
                }
                config_str = f"vmess://{_encode_b64(json.dumps(vmess_data, separators=(',', ':')))}"
            
            elif protocol == 'trojan':
                password = proxy.get('password')
                if not password: continue
                params = {'sni': proxy.get('sni', server)}
                query_string = urlencode({k: v for k, v in params.items() if v})
                config_str = f"trojan://{password}@{server}:{port}?{query_string}#{quote(name)}"

            if config_str:
                configs.add(config_str)
        except (KeyError, TypeError, AttributeError):
            continue
    return configs

def parse_html_content(content: str) -> set:
    """استخراج لینک‌های کانفیگ از محتوای HTML."""
    soup = BeautifulSoup(content, 'html.parser')
    text_content = soup.get_text(separator='\n')
    pattern = r'(' + '|'.join(p for p in VALID_PREFIXES) + r')[^\s\'"<>]+'
    return set(re.findall(pattern, text_content))

def fetch_and_parse_url(url: str) -> set:
    """دانلود و استخراج کانفیگ از یک URL با موتور پردازشگر هوشمند."""
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        content = response.text

        # --- موتور پردازشگر هوشمند ---
        # 1. تلاش برای پردازش به عنوان JSON
        try:
            json_content = json.loads(content)
            parsed_configs = parse_structured_json(json_content)
            if parsed_configs: return parsed_configs
        except json.JSONDecodeError:
            pass # اگر جیسون نبود، به مرحله بعد می‌رود

        # 2. تلاش برای پردازش به عنوان YAML
        try:
            yaml_content = yaml.safe_load(content)
            if isinstance(yaml_content, dict):
                parsed_configs = parse_structured_yaml(yaml_content)
                if parsed_configs: return parsed_configs
        except yaml.YAMLError:
            pass # اگر یمل نبود، به مرحله بعد می‌رود

        # 3. تلاش برای پردازش به عنوان HTML
        if '<html>' in content.lower() or url.endswith(('.html', '.htm')):
            return parse_html_content(content)

        # 4. تلاش برای رمزگشایی کل محتوا به عنوان Base64
        decoded_content = _decode_padded_b64(content)
        if decoded_content:
            content = decoded_content
            
        # 5. استخراج با Regex به عنوان آخرین راه حل
        pattern = r'(' + '|'.join(p for p in VALID_PREFIXES) + r')[^\s\'"<>]+'
        return set(re.findall(pattern, content))

    except requests.RequestException as e:
        print(f"   - هشدار: خطای شبکه در دسترسی به {url[:50]}... دلیل: {e}")
        return set()
    except Exception as e:
        print(f"   - هشدار: خطای نامشخص در پردازش {url[:50]}... دلیل: {e}")
        return set()

# =================================================================================
# === CORE FUNCTIONS (توابع اصلی - بدون تغییر) ===
# =================================================================================
# تابع‌های get_static_sources, discover_dynamic_sources, test_config_via_api, 
# validate_and_categorize_configs, generate_clash_subscription و main
# بدون تغییر باقی می‌مانند، مگر اینکه نیاز به فراخوانی توابع جدید داشته باشند.
# در اینجا کد کامل آورده شده است.

def get_static_sources() -> list:
    """خواندن منابع ثابت از فایل sources.json"""
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f).get("static", [])
    except (FileNotFoundError, json.JSONDecodeError):
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
            repos = g.search_repositories(query=f'{query} language:text', sort='updated', order='desc')
            
            for repo in repos:
                if repo.updated_at < freshness_threshold or len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                    break 
                try:
                    contents = repo.get_contents("")
                    for content_file in contents:
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md', '.yaml', '.yml', '.json')):
                            dynamic_sources.add(content_file.download_url)
                except GithubException:
                    continue
            if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
        except GithubException as e:
            print(f"   - خطا در جستجوی گیت‌هاب: {e}")
            break
    
    print(f"✅ {len(dynamic_sources)} منبع پویای تازه کشف شد.")
    return list(dynamic_sources)

def test_config_via_api(config_str: str) -> dict:
    """تست پینگ یک کانفیگ از طریق API خارجی."""
    try:
        parsed = urlparse(config_str)
        host = parsed.hostname
        port = parsed.port
        
        if parsed.scheme == 'vmess':
            decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
            host, port = decoded['add'], int(decoded['port'])
        
        if not port:
            port = {'ss': 8443, 'trojan': 443, 'vless': 443}.get(parsed.scheme, 443)
            
        response = requests.post(
            SPEED_TEST_API_ENDPOINT, 
            json={'host': host, 'port': port}, 
            headers={'Content-Type': 'application/json'}, 
            timeout=REQUEST_TIMEOUT
        )
        if response.status_code == 200:
            return {'config_str': config_str, 'ping': response.json().get('ping', 9999)}
        return {'config_str': config_str, 'ping': 9999}
    except Exception:
        return {'config_str': config_str, 'ping': 9999}

def validate_and_categorize_configs(configs: set) -> dict:
    """کانفیگ‌ها را بر اساس هسته مورد نیاز (Xray یا Sing-box) دسته‌بندی می‌کند."""
    categorized = {'xray': set(), 'singbox_only': set()}
    for cfg in configs:
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            if parsed.scheme in ('hysteria2', 'hy2', 'tuic') or query_params.get('security') == 'reality':
                categorized['singbox_only'].add(cfg)
            else:
                categorized['xray'].add(cfg)
        except Exception:
            continue
    return categorized

def generate_clash_subscription(configs: list) -> str | None:
    """یک فایل اشتراک با فرمت YAML برای کلاینت‌های Clash تولید می‌کند."""
    proxies = []
    used_names = set()
    for config_str in configs:
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'): continue
            
            url = urlparse(config_str)
            if 'reality' in url.query.lower(): continue

            name = unquote(url.fragment) if url.fragment else url.hostname
            original_name = name
            count = 1
            while name in used_names:
                name = f"{original_name}_{count}"
                count += 1
            used_names.add(name)

            proxy = {'name': name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            
            if protocol == 'vless':
                if not url.username: raise ValueError("VLESS config missing UUID")
                params = dict(parse_qsl(url.query))
                proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
                if proxy.get('network') == 'ws': 
                    proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
            elif protocol == 'vmess':
                decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
                if not decoded.get('id'): raise ValueError("VMESS config missing ID")
                proxy.update({
                    'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 
                    'alterId': decoded.get('aid'), 'cipher': decoded.get('scy', 'auto'), 
                    'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 
                    'servername': decoded.get('sni', decoded.get('add')), 'skip-cert-verify': True
                })
                if proxy.get('network') == 'ws':
                    proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
            elif protocol == 'trojan':
                if not url.username: raise ValueError("Trojan config missing password")
                params = dict(parse_qsl(url.query))
                proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})
            elif protocol == 'ss':
                cred = _decode_padded_b64(unquote(url.username)).split(':')
                if len(cred) < 2 or not cred[0] or not cred[1]: raise ValueError("SS config malformed credentials")
                proxy.update({'cipher': cred[0], 'password': cred[1]})
            
            proxies.append(proxy)
        except Exception:
            continue
            
    if not proxies: return None
    
    clash_config = {'proxies': proxies}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

def main():
    print(f"🚀 V2V Scraper v5.4 - شروع فرآیند با موتور پردازشگر چند فرمتی...")
    start_time = time.time()
    
    static_sources = get_static_sources()
    dynamic_sources = discover_dynamic_sources()
    all_sources = list(set(static_sources + dynamic_sources))
    print(f"📡 مجموع منابع جمع‌آوری شده: {len(all_sources)} ( {len(static_sources)} ثابت + {len(dynamic_sources)} پویا )")
    
    print("\n🚚 در حال دانلود و استخراج کانفیگ‌ها (با موتور هوشمند)...")
    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"📦 {len(raw_configs)} کانفیگ خام منحصر به فرد استخراج شد.")

    if not raw_configs:
        print("❌ هیچ کانفیگی یافت نشد. عملیات متوقف شد.")
        with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f: json.dump({'xray': [], 'singbox': []}, f)
        return

    print("\n🔬 در حال اعتبارسنجی و دسته‌بندی اولیه...")
    categorized_configs = validate_and_categorize_configs(raw_configs)
    xray_compatible_set = categorized_configs['xray']
    all_unique_configs = list(xray_compatible_set.union(categorized_configs['singbox_only']))
    print(f"✅ دسته‌بندی: {len(categorized_configs['xray'])} کانفیگ Xray | {len(categorized_configs['singbox_only'])} کانفیگ فقط Sing-box")
    
    configs_to_test = all_unique_configs
    if len(all_unique_configs) > MAX_CONFIGS_TO_TEST:
        print(f"⚠️ تعداد کل کانفیگ‌ها ({len(all_unique_configs)}) زیاد است. {MAX_CONFIGS_TO_TEST} عدد برای تست نمونه‌گیری می‌شود.")
        configs_to_test = all_unique_configs[:MAX_CONFIGS_TO_TEST]

    print(f"\n🏃‍♂️ در حال تست سرعت {len(configs_to_test)} کانفیگ منحصر به فرد...")
    all_fast_configs_results = []
    with ThreadPoolExecutor(max_workers=30) as executor:
        future_to_config = {executor.submit(test_config_via_api, cfg): cfg for cfg in configs_to_test}
        for future in as_completed(future_to_config):
            result = future.result()
            if result['ping'] < MAX_PING_THRESHOLD:
                all_fast_configs_results.append(result)

    print(f"⚡ {len(all_fast_configs_results)} کانفیگ سریع (زیر {MAX_PING_THRESHOLD}ms) در مجموع یافت شد.")
    all_fast_configs_results.sort(key=lambda x: x['ping'])

    final_xray = []
    for result in all_fast_configs_results:
        if len(final_xray) >= TARGET_CONFIGS_PER_CORE:
            break
        if result['config_str'] in xray_compatible_set:
            final_xray.append(result['config_str'])
            
    final_singbox = [res['config_str'] for res in all_fast_configs_results[:TARGET_CONFIGS_PER_CORE]]

    print("\n💾 در حال تولید فایل‌های خروجی نهایی...")
    output_for_frontend = {
        'xray': final_xray,
        'singbox': final_singbox
    }
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False, indent=2)
    print(f"✅ فایل '{OUTPUT_JSON_FILE}' با موفقیت برای فرانت‌اند ساخته شد.")
    
    clash_content = generate_clash_subscription(final_xray)
    if clash_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_content)
        print(f"✅ فایل '{OUTPUT_CLASH_FILE}' با موفقیت برای کلاینت‌های کلش ساخته شد.")
    else:
        print(f"⚠️ هیچ کانفیگ سازگار با کلش یافت نشد. فایل '{OUTPUT_CLASH_FILE}' آپدیت نشد.")

    elapsed_time = time.time() - start_time
    print("\n🎉 فرآیند با موفقیت تکمیل شد!")
    print("="*30)
    print("📊 خلاصه نتایج:")
    print(f"   - Xray کانفیگ نهایی: {len(final_xray)}")
    print(f"   - Sing-box کانفیگ نهایی: {len(final_singbox)}")
    print(f"   - مجموع کانفیگ‌های سریع یافت شده: {len(all_fast_configs_results)}")
    print(f"   - مدت زمان اجرا: {elapsed_time:.2f} ثانیه")
    print("="*30)

if __name__ == "__main__":
    main()
