from flask import Flask, request, jsonify
from flask_cors import CORS
import socket
import time
import json
from urllib.parse import urlparse
import base64

app = Flask(__name__)
CORS(app) # اجازه دسترسی از دامنه‌های دیگر

def parse_config(config_str):
    try:
        if config_str.startswith('vmess://'):
            json_str = base64.b64decode(config_str[8:] + '==').decode('utf-8')
            decoded = json.loads(json_str)
            return (decoded.get('add'), int(decoded.get('port')))
        else:
            url = urlparse(config_str)
            return (url.hostname, url.port)
    except Exception:
        return (None, None)

def get_tcp_ping(host, port, timeout=8):
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        start_time = time.monotonic()
        sock.connect((host, port))
        end_time = time.monotonic()
        latency = round((end_time - start_time) * 1000)
        return latency
    finally:
        sock.close()

@app.route('/', defaults={'path': ''}, methods=['POST', 'OPTIONS'])
@app.route('/<path:path>', methods=['POST', 'OPTIONS'])
def handler(path):
    if request.method == 'OPTIONS':
        return jsonify(success=True)

    try:
        body = request.get_json()
        if not body:
            return jsonify(ping=9999, error="Invalid JSON"), 400
    except Exception:
        return jsonify(ping=9999, error="Invalid JSON"), 400

    host, port = None, None

    if 'config' in body:
        host, port = parse_config(body['config'])
    elif 'host' in body and 'port' in body:
        host, port = body['host'], int(body['port'])

    if not host or not port:
        return jsonify(ping=9999, error="Invalid input"), 400

    try:
        latency = get_tcp_ping(host, port)
        return jsonify(ping=latency)
    except Exception as e:
        return jsonify(ping=9999, error=str(e))
