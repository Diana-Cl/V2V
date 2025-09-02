# -*- coding: utf-8 -*-

from flask import Flask, request, jsonify
from flask_cors import CORS
import socket
import time
import json
from urllib.parse import urlparse
import base64
import ssl
import logging
import re
from typing import Tuple, Optional

# تنظیم Flask app
app = Flask(__name__)
CORS(app, origins="*")  # اجازه دسترسی از همه دامنه‌ها

# تنظیم logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# تنظیمات
CONFIG_TIMEOUT = 8
MAX_CONFIG_LENGTH = 2000
SUPPORTED_PROTOCOLS = ['vmess', 'vless', 'trojan', 'ss']

def create_error_response(message: str, status_code: int):
    """ایجاد response خطا با CORS headers"""
    response = jsonify(ping=9999, error=message)
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
    return response, status_code

def parse_vmess_config(config_str: str) -> Tuple[Optional[str], Optional[int]]:
    """پارس کانفیگ VMess"""
    try:
        encoded_part = config_str[8:]
        encoded_part += '=' * (-len(encoded_part) % 4)
        
        try:
            json_str = base64.b64decode(encoded_part).decode('utf-8')
        except UnicodeDecodeError:
            json_str = base64.b64decode(encoded_part).decode('latin-1')
        
        vmess_data = json.loads(json_str)
        host = vmess_data.get('add')
        port = vmess_data.get('port')
        
        if not host or not port:
            logger.warning("VMess config missing host or port")
            return None, None
        
        try:
            port = int(port)
            if port < 1 or port > 65535:
                logger.warning(f"VMess port out of range: {port}")
                return None, None
        except (ValueError, TypeError):
            logger.warning(f"VMess port invalid: {port}")
            return None, None
        
        if not isinstance(host, str) or len(host) > 255:
            logger.warning(f"VMess host invalid: {host}")
            return None, None
        
        logger.debug(f"VMess parsed: {host}:{port}")
        return host, port
        
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning(f"VMess JSON decode error: {e}")
        return None, None
    except Exception as e:
        logger.error(f"VMess parse error: {e}")
        return None, None

def parse_url_based_config(config_str: str) -> Tuple[Optional[str], Optional[int]]:
    """پارس کانفیگ‌های URL-based (vless, trojan, ss)"""
    try:
        url = urlparse(config_str)
        
        if not url.hostname:
            logger.warning(f"No hostname in URL: {config_str[:30]}...")
            return None, None
        
        host = url.hostname
        
        if url.port:
            port = url.port
        else:
            default_ports = {
                'https': 443,
                'trojan': 443,
                'vless': 443,
                'ss': 8080,
                'http': 80
            }
            port = default_ports.get(url.scheme, 443)
        
        if port < 1 or port > 65535:
            logger.warning(f"Port out of range: {port}")
            return None, None
        
        if len(host) > 255:
            logger.warning(f"Hostname too long: {host}")
            return None, None
        
        logger.debug(f"URL-based config parsed: {host}:{port}")
        return host, port
        
    except Exception as e:
        logger.error(f"URL parse error: {e}")
        return None, None

def parse_config(config_str: str) -> Tuple[Optional[str], Optional[int]]:
    """پارس کانفیگ با validation کامل"""
    try:
        if not config_str or not isinstance(config_str, str):
            return None, None
        
        config_str = config_str.strip()
        if len(config_str) > MAX_CONFIG_LENGTH or len(config_str) < 10:
            logger.warning(f"Config length invalid: {len(config_str)}")
            return None, None
        
        if any(char in config_str for char in ['<', '>', '&', '"']):
            logger.warning("Config contains harmful characters")
            return None, None
        
        if config_str.startswith('vmess://'):
            return parse_vmess_config(config_str)
        elif any(config_str.startswith(p) for p in ['vless://', 'trojan://', 'ss://']):
            return parse_url_based_config(config_str)
        else:
            logger.warning(f"Unsupported protocol in config: {config_str[:20]}...")
            return None, None
            
    except Exception as e:
        logger.error(f"Config parse error: {e}")
        return None, None

