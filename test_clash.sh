#!/bin/bash

# رنگ‌ها
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "================================"
echo "V2V Clash YAML Complete Tester"
echo "================================"
echo ""

ERRORS=0

# تست 1: بررسی فایل clash_subscription.yml
echo -n "Test 1: Checking clash_subscription.yml exists... "
if [ -f "clash_subscription.yml" ]; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ File not found${NC}"
    echo ""
    echo "Please run: python3 scraper.py"
    exit 1
fi

# تست 2: بررسی ساختار YAML
echo -n "Test 2: Validating YAML syntax... "
if command -v python3 &> /dev/null; then
    YAML_ERROR=$(python3 << 'EOF'
import yaml
import sys

try:
    with open('clash_subscription.yml', 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    
    # بررسی کلیدهای ضروری
    if 'proxies' not in data:
        print("Missing 'proxies' key")
        sys.exit(1)
    
    if 'proxy-groups' not in data:
        print("Missing 'proxy-groups' key")
        sys.exit(1)
    
    if 'rules' not in data:
        print("Missing 'rules' key")
        sys.exit(1)
    
    sys.exit(0)
    
except yaml.YAMLError as e:
    print(f"YAML Error: {e}")
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
EOF
)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
        echo -e "${RED}Error: $YAML_ERROR${NC}"
        ((ERRORS++))
    fi
else
    echo -e "${YELLOW}⊘ Python3 not found, skipping${NC}"
fi

# تست 3: بررسی تعداد proxies
echo -n "Test 3: Checking proxies count... "
PROXY_COUNT=$(grep -c "^  - name:" clash_subscription.yml 2>/dev/null || echo "0")
if [ "$PROXY_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Found $PROXY_COUNT proxies${NC}"
else
    echo -e "${RED}✗ No proxies found${NC}"
    ((ERRORS++))
fi

# تست 4: بررسی proxy-groups
echo -n "Test 4: Checking proxy-groups... "
if grep -q "🚀 V2V Auto" clash_subscription.yml && grep -q "🎯 V2V Select" clash_subscription.yml; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Missing V2V groups${NC}"
    ((ERRORS++))
fi

# تست 5: بررسی rules
echo -n "Test 5: Checking rules... "
if grep -q "GEOIP,IR,DIRECT" clash_subscription.yml && grep -q "MATCH,🎯 V2V Select" clash_subscription.yml; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Missing or incorrect rules${NC}"
    ((ERRORS++))
fi

# تست 6: بررسی فرمت نام‌ها
echo -n "Test 6: Checking [V2V] prefix in proxies... "
V2V_COUNT=$(grep -c "\[V2V\]" clash_subscription.yml 2>/dev/null || echo "0")
if [ "$V2V_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Found $V2V_COUNT configs with [V2V] prefix${NC}"
else
    echo -e "${YELLOW}⚠ No [V2V] prefix found${NC}"
fi

# تست 7: بررسی خطای EOF
echo -n "Test 7: Checking for unexpected EOF... "
LAST_LINE=$(tail -1 clash_subscription.yml)
if [ -z "$LAST_LINE" ] || [ "$LAST_LINE" = $'\n' ]; then
    echo -e "${GREEN}✓ File ends properly${NC}"
else
    # اضافه کردن newline در صورت نیاز
    echo "" >> clash_subscription.yml
    echo -e "${YELLOW}⚠ Fixed: Added newline at end${NC}"
fi

# تست 8: بررسی کوتیشن در URL
echo -n "Test 8: Checking quoted URLs... "
if grep -q 'url: "http://www.gstatic.com/generate_204"' clash_subscription.yml; then
    echo -e "${GREEN}✓ URLs are properly quoted${NC}"
else
    echo -e "${RED}✗ URLs missing quotes (EOF risk!)${NC}"
    ((ERRORS++))
fi

# تست 9: بررسی whitespace
echo -n "Test 9: Checking for tabs (should be spaces)... "
if grep -q $'\t' clash_subscription.yml; then
    echo -e "${RED}✗ Found tabs! Must use spaces${NC}"
    ((ERRORS++))
else
    echo -e "${GREEN}✓ No tabs found${NC}"
fi

# تست 10: بررسی پروتکل‌ها
echo -n "Test 10: Checking protocol diversity... "
VMESS_COUNT=$(grep -c "type: vmess" clash_subscription.yml 2>/dev/null || echo "0")
VLESS_COUNT=$(grep -c "type: vless" clash_subscription.yml 2>/dev/null || echo "0")
TROJAN_COUNT=$(grep -c "type: trojan" clash_subscription.yml 2>/dev/null || echo "0")
SS_COUNT=$(grep -c "type: ss" clash_subscription.yml 2>/dev/null || echo "0")

echo ""
echo -e "  ${BLUE}├─${NC} VMess: $VMESS_COUNT"
echo -e "  ${BLUE}├─${NC} VLESS: $VLESS_COUNT"
echo -e "  ${BLUE}├─${NC} Trojan: $TROJAN_COUNT"
echo -e "  ${BLUE}└─${NC} SS: $SS_COUNT"

# تست 11: نمایش نمونه proxy
echo ""
echo "Test 11: Sample proxy from file:"
echo "================================"
grep -A 10 "^  - name:" clash_subscription.yml | head -11
echo "================================"

# تست 12: بررسی اندازه فایل
echo ""
echo -n "Test 12: Checking file size... "
FILE_SIZE=$(wc -c < clash_subscription.yml)
if [ "$FILE_SIZE" -gt 500 ]; then
    echo -e "${GREEN}✓ File size: $FILE_SIZE bytes${NC}"
else
    echo -e "${YELLOW}⚠ File seems small: $FILE_SIZE bytes${NC}"
fi

# خلاصه نهایی
echo ""
echo "================================"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed! ($PROXY_COUNT proxies)${NC}"
    echo "================================"
    echo ""
    echo "✅ Your Clash YAML is ready to use!"
    echo ""
    echo "📋 Quick Stats:"
    echo "  - Total Proxies: $PROXY_COUNT"
    echo "  - V2V Tagged: $V2V_COUNT"
    echo "  - File Size: $FILE_SIZE bytes"
    echo ""
    echo "🚀 Next Steps:"
    echo "  1. Deploy Workers: wrangler deploy"
    echo "  2. Test Python: python3 test_worker.py"
    echo "  3. Add to Clash client"
    echo ""
    exit 0
else
    echo -e "${RED}✗ $ERRORS test(s) failed!${NC}"
    echo "================================"
    echo ""
    echo "❌ Please fix the errors above"
    echo ""
    echo "💡 Quick Fix:"
    echo "  1. Check worker.js (line 275-290)"
    echo "  2. Ensure all URLs in quotes"
    echo "  3. Run: wrangler deploy"
    echo "  4. Run this test again"
    echo ""
    exit 1
fi
 Error: {e}")
    sys.exit(1)
except Exception as e:
    print(f"✗ Error: {e}")
    sys.exit(1)
EOF
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⊘ Python3 not found, skipping${NC}"
fi

# تست 3: بررسی تعداد proxies
echo -n "Test 3: Checking proxies count... "
PROXY_COUNT=$(grep -c "^  - name:" clash_subscription.yml 2>/dev/null || echo "0")
if [ "$PROXY_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Found $PROXY_COUNT proxies${NC}"
else
    echo -e "${RED}✗ No proxies found${NC}"
    exit 1
fi

# تست 4: بررسی proxy-groups
echo -n "Test 4: Checking proxy-groups... "
if grep -q "🚀 V2V Auto" clash_subscription.yml && grep -q "🎯 V2V Select" clash_subscription.yml; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Missing V2V groups${NC}"
    exit 1
fi

# تست 5: بررسی rules
echo -n "Test 5: Checking rules... "
if grep -q "GEOIP,IR,DIRECT" clash_subscription.yml && grep -q "MATCH,🎯 V2V Select" clash_subscription.yml; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Missing or incorrect rules${NC}"
    exit 1
fi

# تست 6: بررسی فرمت نام‌ها
echo -n "Test 6: Checking [V2V] prefix in proxies... "
V2V_COUNT=$(grep -c "\[V2V\]" clash_subscription.yml 2>/dev/null || echo "0")
if [ "$V2V_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Found $V2V_COUNT configs with [V2V] prefix${NC}"
else
    echo -e "${YELLOW}⚠ No [V2V] prefix found${NC}"
fi

# تست 7: بررسی خطای EOF
echo -n "Test 7: Checking for unexpected EOF... "
LAST_LINE=$(tail -1 clash_subscription.yml)
if [ -z "$LAST_LINE" ] || [ "$LAST_LINE" = $'\n' ]; then
    echo -e "${GREEN}✓ File ends properly${NC}"
else
    # اضافه کردن newline در صورت نیاز
    echo "" >> clash_subscription.yml
    echo -e "${YELLOW}⚠ Fixed: Added newline at end${NC}"
fi

# تست 8: نمونه proxy را نمایش بده
echo ""
echo "Sample proxy from file:"
echo "================================"
grep -A 10 "^  - name:" clash_subscription.yml | head -11
echo "================================"

echo ""
echo -e "${GREEN}✓ All tests passed!${NC}"
echo ""
echo "To use this file:"
echo "1. Copy URL: https://YOUR_WORKER.workers.dev/sub/clash/YOUR_ID"
echo "2. Add to Clash client"
echo ""