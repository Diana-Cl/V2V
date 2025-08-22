import requests
import base64
import os
import json
import socket
import time
import yaml
import uuid
import re
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, unquote, parse_qs

# === CONFIGURATION ===
# 1. منابع به روز شده و جایگزین شدند
# لیست منابع بر اساس آخرین تصمیم ما جایگزین شد
SUBSCRIPTION_SOURCES = [
    # منابع از barry-far
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt",
    # منابع محبوب
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    # منابع از Epodonios
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub4.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub5.txt",
    # منابع تکمیلی
    "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/detailed/vless/2087.txt",
    "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]

# 7. منابع پویا از گیتهاب با کلیدواژه‌های جدید فعال شدند
GITHUB_SEARCH_KEYWORDS = ['vless reality subscription', 'hysteria2 subscription', 'tuic subscription', 'clash subscription']

# 2. راهکار دو هسته‌ای: تعریف تعداد کانفیگ برای هر هسته
TOP_XRAY_CONFIGS = 500
TOP_SINGBOX_CONFIGS = 500 # حداکثر ۵۰۰، هر تعداد که با کیفیت بود

# تعریف خروجی‌ها بر اساس هسته
OUTPUTS = {
    'xray': {'plain': 'configs_xray.txt', 'clash': 'v2v_clash_xray.yaml', 'json': 'configs_xray.json'},
    'singbox': {'plain': 'configs_singbox.txt', 'clash': 'v2v_clash_singbox.yaml', 'json': 'configs_singbox.json'},
    'all': {'json': 'configs.json'} # فایل جامع برای وبسایت اصلی
}

VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Dual-Core-v1.0'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === HELPER & PARSING FUNCTIONS (ارتقا یافته برای هسته‌های جدید) ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=15, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        print(f"Failed to fetch {url}: {e}")
        return None

def decode_content(content: str) -> list[str]:
    # 3. خواندن کامل فایل‌های Base64 تضمین شده
    try:
        return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception:
        return content.strip().splitlines()

def fetch_and_parse_url(url: str) -> set[str]:
    content = get_content_from_url(url)
    if not content: return set()
    configs = set()
    lines = decode_content(content)
    for line in lines:
        if line.strip().startswith(VALID_PREFIXES):
            configs.add(line.strip())
    # برای فایل‌های html که لینک‌ها در آن‌ها پراکنده هستند
    if url.endswith(('.html', '.htm')):
        pattern = r'(' + '|'.join([p.replace('://', r'://[^\s\'"<]+') for p in VALID_PREFIXES]) + ')'
        found_configs = re.findall(pattern, content)
        for config in found_configs:
            configs.add(config.strip())
    return configs

def parse_config(config_url: str) -> dict | None:
    # 2. راهکار دو هسته‌ای: پارسر ارتقا یافته برای تشخیص هسته
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme.lower()
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else (parsed_url.hostname or '')
        
        core = 'xray' # Default core
        
        # --- Xray Core Protocols ---
        if protocol == 'vless':
            query_params = parse_qs(parsed_url.query)
            params = {k: v[0] for k, v in query_params.items()}
            if params.get('security') == 'reality':
                core = 'singbox' # Reality is better handled by sing-box
                return {'protocol': 'vless', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'params': params}
            return {'protocol': 'vless', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'params': params}

        elif protocol == 'vmess':
            decoded_part = base64.b64decode(parsed_url.netloc).decode('utf-8')
            data = json.loads(decoded_part)
            remark = unquote(parsed_url.fragment) or data.get('ps', data.get('add'))
            return {'protocol': 'vmess', 'core': core, 'remark': remark, 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        
        elif protocol == 'trojan':
            return {'protocol': 'trojan', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'params': parse_qs(parsed_url.query)}

        elif protocol == 'ss':
            userinfo, _, server_part = parsed_url.netloc.rpartition('@')
            server, port = server_part.split(':')
            decoded_userinfo = base64.b64decode(userinfo).decode('utf-8')
            cipher, password = decoded_userinfo.split(':', 1)
            return {'protocol': 'ss', 'core': core, 'remark': remark, 'server': server, 'port': int(port), 'password': password, 'cipher': cipher, 'params': parse_qs(parsed_url.query)}

        # --- Sing-box Core Protocols ---
        elif protocol in ['hysteria2', 'hy2']:
            core = 'singbox'
            password, _, server_part = parsed_url.netloc.rpartition('@')
            server, port = server_part.split(':')
            return {'protocol': 'hysteria2', 'core': core, 'remark': remark, 'server': server, 'port': int(port), 'password': password, 'params': parse_qs(parsed_url.query)}
        
        elif protocol == 'tuic':
            core = 'singbox'
            return {'protocol': 'tuic', 'core': core, 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'password': parsed_url.password, 'params': parse_qs(parsed_url.query)}
        
        return None
    except Exception:
        return None

def calculate_quality_score(parsed_config: dict) -> int:
    if not parsed_config: return 0
    score = 0
    params = parsed_config.get('params', {})
    port = parsed_config.get('port')
    
    protocol_scores = {
        'vless': 10 if params.get('security') == 'reality' else (8 if params.get('type') == 'grpc' else 7),
        'hysteria2': 9,
        'tuic': 8,
        'trojan': 6,
        'vmess': 5,
        'ss': 4
    }
    score += protocol_scores.get(parsed_config.get('protocol'), 1)
    
    if port == 443: score += 5
    elif port in [8443, 2053, 2083, 2087, 2096]: score += 3
    
    return score

def tcp_ping(host: str, port: int, timeout: int = 2) -> int | None:
    if not host or not port: return None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            start_time = time.time()
            s.connect((host, port))
            end_time = time.time()
            return int((end_time - start_time) * 1000)
    except Exception: return None

def test_config_latency(config: str) -> tuple[str, int] | None:
    parsed = parse_config(config)
    if parsed and parsed.get('protocol') not in ['hysteria2', 'tuic']: # Ping test is not suitable for UDP-based protocols
        latency = tcp_ping(parsed.get('server'), parsed.get('port'))
        if latency is not None: return (config, latency)
    elif parsed: # For hy2/tuic, if parsable, consider it 'good' with a default ping
        return (config, 999) # Assign a default high ping to keep it in the list but at the bottom
    return None
    
def generate_clash_config(configs_list: list) -> str:
    proxies, used_names = [], set()
    for config_str in configs_list:
        try:
            parsed = parse_config(config_str)
            if not parsed: continue
            # 6. جلوگیری از نام‌های داپلیکیت در کلش
            original_name = parsed.get('remark', '')[:50] or parsed.get('server', '')
            unique_name = original_name
            counter = 1
            while unique_name in used_names:
                unique_name = f"{original_name} {counter}"
                counter += 1
            used_names.add(unique_name)

            proxy = {'name': unique_name, 'type': parsed['protocol'], 'server': parsed['server'], 'port': parsed['port']}
            params = parsed.get('params', {})

            if parsed['protocol'] == 'vless':
                proxy.update({'uuid': parsed['uuid'], 'udp': True, 'tls': params.get('security') in ['tls', 'reality'], 'servername': params.get('sni', [parsed['server']])[0], 'network': params.get('type', ['tcp'])[0]})
                if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': params.get('path', ['/'])[0], 'headers': {'Host': params.get('host', [proxy['servername']])[0]}}
                if params.get('security') == 'reality':
                    proxy['client-fingerprint'] = params.get('fp', ['chrome'])[0]
                    proxy['reality-opts'] = {'public-key': params.get('pbk', [''])[0], 'short-id': params.get('sid', [''])[0]}
            elif parsed['protocol'] == 'vmess':
                proxy.update({'uuid': parsed['uuid'], 'alterId': int(parsed.get('params', {}).get('aid', 0)), 'cipher': parsed.get('params', {}).get('scy', 'auto'), 'udp': True})
            elif parsed['protocol'] == 'trojan':
                proxy.update({'password': parsed['password'], 'udp': True, 'sni': params.get('sni', [parsed['server']])[0]})
            elif parsed['protocol'] == 'ss':
                proxy.update({'password': parsed['password'], 'cipher': parsed['cipher'], 'udp': True})
            elif parsed['protocol'] == 'hysteria2':
                 proxy.update({'password': parsed['password'], 'obfs-password': params.get('obfs-password', [''])[0], 'udp': True})

            # 6. جلوگیری از کانفیگ بدون پسورد/uuid در کلش
            if ('uuid' in proxy and proxy['uuid']) or ('password' in proxy and proxy['password']): proxies.append(proxy)
        except Exception: continue

    clash_config = {'port': 7890, 'socks-port': 7891, 'allow-lan': True, 'mode': 'rule', 'log-level': 'info', 'external-controller': '0.0.0.0:9090', 'proxies': proxies,
        'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies if p], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300},
                         {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto'] + [p['name'] for p in proxies if p]}],
        'rules': ['DOMAIN-SUFFIX,ir,DIRECT', 'GEOIP,IR,DIRECT', 'MATCH,V2V-Select']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

# === MAIN EXECUTION ===
def main():
    # 4. یادآوری برای تنظیم کران‌جاب ۳ ساعته در GitHub Actions
    print("🚀 Starting V2V Dual-Core Scraper...")
    print("Reminder: Set cron job to '0 */3 * * *' in .github/workflows/main.yml for 3-hour updates.")
    
    print(f"🚚 Fetching configs from {len(SUBSCRIPTION_SOURCES)} base sources...")
    all_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, SUBSCRIPTION_SOURCES):
            if results: all_configs.update(results)

    print(f"Found {len(all_configs)} unique configs.")
    if not all_configs: print("No configs found. Aborting."); return

    print(f"\n⚡️ Running lightweight ping test on all {len(all_configs)} configs...")
    configs_with_ping = []
    with ThreadPoolExecutor(max_workers=150) as executor:
        future_to_config = {executor.submit(test_config_latency, cfg): cfg for cfg in all_configs}
        for future in as_completed(future_to_config):
            result = future.result()
            if result:
                config_str, latency = result
                configs_with_ping.append({'config': config_str, 'ping': latency})
    
    print(f"🏅 Found {len(configs_with_ping)} responsive configs.")
    if not configs_with_ping: print("No responsive configs found. Aborting."); return

    print("\n✨ Categorizing by core and calculating quality scores...")
    categorized_configs = {'xray': [], 'singbox': []}
    for item in configs_with_ping:
        parsed = parse_config(item['config'])
        if parsed and parsed.get('core') in categorized_configs:
            item['quality_score'] = calculate_quality_score(parsed)
            categorized_configs[parsed['core']].append(item)

    # 2. راهکار دو هسته‌ای: مرتب‌سازی و انتخاب نهایی
    for core, configs in categorized_configs.items():
        configs.sort(key=lambda x: (x['ping'], -x['quality_score']))
        
        limit = TOP_XRAY_CONFIGS if core == 'xray' else TOP_SINGBOX_CONFIGS
        selected_configs = configs[:limit]
        
        print(f"\n✅ {core.upper()} Core: Selected top {len(selected_configs)} of {len(configs)} configs.")
        
        if not selected_configs:
            print(f"No high-quality configs found for {core} core. Skipping output generation.")
            continue
        
        core_outputs = OUTPUTS[core]
        subscription_links = [item['config'] for item in selected_configs]
        
        with open(core_outputs['plain'], 'w', encoding='utf-8') as f: f.write("\n".join(subscription_links))
        print(f"💾 {core.upper()} subscription file saved to {core_outputs['plain']}")
        
        with open(core_outputs['clash'], 'w', encoding='utf-8') as f: f.write(generate_clash_config(subscription_links))
        print(f"💾 {core.upper()} Clash config file saved to {core_outputs['clash']}")

        json_output = [{'config': item['config'], 'ping': item['ping']} for item in selected_configs]
        with open(core_outputs['json'], 'w', encoding='utf-8') as f: json.dump(json_output, f, ensure_ascii=False)
        print(f"💾 {core.upper()} JSON output saved to {core_outputs['json']}")

    # ایجاد فایل JSON جامع برای وبسایت
    all_json_output = []
    for core, configs in categorized_configs.items():
        limit = TOP_XRAY_CONFIGS if core == 'xray' else TOP_SINGBOX_CONFIGS
        for item in configs[:limit]:
            all_json_output.append({'config': item['config'], 'ping': item['ping'], 'core': core})
    
    with open(OUTPUTS['all']['json'], 'w', encoding='utf-8') as f:
        json.dump(all_json_output, f, ensure_ascii=False)
    print(f"\n💾 Unified JSON for website saved to {OUTPUTS['all']['json']}")
    print("\n🎉 Scraping process completed successfully!")


if __name__ == "__main__":
    main()
