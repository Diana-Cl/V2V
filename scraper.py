import requests
import base64
import os
import json
import re
import time
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs

# === CONFIGURATION ===
# منابع ثابت (18 منبع مطمئن)
BASE_SUBSCRIPTION_SOURCES = [
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt",
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub4.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub5.txt",
    "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/detailed/vless/2087.txt",
    "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]

# تنظیمات کلی
OUTPUT_JSON_FILE = 'all_live_configs.json'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Complete-v3.0'}
if GITHUB_PAT:
    HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# تنظیمات تست سرعت
TARGET_CONFIGS_PER_CORE = 500  # 500 برای هر core
MAX_PING_THRESHOLD = 1000      # حداکثر 1000ms
API_ENDPOINT = 'https://v2-v.vercel.app/api/proxy'  # API ورسل شما
BATCH_SIZE = 15                # تعداد تست همزمان
MAX_WORKERS = 25               # تعداد thread
REQUEST_TIMEOUT = 8            # timeout برای هر درخواست API
GITHUB_SEARCH_LIMIT = 30       # حداکثر repo برای جستجو

# کلمات کلیدی برای جستجوی GitHub
GITHUB_SEARCH_QUERIES = [
    'v2ray subscription',
    'vmess config',
    'vless subscription',
    'trojan config',
    'xray config',
    'clash subscription',
    'v2ray configs',
    'proxy subscription'
]

# === GITHUB SEARCH FUNCTIONS ===
def search_github_repositories(query: str, max_results: int = 10) -> list:
    """جستجو در GitHub برای repository های مرتبط"""
    if not GITHUB_PAT:
        return []
    
    try:
        url = 'https://api.github.com/search/repositories'
        params = {
            'q': f'{query} language:text sort:updated',
            'sort': 'updated',
            'order': 'desc',
            'per_page': max_results
        }
        
        response = requests.get(url, params=params, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            return []
        
        data = response.json()
        repos = []
        
        for item in data.get('items', []):
            # فیلتر repository های مناسب
            if (item.get('size', 0) < 50000 and  # نه خیلی بزرگ
                not item.get('fork', False) and   # اصلی باشه نه fork
                item.get('updated_at')):          # اخیراً بروز شده
                
                repos.append({
                    'owner': item['owner']['login'],
                    'name': item['name'],
                    'full_name': item['full_name']
                })
        
        return repos
    except Exception as e:
        print(f"⚠️ خطا در جستجوی GitHub: {e}")
        return []

def get_repository_files(owner: str, repo: str) -> list:
    """دریافت فایل‌های مناسب از یک repository"""
    if not GITHUB_PAT:
        return []
    
    try:
        # جستجو در root و زیرپوشه‌های معمول
        paths_to_check = ['', 'sub', 'subs', 'subscription', 'config', 'configs']
        file_urls = []
        
        for path in paths_to_check:
            url = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
            try:
                response = requests.get(url, headers=HEADERS, timeout=8)
                if response.status_code != 200:
                    continue
                
                contents = response.json()
                if isinstance(contents, list):
                    for item in contents:
                        if (item.get('type') == 'file' and
                            item.get('name', '').lower().endswith(('.txt', '.yaml', '.yml', '.sub'))):
                            file_urls.append(item['download_url'])
                        
                        # محدود کردن تعداد فایل‌ها از هر repo
                        if len(file_urls) >= 5:
                            break
            except:
                continue
            
            if len(file_urls) >= 5:
                break
        
        return file_urls[:5]  # حداکثر 5 فایل از هر repo
    except Exception:
        return []

def discover_dynamic_sources() -> list:
    """کشف منابع پویا از GitHub"""
    print("🔍 کشف منابع پویا از GitHub...")
    dynamic_sources = []
    
    if not GITHUB_PAT:
        print("⚠️ GitHub PAT یافت نشد، از منابع پویا صرف‌نظر می‌شود")
        return []
    
    try:
        for query in GITHUB_SEARCH_QUERIES[:3]:  # محدود کردن جستجو
            repos = search_github_repositories(query, max_results=5)
            
            for repo in repos:
                file_urls = get_repository_files(repo['owner'], repo['name'])
                dynamic_sources.extend(file_urls)
                
                # محدود کردن کل منابع پویا
                if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                    break
            
            if len(dynamic_sources) >= GITHUB_SEARCH_LIMIT:
                break
            
            time.sleep(1)  # Rate limiting
    
    except Exception as e:
        print(f"⚠️ خطا در کشف منابع پویا: {e}")
    
    # حذف تکراری
    unique_sources = list(set(dynamic_sources))
    print(f"✅ {len(unique_sources)} منبع پویا کشف شد")
    return unique_sources

# === HELPER FUNCTIONS ===
def get_content_from_url(url: str) -> str | None:
    """دانلود محتوا از URL"""
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except Exception:
        return None

def decode_content(content: str) -> list[str]:
    """رمزگشایی محتوای base64 یا برگردان خطوط مستقیم"""
    try:
        # تلاش برای decode base64
        decoded = base64.b64decode(content).decode('utf-8').strip()
        return decoded.splitlines()
    except Exception:
        # اگر base64 نبود، خطوط مستقیم برگردان
        return content.strip().splitlines()

def fetch_and_parse_url(url: str) -> set[str]:
    """دانلود و استخراج کانفیگ از یک URL"""
    content = get_content_from_url(url)
    if not content:
        return set()
    
    configs = set()
    lines = decode_content(content)
    
    # استخراج از خطوط مستقیم
    for line in lines:
        line = line.strip()
        if line.startswith(VALID_PREFIXES):
            configs.add(line)
    
    # استخراج از HTML با regex
    pattern = r'(' + '|'.join([p.replace('://', r'://[^\s\'"<>]+') for p in VALID_PREFIXES]) + ')'
    found_configs = re.findall(pattern, content)
    for config in found_configs:
        configs.add(config.strip())
    
    return configs

def parse_server_details(config_url: str) -> dict | None:
    """استخراج host و port از کانفیگ برای تست ping"""
    try:
        # Handle SS protocol
        if config_url.startswith('ss://'):
            at_index = config_url.rfind('@')
            if at_index == -1:
                return None
            
            host_part = config_url[at_index + 1:]
            if '#' in host_part:
                host_part = host_part[:host_part.rfind('#')]
            
            colon_index = host_part.rfind(':')
            if colon_index == -1:
                return None
            
            host = host_part[:colon_index]
            try:
                port = int(host_part[colon_index + 1:])
                return {'host': host, 'port': port}
            except ValueError:
                return None
        
        # Handle VMESS protocol
        if config_url.startswith('vmess://'):
            try:
                parsed = urlparse(config_url)
                b64_data = parsed.hostname
                
                # Add padding if needed
                missing_padding = len(b64_data) % 4
                if missing_padding:
                    b64_data += '=' * (4 - missing_padding)
                
                decoded = json.loads(base64.b64decode(b64_data).decode('utf-8'))
                host = decoded.get('add')
                port = int(decoded.get('port', 0))
                
                if host and port:
                    return {'host': host, 'port': port}
                return None
            except Exception:
                return None
        
        # Handle other protocols (vless, trojan, etc.)
        parsed = urlparse(config_url)
        if not parsed.hostname:
            return None
        
        port = parsed.port
        if not port:
            # Default ports based on protocol
            default_ports = {
                'vless': 443, 'trojan': 443, 'hysteria2': 443,
                'hy2': 443, 'tuic': 443
            }
            port = default_ports.get(parsed.scheme, 443)
        
        return {'host': parsed.hostname, 'port': port}
    
    except Exception:
        return None

def test_config_via_vercel_api(config_url: str) -> dict:
    """تست کانفیگ از طریق API ورسل"""
    server_details = parse_server_details(config_url)
    
    if not server_details:
        return {
            'config_str': config_url,
            'ping': 9999,
            'status': 'parse_error'
        }
    
    try:
        # ارسال درخواست به API ورسل
        response = requests.post(
            API_ENDPOINT,
            json={
                'host': server_details['host'],
                'port': server_details['port']
            },
            headers={'Content-Type': 'application/json'},
            timeout=REQUEST_TIMEOUT
        )
        
        if response.status_code == 200:
            data = response.json()
            ping = data.get('ping', 9999)
            
            return {
                'config_str': config_url,
                'ping': ping,
                'status': 'success' if ping < 9999 else 'timeout'
            }
        else:
            return {
                'config_str': config_url,
                'ping': 9999,
                'status': f'api_error_{response.status_code}'
            }
    
    except requests.exceptions.Timeout:
        return {
            'config_str': config_url,
            'ping': 9999,
            'status': 'timeout'
        }
    except Exception as e:
        return {
            'config_str': config_url,
            'ping': 9999,
            'status': 'network_error'
        }

def validate_and_categorize_config(config_url: str) -> dict | None:
    """اعتبارسنجی syntax و تعیین نوع core"""
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        
        # Basic validation
        if not parsed_url.hostname and protocol != 'vmess':
            return None
        
        # Determine core type
        core = 'xray'
        if protocol in ['hysteria2', 'hy2', 'tuic']:
            core = 'singbox'
        elif protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            if query_params.get('security', [''])[0] == 'reality':
                core = 'singbox'
                # Validate REALITY public key
                pbk = query_params.get('pbk', [None])[0]
                if not pbk or not re.match(r'^[A-Za-z0-9-_]{43}$', pbk):
                    return None  # Invalid REALITY config
        
        return {
            'core': core,
            'config_str': config_url
        }
    except Exception:
        return None

def process_configs_batch(configs_batch: list) -> list:
    """پردازش یک batch از کانفیگ‌ها"""
    results = []
    
    with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
        # ارسال همزمان درخواست‌ها
        future_to_config = {
            executor.submit(test_config_via_vercel_api, cfg): cfg 
            for cfg in configs_batch
        }
        
        for future in as_completed(future_to_config):
            try:
                result = future.result()
                # فقط کانفیگ‌های زیر threshold را نگه دار
                if result['ping'] <= MAX_PING_THRESHOLD:
                    results.append(result)
            except Exception as e:
                print(f"❌ خطا در تست کانفیگ: {e}")
    
    return results

# === MAIN EXECUTION ===
def main():
    print("🚀 V2V Enhanced Scraper - منابع ثابت + GitHub Search + تست ورسل")
    print(f"🎯 هدف: {TARGET_CONFIGS_PER_CORE} کانفیگ برای هر core")
    print(f"⚡ حداکثر ping: {MAX_PING_THRESHOLD}ms")
    
    # 1. ترکیب منابع ثابت + پویا
    all_sources = BASE_SUBSCRIPTION_SOURCES.copy()
    dynamic_sources = discover_dynamic_sources()
    all_sources.extend(dynamic_sources)
    
    print(f"📡 مجموع منابع: {len(BASE_SUBSCRIPTION_SOURCES)} ثابت + {len(dynamic_sources)} پویا = {len(all_sources)}")
    
    # 2. دانلود و استخراج کانفیگ‌ها
    print("🚚 دانلود و استخراج کانفیگ‌ها...")
    all_configs_raw = set()
    
    with ThreadPoolExecutor(max_workers=20) as executor:
        results = executor.map(fetch_and_parse_url, all_sources)
        for config_set in results:
            all_configs_raw.update(config_set)
    
    print(f"📦 مجموع {len(all_configs_raw)} کانفیگ خام استخراج شد")
    
    if len(all_configs_raw) == 0:
        print("❌ هیچ کانفیگی یافت نشد!")
        return
    
    # 3. اعتبارسنجی syntax و دسته‌بندی
    print("🔬 اعتبارسنجی syntax و دسته‌بندی...")
    categorized_configs = {'xray': [], 'singbox': []}
    
    with ThreadPoolExecutor(max_workers=50) as executor:
        future_to_config = {
            executor.submit(validate_and_categorize_config, cfg): cfg 
            for cfg in all_configs_raw
        }
        
        for future in as_completed(future_to_config):
            result = future.result()
            if result:
                core = result.get('core')
                if core in categorized_configs:
                    categorized_configs[core].append(result['config_str'])
    
    print(f"✅ کانفیگ‌های معتبر: Xray={len(categorized_configs['xray'])}, Singbox={len(categorized_configs['singbox'])}")
    
    # 4. تست سرعت و انتخاب بهترین‌ها
    final_configs = {'xray': [], 'singbox': []}
    
    for core_name, configs in categorized_configs.items():
        if not configs:
            print(f"⚠️ هیچ کانفیگ {core_name.upper()} یافت نشد")
            continue
        
        print(f"\n🏃 تست سرعت {len(configs)} کانفیگ {core_name.upper()}...")
        tested_configs = []
        
        # تست در batch های کوچک
        total_batches = (len(configs) + BATCH_SIZE - 1) // BATCH_SIZE
        
        for i in range(0, len(configs), BATCH_SIZE):
            batch = configs[i:i+BATCH_SIZE]
            batch_num = (i // BATCH_SIZE) + 1
            
            print(f"   📡 Batch {batch_num}/{total_batches}: {len(batch)} کانفیگ")
            
            batch_results = process_configs_batch(batch)
            tested_configs.extend(batch_results)
            
            # نمایش پیشرفت
            fast_count = len([c for c in tested_configs if c['ping'] <= MAX_PING_THRESHOLD])
            print(f"   ⚡ تعداد کانفیگ سریع تا کنون: {fast_count}")
            
            # اگر بیش از حد نیاز یافت شد، توقف زودهنگام
            if len(tested_configs) >= TARGET_CONFIGS_PER_CORE * 3:
                print(f"   🎯 تعداد کافی کانفیگ سریع یافت شد، توقف زودهنگام")
                break
            
            # استراحت کوتاه برای جلوگیری از overload
            time.sleep(0.3)
        
        # مرتب‌سازی بر اساس ping و انتخاب بهترین‌ها
        tested_configs.sort(key=lambda x: x['ping'])
        best_configs = tested_configs[:TARGET_CONFIGS_PER_CORE]
        
        final_configs[core_name] = [
            {
                'config_str': cfg['config_str'],
                'ping': cfg['ping']
            }
            for cfg in best_configs
        ]
        
        print(f"🎯 {core_name.upper()}: {len(final_configs[core_name])} کانفیگ نهایی انتخاب شد")
        
        if final_configs[core_name]:
            # محاسبه آمار
            pings = [c['ping'] for c in final_configs[core_name]]
            avg_ping = sum(pings) / len(pings)
            min_ping = min(pings)
            max_ping = max(pings)
            
            print(f"📊 آمار ping: حداقل={min_ping}ms, حداکثر={max_ping}ms, میانگین={avg_ping:.1f}ms")
    
    # 5. ذخیره نتایج نهایی
    total_configs = len(final_configs['xray']) + len(final_configs['singbox'])
    print(f"\n💾 ذخیره {total_configs} کانفیگ نهایی در {OUTPUT_JSON_FILE}...")
    
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    
    # 6. گزارش نهایی
    print("\n🎉 فرآیند تکمیل شد!")
    print("📈 خلاصه نتایج:")
    print(f"   🔸 Xray: {len(final_configs['xray'])} کانفیگ")
    print(f"   🔸 Singbox: {len(final_configs['singbox'])} کانفیگ")
    print(f"   🔸 مجموع: {total_configs} کانفیگ")
    print(f"💾 فایل خروجی: {OUTPUT_JSON_FILE}")
    print(f"🌐 منابع استفاده شده: {len(all_sources)} منبع")
    
    if total_configs > 0:
        print("✅ فایل آماده برای استفاده در سایت!")
    else:
        print("⚠️ هیچ کانفیگ سالمی یافت نشد!")

if __name__ == "__main__":
    main()