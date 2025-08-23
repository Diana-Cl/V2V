import requests
import base64
import os
import json
import re
import socket
import time
import yaml
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION ===
BASE_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt", "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt", "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime", "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix", "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub4.txt", "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub5.txt", "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/detailed/vless/2087.txt", "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]

# تنظیمات کلی
OUTPUT_JSON_FILE = 'all_live_configs.json'
OUTPUT_CLASH_FILE = 'best_clash.yaml'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://', 'wg://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Complete-v4.0'}
if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# تنظیمات تست سرعت
TARGET_CONFIGS_PER_CORE = 500
MAX_PING_THRESHOLD = 1000
API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'
BATCH_SIZE = 20
MAX_WORKERS = 30
REQUEST_TIMEOUT = 8
GITHUB_SEARCH_LIMIT = 30
MAX_RAW_CONFIGS_TO_TEST = 2000 # NEW: Performance Optimization
TOP_CLASH_CONFIGS_COUNT = 100 # NEW: For auto clash file

# کلمات کلیدی برای جستجوی GitHub
GITHUB_SEARCH_QUERIES = [ 'v2ray subscription', 'vmess config', 'vless subscription', 'trojan config', 'xray config', 'clash subscription' ]

# (بقیه توابع کمکی مانند قبل باقی می‌مانند)
def search_github_repositories(query: str, max_results: int = 10) -> list:
    # ... (بدون تغییر)
    if not GITHUB_PAT: return []
    try:
        url = 'https://api.github.com/search/repositories'
        params = {'q': f'{query} language:text sort:updated', 'sort': 'updated', 'order': 'desc', 'per_page': max_results}
        response = requests.get(url, params=params, headers=HEADERS, timeout=10)
        if response.status_code != 200: return []
        data = response.json()
        repos = []
        for item in data.get('items', []):
            if (item.get('size', 0) < 50000 and not item.get('fork', False) and item.get('updated_at')):
                repos.append({'owner': item['owner']['login'], 'name': item['name'], 'full_name': item['full_name']})
        return repos
    except Exception as e:
        print(f"⚠️ خطا در جستجوی GitHub: {e}")
        return []

def get_repository_files(owner: str, repo: str) -> list:
    # ... (بدون تغییر)
    if not GITHUB_PAT: return []
    try:
        paths_to_check = ['', 'sub', 'subs', 'subscription', 'config', 'configs']
        file_urls = []
        for path in paths_to_check:
            url = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
            try:
                response = requests.get(url, headers=HEADERS, timeout=8)
                if response.status_code != 200: continue
                contents = response.json()
                if isinstance(contents, list):
                    for item in contents:
                        if (item.get('type') == 'file' and item.get('name', '').lower().endswith(('.txt', '.yaml', '.yml', '.sub'))):
                            file_urls.append(item['download_url'])
                        if len(file_urls) >= 5: break
            except: continue
            if len(file_urls) >= 5: break
        return file_urls[:5]
    except Exception: return []

def discover_dynamic_sources() -> list:
    # ... (بدون تغییر)
    print("🔍 کشف منابع پویا از GitHub...")
    dynamic_sources = []
    if not GITHUB_PAT:
        print("⚠️ GitHub PAT یافت نشد، از منابع پویا صرف‌نظر می‌شود")
        return []
    try:
        for query in GITHUB_SEARCH_QUERIES[:3]:
            repos = search_github_repositories(query, max_results=5)
            for repo in repos:
                file_urls = get_repository_files(repo['owner'], repo['name'])
                dynamic_sources.extend(file_urls)
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
            if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT: break
            time.sleep(1)
    except Exception as e:
        print(f"⚠️ خطا در کشف منابع پویا: {e}")
    unique_sources = list(set(dynamic_sources))
    print(f"✅ {len(unique_sources)} منبع پویا کشف شد")
    return unique_sources

def get_content_from_url(url: str) -> str | None:
    # ... (بدون تغییر)
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except Exception:
        return None

def decode_content(content: str) -> list[str]:
    # ... (بدون تغییر)
    try:
        return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception:
        return content.strip().splitlines()

