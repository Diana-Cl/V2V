
Import requests
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
GITHUB_SEARCH_KEYWORDS = ['v2ray subscription', 'vless subscription', 'reality subscription'] # <-- کلیدواژه Reality اضافه شد
TOP_N_CONFIGS = 500
OUTPUT_FILE_PLAIN = 'configs.txt'
OUTPUT_FILE_CLASH = 'v2v_clash.yaml'
# --- START: NEW PROTOCOL SUPPORT ---
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hy2://', 'tuic://')
# --- END: NEW PROTOCOL SUPPORT ---

# === SECRET KEYS ===
GITHUB_PAT = os.environ.get('GH_PAT')
HEADERS = {'User-Agent': 'V2V-Scraper/Final-v2'}
if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# === STATE MANAGEMENT FUNCTIONS ===
def load_sources_status() -> list:
    if not os.path.exists(SOURCES_STATUS_FILE):
        print(f"'{SOURCES_STATUS_FILE}' not found. Initializing with default sources.")
        initial_sources = [{'url': url, 'last_active': datetime.now().isoformat(), 'status': 'active'} for url in INITIAL_BASE_SOURCES]
        save_sources_status(initial_sources)
        return initial_sources
    try:
        with open(SOURCES_STATUS_FILE, 'r', encoding='utf-8') as f: return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        print("Error reading status file. Re-initializing.")
        initial_sources = [{'url': url, 'last_active': datetime.now().isoformat(), 'status': 'active'} for url in INITIAL_BASE_SOURCES]
        save_sources_status(initial_sources)
        return initial_sources

