import requests
import base64
import os
import json
import re
from concurrent.futures import ThreadPoolExecutor

BASE_SOURCES = [
    # // Main Sources from Barry-far
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub2.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub3.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub4.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub5.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub6.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub7.txt",
    "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub8.txt",

    # // Popular & High-Quality Aggregators
    "https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt",
    "https://raw.githubusercontent.com/itsyebekhe/PSG/main/lite/subscriptions/xray/normal/mix",
    "https://raw.githubusercontent.com/arshiacomplus/v2rayExtractor/refs/heads/main/mix/sub.html",
    "https://raw.githubusercontent.com/lagzian/SS-Collector/refs/heads/main/mix.txt",
    
    # // User-Added & Corrected Links
    "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/SSTime",
    "https://raw.githubusercontent.com/hamedcode/port-based-v2ray-configs/main/sub/port_8443.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub1.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub2.txt",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/Sub3.txt",
    "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",

    # // High-Quality Base64 Source
    "https://robin.nscl.ir/"
]
OUTPUT_JSON_FILE = 'all_live_configs.json'
VALID_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://', 'wg://')
HEADERS = {'User-Agent': 'V2V-Collector/1.0'}

def get_content_from_url(url: str) -> str | None:
    try:
        response = requests.get(url, timeout=10, headers=HEADERS)
        response.raise_for_status()
        return response.text
    except Exception:
        return None

def fetch_and_parse_url(url: str) -> set[str]:
    content = get_content_from_url(url)
    if not content: return set()
    try:
        content = base64.b64decode(content).decode('utf-8')
    except:
        pass
    return set(re.findall(r'(vless|vmess|trojan|ss|wg)://[^\s\'"<]+', content))

def main():
    print("V2V Collector: Fetching and de-duplicating configs...")
    with ThreadPoolExecutor(max_workers=20) as executor:
        config_sets = executor.map(fetch_and_parse_url, BASE_SOURCES)
    
    all_configs_raw = set.union(*config_sets)
    print(f"Found {len(all_configs_raw)} unique raw configs.")

    final_configs = {'xray': [], 'singbox': []}
    for cfg in all_configs_raw:
        # A simple categorization logic
        protocol = cfg.split('://')[0]
        if 'reality' in cfg or protocol == 'wg':
             final_configs['singbox'].append({'config_str': cfg, 'ping': 'N/A'})
        else:
             final_configs['xray'].append({'config_str': cfg, 'ping': 'N/A'})
    
    with open(OUTPUT_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(final_configs, f, ensure_ascii=False, indent=2)
    
    print("Process completed successfully.")
    print(f"Saved {len(final_configs['xray'])} xray configs and {len(final_configs['singbox'])} singbox configs.")

if __name__ == "__main__":
    main()
