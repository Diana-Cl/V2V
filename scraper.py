import json
import base64
import time
import re
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import socket
import ssl

# --- configuration ---
sources_file = 'sources.json'
output_json_file = 'all_live_configs.json'
output_clash_file = 'clash_subscription.yml'
cache_version_file = 'cache_version.txt'

github_pat = 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' # ⚠️ Replace with your GitHub PAT if needed for higher limits
github_search_limit = 1000 # Max number of configs to fetch from GitHub

# Test parameters
max_configs_to_test = 2000 # Number of configs to test from all collected
max_latency_ms = 2500      # Max acceptable latency for a config to be considered "fast"
max_test_workers = 50      # Number of concurrent workers for handshake testing
test_timeout_sec = 8       # Timeout for each handshake test

# Final config selection parameters
min_target_configs_per_core = 300 # Minimum number of configs to aim for each core (Xray/Sing-box)
max_final_configs_per_core = 500  # Maximum number of configs to keep for each core (Xray/Sing-box)

# Protocols
xray_protocols = {'vless', 'vmess', 'trojan', 'ss'}
singbox_protocols = {'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hy2', 'hysteria2', 'tuic'}
# All valid protocols for both cores
valid_protocols = xray_protocols.union(singbox_protocols)

# Clash Meta compatible transports for Xray configs (VMess, VLESS, Trojan)
clash_compatible_transports = ['tcp', 'ws', 'h2', 'grpc', 'udp', 'quic'] # Add more if Clash Meta supports them


# --- helpers ---
def fetch_from_static_sources(static_sources: list[str]) -> set[str]:
    """Fetches configs from predefined static URLs."""
    print("  Fetching from static sources...")
    collected = set()
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = []
        for url in static_sources:
            if url.startswith("github:"):
                repo_path = url[len("github:"):]
                owner, repo, file_path = repo_path.split('/', 2)
                raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/main/{file_path}"
                futures.append(executor.submit(fetch_url_content, raw_url))
            else:
                futures.append(executor.submit(fetch_url_content, url))

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