def save_sources_status(sources_data: list):
    with open(SOURCES_STATUS_FILE, 'w', encoding='utf-8') as f: json.dump(sources_data, f, indent=2, ensure_ascii=False)

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
    if 'githubusercontent.com' in url: return get_github_file_last_commit(url)
    try:
        response = requests.head(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return datetime.now()
    except requests.RequestException: return None

# === HELPER FUNCTIONS (IMPROVED) ===
# --- START: BASE64 FIX ---
def safe_b64_decode(data: str) -> bytes:
    """Safely decodes base64 strings, handling padding errors."""
    padding = '=' * (-len(data) % 4)
    return base64.b64decode(data + padding)
# --- END: BASE64 FIX ---

def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except requests.RequestException: return None

def decode_content(content: str) -> list[str]:
    try: 
        # --- Use safe_b64_decode ---
        return safe_b64_decode(content).decode('utf-8').strip().splitlines()
    except Exception: 
        return content.strip().splitlines()

# --- START: ERROR REPORTING ---
def fetch_and_parse_url(url: str) -> tuple[str, set]:
    """Fetches configs from a URL. Returns status and result."""
    content = get_content_from_url(url)
    if not content: return "failed", {url}
    
    configs = set()
    # Support for HTML pages with configs
    if url.endswith(('.html', '.htm')):
        pattern = r'(' + '|'.join([p.replace('://', ':\\/\\/') for p in VALID_PREFIXES]) + r'[^\s\'"<]+)'
        found_configs = re.findall(pattern, content)
        for config in found_configs:
            if config.strip().startswith(VALID_PREFIXES): configs.add(config.strip())
    else:
        for config in decode_content(content):
            if config.strip().startswith(VALID_PREFIXES): configs.add(config.strip())

    if not configs: return "failed", {url}
    return "success", configs
# --- END: ERROR REPORTING ---

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
                    discovered_urls.add(f"https://raw.githubusercontent.com/{repo['full_name']}/{repo['default_branch']}/{filename}")
        except requests.RequestException as e:
            print(f"Failed to search GitHub with keyword '{keyword}': {e}")
            continue
    print(f"Discovered {len(discovered_urls)} potential new source URLs.")
    return discovered_urls

# --- START: FULL PROTOCOL SUPPORT ---
def parse_config(config_url: str) -> dict | None:
    try:
        parsed_url = urlparse(config_url)
        protocol = parsed_url.scheme
        remark = unquote(parsed_url.fragment) if parsed_url.fragment else f"{protocol}-{parsed_url.hostname}"
        
        # --- Use safe_b64_decode ---
        if protocol == 'vmess':
            try:
                decoded_part = safe_b64_decode(parsed_url.netloc).decode('utf-8')
                data = json.loads(decoded_part)
                remark = data.get('ps', data.get('add'))
                return {'protocol': 'vmess', 'remark': remark, 'server': data.get('add'), 'port': int(data.get('port', 0)), 'uuid': data.get('id'), 'params': data}
            except Exception: return None
            
        elif protocol == 'ss':
            try:
                userinfo, _, server_part = parsed_url.netloc.rpartition('@')
                server, port_str = server_part.split(':')
                decoded_userinfo = safe_b64_decode(userinfo).decode('utf-8')
                cipher, password = decoded_userinfo.split(':', 1)
                return {'protocol': 'ss', 'remark': remark, 'server': server, 'port': int(port_str), 'password': password, 'cipher': cipher, 'params': {}}
            except Exception: return None

        query_params = parse_qs(parsed_url.query)
        params = {k: v[0] for k, v in query_params.items()}
        
        if protocol == 'vless':
            return {'protocol': 'vless', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'params': params}
        elif protocol == 'trojan':
            return {'protocol': 'trojan', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'params': params}
        elif protocol == 'hy2': # Hysteria2 Support
            return {'protocol': 'hysteria2', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'password': parsed_url.username, 'params': params}
        elif protocol == 'tuic': # TUIC v5 Support
            return {'protocol': 'tuic', 'remark': remark, 'server': parsed_url.hostname, 'port': parsed_url.port, 'uuid': parsed_url.username, 'password': parsed_url.password, 'params': params}

        return None
    except Exception:
        return None
# --- END: FULL PROTOCOL SUPPORT ---

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

def test_config_latency(config: str) -> tuple[str, int, dict] | None:
    """Tests latency and returns the original config string, latency, and the parsed config."""
    parsed = parse_config(config)
    if parsed:
        latency = tcp_ping(parsed.get('server'), parsed.get('port'))
        if latency is not None:
            return (config, latency, parsed) # Return parsed config to avoid re-parsing
    return None

# --- START: ADVANCED CLASH CONFIG GENERATION ---
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
                proxy.update({'uuid': parsed['uuid'], 'udp': True, 'tls': params.get('security') in ['tls', 'reality'], 'network': params.get('type', 'ws')})
                # REALITY Support
                if params.get('security') == 'reality':
                    proxy['servername'] = params.get('sni', '')
                    proxy['reality-opts'] = {'public-key': params.get('pbk', ''), 'short-id': params.get('sid', '')}
                # TLS (non-reality)
                elif proxy['tls']:
                    proxy['servername'] = params.get('sni', parsed['server'])
                # WS/gRPC opts
                if proxy['network'] == 'ws':
                    proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', proxy.get('servername', parsed['server']))}}
                elif proxy['network'] == 'grpc':
                    proxy['grpc-opts'] = {'grpc-service-name': params.get('serviceName', '')}
            
            elif parsed['protocol'] == 'vmess':
                p = parsed['params']
                proxy.update({'uuid': parsed['uuid'], 'alterId': int(p.get('aid', 0)), 'cipher': p.get('scy', 'auto'), 'udp': True, 'tls': p.get('tls') == 'tls', 'network': p.get('net', 'ws')})
                if proxy['tls']: proxy['servername'] = p.get('sni', parsed['server'])
                if proxy['network'] == 'ws': proxy['ws-opts'] = {'path': p.get('path', '/'), 'headers': {'Host': p.get('host', proxy.get('servername', parsed['server']))}}

            elif parsed['protocol'] == 'trojan':
                proxy.update({'password': parsed['password'], 'udp': True, 'sni': params.get('sni', parsed['server'])})

            elif parsed['protocol'] == 'ss':
                proxy.update({'password': parsed['password'], 'cipher': parsed['cipher'], 'udp': True})
            
            elif parsed['protocol'] == 'hysteria2':
                proxy['type'] = 'hysteria2'
                proxy.update({'password': parsed['password'], 'sni': params.get('sni', parsed['server']), 'obfs': params.get('obfs'), 'obfs-password': params.get('obfs-password')})

            elif parsed['protocol'] == 'tuic':
                proxy['type'] = 'tuic'
                proxy.update({'uuid': parsed['uuid'], 'password': parsed['password'], 'sni': params.get('sni', parsed['server']), 'alpn': [p for p in params.get('alpn', '').split(',') if p]})
            
            # ShadowTLS Support (as a plugin)
            if 'shadowtls' in params:
                proxy['plugin'] = 'shadow-tls'
                proxy['plugin-opts'] = {'host': params.get('sni', parsed['server']), 'password': params.get('shadowtls'), 'version': '3'}

            proxies.append(proxy)
        except Exception:
            continue
            
    clash_config = {'port': 7890, 'socks-port': 7891, 'allow-lan': False, 'mode': 'rule', 'log-level': 'info', 'proxies': proxies,
        'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': [p['name'] for p in proxies], 'url': 'http://www.gstatic.com/generate_204', 'interval': 300},
                         {'name': 'V2V-Select', 'type': 'select', 'proxies': ['V2V-Auto'] + [p['name'] for p in proxies]}],
        'rules': ['DOMAIN-SUFFIX,ir,DIRECT', 'GEOIP,IR,DIRECT', 'MATCH,V2V-Select']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False)
# --- END: ADVANCED CLASH CONFIG GENERATION ---


# --- START: OPERATOR-BASED SORTING ---
def get_operator_priority(config_name: str) -> int:
    """Assigns a priority score based on operator keywords found in the config name."""
    name_lower = config_name.lower()
    if any(k in name_lower for k in ['mci', 'hamrah', 'همراه']): return 1
    if any(k in name_lower for k in ['irancell', 'ایرانسل']): return 2
    if any(k in name_lower for k in ['rightel', 'رایتل']): return 3
    return 99 # Default for others
