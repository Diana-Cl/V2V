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
INITIAL_BASE_SOURCES = [
    "https://robin.nscl.ir",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt",
    "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/All_Configs_Sub.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt",
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/MrPooyaX/V2Ray/main/sub/mix",
    "https://raw.githubusercontent.com/yebekhe/Configura/main/Sub/Normal/Sub.txt",
    "https://raw.githubusercontent.com/soroushmirzaei/V2Ray-configs/main/All-Configs-base64",
    "https://raw.githubusercontent.com/mrvcoder/V2rayCollector/main/sub/mix_base64",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/all.txt",
    "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/All-Configs-for-V2Ray.txt",
    "https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/sub/subscription_base64.txt",
    "https://raw.githubusercontent.com/Argh94/V2RayAutoConfig/main/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/main/sub/vless.txt",
    "https://raw.githubusercontent.com/NiREvil/vless/main/XRAY/vless.txt",
    "https://raw.githubusercontent.com/4n0nymou3/multi-proxy-config-fetcher/main/configs/proxy_configs.txt",
    "https://raw.githubusercontent.com/MahsaNetConfigTopic/config/main/xray_final.txt"
]
SOURCES_STATUS_FILE = 'sources_status.json'
INACTIVE_DAYS_THRESHOLD = 30
GITHUB_SEARCH_KEYWORDS = ['vless reality subscription', 'hysteria2 subscription', 'tuic subscription', 'clash subscription']
TOP_N_CONFIGS = 500
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_CLASH = 'v2v_clash.yaml'
OUTPUT_FILE_JSON = 'configs.json'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')