def get_tcp_ping(host: str, port: int, timeout: int = CONFIG_TIMEOUT) -> int:
    """تست پینگ TCP با SSL support"""
    sock = None
    try:
        if not host or not isinstance(port, int) or port < 1 or port > 65535:
            logger.warning(f"Invalid input: host={host}, port={port}")
            return 9999
        
        common_tls_ports = {443, 8443, 2053, 2083, 2087, 2096, 2082, 2086}
        needs_tls = port in common_tls_ports
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        
        start_time = time.monotonic()
        
        if needs_tls:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            context.set_ciphers('DEFAULT:@SECLEVEL=1')
            
            try:
                with context.wrap_socket(sock, server_hostname=host) as ssock:
                    ssock.connect((host, port))
                    ssock.send(b'HEAD / HTTP/1.1\r\nHost: ' + host.encode() + b'\r\nConnection: close\r\n\r\n')
            except ssl.SSLError as e:
                logger.debug(f"SSL handshake failed for {host}:{port}: {e}")
                return 9999
        else:
            sock.connect((host, port))
        
        end_time = time.monotonic()
        latency = round((end_time - start_time) * 1000)
        
        return min(latency, 5000)
        
    except socket.timeout:
        logger.debug(f"Timeout for {host}:{port}")
        return 9999
    except socket.gaierror as e:
        logger.debug(f"DNS resolution failed for {host}: {e}")
        return 9999
    except (ConnectionRefusedError, OSError) as e:
        logger.debug(f"Connection refused for {host}:{port}: {e}")
        return 9999
    except Exception as e:
        logger.error(f"Unexpected error testing {host}:{port}: {e}")
        return 9999
    finally:
        if sock:
            try:
                sock.close()
            except:
                pass

@app.route('/', defaults={'path': ''}, methods=['POST', 'OPTIONS'])
@app.route('/<path:path>', methods=['POST', 'OPTIONS'])
def handler(path):
    """Handler اصلی API"""
    
    if request.method == 'OPTIONS':
        response = jsonify(success=True)
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response, 200

    try:
        body = request.get_json(force=True)
        if not body or not isinstance(body, dict):
            return create_error_response("Invalid or empty JSON body", 400)
    except Exception as e:
        logger.error(f"JSON parse error: {e}")
        return create_error_response("Malformed JSON request", 400)

    host, port = None, None

    if 'config' in body:
        config_str = body.get('config', '')
        if not isinstance(config_str, str):
            return create_error_response("Config must be a string", 400)
        
        host, port = parse_config(config_str)
    elif 'host' in body and 'port' in body:
        try:
            host = str(body['host']).strip()
            port = int(body['port'])
        except (ValueError, TypeError) as e:
            logger.error(f"Direct host/port parse error: {e}")
            return create_error_response("Invalid host or port format", 400)

    if not host or not port:
        return create_error_response("Could not extract valid host and port", 400)

    try:
        start_test_time = time.time()
        latency = get_tcp_ping(host, port)
        test_duration = time.time() - start_test_time
        
        logger.info(f"Ping test completed: {host}:{port} = {latency}ms (took {test_duration:.2f}s)")
        
        response = jsonify(
            ping=latency,
            host=host,
            port=port,
            test_duration=round(test_duration, 2)
        )
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response, 200
        
    except Exception as e:
        logger.error(f"Ping test critical error for {host}:{port}: {e}")
        return create_error_response(f"Test execution failed: {str(e)}", 500)

@app.route('/health', methods=['GET'])
def health_check():
    """Endpoint سلامت سرویس"""
    response = jsonify(
        status="healthy",
        service="V2V Ping Test API",
        version="3.0.0",
        timestamp=time.time()
    )
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response, 200

if __name__ == '__main__':
    logger.info("Starting V2V Flask Ping Test API...")
    app.run(debug=False, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
