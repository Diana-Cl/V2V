import requests
import base64
import json
import re
import binascii
import os
import yaml
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, unquote
from github import Github, Auth

# --- پیکربندی ---
SOURCES_FILE = "sources.json"
OUTPUT_JSON_FILE = "all_live_configs.json"
OUTPUT_CLASH_FILE = "clash_subscription.yaml"
GH_PAT = os.environ.get('GH_PAT') # توکن گیت‌هاب برای جستجوی پویا
HEADERS = {'User-Agent': 'V2V-Scraper/3.0-Final'}
CLASH_COMPATIBLE_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}

# --- منطق اصلی ---

def process_url(url: str) -> set[str]:
    """محتوای یک URL را دریافت، دیکُد و کانفیگ‌های آن را استخراج می‌کند."""
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        content = response.text
    except requests.RequestException:
        return set()

    try:
        content_sanitized = content.strip().replace('\r', '').replace('\n', '')
        missing_padding = len(content_sanitized) % 4
        if missing_padding:
            content_sanitized += '=' * (4 - missing_padding)
        content = base64.b64decode(content_sanitized).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError, ValueError):
        pass

    return set(re.findall(r'(vless|vmess|trojan|ss|wg)://[^\s\'"]+', content))

def search_github_for_configs() -> set[str]:
    """منابع جدید و به‌روز را از طریق جستجو در گیت‌هاب پیدا می‌کند."""
    if not GH_PAT:
        print("توکن گیت‌هاب (GH_PAT) یافت نشد. از جستجوی پویا صرف نظر می‌شود.")
        return set()
    
    print("شروع جستجوی پویا در گیت‌هاب برای یافتن منابع جدید...")
    auth = Auth.Token(GH_PAT)
    g = Github(auth=auth)
    query = '"vless://" OR "vmess://" OR "trojan://" in:file extension:txt'
    
    configs = set()
    try:
        results = g.search_code(query, sort='indexed', order='desc')
        # فقط ۵۰ نتیجه اول را برای به‌روز بودن و جلوگیری از محدودیت بررسی می‌کنیم
        for i, content_file in enumerate(results):
            if i >= 50:
                break
            download_url = content_file.download_url
            if download_url:
                configs.update(process_url(download_url))
    except Exception as e:
        print(f"خطا در جستجوی گیت‌هاب: {e}")
        
    print(f"تعداد {len(configs)} کانفیگ از منابع پویای گیت‌هاب یافت شد.")
    return configs

def generate_clash_subscription(configs: list) -> str:
    """یک فایل اشتراک کلش استاندارد از کانفیگ‌های ورودی تولید می‌کند."""
    proxies = []
    for config_str in configs:
        protocol = config_str.split("://")[0]
        if protocol not in CLASH_COMPATIBLE_PROTOCOLS:
            continue
        try:
            url = urlparse(config_str)
            if 'reality' in url.query.lower(): continue
            name = unquote(url.fragment) if url.fragment else url.hostname
            proxy = {'name': name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            
            if protocol == 'vless':
                params = dict(parse_qsl(url.query))
                proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
                if proxy['network'] == 'ws':
                    proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
            elif protocol == 'vmess':
                decoded = json.loads(base64.b64decode(config_str.replace("vmess://", "")).decode('utf-8'))
                proxy.update({'uuid': decoded['id'], 'alterId': decoded['aid'], 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 'servername': decoded.get('sni', decoded['add']), 'skip-cert-verify': True})
                proxy.update({'server': decoded['add'], 'port': int(decoded['port'])})
            elif protocol == 'trojan':
                params = dict(parse_qsl(url.query))
                proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})
            elif protocol == 'ss':
                cred = base64.b64decode(unquote(url.username)).decode().split(':')
                proxy.update({'cipher': cred[0], 'password': cred[1]})
            
            proxies.append(proxy)
        except Exception:
            continue
            
    clash_config = {'proxies': proxies}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

def main():
    """تابع اصلی برای اجرای اسکریپت"""
    from urllib.parse import parse_qsl
    
    print("شروع به کار اسکریپت V2V...")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            static_sources = json.load(f).get("static", [])
    except Exception as e:
        print(f"خطا در خواندن sources.json: {e}")
        return

    print(f"پردازش {len(static_sources)} منبع ثابت...")
    static_configs = set()
    with ThreadPoolExecutor(max_workers=20) as executor:
        for result in executor.map(process_url, static_sources):
            static_configs.update(result)
    print(f"تعداد {len(static_configs)} کانفیگ از منابع ثابت یافت شد.")

    dynamic_configs = search_github_for_configs()
    all_configs = static_configs.union(dynamic_configs)
    print(f"تعداد کل کانفیگ‌های منحصر به فرد: {len(all_configs)}")

    # دسته‌بندی نهایی
    final_configs = {"xray": [], "singbox": []}
    for cfg in all_configs:
        if 'reality' in cfg.lower() or cfg.startswith('wg://'):
            final_configs["singbox"].append(cfg)
        else:
            final_configs["xray"].append(cfg)
    
    # اضافه کردن کانفیگ‌های استاندارد به singbox
    final_configs["singbox"].extend([c for c in final_configs["xray"] if c.startswith(('vless://', 'vmess://', 'trojan://'))])
    final_configs["xray"] = sorted(list(set(final_configs["xray"])))
    final_configs["singbox"] = sorted(list(set(final_configs["singbox"])))

    # ذخیره خروجی JSON
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    print(f"فایل {OUTPUT_JSON_FILE} با موفقیت ساخته شد.")

    # ساخت و ذخیره فایل اشتراک کلش
    clash_content = generate_clash_subscription(final_configs["xray"])
    with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
        f.write(clash_content)
    print(f"فایل {OUTPUT_CLASH_FILE} با موفقیت ساخته شد.")
    
    print("عملیات با موفقیت به پایان رسید.")

if __name__ == "__main__":
    main()
