#!/usr/bin/env bash
# finviz_alert.sh — Daily alert push notification for finviz.
# Called by cron at the user-configured time.
# Generates a fresh summary then sends a push notification.
set -euo pipefail

PORT="${MARCHDECK_PORT:-8800}"
API="http://localhost:$PORT/api/app/finviz"

# 1. Trigger summary generation
curl -sf "$API/summary/24h?regenerate=1&topic=Market" > /dev/null 2>&1 || true

# 2. Wait for generation to complete (poll up to 90s)
for i in $(seq 1 30); do
    sleep 3
    STATUS=$(curl -sf "$API/summary/24h?topic=Market" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [[ "$STATUS" == "ready" ]]; then
        break
    fi
done

# 3. Send push notification
curl -sf -X POST "$API/alert-send" > /dev/null 2>&1 || true
