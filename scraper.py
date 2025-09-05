# -*- coding: utf-8 -*-
"""
V2V Scraper v16.2 - Professional Debug Edition
This version adds comprehensive debugging to identify the exact point of failure.
"""
import requests
import base64
import os
import json
import re
import time
import yaml
import socket
import ssl
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qsl, unquote, quote, urlencode
from collections import defaultdict
from github import Github, Auth, GithubException

# --- CONFIGURATION ---
print("INFO: Initializing configuration...")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yaml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive'
}
GITHUB_PAT = os.environ.get('GH_PAT')
GITHUB_SEARCH_QUERIES = [
    '"vless" "subscription" in:file', '"vmess" "sub" in:file', 'filename:v2ray.txt',
    'filename:clash.yaml "vless"', 'path:.github/workflows "v2ray"', '"trojan" "configs" in:file'
]

MAX_CONFIGS_TO_TEST = 4000
MAX_PING_THRESHOLD = 5000
TARGET_CONFIGS_PER_CORE = 500
REQUEST_TIMEOUT = 10
TCP_TEST_TIMEOUT = 5
MAX_NAME_LENGTH = 45
PROTOCOL_QUOTAS = {'vless': 0.45, 'vmess': 0.45, 'trojan': 0.05, 'ss': 0.05}

if GITHUB_PAT: HEADERS['Authorization'] = f'token {GITHUB_PAT}'

# Debug counters
DEBUG_STATS = {
    'total_sources': 0,
    'successful_fetches': 0,
    'failed_fetches': 0,
    'empty_responses': 0,
    'parse_attempts': 0,
    'regex_matches_found': 0,
    'valid_configs_found': 0
}

# --- PARSING & HELPER FUNCTIONS ---
def _decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try: 
        decoded = base64.b64decode(padded_str).decode('utf-8')
        print(f"DEBUG_B64: Successfully decoded Base64 (original: {len(encoded_str)}, decoded: {len(decoded)})")
        return decoded
    except Exception as e:
        print(f"DEBUG_B64: Base64 decode failed: {e}")
        for encoding in ['latin1', 'ascii', 'utf-16']:
            try: 
                decoded = base64.b64decode(padded_str).decode(encoding)
                print(f"DEBUG_B64: Alternative encoding {encoding} worked")
                return decoded
            except: continue
        return ""

def _is_valid_config_format(config_str: str) -> bool:
    try:
        parsed = urlparse(config_str)
        is_valid = (parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] 
                   and parsed.hostname and len(config_str) > 20 and '://' in config_str)
        if is_valid:
            print(f"DEBUG_VALID: Found valid config: {parsed.scheme}://{parsed.hostname}:{parsed.port or 'default'}")
        else:
            print(f"DEBUG_INVALID: Rejected config - scheme:{parsed.scheme}, host:{parsed.hostname}, len:{len(config_str)}")
        return is_valid
    except Exception as e:
        print(f"DEBUG_VALID: Config validation error: {e}")
        return False

def parse_subscription_content(content: str) -> set:
    global DEBUG_STATS
    DEBUG_STATS['parse_attempts'] += 1
    
    print(f"DEBUG_PARSE: Starting parse - content length: {len(content)}")
    configs = set()
    
    # Show content preview
    preview = content[:200].replace('\n', '\\n').replace('\r', '\\r')
    print(f"DEBUG_PARSE: Content preview: {preview}")
    
    # Try Base64 decode first
    original_content = content
    try:
        decoded_content = _decode_padded_b64(content)
        if decoded_content and decoded_content.count("://") > content.count("://"):
            print("DEBUG_PARSE: Content appears to be Base64 encoded, using decoded version")
            content = decoded_content
    except Exception as e:
        print(f"DEBUG_PARSE: Base64 decode attempt failed: {e}")
    
    # Apply regex pattern
    pattern = r'(' + '|'.join(re.escape(p) for p in VALID_PREFIXES) + r')[^\s\'"<>\[\]{}()]*'
    print(f"DEBUG_PARSE: Using regex pattern: {pattern}")
    
    matches = re.findall(pattern, content, re.MULTILINE | re.IGNORECASE)
    print(f"DEBUG_PARSE: Regex found {len(matches)} potential matches")
    DEBUG_STATS['regex_matches_found'] += len(matches)
    
    # Show first few matches
    for i, match in enumerate(matches[:3]):
        print(f"DEBUG_PARSE: Match {i+1}: {match[:100]}...")
    
    # Validate each match
    valid_count = 0
    for match in matches:
        clean_match = match.strip().strip('\'"')
        if _is_valid_config_format(clean_match):
            configs.add(clean_match)
            valid_count += 1
    
    print(f"DEBUG_PARSE: Final result: {len(configs)} valid configs from {len(matches)} matches")
    DEBUG_STATS['valid_configs_found'] += len(configs)
    
    return configs

