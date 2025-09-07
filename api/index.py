# -*- coding: utf-8 -*-
import os
import uuid
import json
import base64
import requests
import yaml
import re
import socket
import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from redis import Redis
from urllib.parse import urlparse, parse_qsl, unquote
from concurrent.futures import ThreadPoolExecutor
from typing import Set, Optional

# --- Constants ---
SUB_KEY_PREFIX = "sub:"
SUB_EXPIRY_SECONDS = 30 * 24 * 60 * 60  # 30 days
SUPPORTED_PROTOCOLS = {'vless', 'vmess', 'trojan', 'ss'}
PING_TIMEOUT = 2.5 # seconds
PING_MAX_WORKERS = 30
REQUESTS_TIMEOUT = 5 # seconds

# --- Flask App Initialization ---
app = Flask(__name__)
CORS(app)

# --- Connections ---
redis_client = None
try:
    redis_url = os.environ.get("KV_URL")
    if redis_url:
        redis_client = Redis.from_url(redis_url)
    else:
        print("WARNING: KV_URL environment variable is not set. Redis client not initialized.")
except Exception as e:
    print(f"CRITICAL: Could not connect to Vercel KV. Error: {e}")

# --- NEW: Failover URL Configuration ---
PRIMARY_CONFIGS_URL = os.environ.get("PRIMARY_CONFIGS_URL")
FALLBACK_CONFIGS_URL = os.environ.get("FALLBACK_CONFIGS_URL")

if not PRIMARY_CONFIGS_URL:
    print("CRITICAL: PRIMARY_CONFIGS_URL environment variable is not set!")
if not FALLBACK_CONFIGS_URL:
    print("WARNING: FALLBACK_CONFIGS_URL is not set. No failover source is available.")

# --- Helper Functions (Shared & Parsing) ---
def _decode_padded_b64(encoded_str: str) -> str:
    """Decodes a base64 string, adding padding if necessary."""
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try:
        return base64.b64decode(padded_str).decode('utf-8')
    except (base64.binascii.Error, UnicodeDecodeError):
        return ""

def _extract_connection_details(config: str) -> dict | None:
    """Parses any supported proxy config string to extract hostname and port for TCP ping."""
    try:
        protocol = config.split("://")[0]
        if protocol not in SUPPORTED_PROTOCOLS:
            return None
        if protocol == 'vmess':
            decoded_str = _decode_padded_b64(config.replace("vmess://", ""))
            if not decoded_str: return None
            vmess_data = json.loads(decoded_str)
            return {'hostname': vmess_data.get('add'), 'port': int(vmess_data.get('port'))}
        url = urlparse(config)
        if not url.hostname or not url.port:
            return None
        return {'hostname': url.hostname, 'port': int(url.port)}
    except (ValueError, IndexError, json.JSONDecodeError):
        return None

# --- START: TCP Ping Functionality ---
def _test_tcp_connection(config: str) -> dict:
    """Tests a single TCP connection and returns the latency."""
    details = _extract_connection_details(config)
    if not details:
        return {'config': config, 'ping': None}
    hostname, port = details['hostname'], details['port']
    start_time = time.time()
    try:
        with socket.create_connection((hostname, port), timeout=PING_TIMEOUT) as sock:
            end_time = time.time()
            latency = int((end_time - start_time) * 1000)
            return {'config': config, 'ping': latency}
    except (socket.error, socket.timeout):
        return {'config': config, 'ping': None}

@app.route('/api/ping', methods=['POST'])
def tcp_ping_handler():
    """API endpoint to ping a list of proxy configurations."""
    try:
        data = request.get_json()
        configs = data.get('configs')
        if not isinstance(configs, list) or not configs:
            return jsonify({'error': 'Invalid request: "configs" must be a non-empty array.'}), 400
        with ThreadPoolExecutor(max_workers=PING_MAX_WORKERS) as executor:
            ping_results = list(executor.map(_test_tcp_connection, configs))
        return jsonify(ping_results), 200
    except Exception as e:
        print(f"ERROR in tcp_ping_handler: {e}")
        return jsonify({'error': 'An unexpected error occurred.'}), 500
# --- END: TCP Ping Functionality ---


