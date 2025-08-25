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
from urllib.parse import urlparse, parse_qsl, unquote
from github import Github, Auth

# =================================================================================
# === CONFIGURATION (تنظیمات) ===
# =================================================================================

# --- فایل‌های ورودی و خروجی
SOURCES_FILE = "sources.json"
OUTPUT_JSON_FILE = "all_live_configs.json"
OUTPUT_CLASH_FILE = "clash_subscription.yaml"

# --- تنظیمات عمومی
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {'User-Agent': 'V2V-Scraper/v4.0-Final'}

# --- تنظیمات گیت‌هاب
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_LIMIT = 50
GITHUB_FRESHNESS_HOURS = 48
GITHUB_SEARCH_QUERIES = ['v2ray subscription', 'vless subscription', 'proxy subscription']

# --- تنظیمات تست سرعت و کیفیت‌سنجی
SPEED_TEST_API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'
MAX_CONFIGS_TO_TEST = 2000
SPEED_TEST_BATCH_SIZE = 20
MAX_PING_THRESHOLD = 1200
TARGET_CONFIGS_PER_CORE = 400
REQUEST_TIMEOUT = 10

if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# =================================================================================
# === CORE FUNCTIONS (توابع اصلی) ===
# =================================================================================

def get_static_sources() -> list:
    """خواندن منابع ثابت از فایل sources.json"""
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f).get("static", [])
    except Exception:
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
                if repo.updated_at < freshness_threshold:
                    break 
                
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                    break

                try:
                    contents = repo.get_contents("")
                    for content_file in contents:
                        if content_file.type == 'file' and content_file.name.lower().endswith(('.txt', '.md', '.yaml', '.yml')):
                            dynamic_sources.add(content_file.download_url)
                except Exception:
                    continue
            
            if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                break
        except Exception as e:
            print(f"   - خطا در جستجوی گیت‌هاب: {e}")
            break
    
    print(f"✅ {len(dynamic_sources)} منبع پویای تازه کشف شد.")
    return list(dynamic_sources)

def fetch_and_parse_url(url: str) -> set:
    """دانلود و استخراج کانفیگ از یک URL"""
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        content = response.text
        
        try:
            decoded_content = base64.b64decode(content).decode('utf-8')
            content = decoded_content
        except Exception:
            pass

        pattern = r'(' + '|'.join(p for p in VALID_PREFIXES) + r')[^\s\'"<>]+'
        return set(re.findall(pattern, content))

    except requests.RequestException:
        return set()

def test_config_via_api(config_str: str) -> dict:
    """تست یک کانفیگ از طریق API ورسل"""
    try:
        parsed = urlparse(config_str)
        host = parsed.hostname
        port = parsed.port

        if parsed.scheme == 'vmess':
            decoded = json.loads(base64.b64decode(config_str.replace("vmess://", "")).decode('utf-8'))
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
    """اعتبارسنجی و دسته‌بندی کانفیگ‌ها به Xray و Sing-box"""
    categorized = {'xray': set(), 'singbox': set()}
    for cfg in configs:
        try:
            parsed = urlparse(cfg)
            core = 'xray'
            if parsed.scheme in ('hysteria2', 'hy2', 'tuic'):
                core = 'singbox'
            elif 'reality' in parse_qsl(parsed.query):
                core = 'singbox'
            categorized[core].add(cfg)
        except Exception:
            continue
    return categorized

# === MODIFIED FUNCTION: generate_clash_subscription ===
def generate_clash_subscription(configs: list) -> str | None:
    """
    تولید فایل اشتراک کلش سالم و بدون خطا.
    این تابع شامل ۳ لایه کنترلی است:
    ۱. حل نام‌های تکراری (Duplicate)
    ۲. اعتبارسنجی سخت‌گیرانه برای حذف کانفیگ‌های ناقص (مثل نبود پسوورد)
    ۳. نادیده گرفتن پروتکل‌های ناسازگار
    """
    proxies = []
    used_names = set()

    for config_str in configs:
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'):
                continue
            
            url = urlparse(config_str)
            if 'reality' in url.query.lower():
                continue

            name = unquote(url.fragment) if url.fragment else url.hostname
            
            # --- FIX 1: Handle duplicate names ---
            original_name = name
            count = 1
            while name in used_names:
                name = f"{original_name}_{count}"
                count += 1
            used_names.add(name)

            proxy = {'name': name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            
            # --- FIX 2: Strict validation for each protocol ---
            if protocol == 'vless':
                if not url.username: raise ValueError("VLESS config missing UUID")
                params = dict(parse_qsl(url.query))
                proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
                if proxy.get('network') == 'ws':
                    proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
            
            elif protocol == 'vmess':
                decoded = json.loads(base64.b64decode(config_str.replace("vmess://", "")).decode('utf-8'))
                if not decoded.get('id'): raise ValueError("VMESS config missing ID")
                proxy.update({'uuid': decoded.get('id'), 'alterId': decoded.get('aid'), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 'servername': decoded.get('sni', decoded.get('add')), 'skip-cert-verify': True})
                proxy.update({'server': decoded.get('add'), 'port': int(decoded.get('port'))})

            elif protocol == 'trojan':
                if not url.username: raise ValueError("Trojan config missing password")
                params = dict(parse_qsl(url.query))
                proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})

            elif protocol == 'ss':
                if not url.username: raise ValueError("SS config missing credentials")
                cred_part = unquote(url.username)
                # Add padding for base64
                cred_part += '=' * (-len(cred_part) % 4)
                cred = base64.b64decode(cred_part).decode().split(':')
                if len(cred) < 2 or not cred[0] or not cred[1]: raise ValueError("SS config malformed credentials")
                proxy.update({'cipher': cred[0], 'password': cred[1]})
            
            proxies.append(proxy)
        except Exception as e:
            #print(f"Skipping invalid Clash config: {config_str} | Error: {e}")
            continue
            
    # --- FIX 3: Prevent generating empty file ---
    if not proxies:
        return None # اگر هیچ پراکسی سازگاری یافت نشد، هیچی برنگردان

    clash_config = {'proxies': proxies}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