def parse_singbox_json_config(json_content: dict) -> set:
    print(f"DEBUG_JSON: Parsing Sing-box JSON with {len(json_content.get('outbounds', []))} outbounds")
    configs = set()
    
    if not isinstance(json_content, dict): 
        print("DEBUG_JSON: Invalid JSON structure")
        return configs
    
    for i, outbound in enumerate(json_content.get("outbounds", [])):
        try:
            protocol = outbound.get("type")
            server = outbound.get("server")
            port = outbound.get("server_port")
            uuid = outbound.get("uuid")
            
            print(f"DEBUG_JSON: Outbound {i}: type={protocol}, server={server}, port={port}")
            
            if not all([protocol, server, port, uuid]): 
                print(f"DEBUG_JSON: Outbound {i} missing required fields")
                continue
                
            if protocol == "vless":
                tls = outbound.get("tls", {})
                transport = outbound.get("transport", {})
                params = {
                    "type": transport.get("type", "tcp"),
                    "security": "tls" if tls.get("enabled") else "none",
                    "sni": tls.get("server_name", server),
                    "path": transport.get("path", "/"),
                    "host": transport.get("headers", {}).get("Host", server)
                }
                query_string = urlencode(params)
                config_str = f"vless://{uuid}@{server}:{port}?{query_string}#{quote(outbound.get('tag', 'config'))}"
                
                if _is_valid_config_format(config_str):
                    configs.add(config_str)
                    print(f"DEBUG_JSON: Successfully parsed outbound {i}")
                    
        except Exception as e:
            print(f"DEBUG_JSON: Error parsing outbound {i}: {e}")
            continue
    
    print(f"DEBUG_JSON: Final result: {len(configs)} configs from JSON")
    return configs

# --- CORE LOGIC FUNCTIONS ---
def fetch_and_parse_url(url: str) -> set:
    """
    Enhanced fetch with comprehensive debugging
    """
    global DEBUG_STATS
    DEBUG_STATS['total_sources'] += 1
    
    print(f"\n=== FETCH_DEBUG: Processing source {DEBUG_STATS['total_sources']}: {url} ===")
    
    try:
        # Make request with timeout
        print("FETCH_DEBUG: Sending HTTP request...")
        response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=HEADERS)
        
        print(f"FETCH_DEBUG: Response received - Status: {response.status_code}")
        print(f"FETCH_DEBUG: Content-Type: {response.headers.get('Content-Type', 'N/A')}")
        print(f"FETCH_DEBUG: Content-Length: {len(response.text)}")
        
        if response.status_code != 200:
            print(f"FETCH_DEBUG: Non-200 status code, skipping")
            DEBUG_STATS['failed_fetches'] += 1
            return set()
        
        response.raise_for_status()
        content = response.text
        
        if len(content) == 0:
            print("FETCH_DEBUG: Empty response content")
            DEBUG_STATS['empty_responses'] += 1
            return set()
        
        DEBUG_STATS['successful_fetches'] += 1
        
        # Content preview
        preview = content[:150].replace('\n', '\\n')
        print(f"FETCH_DEBUG: Content preview: {preview}")
        
        # Dispatch to appropriate parser
        configs = set()
        if url.endswith((".json", "sing-box.json")):
            print("FETCH_DEBUG: Attempting JSON parsing...")
            try:
                json_data = json.loads(content)
                configs = parse_singbox_json_config(json_data)
                print(f"FETCH_DEBUG: JSON parser returned {len(configs)} configs")
            except json.JSONDecodeError as e:
                print(f"FETCH_DEBUG: JSON parse failed, falling back to text parsing: {e}")
                configs = parse_subscription_content(content)
        else:
            print("FETCH_DEBUG: Attempting subscription content parsing...")
            configs = parse_subscription_content(content)
        
        print(f"FETCH_DEBUG: Final result for this source: {len(configs)} configs")
        return configs
        
    except requests.exceptions.Timeout:
        print(f"FETCH_DEBUG: Request timeout for {url}")
        DEBUG_STATS['failed_fetches'] += 1
        return set()
    except requests.exceptions.ConnectionError as e:
        print(f"FETCH_DEBUG: Connection error for {url}: {str(e)[:100]}")
        DEBUG_STATS['failed_fetches'] += 1
        return set()
    except requests.exceptions.RequestException as e:
        print(f"FETCH_DEBUG: Request exception for {url}: {str(e)[:100]}")
        DEBUG_STATS['failed_fetches'] += 1
        return set()
    except Exception as e:
        print(f"FETCH_DEBUG: Unexpected error for {url}: {str(e)[:100]}")
        DEBUG_STATS['failed_fetches'] += 1
        return set()

