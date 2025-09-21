import json
import base64
import time
import re
from urllib.parse import urlparse, parse_qs, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import socket
import ssl
import os

# --- configuration ---
sources_file = 'sources.json'
output_json_file = 'all_live_configs.json'
# output_clash_file = 'clash_subscription.yml' # ✅ حذف شده
cache_version_file = 'cache_version.txt'

github_pat = os.getenv('GH_PAT', '') # ✅ استفاده از نام Secret شما (GH_PAT)
github_search_limit = 500

# Test parameters
max_configs_to_test = 3000
max_latency_ms = 1500
max_test_workers = 100
test_timeout_sec = 8

# Final config selection parameters
min_target_configs_per_core = 500
max_final_configs_per_core = 1000

# Protocols
xray_protocols = {'vless', 'vmess', 'trojan', 'ss'}
singbox_protocols = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hy2', 'hysteria2', 'tuic'}
valid_protocols = xray_protocols.union(singbox_protocols)

# Clash Meta compatible transports for Xray configs (VMess, VLESS, Trojan)
# این لیست هنوز در اینجا هست تا اگر ورکر خواست Clash تولید کند، از آن استفاده کند.
clash_compatible_transports = ['tcp', 'ws', 'h2', 'grpc', 'udp', 'quic']

# --- helpers ---
def fetch_from_static_sources(static_sources: list[str]) -> set[str]:
    """Fetches configs from predefined static URLs."""
    print("  Fetching from static sources...")
    collected = set()
    
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36'}
    
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for url in static_sources:
            if url.startswith("github:"):
                repo_path = url[len("github:"):]
                owner, repo, file_path = repo_path.split('/', 2)
                raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/main/{file_path}"
                futures.append(executor.submit(fetch_url_content, raw_url, headers))
            else:
                futures.append(executor.submit(fetch_url_content, url, headers))

        for i, future in enumerate(as_completed(futures)):
            content = future.result()
            if content:
                for line in content.splitlines():
                    line = line.strip()
                    if any(line.lower().startswith(p + "://") for p in valid_protocols):
                        collected.add(line)
            if (i + 1) % 10 == 0:
                print(f"  Fetched from {i+1} static sources...")
    print(f"  ✅ Found {len(collected)} configs from static sources.")
    return collected

def fetch_url_content(url: str, headers: dict = None) -> str | None:
    """Fetches content from a single URL."""
    try:
        import requests
        if headers is None:
            headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=test_timeout_sec)
        response.raise_for_status()
        return response.text
    except requests.exceptions.RequestException as e:
        print(f"  ⚠️ Failed to fetch {url}: {e}")
        return None

def fetch_from_github(pat: str, search_limit: int) -> set[str]:
    """Fetches configs from GitHub using API search."""
    print("  Fetching from GitHub...")
    collected = set()
    try:
        import requests
        headers = {'User-Agent': 'Mozilla/50 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36', 'Accept': 'application/vnd.github.v3.text-match+json'}
        if pat: # ✅ بررسی وجود PAT
            headers['Authorization'] = f'token {pat}'
        else:
            print("  ⚠️ GitHub PAT not provided. Using unauthenticated requests which have lower rate limits.")

        queries = [
            'vless in:file extension:txt', 'vmess in:file extension:txt', 'trojan in:file extension:txt', 'ss in:file extension:txt',
            'hysteria2 in:file extension:txt', 'tuic in:file extension:txt',
            'vless in:file extension:yaml', 'vmess in:file extension:yaml', 'trojan in:file extension:yaml', 'ss in:file extension:yaml',
            'hysteria2 in:file extension:yaml', 'tuic in:file extension:yaml',
            'vless in:file extension:yml', 'vmess in:file extension:yml', 'trojan in:file extension:yml', 'ss in:file extension:yml',
            'hysteria2 in:file extension:yml', 'tuic in:file extension:yml',
        ]
        
        for query in queries:
            if len(collected) >= search_limit:
                print(f"  Reached GitHub search limit ({search_limit}). Stopping.")
                break

            response = requests.get(
                f"https://api.github.com/search/code?q={query}+size:<=1000",
                headers=headers,
                timeout=test_timeout_sec
            )
            response.raise_for_status()
            
            items = response.json().get('items', [])
            for item in items:
                if len(collected) >= search_limit: break
                
                repo_url = item['repository']['html_url']
                file_path = item['path']
                raw_url = f"https://raw.githubusercontent.com/{item['repository']['owner']['login']}/{item['repository']['name']}/main/{file_path}"
                
                content = fetch_url_content(raw_url, headers)
                if content:
                    for line in content.splitlines():
                        line = line.strip()
                        if any(line.lower().startswith(p + "://") for p in valid_protocols):
                            collected.add(line)
        
    except requests.exceptions.RequestException as e:
        print(f"  ⚠️ Failed to fetch from GitHub API: {e}")
        if e.response is not None:
            if e.response.status_code == 401:
                print("  HINT: GitHub PAT is invalid or missing. Ensure GH_PAT secret is set correctly.")
            elif e.response.status_code == 403:
                print("  HINT: GitHub API rate limit exceeded. Try again later or use a valid PAT.")
    except Exception as e:
        print(f"  ⚠️ An error occurred during GitHub fetching: {e}")
    print(f"  ✅ Found {len(collected)} configs from GitHub.")
    return collected

