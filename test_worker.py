#!/usr/bin/env python3
"""
تست کامل Worker و فایل‌های Clash
"""

import requests
import json
import yaml
import time
import sys

# تنظیمات
WORKER_URLS = [
    'https://v2v-proxy.mbrgh87.workers.dev',
    'https://v2v.mbrgh87.workers.dev',
    'https://rapid-scene-1da6.mbrgh87.workers.dev',
    'https://winter-hill-0307.mbrgh87.workers.dev',
]

# رنگ‌ها
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
RESET = '\033[0m'

def print_success(msg):
    print(f"{GREEN}✓{RESET} {msg}")

def print_error(msg):
    print(f"{RED}✗{RESET} {msg}")

def print_warning(msg):
    print(f"{YELLOW}⚠{RESET} {msg}")

def print_info(msg):
    print(f"{BLUE}ℹ{RESET} {msg}")

def test_worker_status(url):
    """تست وضعیت Worker"""
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            data = response.json()
            if data.get('status') == 'V2V Worker Active':
                return True, data.get('version', 'Unknown')
        return False, None
    except:
        return False, None

def test_worker_ping(url):
    """تست قابلیت ping Worker"""
    try:
        response = requests.post(
            f"{url}/ping",
            json={'host': '8.8.8.8', 'port': 53},
            timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            if 'latency' in data:
                return True, data.get('latency')
        return False, None
    except:
        return False, None

def test_create_subscription(url, configs, format_type):
    """تست ساخت subscription"""
    try:
        response = requests.post(
            f"{url}/create-sub",
            json={'configs': configs, 'format': format_type},
            timeout=15
        )
        if response.status_code == 200:
            data = response.json()
            if data.get('success'):
                return True, data.get('id'), data.get('url')
        return False, None, None
    except Exception as e:
        return False, None, str(e)

def test_fetch_subscription(url):
    """تست دریافت subscription"""
    try:
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            return True, response.text
        return False, None
    except:
        return False, None

def validate_clash_yaml(yaml_content):
    """اعتبارسنجی فایل Clash YAML"""
    errors = []
    
    try:
        data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        return False, [f"YAML Syntax Error: {e}"]
    
    # بررسی کلیدهای ضروری
    if 'proxies' not in data:
        errors.append("Missing 'proxies' key")
    elif not isinstance(data['proxies'], list):
        errors.append("'proxies' must be a list")
    
    if 'proxy-groups' not in data:
        errors.append("Missing 'proxy-groups' key")
    elif not isinstance(data['proxy-groups'], list):
        errors.append("'proxy-groups' must be a list")
    
    if 'rules' not in data:
        errors.append("Missing 'rules' key")
    elif not isinstance(data['rules'], list):
        errors.append("'rules' must be a list")
    
    # بررسی proxies
    if 'proxies' in data and isinstance(data['proxies'], list):
        for i, proxy in enumerate(data['proxies']):
            if 'name' not in proxy:
                errors.append(f"Proxy {i}: Missing 'name'")
            if 'type' not in proxy:
                errors.append(f"Proxy {i}: Missing 'type'")
            if 'server' not in proxy:
                errors.append(f"Proxy {i}: Missing 'server'")
            if 'port' not in proxy:
                errors.append(f"Proxy {i}: Missing 'port'")
    
    # بررسی proxy-groups
    if 'proxy-groups' in data and isinstance(data['proxy-groups'], list):
        found_auto = False
        found_select = False
        for group in data['proxy-groups']:
            if '🚀 V2V Auto' in group.get('name', ''):
                found_auto = True
            if '🎯 V2V Select' in group.get('name', ''):
                found_select = True
        
        if not found_auto:
            errors.append("Missing '🚀 V2V Auto' group")
        if not found_select:
            errors.append("Missing '🎯 V2V Select' group")
    
    return len(errors) == 0, errors

def main():
    print("=" * 60)
    print("V2V Worker & Clash Complete Test")
    print("=" * 60)
    print()
    
    # تست 1: بررسی Workers
    print("Test 1: Checking Workers Status")
    print("-" * 60)
    active_workers = []
    for url in WORKER_URLS:
        status, version = test_worker_status(url)
        if status:
            print_success(f"{url} (v{version})")
            active_workers.append(url)
        else:
            print_error(f"{url} - Not responding")
    
    if not active_workers:
        print_error("No active workers found!")
        sys.exit(1)
    
    print()
    print_info(f"Active Workers: {len(active_workers)}/{len(WORKER_URLS)}")
    print()
    
    # تست 2: بررسی قابلیت Ping
    print("Test 2: Testing Ping Capability")
    print("-" * 60)
    for url in active_workers[:2]:  # فقط 2 تای اول
        success, latency = test_worker_ping(url)
        if success:
            print_success(f"{url} - Latency: {latency}ms")
        else:
            print_error(f"{url} - Ping failed")
    print()
    
    # تست 3: نمونه configs
    sample_configs = [
        "vmess://eyJhZGQiOiIxMDQuMjYuNS4yNTEiLCJhaWQiOiIwIiwiaG9zdCI6IiIsImlkIjoiNDIzZDFhMDUtOWRmMS00NzM3LWI0YWEtZDU5NzIwMTBjYzk3IiwibmV0Ijoid3MiLCJwYXRoIjoiLyIsInBvcnQiOiI0NDMiLCJwcyI6IlRlc3QtVk1lc3MiLCJzY3kiOiJhdXRvIiwic25pIjoiIiwidGxzIjoidGxzIiwidHlwZSI6IiIsInYiOiIyIn0=",
        "vless://423d1a05-9df1-4737-b4aa-d5972010cc97@104.26.5.251:443?security=tls&type=ws&path=/&host=#Test-VLESS",
        "trojan://423d1a05@104.26.5.251:443?security=tls&sni=test.com#Test-Trojan",
    ]
    
    # تست 4: ساخت Clash Subscription
    print("Test 3: Creating Clash Subscription")
    print("-" * 60)
    
    worker_url = active_workers[0]
    success, sub_id, sub_url = test_create_subscription(worker_url, sample_configs, 'clash')
    
    if success:
        print_success(f"Subscription created: {sub_id}")
        print_info(f"URL: {sub_url}")
        print()
        
        # تست 5: دریافت Subscription
        print("Test 4: Fetching Clash Subscription")
        print("-" * 60)
        
        time.sleep(1)  # کمی صبر کنیم
        fetch_success, yaml_content = test_fetch_subscription(sub_url)
        
        if fetch_success:
            print_success("Subscription fetched successfully")
            print_info(f"Content length: {len(yaml_content)} bytes")
            print()
            
            # تست 6: اعتبارسنجی YAML
            print("Test 5: Validating Clash YAML")
            print("-" * 60)
            
            is_valid, errors = validate_clash_yaml(yaml_content)
            
            if is_valid:
                print_success("YAML is valid!")
                
                # نمایش آمار
                data = yaml.safe_load(yaml_content)
                print()
                print_info(f"Proxies: {len(data.get('proxies', []))}")
                print_info(f"Groups: {len(data.get('proxy-groups', []))}")
                print_info(f"Rules: {len(data.get('rules', []))}")
                
                # نمایش نمونه proxy
                if data.get('proxies'):
                    print()
                    print("Sample Proxy:")
                    print("-" * 60)
                    sample = data['proxies'][0]
                    print(f"Name: {sample.get('name')}")
                    print(f"Type: {sample.get('type')}")
                    print(f"Server: {sample.get('server')}")
                    print(f"Port: {sample.get('port')}")
                
            else:
                print_error("YAML validation failed!")
                for error in errors:
                    print(f"  - {error}")
                sys.exit(1)
        else:
            print_error("Failed to fetch subscription")
            sys.exit(1)
    else:
        print_error("Failed to create subscription")
        sys.exit(1)
    
    # تست 7: بررسی فایل محلی
    print()
    print("Test 6: Checking Local clash_subscription.yml")
    print("-" * 60)
    
    try:
        with open('clash_subscription.yml', 'r', encoding='utf-8') as f:
            local_yaml = f.read()
        
        print_success("File exists")
        
        is_valid, errors = validate_clash_yaml(local_yaml)
        
        if is_valid:
            print_success("Local YAML is valid!")
            
            data = yaml.safe_load(local_yaml)
            print_info(f"Proxies: {len(data.get('proxies', []))}")
            print_info(f"Groups: {len(data.get('proxy-groups', []))}")
            print_info(f"Rules: {len(data.get('rules', []))}")
            
            # بررسی امضای V2V
            v2v_count = sum(1 for p in data.get('proxies', []) if '[V2V]' in p.get('name', ''))
            if v2v_count > 0:
                print_success(f"Found {v2v_count} configs with [V2V] prefix")
            else:
                print_warning("No [V2V] prefix found in proxies")
            
        else:
            print_error("Local YAML validation failed!")
            for error in errors:
                print(f"  - {error}")
    
    except FileNotFoundError:
        print_warning("clash_subscription.yml not found")
    except Exception as e:
        print_error(f"Error reading file: {e}")
    
    print()
    print("=" * 60)
    print_success("All tests completed successfully!")
    print("=" * 60)

if __name__ == '__main__':
    main()