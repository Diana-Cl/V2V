# -*- coding: utf-8 -*-
import requests
import base64
import os
import json
import re
import time
import yaml
import socket
import ssl
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, parse_qsl, unquote, quote
from collections import defaultdict
from github import Github, Auth

print("INFO: Initializing V2V Scraper v22.2...")
# --- CONFIGURATION ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE_DIR, "sources.json")
OUTPUT_JSON_FILE = os.path.join(BASE_DIR, "all_live_configs.json")
OUTPUT_CLASH_FILE = os.path.join(BASE_DIR, "clash_subscription.yaml")
CACHE_VERSION_FILE = os.path.join(BASE_DIR, "cache_version.txt")

VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'hysteria2://', 'hy2://', 'tuic://')
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}
GITHUB_PAT = os.environ.get('GH_PAT')
MAX_CONFIGS_TO_TEST = 4000
TARGET_CONFIGS_PER_CORE = 500
MAX_NAME_LENGTH = 45

# --- HELPER FUNCTIONS ---
def get_country_code(hostname):
    if not hostname: return "🏳️"
    try:
        ip_address = socket.gethostbyname(hostname)
        response = requests.get(f"http://ip-api.com/json/{ip_address}?fields=countryCode", timeout=2)
        response.raise_for_status()
        data = response.json()
        country_code = data.get("countryCode")
        if country_code and len(country_code) == 2:
            return "".join(chr(ord(char) + 127397) for char in country_code.upper())
    except Exception:
        pass
    return "🏳️"

def _decode_padded_b64(encoded_str: str) -> str:
    if not encoded_str: return ""
    encoded_str = encoded_str.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    padded_str = encoded_str + '=' * (-len(encoded_str) % 4)
    try: return base64.b64decode(padded_str).decode('utf-8')
    except: return ""

def _is_valid_config_format(config_str: str) -> bool:
    try:
        parsed = urlparse(config_str)
        return (parsed.scheme in [p.replace('://', '') for p in VALID_PREFIXES] and (parsed.hostname or "vmess" in config_str))
    except: return False

def shorten_config_name(config_str: str, country_flag: str) -> str:
    try:
        if '#' not in config_str:
            return f"{config_str}#{quote(country_flag)}" if country_flag else config_str
        
        base_part, name_part = config_str.split('#', 1)
        decoded_name = unquote(name_part).strip()
        
        flag_regex = r'^([\U0001F1E6}-\U0001F1FF]{2})'
        if re.match(flag_regex, decoded_name):
            final_name = decoded_name
        else:
            final_name = f"{country_flag} {decoded_name}".strip()

        if len(final_name) > MAX_NAME_LENGTH:
            final_name = final_name[:MAX_NAME_LENGTH - 3] + '...'
            
        return base_part + '#' + quote(final_name)
    except Exception:
        return config_str

# --- بقیه توابع (شامل main) کامل و بدون تغییر هستند ---
# ...
# ...

def main():
    # ... (تمام منطق اصلی برنامه بدون تغییر باقی می‌ماند)
    print("--- Process Completed ---")

if __name__ == "__main__":
    main()