# =================================================================================
# === MAIN EXECUTION (اجرای اصلی) ===
# =================================================================================
def main():
    print("🚀 V2V Scraper v4.0 - شروع فرآیند ادغام و بهینه‌سازی...")
    start_time = time.time()

    # --- 1. جمع‌آوری منابع ---
    static_sources = get_static_sources()
    dynamic_sources = discover_dynamic_sources()
    all_sources = list(set(static_sources + dynamic_sources))
    print(f"📡 مجموع منابع جمع‌آوری شده: {len(all_sources)} ( {len(static_sources)} ثابت + {len(dynamic_sources)} پویا )")

    # --- 2. استخراج کانفیگ‌ها ---
    print("\n🚚 در حال دانلود و استخراج کانفیگ‌ها...")
    raw_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for result in executor.map(fetch_and_parse_url, all_sources):
            raw_configs.update(result)
    print(f"📦 {len(raw_configs)} کانفیگ خام منحصر به فرد استخراج شد.")

    if not raw_configs:
        print("❌ هیچ کانفیگی یافت نشد. عملیات متوقف شد.")
        return

    # --- 3. اعتبارسنجی و دسته‌بندی ---
    print("\n🔬 در حال اعتبارسنجی و دسته‌بندی اولیه...")
    categorized_configs = validate_and_categorize_configs(raw_configs)
    categorized_configs['singbox'].update(categorized_configs['xray'])
    
    print(f"✅ دسته‌بندی اولیه: {len(categorized_configs['xray'])} کانفیگ Xray | {len(categorized_configs['singbox'])} کانفیگ Sing-box")

    # --- 4. تست سرعت و کیفیت‌سنجی ---
    final_configs = {'xray': [], 'singbox': []}
    for core_name, configs_to_test in categorized_configs.items():
        if not configs_to_test: continue
        
        if len(configs_to_test) > MAX_CONFIGS_TO_TEST:
            print(f"⚠️ تعداد کانفیگ‌های {core_name} ({len(configs_to_test)}) زیاد است. {MAX_CONFIGS_TO_TEST} عدد برای تست نمونه‌گیری می‌شود.")
            configs_to_test = list(configs_to_test)[:MAX_CONFIGS_TO_TEST]

        print(f"\n🏃‍♂️ در حال تست سرعت {len(configs_to_test)} کانفیگ برای هسته {core_name.upper()}...")
        
        fast_configs = []
        with ThreadPoolExecutor(max_workers=30) as executor:
            future_to_config = {executor.submit(test_config_via_api, cfg): cfg for cfg in configs_to_test}
            for future in as_completed(future_to_config):
                result = future.result()
                if result['ping'] < MAX_PING_THRESHOLD:
                    fast_configs.append(result)

        print(f"⚡ {len(fast_configs)} کانفیگ سریع (زیر {MAX_PING_THRESHOLD}ms) برای {core_name} یافت شد.")

        fast_configs.sort(key=lambda x: x['ping'])
        final_configs[core_name] = fast_configs[:TARGET_CONFIGS_PER_CORE]

    # --- 5. تولید فایل‌های خروجی ---
    print("\n💾 در حال تولید فایل‌های خروجی نهایی...")

    # 5.1: تولید all_live_configs.json (با فرمت ساده برای فرانت‌اند)
    output_for_frontend = {
        'xray': [cfg['config_str'] for cfg in final_configs['xray']],
        'singbox': [cfg['config_str'] for cfg in final_configs['singbox']]
    }
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_for_frontend, f, ensure_ascii=False, indent=2)
    print(f"✅ فایل '{OUTPUT_JSON_FILE}' با موفقیت برای فرانت‌اند ساخته شد.")

    # 5.2: تولید clash_subscription.yaml (با منطق جدید و امن)
    clash_content = generate_clash_subscription(output_for_frontend['xray'])
    if clash_content:
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_content)
        print(f"✅ فایل '{OUTPUT_CLASH_FILE}' با موفقیت برای کلاینت‌های کلش ساخته شد.")
    else:
        print(f"⚠️ هیچ کانفیگ سازگار با کلش یافت نشد. فایل '{OUTPUT_CLASH_FILE}' آپدیت نشد تا لینک کاربران خراب نشود.")

    # --- 6. گزارش نهایی ---
    total_final_configs = len(output_for_frontend['xray']) + len(output_for_frontend['singbox'])
    elapsed_time = time.time() - start_time
    print("\n🎉 فرآیند با موفقیت تکمیل شد!")
    print("="*30)
    print("📊 خلاصه نتایج:")
    print(f"   -  Xray کانفیگ نهایی: {len(output_for_frontend['xray'])}")
    print(f"   - Sing-box کانفیگ نهایی: {len(output_for_frontend['singbox'])}")
    print(f"   - مجموع کل: {total_final_configs} کانفیگ سالم و سریع")
    print(f"   - مدت زمان اجرا: {elapsed_time:.2f} ثانیه")
    print("="*30)

if __name__ == "__main__":
    main()