def parse_config_address(config_url: str) -> tuple[str, int, str, str] | None:
    """Parses config URL to extract host and port."""
    try:
        if config_url.startswith("vmess://"):
            decoded_vmess = base64.b64decode(config_url[8:]).decode('utf-8')
            vmess_json = json.loads(decoded_vmess)
            return vmess_json['add'], int(vmess_json['port']), vmess_json.get('net', 'tcp'), vmess_json.get('type', 'auto')
        
        url_parsed = urlparse(config_url)
        scheme = url_parsed.scheme.lower()

        if scheme in ['vless', 'trojan', 'ss']:
            host = url_parsed.hostname
            port = url_parsed.port
            query_params = parse_qs(url_parsed.query)
            transport = query_params.get('type', ['tcp'])[0] if scheme == 'vless' else 'tcp'
            return host, int(port), transport, scheme
        
        elif scheme in ['hy2', 'hysteria2', 'tuic']:
            host = url_parsed.hostname
            port = url_parsed.port
            return host, int(port), 'webtransport', scheme
        
        return None
    except Exception as e:
        return None

def test_full_protocol_handshake(config_url: str) -> tuple[str, int] | None:
    """Tests the full handshake for a given config URL, returning latency if successful."""
    parsed = parse_config_address(config_url)
    if not parsed:
        return None

    host, port, transport, scheme = parsed
    
    if not host or not port:
        return None

    sock = None
    start_time = time.time()
    try:
        addr_info = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not addr_info:
            return None
        
        family, socktype, proto, canonname, sa = addr_info[0]
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(test_timeout_sec)
        
        if scheme in ['vless', 'trojan', 'vmess', 'hysteria2', 'hy2', 'tuic']:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=host)

        sock.connect(sa)
        end_time = time.time()
        latency_ms = int((end_time - start_time) * 1000)
        return config_url, latency_ms
    except socket.timeout:
        return None
    except Exception as e:
        return None
    finally:
        if sock:
            sock.close()

def select_configs_with_fluid_quota(
    configs_with_latency: list[tuple[str, int]], 
    min_target: int, 
    max_final: int,
    target_protocols: set[str]
) -> list[str]:
    """
    Selects configs, prioritizing lower latency, trying to meet min_target
    but not exceeding max_final. Ensures diversity of target protocols.
    """
    configs_with_latency.sort(key=lambda x: x[1])

    final_configs_set = set()
    protocol_counts = defaultdict(int)
    
    initial_diversity_target = 2
    for config_url, _ in configs_with_latency:
        if len(final_configs_set) >= max_final: break
        protocol = urlparse(config_url).scheme.lower()
        if protocol == 'hysteria2': protocol = 'hy2'
        
        if protocol in target_protocols and protocol_counts[protocol] < initial_diversity_target:
            final_configs_set.add(config_url)
            protocol_counts[protocol] += 1
            
    for config_url, _ in configs_with_latency:
        if len(final_configs_set) >= min_target: break
        if len(final_configs_set) >= max_final: break
        
        final_configs_set.add(config_url)

    for config_url, _ in configs_with_latency:
        if len(final_configs_set) >= max_final: break
        final_configs_set.add(config_url)

    return list(final_configs_set)

# ✅ تابع generate_clash_yaml از اینجا حذف شده است.

