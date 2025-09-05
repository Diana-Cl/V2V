# -*- coding: utf-8 -*-
import os, uuid, json, base64, requests, yaml, re
from flask import Flask, request, jsonify
from flask_cors import CORS
from redis import Redis
from urllib.parse import urlparse, parse_qsl, unquote

app = Flask(__name__)
CORS(app) 

try:
    redis_client = Redis.from_url(os.environ.get("KV_URL"))
except Exception as e:
    redis_client = None
    print(f"CRITICAL: Could not connect to Vercel KV. API will not work. Error: {e}")

LIVE_CONFIGS_URL = os.environ.get("LIVE_CONFIGS_URL")
if not LIVE_CONFIGS_URL: print("CRITICAL: LIVE_CONFIGS_URL environment variable is not set!")

# --- Helper Functions (Mirrored from scraper.py for consistency) ---
def _decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try: return base64.b64decode(padded_str).decode('utf-8')
    except: return ""

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
    cred = _decode_padded_b64(unquote(url.username)).split(':')
    if len(cred) < 2 or not cred[0] or not cred[1]: return False
    proxy.update({'cipher': cred[0], 'password': cred[1]})
    return True

def generate_clash_config(configs: list) -> str | None:
    proxies, used_names = [], set()
    for i, config_str in enumerate(configs):
        try:
            protocol = config_str.split("://")[0]
            if protocol not in ('vless', 'vmess', 'trojan', 'ss'): continue
            url = urlparse(config_str)
            if not url.hostname or not url.port or 'reality' in config_str.lower(): continue
            name = unquote(url.fragment) if url.fragment else f"{protocol}-{url.hostname}-{i}"
            original_name = re.sub(r'[^\w\s-]', '', name).strip()[:50]
            if not original_name: original_name = f"{protocol}-{i}"
            final_name, count = original_name, 1
            while final_name in used_names:
                final_name = f"{original_name}_{count}"
                count += 1
            used_names.add(final_name)
            proxy = {'name': final_name, 'type': protocol, 'server': url.hostname, 'port': int(url.port)}
            params = dict(parse_qsl(url.query))
            success = False
            if protocol == 'vless': success = _clash_parse_vless(proxy, url, params)
            elif protocol == 'vmess': success = _clash_parse_vmess(proxy, config_str)
            elif protocol == 'trojan': success = _clash_parse_trojan(proxy, url, params)
            elif protocol == 'ss': success = _clash_parse_ss(proxy, url)
            if success: proxies.append(proxy)
        except Exception: continue
    if not proxies: return None
    clash_config = {'proxies': proxies,'proxy-groups': [{'name': 'V2V-Auto','type': 'url-test','proxies': [p['name'] for p in proxies],'url': 'http://www.gstatic.com/generate_204','interval': 300},{'name': 'V2V-Proxies','type': 'select','proxies': ['V2V-Auto'] + [p['name'] for p in proxies]}],'rules': ['MATCH,V2V-Proxies']}
    return yaml.dump(clash_config, allow_unicode=True, sort_keys=False, indent=2)

# --- API Endpoints ---
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    if request.path == '/': return "V2V Subscription API is running."
    parts = request.path.strip('/').split('/')
    try:
        if len(parts) == 2 and parts[0] == 'sub': return get_subscription(parts[1], "standard")
        if len(parts) == 3 and parts[0] == 'sub' and parts[1] == 'clash': return get_subscription(parts[2], "clash")
    except Exception as e:
        print(f"ERROR processing request for {path}: {e}")
        return "Internal Server Error", 500
    return "Not Found", 404

def get_subscription(sub_uuid, sub_type):
    if not redis_client: return "Database connection error.", 503
    try:
        key = f"sub:{sub_uuid}"
        user_configs_json = redis_client.get(key)
        if not user_configs_json: return "Subscription not found.", 404
        user_configs = json.loads(user_configs_json)
    except Exception as e:
        print(f"ERROR reading from Redis: {e}")
        return "Database error.", 500

    try:
        response = requests.get(LIVE_CONFIGS_URL, timeout=5)
        response.raise_for_status()
        live_data = response.json()
        live_configs_set = {item['config'] for item in live_data.get('xray', [])}
    except Exception:
        live_configs_set = set(user_configs)
        print(f"WARNING: Could not fetch live configs. Using user's list as fallback.")

    healed_configs, dead_configs_count, user_configs_set = [], 0, set(user_configs)
    for config in user_configs:
        if config in live_configs_set: healed_configs.append(config)
        else: dead_configs_count += 1
    
    if dead_configs_count > 0:
        potential_replacements = [cfg for cfg in live_configs_set if cfg not in user_configs_set]
        healed_configs.extend(potential_replacements[:dead_configs_count])
    if not healed_configs: return "No valid configs found after healing.", 500

    if sub_type == "clash":
        clash_content = generate_clash_config(healed_configs)
        return clash_content if clash_content else ("No valid Clash configs could be generated.", 500)
    else:
        final_configs_str = "\n".join(healed_configs)
        return base64.b64encode(final_configs_str.encode("utf-8")).decode("utf-8")

@app.route('/api/subscribe', methods=['POST'])
def create_subscription():
    if not redis_client: return jsonify({"error": "Database connection error."}), 503
    try:
        selected_configs = request.json.get('configs')
        sub_type = request.json.get('type', 'standard')
        if not isinstance(selected_configs, list) or not selected_configs:
            return jsonify({"error": "Invalid input. 'configs' must be a non-empty list."}), 400
        
        sub_uuid = str(uuid.uuid4())
        key = f"sub:{sub_uuid}"
        redis_client.set(key, json.dumps(selected_configs))
        redis_client.expire(key, 30 * 24 * 60 * 60)
        
        host_url = request.host_url.replace("http://", "https://")
        if sub_type == "clash":
            subscription_url = f"{host_url}sub/clash/{sub_uuid}"
        else:
            subscription_url = f"{host_url}sub/{sub_uuid}"
        return jsonify({"subscription_url": subscription_url, "uuid": sub_uuid})
    except Exception as e:
        print(f"ERROR in create_subscription: {e}")
        return jsonify({"error": "Internal server error during subscription creation."}), 500