def fetch_and_parse_url(url: str) -> set[str]:
    # ... (بدون تغییر)
    content = get_content_from_url(url)
    if not content: return set()
    configs = set()
    lines = decode_content(content)
    for line in lines:
        line = line.strip()
        if line.startswith(VALID_PREFIXES): configs.add(line)
    pattern = r'(' + '|'.join([p.replace('://', r'://[^\s\'"<]+') for p in VALID_PREFIXES]) + ')'
    found_configs = re.findall(pattern, content)
    for config in found_configs: configs.add(config.strip())
    return configs

def parse_server_details(config_url: str) -> dict | None:
    # ... (بدون تغییر)
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        if protocol == 'ss':
            at_index = config_url.rfind('@')
            host_part = config_url[at_index + 1:].split('#')[0]
            host, port_str = host_part.rsplit(':', 1)
            return {'host': host, 'port': int(port_str)}
        if protocol == 'vmess':
            decoded = json.loads(base64.b64decode(config_url.replace("vmess://", "")).decode('utf-8'))
            return {'host': decoded.get('add'), 'port': int(decoded.get('port', 0))}
        if parsed_url.hostname:
            return {'host': parsed_url.hostname, 'port': parsed_url.port or 443}
        return None
    except Exception:
        return None

def test_config_via_vercel_api(config_url: str) -> dict:
    # ... (بدون تغییر)
    server_details = parse_server_details(config_url)
    if not server_details: return {'config_str': config_url, 'ping': 9999, 'status': 'parse_error'}
    try:
        response = requests.post(API_ENDPOINT, json=server_details, headers={'Content-Type': 'application/json'}, timeout=REQUEST_TIMEOUT)
        if response.status_code == 200:
            ping = response.json().get('ping', 9999)
            return {'config_str': config_url, 'ping': ping, 'status': 'success' if ping < 9999 else 'timeout'}
        return {'config_str': config_url, 'ping': 9999, 'status': f'api_error_{response.status_code}'}
    except Exception:
        return {'config_str': config_url, 'ping': 9999, 'status': 'network_error'}

def validate_and_categorize_config(config_url: str) -> dict | None:
    # ... (بدون تغییر)
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        if not parsed_url.hostname and protocol not in ['vmess', 'ss', 'wg']: return None
        core = 'xray'
        if protocol in ['hysteria2', 'hy2', 'tuic', 'wg']: core = 'singbox'
        elif protocol == 'vless' and 'reality' in parsed_url.query:
                core = 'singbox'
        return {'core': core, 'config_str': config_url}
    except Exception:
        return None

def process_configs_batch(configs_batch: list) -> list:
    # ... (بدون تغییر)
    results = []
    with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
        future_to_config = {executor.submit(test_config_via_vercel_api, cfg): cfg for cfg in configs_batch}
        for future in as_completed(future_to_config):
            try:
                result = future.result()
                if result['ping'] <= MAX_PING_THRESHOLD: results.append(result)
            except Exception: pass
    return results

# NEW: Function to generate Clash config file from a list of configs
def generate_clash_config_from_urls(configs: list) -> str:
    proxies = []
    for config_str in configs:
        try:
            url = urlparse(config_str)
            name = unquote(url.fragment) if url.fragment else url.hostname
            proxy = {'name': name, 'server': url.hostname, 'port': url.port}

            if url.scheme == 'vless':
                proxy.update({
                    'type': 'vless', 'uuid': url.username,
                    'tls': 'tls' in url.query, 'network': 'ws',
                    'ws-opts': {'path': parse_qs(url.query).get('path', ['/'])[0], 'headers': {'Host': url.hostname}}
                })
            elif url.scheme == 'vmess':
                decoded = json.loads(base64.b64decode(config_str.replace("vmess://", "")).decode('utf-8'))
                proxy.update({
                    'type': 'vmess', 'uuid': decoded['id'], 'alterId': decoded['aid'], 'cipher': decoded.get('scy', 'auto'),
                    'server': decoded['add'], 'port': int(decoded['port']), 'tls': decoded.get('tls') == 'tls',
                    'network': decoded.get('net', 'tcp')
                })
            elif url.scheme == 'trojan':
                proxy.update({'type': 'trojan', 'password': url.username})
            elif url.scheme == 'ss':
                cred = base64.b64decode(url.username).decode().split(':')
                proxy.update({'type': 'ss', 'cipher': cred[0], 'password': cred[1]})
            else: continue
            proxies.append(proxy)
        except Exception: continue
    
    clash_config = {
        'proxies': proxies,
        'proxy-groups': [{'name': 'V2V-Auto', 'type': 'select', 'proxies': [p['name'] for p in proxies]}],
        'rules': ['MATCH,V2V-Auto']
    }
    return yaml.dump(clash_config, allow_unicode=True)