# --- END: OPERATOR-BASED SORTING ---

def main():
    print("🚀 Starting V2V Smart Scraper (v2 Final)...")
    
    base_sources_data = load_sources_status()
    print(f"\n🩺 Checking health of {len(base_sources_data)} base sources...")
    
    sources_to_remove, now = [], datetime.now()
    for source in base_sources_data:
        last_active_date = check_source_activity(source['url'])
        if last_active_date:
            source['last_active'] = last_active_date.isoformat()
            source['status'] = 'active'
        else:
            last_known_active = datetime.fromisoformat(source['last_active'])
            if (now - last_known_active).days > INACTIVE_DAYS_THRESHOLD:
                source['status'] = 'inactive'
                sources_to_remove.append(source)
                print(f"🚩 Marked for removal (inactive for >{INACTIVE_DAYS_THRESHOLD} days): {source['url']}")

    if sources_to_remove:
        print(f"\n🔄 Found {len(sources_to_remove)} inactive sources. Attempting to replace them...")
        discovered_sources = discover_github_sources()
        current_urls = {s['url'] for s in base_sources_data}
        potential_replacements = [url for url in discovered_sources if url not in current_urls]

        if not potential_replacements:
            print("⚠️ No new dynamic sources found to replace inactive ones. The list will shrink.")
            base_sources_data = [s for s in base_sources_data if s not in sources_to_remove]
        else:
            for old_source in sources_to_remove:
                if potential_replacements:
                    new_source_url = potential_replacements.pop(0)
                    base_sources_data.remove(old_source)
                    new_source_obj = {'url': new_source_url, 'last_active': now.isoformat(), 'status': 'active'}
                    base_sources_data.append(new_source_obj)
                    print(f"✅ Replaced '{old_source['url']}' with '{new_source_url}'")
                else:
                    print(f"⚠️ No more new sources to replace '{old_source['url']}'. Removing it.")
                    base_sources_data.remove(old_source)
    
    print("\n💾 Saving updated sources list...")
    save_sources_status(base_sources_data)
    
    active_base_urls = [s['url'] for s in base_sources_data]
    all_sources = set(active_base_urls)
    all_sources.update(discover_github_sources())
    
    print(f"\n🚚 Fetching configs from {len(all_sources)} sources...")
    all_configs = set()
    failed_sources = set() # For error reporting
    with ThreadPoolExecutor(max_workers=30) as executor:
        future_to_url = {executor.submit(fetch_and_parse_url, url): url for url in all_sources}
        for future in as_completed(future_to_url):
            try:
                status, result = future.result()
                if status == "success":
                    all_configs.update(result)
                else:
                    failed_sources.update(result)
            except Exception as exc:
                print(f'{future_to_url[future]} generated an exception: {exc}')
                failed_sources.add(future_to_url[future])

    print(f"Found {len(all_configs)} unique configs.")
    if not all_configs: print("No configs found. Aborting."); return

    print("\n⚡️ Testing latency of configs...")
    working_configs = [] # Now a list of (config_str, latency, parsed_dict)
    with ThreadPoolExecutor(max_workers=100) as executor:
        for result in executor.map(test_config_latency, all_configs):
            if result: working_configs.append(result)

    print(f"Found {len(working_configs)} responsive configs.")
    if not working_configs:
        print("No working configs found to save. Aborting.")
        # --- Print Error Report Even on Failure ---
        if failed_sources:
            print(f"\n--- ⚠️ Error Report: {len(failed_sources)} sources failed ---")
            for source in sorted(list(failed_sources)): print(f"- {source}")
        return

    # --- Apply new sorting logic ---
    working_configs.sort(key=lambda x: (get_operator_priority(x[2]['remark']), x[1]))
    top_configs_data = working_configs[:TOP_N_CONFIGS]
    top_configs_str = [cfg for cfg, lat, parsed in top_configs_data] # Extract only strings for output
    
    print(f"🏅 Selected top {len(top_configs_str)} configs, sorted by operator and latency.")
    
    with open(OUTPUT_FILE_PLAIN, 'w', encoding='utf-8') as f: f.write("\n".join(top_configs_str))
    print(f"💾 Successfully saved plain text configs to {OUTPUT_FILE_PLAIN}")
    
    with open(OUTPUT_FILE_CLASH, 'w', encoding='utf-8') as f: f.write(generate_clash_config(top_configs_str))
    print(f"💾 Successfully saved Clash config to {OUTPUT_FILE_CLASH}")

    # --- Final Error Report ---
    if failed_sources:
        print(f"\n--- ⚠️ Error Report: {len(failed_sources)} sources failed ---")
        for source in sorted(list(failed_sources)):
            print(f"- {source}")

if __name__ == "__main__":
    main()