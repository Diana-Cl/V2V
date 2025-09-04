# -*- coding: utf-8 -*-
import os
import uuid
import json
import base64
import requests
from flask import Flask, request, jsonify
from redis import Redis

app = Flask(__name__)

# --- اتصال به دیتابیس Redis ---
# Vercel به طور خودکار متغیرهای محیطی سرویس KV خود را تنظیم می‌کند.
# در حالت توسعه محلی، می‌توانید از فایل .env استفاده کنید.
try:
    redis_client = Redis.from_url(os.environ.get("KV_URL"))
except Exception as e:
    # یک fallback ساده برای زمانی که KV_URL موجود نیست
    print(f"Could not connect to Vercel KV, falling back to local Redis. Error: {e}")
    redis_client = Redis(decode_responses=True)


# --- آدرس فایل کانفیگ‌های زنده ---
# این آدرس را باید در تنظیمات Vercel به عنوان متغیر محیطی تنظیم کنید.
# این آدرس به فایل all_live_configs.json شما در ابر آروان یا گیت‌هاب اشاره دارد.
LIVE_CONFIGS_URL = os.environ.get(
    "LIVE_CONFIGS_URL", 
    "https://raw.githubusercontent.com/smbcryp/V2V/main/all_live_configs.json" # یک مقدار پیش‌فرض برای تست
)


@app.route('/api/subscribe', methods=['POST'])
def create_subscription():
    """
    یک لینک اشتراک جدید بر اساس کانفیگ‌های انتخابی کاربر ایجاد می‌کند.
    """
    selected_configs = request.json.get('configs')
    if not isinstance(selected_configs, list) or not selected_configs:
        return jsonify({"error": "Invalid input. 'configs' must be a non-empty list."}), 400

    # تولید یک شناسه منحصر به فرد
    sub_uuid = str(uuid.uuid4())
    key = f"sub:{sub_uuid}"

    # ذخیره لیست کانفیگ‌ها در Redis
    # ما لیست را به صورت یک رشته JSON ذخیره می‌کنیم
    redis_client.set(key, json.dumps(selected_configs))
    # یک زمان انقضا برای کلیدها تنظیم می‌کنیم تا دیتابیس بیهوده پر نشود (مثلا ۳۰ روز)
    redis_client.expire(key, 30 * 24 * 60 * 60)

    # ساخت URL کامل برای اشتراک
    subscription_url = f"{request.host_url}sub/{sub_uuid}"
    
    return jsonify({"subscription_url": subscription_url, "uuid": sub_uuid})


@app.route('/sub/<string:sub_uuid>', methods=['GET'])
def get_subscription(sub_uuid):
    """
    لینک اشتراک را با منطق خودترمیم‌گر ارائه می‌دهد.
    """
    key = f"sub:{sub_uuid}"
    
    # ۱. خواندن کانفیگ‌های ذخیره شده کاربر از Redis
    user_configs_json = redis_client.get(key)
    if not user_configs_json:
        return "Subscription not found.", 404
    
    user_configs = json.loads(user_configs_json)
    
    # ۲. دریافت لیست تمام کانفیگ‌های سالم و زنده
    try:
        response = requests.get(LIVE_CONFIGS_URL, timeout=5)
        response.raise_for_status()
        live_data = response.json()
        # ما فقط به کانفیگ‌های xray نیاز داریم که فرمت استاندارد دارند
        live_configs_with_ping = live_data.get('xray', [])
        live_configs_set = {item['config'] for item in live_configs_with_ping}
    except Exception as e:
        # اگر نتوانستیم لیست زنده را بگیریم، حداقل کانفیگ‌های ذخیره شده کاربر را برمی‌گردانیم
        print(f"Could not fetch live configs: {e}")
        final_configs_str = "\n".join(user_configs)
        return base64.b64encode(final_configs_str.encode("utf-8")).decode("utf-8"), 200

    # ۳. اجرای منطق خودترمیم‌گر (Self-Healing)
    healed_configs = []
    dead_configs_count = 0
    user_configs_set = set(user_configs)

    for config in user_configs:
        if config in live_configs_set:
            healed_configs.append(config)
        else:
            dead_configs_count += 1
    
    # جایگزینی کانفیگ‌های از کار افتاده
    if dead_configs_count > 0:
        # از لیست کانفیگ‌های زنده، مواردی را انتخاب می‌کنیم که کاربر از قبل آن‌ها را نداشته
        potential_replacements = [cfg for cfg in live_configs_set if cfg not in user_configs_set]
        healed_configs.extend(potential_replacements[:dead_configs_count])

    if not healed_configs:
         return "No valid configs found after healing.", 500

    # ۴. آماده‌سازی خروجی نهایی با فرمت Base64
    final_configs_str = "\n".join(healed_configs)
    
    return base64.b64encode(final_configs_str.encode("utf-8")).decode("utf-8")


# یک روت ساده برای تست اینکه سرور کار می‌کند یا نه
@app.route('/', methods=['GET'])
def index():
    return "V2V Subscription API is running."

# این بخش برای اجرای محلی سرور است و روی Vercel استفاده نمی‌شود
if __name__ == '__main__':
    app.run(debug=True)