def main():
    print("🚀 V2V Scraper v4.0 - Optimized & Automated Clash Generation")
    all_sources = BASE_SOURCES.copy()
    all_sources.extend(discover_dynamic_sources())
    print(f"📡 مجموع منابع: {len(all_sources)}")

    all_configs_raw = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for config_set in executor.map(fetch_and_parse_url, all_sources):
            all_configs_raw.update(config_set)
    
    print(f"📦 مجموع {len(all_configs_raw)} کانفیگ خام استخراج شد")
    if not all_configs_raw:
        print("❌ هیچ کانفیگی یافت نشد!")
        return

    categorized_configs = {'xray': [], 'singbox': []}
    for cfg in all_configs_raw:
        result = validate_and_categorize_config(cfg)
        if result and result.get('core') in categorized_configs:
            categorized_configs[result['core']].append(result['config_str'])
    
    print(f"✅ کانفیگ‌های معتبر: Xray={len(categorized_configs['xray'])}, Singbox={len(categorized_configs['singbox'])}")
    
    final_configs = {'xray': [], 'singbox': []}
    for core_name, configs in categorized_configs.items():
        if not configs: continue
        
        # NEW: Performance optimization - test a random sample
        if len(configs) > MAX_RAW_CONFIGS_TO_TEST:
            print(f"⚠️ تعداد کانفیگ‌های {core_name.upper()} ({len(configs)}) زیاد است. تست روی {MAX_RAW_CONFIGS_TO_TEST} کانفیگ تصادفی انجام می‌شود.")
            configs_to_test = random.sample(configs, MAX_RAW_CONFIGS_TO_TEST)
        else:
            configs_to_test = configs

        print(f"\n🏃 تست سرعت {len(configs_to_test)} کانفیگ {core_name.upper()}...")
        tested_configs = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            future_to_config = {executor.submit(test_config_via_vercel_api, cfg): cfg for cfg in configs_to_test}
            for future in as_completed(future_to_config):
                try:
                    result = future.result()
                    if result['ping'] <= MAX_PING_THRESHOLD:
                        tested_configs.append(result)
                except Exception:
                    pass
        
        tested_configs.sort(key=lambda x: x['ping'])
        best_configs = tested_configs[:TARGET_CONFIGS_PER_CORE]
        final_configs[core_name] = [{'config_str': cfg['config_str'], 'ping': cfg['ping']} for cfg in best_configs]
        print(f"🎯 {core_name.upper()}: {len(final_configs[core_name])} کانفیگ نهایی انتخاب شد")

    # NEW: Generate and save the automatic Clash file
    if final_configs['xray']:
        print(f"\n🛠️ ساخت فایل Clash خودکار از {TOP_CLASH_CONFIGS_COUNT} کانفیگ برتر...")
        top_xray_configs = [cfg['config_str'] for cfg in final_configs['xray'][:TOP_CLASH_CONFIGS_COUNT]]
        clash_content = generate_clash_config_from_urls(top_xray_configs)
        with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
            f.write(clash_content)
        print(f"✅ فایل {OUTPUT_CLASH_FILE} با موفقیت ساخته شد.")

    print(f"\n💾 ذخیره کانفیگ‌ها در {OUTPUT_JSON_FILE}...")
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    
    print("\n🎉 فرآیند تکمیل شد!")

if __name__ == "__main__":
    main()