# === SECRET KEYS ===
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Hybrid-v1.1'} # Version updated slightly
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === STATE MANAGEMENT FUNCTIONS ===
def load_sources_status() -> list:
    if not os.path.exists(SOURCES_STATUS_FILE):
        print(f"'{SOURCES_STATUS_FILE}' not found. Initializing with default sources.")
        initial_sources = [{'url': url, 'last_active': datetime.now().isoformat(), 'status': 'active'} for url in INITIAL_BASE_SOURCES]
        save_sources_status(initial_sources)
        return initial_sources
    try:
        with open(SOURCES_STATUS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        print("Error reading status file. Re-initializing.")
        initial_sources = [{'url': url, 'last_active': datetime.now().isoformat(), 'status': 'active'} for url in INITIAL_BASE_SOURCES]
        save_sources_status(initial_sources)
        return initial_sources

def save_sources_status(sources_data: list):
    with open(SOURCES_STATUS_FILE, 'w', encoding='utf-8') as f:
        json.dump(sources_data, f, indent=2, ensure_ascii=False)

def get_github_file_last_commit(url: str) -> datetime | None:
    match = re.search(r'raw.githubusercontent.com/([^/]+)/([^/]+)/([^/]+)/(.+)', url)
    if not match or not GITHUB_PAT: return None
    owner, repo, _, path = match.groups()
    api_url = f"https://api.github.com/repos/{owner}/{repo}/commits?path={path}&per_page=1"
    try:
        response = requests.get(api_url, headers=HEADERS, timeout=15)
        response.raise_for_status()
        commit_date_str = response.json()[0]['commit']['committer']['date']
        return datetime.fromisoformat(commit_date_str.replace('Z', '+00:00'))
    except Exception: return None

def check_source_activity(url: str) -> datetime | None:
    if 'githubusercontent.com' in url:
        return get_github_file_last_commit(url)
    try:
        response = requests.head(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return datetime.now()
    except requests.RequestException:
        return None

# === HELPER FUNCTIONS ===
def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except requests.RequestException: return None

def decode_content(content: str) -> list[str]:
    try: return base64.b64decode(content).decode('utf-8').strip().splitlines()
    except Exception: return content.strip().splitlines()

def fetch_and_parse_url(url: str) -> set[str]:
    content = get_content_from_url(url)
    if not content: return set()
    configs = set()
    if url.endswith(('.html', '.htm')):
        pattern = r'(vless://[^\s\'"<]+|vmess://[^\s\'"<]+|trojan://[^\s\'"<]+|ss://[^\s\'"<]+)'
        found_configs = re.findall(pattern, content)
        for config in found_configs:
            if config.strip().startswith(VALID_PREFIXES): configs.add(config.strip())
    else:
        for config in decode_content(content):
            if config.strip().startswith(VALID_PREFIXES): configs.add(config.strip())
    return configs

def discover_github_sources() -> set[str]:
    if not GITHUB_PAT:
        print("GitHub PAT not found, skipping dynamic discovery.")
        return set()
    print("🔍 Discovering new sources from GitHub...")
    discovered_urls = set()
    for keyword in GITHUB_SEARCH_KEYWORDS:
        params = {'q': f'"{keyword}" in:readme,description', 'sort': 'updated', 'per_page': 50}
        try:
            response = requests.get("https://api.github.com/search/repositories", headers=HEADERS, params=params, timeout=20)
            response.raise_for_status()
            for repo in response.json().get('items', []):
                for filename in ['sub.txt', 'all.txt', 'vless.txt', 'vmess.txt', 'configs.txt', 'subscription.txt', 'reality.txt']:
                    discovered_urls.add(f"https://raw.githubusercontent.com/{repo['full_name']}/{repo.get('default_branch', 'main')}/{filename}")
        except requests.RequestException as e:
            print(f"Failed to search GitHub with keyword '{keyword}': {e}")
            continue
    print(f"Discovered {len(discovered_urls)} potential new source URLs.")
    return discovered_urls

def parse_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else parsed_url.hostname
        query_params = parse_qs(parsed_url.query)
        params = {k: v[0] for k, v in query_params.items()}

        if protocol == 'vmess':
            decoded_part = base64.b64decode(parsed_url.netloc).decode('utf-8')
            data = json.loads(decoded_part)
            remark = unquote(parsed_url.fragment) or data.get('ps', data.get('add'))
            return {'protocol': 'vmess', 'remark': remark, 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
        
        elif protocol == 'ss':
            userinfo, _, server_part = parsed_url.netloc.rpartition('@')
            server, port = server_part.split(':')
            decoded_userinfo = base64.b64decode(userinfo).decode('utf-8')
            cipher, password = decoded_userinfo.split(':', 1)
            return {'protocol': 'ss', 'remark': remark, 'server': server, 'port': int(port), 'password': password, 'cipher': cipher, 'params': params}
        
        elif protocol == 'vless':
            return {'protocol': 'vless', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'params': params}
        
        elif protocol == 'trojan':
            return {'protocol': 'trojan', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'params': params}
        
        return None
    except Exception:
        return None

# === QUALITY SCORING FUNCTION (UNRESTRICTED VERSION) ===
def score_config(parsed_config: dict) -> int:
    """
    Gives a quality score to a config based on its parameters.
    Prioritizes secure configs but does not discard less secure ones.
    """
    if not parsed_config: return 0
    score = 0
    protocol = parsed_config.get('protocol')
    params = parsed_config.get('params', {})
    port = parsed_config.get('port')

    if protocol == 'vless':
        security = params.get('security')
        net_type = params.get('type')
        if security == 'reality': score += 10
        elif net_type == 'grpc' and security == 'tls': score += 7
        elif security == 'tls': score += 5
        else: score += 1  # CHANGE: Give a minimal score instead of discarding
    
    elif protocol == 'trojan':
        score += 3

    elif protocol == 'vmess':
        if params.get('tls') == 'tls' or params.get('security') == 'tls': score += 4
        else: score += 1  # CHANGE: Give a minimal score instead of discarding
    
    elif protocol == 'ss':
        if parsed_config.get('cipher') in ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'aes-256-gcm', 'chacha20-poly1305']: score += 3
        else: score += 1  # CHANGE: Give a minimal score to older ciphers
    
    # Add bonus points for standard ports
    if port == 443:
        score += 5
    elif port in [8443, 2053, 2083, 2087, 2096]:
        score += 2
    
    return score

# === TESTING & OUTPUT FUNCTIONS ===
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
    if parsed:
        latency = tcp_ping(parsed.get('server'), parsed.get('port'))
        if latency is not None: return (config, latency)
    return None

def generate_clash_config(configs_list: list) -> str:
    proxies, used_names = [], set()
    for config_str in configs_list:
        try:
            parsed = parse_config(config_str)
            if not parsed: continue
            original_name = parsed.get('remark') or parsed.get('server')
            unique_name = f"{original_name} {uuid.uuid4().hex[:4]}" if original_name in used_names else original_name
            used_names.add(unique_name)
            proxy = {'name': unique_name, 'type': parsed['protocol'], 'server': parsed['server'], 'port': parsed['port']}
            params = parsed.get('params', {})
            if parsed['protocol'] == 'vless':
                proxy.update({'uuid': parsed['uuid'], 'udp': True, 'tls': params.get('security') in ['tls', 'reality'], 'servername': params.get('sni', parsed['server']), 'network': params.get('type', 'ws')})
                if proxy['network'] == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', proxy['servername'])}}
                if params.get('security') == 'reality':
                    proxy['client-fingerprint'] = params.get('fp', 'chrome')
                    proxy['reality-opts'] = {'public-key': params.get('pbk'), 'short-id': params.get('sid', '')}
            elif parsed['protocol'] == 'vmess':
                proxy.update({'uuid': parsed['uuid'], 'alterId': int(params.get('aid', 0)), 'cipher': params.get('scy', 'auto'), 'udp': True, 'tls': params.get('tls') == 'tls', 'servername': params.get('sni', parsed['server']), 'network': params.get('net', 'ws')})
                if proxy['network'] == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', proxy['servername'])}}
            elif parsed['protocol'] == 'trojan': proxy.update({'password': parsed['password'], 'udp': True, 'sni': params.get('sni', parsed['server'])})
            elif parsed['protocol'] == 'ss': proxy.update({'password': parsed['password'], 'cipher': parsed['cipher'], 'udp': True})
            if ('uuid' in proxy and proxy['uuid']) or ('password' in proxy and proxy['password']): proxies.append(proxy)
        except Exception: continue
    clash_config = {'port': 7890, 'socks-port': 7891, 'allow-lan': True, 'mode': 'rule', 'log-level': 'info', 'external-controller': '0.0.0.0:9090', 'proxies': proxies,
        'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies if p], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300},
                         {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto'] + [p['name'] for p in proxies if p]}],
        'rules': ['DOMAIN-SUFFIX,ir,DIRECT', 'GEOIP,IR,DIRECT', 'MATCH,V2V-Select']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)

# === MAIN EXECUTION FUNCTION ===
def main():
    print("🚀 Starting V2V Smart Scraper with Hybrid Logic...")
    
    base_sources_data = load_sources_status()
    print(f"\n🩺 Checking health of {len(base_sources_data)} base sources...")
    
    sources_to_remove = []
    now = datetime.now()
    with ThreadPoolExecutor(max_workers=20) as executor:
        future_to_source = {executor.submit(check_source_activity, source['url']): source for source in base_sources_data}
        for future in as_completed(future_to_source):
            source = future_to_source[future]
            last_active_date = future.result()
            if last_active_date:
                source['last_active'] = last_active_date.isoformat()
                source['status'] = 'active'
            else:
                last_known_active = datetime.fromisoformat(source.get('last_active', '1970-01-01T00:00:00+00:00'))
                if (now - last_known_active).days > INACTIVE_DAYS_THRESHOLD:
                    source['status'] = 'inactive'
                    sources_to_remove.append(source)
                    print(f"🚩 Marked for removal (inactive for >{INACTIVE_DAYS_THRESHOLD} days): {source['url']}")

    if sources_to_remove:
        base_sources_data = [s for s in base_sources_data if s not in sources_to_remove]
        print(f"\n🔄 Found {len(sources_to_remove)} inactive sources. Attempting to replace them...")
        discovered_sources = discover_github_sources()
        current_urls = {s['url'] for s in base_sources_data}
        potential_replacements = [url for url in discovered_sources if url not in current_urls]
        
        num_to_add = len(sources_to_remove)
        for i in range(min(num_to_add, len(potential_replacements))):
            new_source_url = potential_replacements[i]
            new_source_obj = {'url': new_source_url, 'last_active': now.isoformat(), 'status': 'active'}
            base_sources_data.append(new_source_obj)
            print(f"✅ Added new source: '{new_source_url}'")

    print("\n💾 Saving updated sources list...")
    save_sources_status(base_sources_data)
    
    active_urls = {s['url'] for s in base_sources_data if s.get('status', 'active') == 'active'}
    print(f"\n🚚 Fetching configs from {len(active_urls)} active sources...")
    all_configs = set()
    with ThreadPoolExecutor(max_workers=30) as executor:
        for results in executor.map(fetch_and_parse_url, active_urls):
            if results: all_configs.update(results)

    print(f"Found {len(all_configs)} unique configs.")
    if not all_configs: print("No configs found. Aborting."); return

    # --- Step 1: Score and select configs based on quality ---
    print("\n✨ Scoring configs based on quality...")
    scored_configs = []
    for config_str in all_configs:
        parsed = parse_config(config_str)
        if parsed:
            score = score_config(parsed)
            if score > 0: scored_configs.append((config_str, score))

    scored_configs.sort(key=lambda x: x[1], reverse=True)
    top_configs_by_quality = [cfg for cfg, score in scored_configs[:TOP_N_CONFIGS]]
    
    print(f"🏅 Selected top {len(top_configs_by_quality)} configs based on quality score.")
    if not top_configs_by_quality: print("No high-quality configs found. Aborting."); return

    # --- Step 2: Run lightweight ping test on top configs ---
    print("\n⚡️ Running lightweight ping test on top configs...")
    final_configs_with_ping = []
    with ThreadPoolExecutor(max_workers=100) as executor:
        future_to_config = {executor.submit(test_config_latency, cfg): cfg for cfg in top_configs_by_quality}
        for future in as_completed(future_to_config):
            result = future.result()
            config_str = future_to_config[future]
            if result:
                _, latency = result
                final_configs_with_ping.append({'config': config_str, 'ping': latency})
            else:
                final_configs_with_ping.append({'config': config_str, 'ping': -1})

    final_configs_with_ping.sort(key=lambda x: (x['ping'] == -1, x['ping']))
    
    print(f"\n✅ Test complete. Found {len(final_configs_with_ping)} final configs.")

    # --- Step 3: Generate output files ---
    with open(OUTPUT_FILE_JSON, 'w', encoding='utf-8') as f:
        json.dump(final_configs_with_ping, f, ensure_ascii=False)
    print(f"💾 Main JSON output saved to {OUTPUT_FILE_JSON}")

    subscription_links = [item['config'] for item in final_configs_with_ping]
    with open(OUTPUT_FILE_PLAIN, 'w', encoding='utf-8') as f:
        f.write("\n".join(subscription_links))
    print(f"💾 Subscription file saved to {OUTPUT_FILE_PLAIN}")

    with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f:
        f.write(generate_clash_config(subscription_links))
    print(f"💾 Clash config file saved to {OUTPUT_FILE_CLASH}")


if __name__ == "__main__":
    main()