# --- START: Clash Config Generation ---
# This section remains unchanged as its logic is self-contained.
# (Functions: _clash_parse_vless, _clash_parse_vmess, _clash_parse_trojan, _clash_parse_ss, generate_clash_config)
def _clash_parse_vless(proxy, url, params):
    if not url.username: return False
    proxy.update({'uuid': url.username, 'tls': params.get('security') == 'tls', 'network': params.get('type', 'tcp'), 'servername': params.get('sni', url.hostname), 'skip-cert-verify': True})
    if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': params.get('path', '/'), 'headers': {'Host': params.get('host', url.hostname)}}
    return True
def _clash_parse_vmess(proxy, config_str):
    decoded = json.loads(_decode_padded_b64(config_str.replace("vmess://", "")))
    if not decoded.get('id'): return False
    proxy.update({'server': decoded.get('add'), 'port': int(decoded.get('port')), 'uuid': decoded.get('id'), 'alterId': decoded.get('aid', 0), 'cipher': decoded.get('scy', 'auto'), 'tls': decoded.get('tls') == 'tls', 'network': decoded.get('net', 'tcp'), 'servername': decoded.get('sni', decoded.get('add')), 'skip-cert-verify': True})
    if proxy.get('network') == 'ws': proxy['ws-opts'] = {'path': decoded.get('path', '/'), 'headers': {'Host': decoded.get('host', decoded.get('add'))}}
    return True
def _clash_parse_trojan(proxy, url, params):
    if not url.username: return False
    proxy.update({'password': url.username, 'sni': params.get('sni', url.hostname), 'skip-cert-verify': True})
    return True
def _clash_parse_ss(proxy, url):
    cred_str = _decode_padded_b64(unquote(url.username))
    if not cred_str: return False
    cred = cred_str.split(':', 1)
    if len(cred) < 2 or not cred[0] or not cred[1]: return False
    proxy.update({'cipher': cred[0], 'password': cred[1]})
    return True
def generate_clash_config(configs: list) -> str | None:
    proxies, used_names = [], set()
    for i, config_str in enumerate(configs):
        try:
            protocol = config_str.split("://")[0]
            if protocol not in SUPPORTED_PROTOCOLS or 'reality' in config_str.lower(): continue
            url = urlparse(config_str)
            if protocol != 'vmess' and (not url.hostname or not url.port): continue
            name = unquote(url.fragment) if url.fragment else f"{protocol}-{url.hostname}-{i}"
            original_name = re.sub(r'[^\w\s-]', '', name).strip()[:50]
            if not original_name: original_name = f"{protocol}-{i}"
            final_name, count = original_name, 1
            while final_name in used_names:
                final_name = f"{original_name}_{count}"
                count += 1
            used_names.add(final_name)
            proxy = {'name': final_name, 'type': protocol, 'server': url.hostname, 'port': int(url.port) if url.port else None}
            params = dict(parse_qsl(url.query))
            success = False
            if protocol == 'vless': success = _clash_parse_vless(proxy, url, params)
            elif protocol == 'vmess': success = _clash_parse_vmess(proxy, config_str)
            elif protocol == 'trojan': success = _clash_parse_trojan(proxy, url, params)
            elif protocol == 'ss': success = _clash_parse_ss(proxy, url)
            if success: proxies.append(proxy)
        except Exception: continue
    if not proxies: return None
    proxy_names = [p['name'] for p in proxies]
    clash_config = {'proxies': proxies, 'proxy-groups': [{'name': 'V2V-Auto', 'type': 'url-test', 'proxies': proxy_names, 'url': 'http://www.gstatic.com/generate_204', 'interval': 300}, {'name': 'V2V-Proxies', 'type': 'select', 'proxies': ['V2V-Auto'] + proxy_names}], 'rules': ['MATCH,V2V-Proxies']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, indent=2)
# --- END: Clash Config Generation ---


# --- START: Subscription Logic with Failover ---