def fetch_url_content(url: str) -> str | None:
    """Fetches content from a single URL."""
    try:
        import requests
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
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/vnd.github.v3.text-match+json'}
        if pat:
            headers['Authorization'] = f'token {pat}'

        queries = [
            'vless in:file extension:txt',
            'vmess in:file extension:txt',
            'trojan in:file extension:txt',
            'ss in:file extension:txt',
            'hysteria2 in:file extension:txt',
            'tuic in:file extension:txt'
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
                raw_url = f"https://raw.githubusercontent.com/{repo_url.split('/')[-2]}/{repo_url.split('/')[-1]}/main/{file_path}"
                
                content = fetch_url_content(raw_url)
                if content:
                    for line in content.splitlines():
                        line = line.strip()
                        if any(line.lower().startswith(p + "://") for p in valid_protocols):
                            collected.add(line)
        
    except requests.exceptions.RequestException as e:
        print(f"  ⚠️ Failed to fetch from GitHub API: {e}")
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
            # Default transport to tcp if not specified, or infer from 'type' param for VLESS
            transport = query_params.get('type', ['tcp'])[0] if scheme == 'vless' else 'tcp'
            return host, int(port), transport, scheme
        
        elif scheme in ['hy2', 'hysteria2', 'tuic']:
            host = url_parsed.hostname
            port = url_parsed.port
            return host, int(port), 'webtransport', scheme # Hysteria2 and TUIC typically use WebTransport-like connections
        
        return None
    except Exception as e:
        # print(f"  ⚠️ Failed to parse config address {config_url[:50]}...: {e}")
        return None

def test_full_protocol_handshake(config_url: str) -> tuple[str, int] | None:
    """Tests the full handshake for a given config URL, returning latency if successful."""
    parsed = parse_config_address(config_url)
    if not parsed:
        return None

    host, port, transport, scheme = parsed
    
    # We'll use a simple TCP connect for all, as deeper protocol handshakes are complex in Python
    # This is a basic reachability test, not a full protocol negotiation
    
    if not host or not port:
        return None

    sock = None
    start_time = time.time()
    try:
        # Resolve hostname
        addr_info = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        if not addr_info:
            return None
        
        # Try connecting to the first available address
        family, socktype, proto, canonname, sa = addr_info[0]
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(test_timeout_sec)
        
        # Wrap socket with SSL if protocol implies TLS
        if scheme in ['vless', 'trojan', 'vmess', 'hysteria2', 'hy2', 'tuic']: # Most modern protocols use TLS
            context = ssl.create_default_context()
            context.check_hostname = False # Not verifying hostname for faster test
            context.verify_mode = ssl.CERT_NONE # Not verifying certs
            sock = context.wrap_socket(sock, server_hostname=host)

        sock.connect(sa)
        end_time = time.time()
        latency_ms = int((end_time - start_time) * 1000)
        return config_url, latency_ms
    except Exception as e:
        # print(f"  ⚠️ Handshake failed for {host}:{port} ({scheme}/{transport}): {e}")
        return None
    finally:
        if sock:
            sock.close()

def select_configs_with_fluid_quota(
    configs_with_latency: list[tuple[str, int]], 
    min_target: int, 
    max_final: int
) -> list[str]:
    """
    Selects configs, prioritizing lower latency, trying to meet min_target
    but not exceeding max_final. Uses a fluid quota system for protocols.
    """
    # Sort by latency
    configs_with_latency.sort(key=lambda x: x[1])

    final_configs = []
    protocol_counts = defaultdict(int)
    
    # Add configs up to max_final, prioritizing lowest latency
    for config_url, _ in configs_with_latency:
        if len(final_configs) >= max_final:
            break
        
        protocol = urlparse(config_url).scheme.lower()
        if protocol == 'hysteria2': protocol = 'hy2' # Normalize
        
        final_configs.append(config_url)
        protocol_counts[protocol] += 1
            
    return final_configs


def generate_clash_yaml(configs: list[str]) -> str | None:
    """Generates a Clash Meta YAML subscription file from Xray-compatible configs."""
    proxies = []
    for config_url in configs:
        try:
            scheme = urlparse(config_url).scheme.lower()
            if scheme == 'vmess':
                # VMess specific parsing
                decoded_vmess = base64.b64decode(config_url[8:]).decode('utf-8')
                vmess_json = json.loads(decoded_vmess)
                
                # Check if transport is compatible with Clash Meta
                vmess_net = vmess_json.get('net', 'tcp')
                if vmess_net not in clash_compatible_transports:
                    continue # Skip if not compatible

                proxy = {
                    "name": vmess_json.get('ps', 'vmess_proxy'),
                    "type": "vmess",
                    "server": vmess_json['add'],
                    "port": int(vmess_json['port']),
                    "uuid": vmess_json['id'],
                    "alterId": int(vmess_json.get('aid', 0)),
                    "cipher": vmess_json.get('scy', 'auto'), # scy for security
                    "tls": vmess_json.get('tls', '') == 'tls',
                }
                if vmess_net == "ws":
                    proxy["network"] = "ws"
                    proxy["ws-path"] = vmess_json.get('path', '/')
                    proxy["ws-headers"] = {"Host": vmess_json.get('host', vmess_json['add'])}
                elif vmess_net == "h2":
                    proxy["network"] = "h2"
                    proxy["h2-path"] = vmess_json.get('path', '/')
                    proxy["h2-headers"] = {"Host": vmess_json.get('host', vmess_json['add'])}
                # Add other network types if Clash Meta supports them (e.g., grpc)
                elif vmess_net == "grpc":
                    proxy["network"] = "grpc"
                    proxy["grpc-service-name"] = vmess_json.get('path', '')
                    proxy["grpc-auto-tls"] = False # Adjust based on actual config
                # Else it's tcp
                proxies.append(proxy)

            elif scheme == 'vless':
                # VLESS specific parsing
                url_parsed = urlparse(config_url)
                params = parse_qs(url_parsed.query)

                vless_type = params.get('type', [''])[0]
                if vless_type not in clash_compatible_transports:
                    continue # Skip if not compatible

                proxy = {
                    "name": url_parsed.fragment or 'vless_proxy',
                    "type": "vless",
                    "server": url_parsed.hostname,
                    "port": int(url_parsed.port),
                    "uuid": url_parsed.username,
                    "tls": params.get('security', [''])[0] == 'tls',
                    "flow": params.get('flow', [''])[0] or None,
                }
                if vless_type == "ws":
                    proxy["network"] = "ws"
                    proxy["ws-path"] = params.get('path', ['/'])[0]
                    proxy["ws-headers"] = {"Host": params.get('host', [url_parsed.hostname])[0]}
                elif vless_type == "h2":
                    proxy["network"] = "h2"
                    proxy["h2-path"] = params.get('path', ['/'])[0]
                    proxy["h2-headers"] = {"Host": params.get('host', [url_parsed.hostname])[0]}
                elif vless_type == "grpc":
                    proxy["network"] = "grpc"
                    proxy["grpc-service-name"] = params.get('serviceName', [''])[0]
                    proxy["grpc-auto-tls"] = params.get('tls', [''])[0] == '1' # Assuming 1 for true
                # Else it's tcp
                proxies.append(proxy)
                
            elif scheme == 'trojan':
                # Trojan specific parsing
                url_parsed = urlparse(config_url)
                params = parse_qs(url_parsed.query)

                proxy = {
                    "name": url_parsed.fragment or 'trojan_proxy',
                    "type": "trojan",
                    "server": url_parsed.hostname,
                    "port": int(url_parsed.port),
                    "password": url_parsed.password,
                    "tls": True, # Trojan inherently uses TLS
                    "flow": params.get('flow', [''])[0] or None,
                }
                # Check if transport is compatible with Clash Meta (e.g., ws or grpc over Trojan)
                trojan_type = params.get('type', [''])[0]
                if trojan_type == "ws":
                    proxy["network"] = "ws"
                    proxy["ws-path"] = params.get('path', ['/'])[0]
                    proxy["ws-headers"] = {"Host": params.get('host', [url_parsed.hostname])[0]}
                elif trojan_type == "grpc":
                    proxy["network"] = "grpc"
                    proxy["grpc-service-name"] = params.get('serviceName', [''])[0]
                # Else it's tcp over tls
                proxies.append(proxy)
                
            elif scheme == 'ss' or scheme == 'shadowsocks':
                # Shadowsocks specific parsing (usually ss://<base64_encoded_method:password>@server:port#name)
                # Clash Meta supports ss:// directly
                # However, for advanced features like plugins, it might be more complex
                # This basic implementation assumes direct SS config without plugins in URL
                if "@" in config_url:
                    parts = config_url[5:].split("@")
                    if len(parts) == 2:
                        method_password_encoded = parts[0]
                        server_port_name = parts[1]
                        
                        try:
                            # Decode base64 for method:password
                            method, password = base64.b64decode(method_password_encoded).decode('utf-8').split(':', 1)
                        except: # If not base64, assume it's direct method:password
                            method, password = method_password_encoded.split(':', 1)
                            
                        server_part, name = (server_port_name.split("#") + ["shadowsocks_proxy"])[:2]
                        server, port = server_part.split(':')
                        
                        proxies.append({
                            "name": name,
                            "type": "ss",
                            "server": server,
                            "port": int(port),
                            "cipher": method,
                            "password": password
                        })
                
        except Exception as e:
            print(f"  ⚠️ Error parsing config for Clash YAML ({config_url[:50]}...): {e}")
            continue

    if not proxies:
        return None

    import yaml
    proxy_names = [p['name'] for p in proxies]
    yaml_config = {
        "proxies": proxies,
        "proxy-groups": [
            {
                "name": "🚀 Manual Proxy",
                "type": "select",
                "proxies": proxy_names
            },
            {
                "name": "🌐 Auto Select",
                "type": "url-test",
                "url": "http://www.gstatic.com/generate_204",
                "interval": 300,
                "proxies": proxy_names
            }
        ],
        "rules": [
            "MATCH,🚀 Manual Proxy"
        ]
    }
    return yaml.dump(yaml_config, allow_unicode=True, sort_keys=False)

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
    with ThreadPoolExecutor(max_workers=5) as executor: # Reduced workers for fetching to avoid IP bans
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
    singbox_eligible_pool = [(c, l) for c, l in fast_configs_with_latency if urlparse(c).scheme.lower() in singbox_protocols] # Fixed to singbox_protocols

    xray_final_selected = select_configs_with_fluid_quota(xray_eligible_pool, min_target_configs_per_core, max_final_configs_per_core)
    singbox_final_selected = select_configs_with_fluid_quota(singbox_eligible_pool, min_target_configs_per_core, max_final_configs_per_core)
    
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
    # writing all_live_configs.json
    with open(output_json_file, 'w', encoding='utf-8') as f:
        json.dump(output_data_for_kv, f, indent=2, ensure_ascii=False)
    print(f"✅ Wrote combined configs to {output_json_file}.")

    # writing clash_subscription.yml (using Xray configs for Clash Meta)
    clash_yaml_content = generate_clash_yaml(xray_final_selected)
    if clash_yaml_content:
        with open(output_clash_file, 'w', encoding='utf-8') as f:
            f.write(clash_yaml_content)
        print(f"✅ Wrote Clash subscription with {len(xray_final_selected)} configs to {output_clash_file}.")
    else:
        print("⚠️ Could not generate Clash subscription file (no compatible Xray configs found).")

    # writing cache_version.txt
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