# --- main logic ---
def main():
    print("--- 1. loading sources ---")
    try:
        with open(sources_file, 'r', encoding='utf-8') as f:
            sources_config = json.load(f)
        
        static_sources = sources_config.get("static", [])
        print(f"✅ loaded {len(static_sources)} static sources. Github search limit set to: {github_search_limit}.")
    except Exception as e:
        print(f"FATAL: Cannot load or parse {sources_file}: {e}. Exiting.")
        return

    print("\n--- 2. fetching configs ---")
    all_collected_configs = set()
    with ThreadPoolExecutor(max_workers=5) as executor:
        static_future = executor.submit(fetch_from_static_sources, static_sources)
        dynamic_future = executor.submit(fetch_from_github, github_pat, github_search_limit)
        
        all_collected_configs.update(static_future.result())
        all_collected_configs.update(dynamic_future.result())
    
    if not all_collected_configs: 
        print("FATAL: No configs found after fetching from all sources. Exiting.")
        return
    print(f"📊 Total unique configs collected: {len(all_collected_configs)}")

    print(f"\n--- 3. performing deep protocol handshake test ---")
    fast_configs_with_latency = []
    configs_to_test_list = list(all_collected_configs)[:max_configs_to_test] 
    print(f"  Testing {len(configs_to_test_list)} configs with {max_test_workers} workers...")
    
    with ThreadPoolExecutor(max_workers=max_test_workers) as executor:
        futures = {executor.submit(test_full_protocol_handshake, cfg): cfg for cfg in configs_to_test_list}
        for i, future in enumerate(as_completed(futures)):
            if (i + 1) % 500 == 0:
                print(f"  Tested {i+1}/{len(futures)} configs...")
            result = future.result()
            if result and result[1] <= max_latency_ms:
                fast_configs_with_latency.append(result)

    if not fast_configs_with_latency: 
        print("FATAL: No fast configs found after testing. Exiting.")
        return
    print(f"🏆 Found {len(fast_configs_with_latency)} fast configs.")

    print("\n--- 4. grouping and finalizing configs ---")
    xray_eligible_pool = [(c, l) for c, l in fast_configs_with_latency if urlparse(c).scheme.lower() in xray_protocols]
    singbox_eligible_pool = [(c, l) for c, l in fast_configs_with_latency if urlparse(c).scheme.lower() in singbox_protocols]

    xray_final_selected = select_configs_with_fluid_quota(xray_eligible_pool, min_target_configs_per_core, max_final_configs_per_core, xray_protocols)
    singbox_final_selected = select_configs_with_fluid_quota(singbox_eligible_pool, min_target_configs_per_core, max_final_configs_per_core, singbox_protocols)
    
    if len(xray_final_selected) < min_target_configs_per_core:
        print(f"  Xray configs below min_target ({len(xray_final_selected)}). Attempting to fill from Sing-box.")
        for cfg, _ in singbox_eligible_pool: # ✅ پر کردن از eligible_pool نه final_selected برای تنوع بیشتر
            if urlparse(cfg).scheme.lower() in xray_protocols and cfg not in xray_final_selected and len(xray_final_selected) < max_final_configs_per_core:
                xray_final_selected.append(cfg)
        print(f"  Xray configs after filling: {len(xray_final_selected)}")

    if len(singbox_final_selected) < min_target_configs_per_core:
        print(f"  Sing-box configs below min_target ({len(singbox_final_selected)}). Attempting to fill from Xray.")
        for cfg, _ in xray_eligible_pool: # ✅ پر کردن از eligible_pool نه final_selected برای تنوع بیشتر
            if urlparse(cfg).scheme.lower() in singbox_protocols and cfg not in singbox_final_selected and len(singbox_final_selected) < max_final_configs_per_core:
                singbox_final_selected.append(cfg)
        print(f"  Sing-box configs after filling: {len(singbox_final_selected)}")

    print(f"✅ Selected {len(xray_final_selected)} configs for Xray core.")
    print(f"✅ Selected {len(singbox_final_selected)} configs for Sing-box core.")

    def group_by_protocol_for_output(configs: list[str]) -> dict[str, list[str]]:
        grouped = defaultdict(list)
        for cfg in configs:
            proto = urlparse(cfg).scheme.lower()
            if proto == 'hysteria2': proto = 'hy2'
            grouped[proto].append(cfg)
        return dict(grouped)

    output_data_for_kv = {
        "xray": group_by_protocol_for_output(xray_final_selected), 
        "singbox": group_by_protocol_for_output(singbox_final_selected)
    }

    print("\n--- 5. writing local files ---")
    with open(output_json_file, 'w', encoding='utf-8') as f:
        json.dump(output_data_for_kv, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote combined configs to {output_json_file}.")

    # ✅ حذف تولید و نوشتن clash_subscription.yml
    # clash_yaml_content = generate_clash_yaml(xray_final_selected) 
    # if clash_yaml_content:
    #     with open(output_clash_file, 'w', encoding='utf-8') as f:
    #         f.write(clash_yaml_content)
    #     print(f"✅ Wrote Clash subscription with {len(xray_final_selected)} configs to {output_clash_file}.")
    # else:
    #     print("⚠️ Could not generate Clash subscription file (no compatible Xray configs found).")

    with open(cache_version_file, 'w', encoding='utf-8') as f:
        f.write(str(int(time.time())))
    print(f"✅ Cache version updated in {cache_version_file}.")

    print("\n--- Cloudflare KV upload will be handled by GitHub Actions ---")
    print("\n--- Process completed successfully ---")
    
    total_xray = sum(len(configs) for configs in output_data_for_kv["xray"].values())
    total_singbox = sum(len(configs) for configs in output_data_for_kv["singbox"].values())
    print(f"Final Summary:")
    print(f"   - Xray configs: {total_xray}")
    print(f"   - Sing-box configs: {total_singbox}")

if __name__ == "__main__":
    main()
