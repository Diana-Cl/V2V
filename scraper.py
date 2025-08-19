import base64
import json
import socket
import time
from urllib.parse import unquote

# ---------------- Safe Base64 Decode ----------------
def safe_b64_decode(data: str) -> str:
    """
    دیکد کردن امن Base64 برای جلوگیری از خطا در لینک‌های بدون پدینگ.
    """
    try:
        data += "=" * (-len(data) % 4)
        return base64.urlsafe_b64decode(data.encode()).decode()
    except Exception:
        return ""

# ---------------- Config Parser ----------------
def parse_config(config: str):
    """
    تجزیه (Parse) لینک‌های مختلف و استخراج اطلاعات کانفیگ.
    """
    config = config.strip()

    # ---------- VMESS ----------
    if config.startswith("vmess://"):
        try:
            raw = config[len("vmess://"):]
            decoded = safe_b64_decode(raw)
            data = json.loads(decoded)
            return {
                "protocol": "vmess",
                "server": data.get("add", ""),
                "port": int(data.get("port", 443)),
                "uuid": data.get("id", ""),
                "network": data.get("net", "tcp"),
                "tls": data.get("tls", ""),
                "host": data.get("host", ""),
                "path": data.get("path", "/"),
                "remark": data.get("ps", f"vmess-{data.get('add','')}")
            }
        except Exception as e:
            print(f"❌ vmess parse error: {e}")
            return None

    # ---------- VLESS ----------
    elif config.startswith("vless://"):
        try:
            raw = config[len("vless://"):]
            uuid, rest = raw.split("@", 1)
            server_part, params_str = rest.split("?", 1)
            server, port = server_part.split(":")
            params = dict(x.split("=", 1) for x in params_str.split("&"))
            remark = unquote(params.get("remark", f"vless-{server}"))
            return {
                "protocol": "vless",
                "server": server,
                "port": int(port),
                "uuid": uuid,
                "network": params.get("type", "tcp"),
                "security": params.get("security", ""),
                "flow": params.get("flow", ""),
                "sni": params.get("sni", ""),
                "pbk": params.get("pbk", ""),
                "sid": params.get("sid", ""),
                "remark": remark
            }
        except Exception as e:
            print(f"❌ vless parse error: {e}")
            return None

    # ---------- TROJAN ----------
    elif config.startswith("trojan://"):
        try:
            raw = config[len("trojan://"):]
            password, rest = raw.split("@", 1)
            if "?" in rest:
                server_part, params_str = rest.split("?", 1)
                params = dict(x.split("=", 1) for x in params_str.split("&"))
            else:
                server_part = rest
                params = {}
            server, port = server_part.split(":")
            remark = unquote(params.get("remark", f"trojan-{server}"))
            return {
                "protocol": "trojan",
                "server": server,
                "port": int(port),
                "password": password,
                "sni": params.get("sni", server),
                "remark": remark
            }
        except Exception as e:
            print(f"❌ trojan parse error: {e}")
            return None

    # ---------- Shadowsocks ----------
    elif config.startswith("ss://"):
        try:
            raw = config[len("ss://"):]
            if "#" in raw:
                raw, remark = raw.split("#", 1)
                remark = unquote(remark)
            else:
                remark = "shadowsocks"
            
            if "@" in raw:
                method_pass, server_part = raw.split("@", 1)
            else:
                decoded = safe_b64_decode(raw)
                method_pass, server_part = decoded.split("@", 1)

            method, password = method_pass.split(":", 1)
            server, port = server_part.split(":", 1)
            return {
                "protocol": "ss",
                "server": server,
                "port": int(port),
                "method": method,
                "password": password,
                "remark": remark
            }
        except Exception as e:
            print(f"❌ ss parse error: {e}")
            return None

    # ---------- TUIC ----------
    elif config.startswith("tuic://"):
        try:
            raw = config[len("tuic://"):]
            uuid, rest = raw.split("@", 1)
            server_part, params_str = rest.split("?", 1)
            server, port = server_part.split(":", 1)
            params = dict(x.split("=", 1) for x in params_str.split("&"))
            remark = unquote(params.get("remark", f"tuic-{server}"))
            return {
                "protocol": "tuic",
                "server": server,
                "port": int(port),
                "uuid": uuid,
                "password": params.get("password", ""),
                "congestion_control": params.get("congestion_control", "bbr"),
                "remark": remark
            }
        except Exception as e:
            print(f"❌ tuic parse error: {e}")
            return None

    # ---------- Hysteria2 ----------
    elif config.startswith("hysteria2://"):
        try:
            raw = config[len("hysteria2://"):]
            password, rest = raw.split("@", 1)
            if "?" in rest:
                server_part, params_str = rest.split("?", 1)
                params = dict(x.split("=", 1) for x in params_str.split("&"))
            else:
                server_part = rest
                params = {}
            server, port = server_part.split(":")
            remark = unquote(params.get("remark", f"hysteria2-{server}"))
            return {
                "protocol": "hysteria2",
                "server": server,
                "port": int(port),
                "password": password,
                "sni": params.get("sni", ""),
                "remark": remark
            }
        except Exception as e:
            print(f"❌ hysteria2 parse error: {e}")
            return None

    return None

# ---------------- Latency Test ----------------
def tcp_ping(host, port, timeout=2):
    """
    تست سریع تأخیر (Latency) با TCP handshake.
    """
    start = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return int((time.time() - start) * 1000)
    except Exception:
        return None