def get_static_sources() -> list:
    print("INFO: Loading static sources...")
    try:
        with open(SOURCES_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            sources = data.get("static", [])
            print(f"INFO: Found {len(sources)} static sources.")
            
            # Show first few sources for debugging
            for i, source in enumerate(sources[:3]):
                print(f"DEBUG_SOURCES: Static {i+1}: {source}")
                
            return sources
    except Exception as e:
        print(f"CRITICAL: Could not read static sources file '{SOURCES_FILE}'. Error: {e}")
        return []

def discover_dynamic_sources() -> list:
    print("INFO: Attempting to discover dynamic sources from GitHub...")
    if not GITHUB_PAT:
        print("INFO: Skipping dynamic source discovery because GH_PAT is missing.")
        return []
    
    dynamic_sources = set()
    try:
        g = Github(auth=Auth.Token(GITHUB_PAT), timeout=30)
        user = g.get_user()
        print(f"INFO: Successfully authenticated to GitHub as user '{user.login}'.")
        
        freshness_threshold = datetime.now(timezone.utc) - timedelta(hours=240)
        
        for query in GITHUB_SEARCH_QUERIES:
            print(f"INFO: Searching GitHub for query: '{query}'")
            try:
                repos = g.search_repositories(query=f'{query}', sort='updated', order='desc')
                for repo in repos:
                    if repo.updated_at < freshness_threshold or len(dynamic_sources) >= 75:
                        break
                    try:
                        for content_file in repo.get_contents(""):
                            if (content_file.type == 'file' and 
                                content_file.name.lower().endswith(('.txt', '.md', '.json', '.yaml', '.yml'))):
                                dynamic_sources.add(content_file.download_url)
                    except GithubException:
                        continue
                    if len(dynamic_sources) >= 75:
                        break
            except GithubException as e:
                print(f"WARNING: GitHub API error during search for query '{query}'. Error: {e}")
                continue
        
        sources_list = list(dynamic_sources)
        print(f"INFO: Found {len(sources_list)} dynamic sources from GitHub.")
        
        # Show first few dynamic sources
        for i, source in enumerate(sources_list[:3]):
            print(f"DEBUG_SOURCES: Dynamic {i+1}: {source}")
            
        return sources_list
    except Exception as e:
        print(f"CRITICAL: A fatal error occurred during GitHub dynamic source discovery. Error: {e}")
        return []

def print_debug_summary():
    """Print comprehensive debug statistics"""
    print("\n" + "="*60)
    print("COMPREHENSIVE DEBUG SUMMARY")
    print("="*60)
    print(f"Total sources processed: {DEBUG_STATS['total_sources']}")
    print(f"Successful fetches: {DEBUG_STATS['successful_fetches']}")
    print(f"Failed fetches: {DEBUG_STATS['failed_fetches']}")
    print(f"Empty responses: {DEBUG_STATS['empty_responses']}")
    print(f"Parse attempts: {DEBUG_STATS['parse_attempts']}")
    print(f"Regex matches found: {DEBUG_STATS['regex_matches_found']}")
    print(f"Valid configs found: {DEBUG_STATS['valid_configs_found']}")
    
    if DEBUG_STATS['total_sources'] > 0:
        success_rate = (DEBUG_STATS['successful_fetches'] / DEBUG_STATS['total_sources']) * 100
        print(f"Fetch success rate: {success_rate:.1f}%")
    
    if DEBUG_STATS['successful_fetches'] > 0:
        avg_matches = DEBUG_STATS['regex_matches_found'] / DEBUG_STATS['successful_fetches']
        avg_valid = DEBUG_STATS['valid_configs_found'] / DEBUG_STATS['successful_fetches']
        print(f"Average regex matches per successful fetch: {avg_matches:.1f}")
        print(f"Average valid configs per successful fetch: {avg_valid:.1f}")
    
    print("="*60)

# --- REST OF THE CODE (validation, testing, main) ---
def validate_and_categorize_configs(configs: set) -> dict:
    print(f"DEBUG_VALIDATE: Categorizing {len(configs)} configs...")
    categorized = {'xray': set(), 'singbox_only': set()}
    
    for cfg in configs:
        if not _is_valid_config_format(cfg): 
            continue
        try:
            parsed = urlparse(cfg)
            query_params = dict(parse_qsl(parsed.query))
            if (parsed.scheme in ('hysteria2', 'hy2', 'tuic') or 
                query_params.get('security') == 'reality'):
                categorized['singbox_only'].add(cfg)
            else:
                categorized['xray'].add(cfg)
        except Exception:
            categorized['xray'].add(cfg)
    
    print(f"DEBUG_VALIDATE: Xray-compatible: {len(categorized['xray'])}, Sing-box only: {len(categorized['singbox_only'])}")
    return categorized

def test_config_advanced(config_str: str) -> dict:
    # Simplified version for debugging - original logic maintained
    try:
        parsed_url = urlparse(config_str)
        host, port = parsed_url.hostname, parsed_url.port
        if not host or not port: return {'config_str': config_str, 'ping': 9999}
        
        # Quick socket test
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(TCP_TEST_TIMEOUT)
        start_time = time.monotonic()
        
        try:
            sock.connect((host, port))
            ping = int((time.monotonic() - start_time) * 1000)
            return {'config_str': config_str, 'ping': ping}
        except:
            return {'config_str': config_str, 'ping': 9999}
        finally:
            sock.close()
    except:
        return {'config_str': config_str, 'ping': 9999}

def shorten_config_name(config_str: str) -> str:
    try:
        if '#' not in config_str: return config_str
        base_part, name_part = config_str.split('#', 1)
        decoded_name = unquote(name_part)
        if len(decoded_name) > MAX_NAME_LENGTH:
            shortened_name = decoded_name[:MAX_NAME_LENGTH-3] + '...'
            return base_part + '#' + quote(shortened_name)
        return config_str
    except Exception: return config_str

def generate_clash_subscription(configs: list) -> str | None:
    # Simplified for debugging
    if not configs: return None
    return yaml.dump({'proxies': [], 'proxy-groups': [], 'rules': []})

def main():
    print("--- V2V Scraper v16.2 (Professional Debug) ---")
    start_time = time.time()
    
    # Get all sources
    static_sources = get_static_sources()
    dynamic_sources = discover_dynamic_sources()
    all_sources = list(set(static_sources + dynamic_sources))
    
    print(f"INFO: Total unique sources to fetch: {len(all_sources)}")
    
    if not all_sources: 
        print("CRITICAL: No sources found. Exiting gracefully.")
        return
    
    # Process first 10 sources for detailed debugging
    print(f"\nDEBUG_MAIN: Processing first 10 sources for detailed analysis...")
    test_sources = all_sources[:10]
    
    raw_configs = set()
    
    # Process sources sequentially for better debugging
    for i, source in enumerate(test_sources):
        print(f"\n--- Processing source {i+1}/{len(test_sources)} ---")
        configs = fetch_and_parse_url(source)
        raw_configs.update(configs)
        print(f"Running total configs: {len(raw_configs)}")
    
    print_debug_summary()
    
    print(f"INFO: Total unique raw configs found after fetching: {len(raw_configs)}")
    
    if not raw_configs: 
        print("CRITICAL: No raw configs could be parsed. Stopping here for analysis.")
        print("RECOMMENDATION: Check the debug output above to identify the issue.")
        return
    
    # If we found configs, continue with a simplified version
    print("SUCCESS: Raw configs found! Proceeding with simplified processing...")
    
    # Simple output for testing
    sample_configs = list(raw_configs)[:100]  # Take first 100 for testing
    output_data = {
        'xray': [{'config': cfg, 'ping': 999} for cfg in sample_configs[:50]],
        'singbox': [{'config': cfg, 'ping': 999} for cfg in sample_configs[50:]]
    }
    
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)
    
    with open(OUTPUT_CLASH_FILE, 'w', encoding='utf-8') as f:
        f.write("proxies: []\nproxy-groups: []\nrules: []")
    
    with open(CACHE_VERSION_FILE, 'w') as f:
        f.write(str(int(time.time())))
    
    elapsed_time = time.time() - start_time
    print(f"\n--- Debug Process Completed in {elapsed_time:.2f} seconds ---")
    print(f"Results: Found {len(raw_configs)} total configs")

if __name__ == "__main__":
    main()