def _fetch_live_configs(urls: list) -> Optional[Set[str]]:
    """Tries to fetch and parse configs from a list of URLs, returning the first success."""
    for i, url in enumerate(urls):
        if not url:
            continue
        source_name = "PRIMARY" if i == 0 else "FALLBACK"
        try:
            print(f"INFO: Attempting to fetch configs from {source_name} source...")
            response = requests.get(url, timeout=REQUESTS_TIMEOUT)
            response.raise_for_status()
            live_data = response.json()
            live_configs_set = {item['config'] for item in live_data.get('xray', [])}
            print(f"SUCCESS: Fetched {len(live_configs_set)} configs from {source_name} source.")
            return live_configs_set
        except requests.RequestException as e:
            print(f"WARNING: Could not fetch from {source_name} source ({url}). Error: {e}")
        except json.JSONDecodeError as e:
            print(f"WARNING: Could not parse JSON from {source_name} source ({url}). Error: {e}")
    
    print("CRITICAL: All remote config sources failed.")
    return None

def get_subscription(sub_uuid: str, sub_type: str):
    """Fetches, heals, and formats a subscription with failover logic."""
    if not redis_client: return "Database connection is not available.", 503
    
    try:
        key = f"{SUB_KEY_PREFIX}{sub_uuid}"
        user_configs_json = redis_client.get(key)
        if not user_configs_json:
            return "Subscription not found.", 404
        user_configs = json.loads(user_configs_json)
        user_configs_set = set(user_configs)
    except Exception as e:
        print(f"ERROR reading from Redis for UUID {sub_uuid}: {e}")
        return "Failed to retrieve subscription data.", 500

    # Fetch live configs using the new failover function
    live_configs_set = _fetch_live_configs([PRIMARY_CONFIGS_URL, FALLBACK_CONFIGS_URL])
    
    # If all remote sources fail, use the user's list as the ultimate fallback for healing
    if live_configs_set is None:
        print("WARNING: Using user's own list as a last resort for healing.")
        live_configs_set = user_configs_set

    # Healing Logic
    healed_configs = [cfg for cfg in user_configs if cfg in live_configs_set]
    dead_configs_count = len(user_configs) - len(healed_configs)
    
    if dead_configs_count > 0:
        potential_replacements = [cfg for cfg in live_configs_set if cfg not in user_configs_set]
        healed_configs.extend(potential_replacements[:dead_configs_count])

    if not healed_configs:
        return "No valid configurations could be found after healing.", 404

    # Format output
    if sub_type == "clash":
        clash_content = generate_clash_config(healed_configs)
        return clash_content if clash_content else ("No valid Clash configs could be generated.", 500)
    else: # standard
        final_configs_str = "\n".join(healed_configs)
        return base64.b64encode(final_configs_str.encode("utf-8")).decode("utf-8")

# --- API Endpoints ---
@app.route('/', methods=['GET'])
def index():
    return "V2V Subscription API is running."

@app.route('/api/subscribe', methods=['POST'])
def create_subscription():
    if not redis_client:
        return jsonify({"error": "Database service is unavailable."}), 503
    try:
        data = request.get_json()
        selected_configs = data.get('configs')
        sub_type = data.get('type', 'standard')
        if not isinstance(selected_configs, list) or not selected_configs:
            return jsonify({"error": "Invalid input. 'configs' must be a non-empty list."}), 400
        sub_uuid = str(uuid.uuid4())
        key = f"{SUB_KEY_PREFIX}{sub_uuid}"
        redis_client.set(key, json.dumps(selected_configs), ex=SUB_EXPIRY_SECONDS)
        host_url = request.host_url.replace("http://", "https://")
        sub_path = f"sub/clash/{sub_uuid}" if sub_type == "clash" else f"sub/{sub_uuid}"
        subscription_url = f"{host_url}{sub_path}"
        return jsonify({"subscription_url": subscription_url, "uuid": sub_uuid}), 201
    except Exception as e:
        print(f"ERROR in create_subscription: {e}")
        return jsonify({"error": "Internal server error."}), 500

@app.route('/sub/<string:sub_uuid>', methods=['GET'])
def handle_standard_sub(sub_uuid):
    return get_subscription(sub_uuid, "standard")

@app.route('/sub/clash/<string:sub_uuid>', methods=['GET'])
def handle_clash_sub(sub_uuid):
    return get_subscription(sub_uuid, "clash")

# Vercel handler
app = app