# ---------------- Generate Clash Proxy ----------------
def to_clash_proxy(parsed_config):
    """
    تبدیل اطلاعات کانفیگ به فرمت استاندارد Clash.
    """
    if not parsed_config:
        return None

    protocol = parsed_config["protocol"]
    server = parsed_config["server"]
    port = parsed_config["port"]
    remark = parsed_config["remark"]
    
    proxy = {}

    if protocol == "vmess":
        proxy = {
            "name": remark,
            "type": "vmess",
            "server": server,
            "port": port,
            "uuid": parsed_config.get("uuid"),
            "alterId": 0,
            "cipher": "auto",
            "tls": parsed_config.get("tls", "") == "tls",
            "network": parsed_config.get("network", "tcp"),
        }
        if proxy["network"] == "ws":
            proxy["ws-opts"] = {
                "path": parsed_config.get("path", "/"),
                "headers": {"Host": parsed_config.get("host", "")}
            }

    elif protocol == "vless":
        if parsed_config.get("security") == "reality":
            proxy = {
                "name": remark,
                "type": "vless",
                "server": server,
                "port": port,
                "uuid": parsed_config.get("uuid"),
                "network": parsed_config.get("network", "tcp"),
                "tls": True,
                "flow": parsed_config.get("flow", "xtls-rprx-vision"),
                "server_name": parsed_config.get("sni", ""),
                "reality-opts": {
                    "public-key": parsed_config.get("pbk", ""),
                    "short-id": parsed_config.get("sid", "")
                }
            }
        else:
            proxy = {
                "name": remark,
                "type": "vless",
                "server": server,
                "port": port,
                "uuid": parsed_config.get("uuid"),
                "network": parsed_config.get("network", "tcp"),
                "tls": parsed_config.get("security") == "tls",
                "server_name": parsed_config.get("sni", "")
            }

    elif protocol == "trojan":
        proxy = {
            "name": remark,
            "type": "trojan",
            "server": server,
            "port": port,
            "password": parsed_config.get("password"),
            "sni": parsed_config.get("sni", ""),
            "skip-cert-verify": True
        }

    elif protocol == "ss":
        proxy = {
            "name": remark,
            "type": "ss",
            "server": server,
            "port": port,
            "cipher": parsed_config.get("method"),
            "password": parsed_config.get("password")
        }

    elif protocol == "tuic":
        proxy = {
            "name": remark,
            "type": "tuic",
            "server": server,
            "port": port,
            "uuid": parsed_config.get("uuid"),
            "password": parsed_config.get("password", ""),
            "congestion_control": parsed_config.get("congestion_control", "bbr"),
            "udp_relay_mode": "native",
            "disable_sni": False,
            "reduce_rtt": True
        }

    elif protocol == "hysteria2":
        proxy = {
            "name": remark,
            "type": "hysteria2",
            "server": server,
            "port": port,
            "password": parsed_config.get("password", ""),
            "alpn": ["h3"],
            "sni": parsed_config.get("sni", ""),
            "skip-cert-verify": True,
            "down": "50 Mbps",
            "up": "20 Mbps"
        }

    return proxy

# ---------------- MAIN ----------------
if __name__ == "__main__":
    test_links = [
        "vmess://eyJhZGQiOiAidGVzdC5jb20iLCAicG9ydCI6ICI0NDMiLCAiaWQiOiAiMTIzNCIsICJuZXQiOiAid3MiLCAidGxzIjogInRscyIsICJwcyI6ICJ2bWVzcy10ZXN0In0=",
        "vless://d6c7553f-b633-4b68-8097-f50c0570b54f@vless.example.com:443?security=tls&encryption=none&type=ws&host=vless.example.com&path=%2F#VLESS-WS",
        "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpQQHNzdzByZEAxMjcuMC4wLjE6ODQ0Mw==#ShadowSocks-Test",
        "trojan://password@trojan-test.com:443?sni=trojan-test.com#Trojan-Test",
        "tuic://aGVsbG8tdHUiQGF0dHVpYy5jb206MTI0NQ==?congestion_control=bbr&password=testpass#TUIC-Test",
        "hysteria2://password@hysteria2-test.com:443?sni=hysteria2-test.com#Hysteria2-Test"
    ]

    proxies = []
    print("شروع به پردازش لینک‌ها...")
    for link in test_links:
        print(f"\n🔗 در حال پردازش لینک: {link[:50]}...")
        parsed = parse_config(link)
        if parsed:
            server_name = parsed.get("server", "unknown")
            port = parsed.get("port", "unknown")
            print(f"✅ اطلاعات کانفیگ استخراج شد: {server_name}:{port}")
            latency = tcp_ping(server_name, port)
            print(f"⏱️ تأخیر (Latency): {'Disabled' if latency is None else f'{latency}ms'}")
            clash_proxy = to_clash_proxy(parsed)
            if clash_proxy:
                clash_proxy["latency"] = latency
                proxies.append(clash_proxy)
                print("✅ کانفیگ Clash با موفقیت ساخته شد.")
            else:
                print("❌ ساخت کانفیگ Clash با خطا مواجه شد.")
        else:
            print("❌ تجزیه لینک با خطا مواجه شد.")

    print("\n---")
    print("خروجی نهایی به فرمت JSON برای Clash:")
    print(json.dumps(proxies, indent=2, ensure_ascii=False))
