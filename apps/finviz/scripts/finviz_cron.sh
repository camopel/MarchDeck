#!/usr/bin/env bash
# finviz_cron.sh — Cron wrapper for finviz crawler.
# Runs one crawl cycle (--sleep 0), exits if another instance is running.
# Designed to be called every 5 minutes via crontab.
set -euo pipefail

DATA_DIR="${MARCHDECK_DATA:-$HOME/.march-deck}"
PIDFILE="$DATA_DIR/app/finviz/crawler.pid"
VENV="${MARCHDECK_VENV:-$HOME/Workspace/.venv}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWLER="$SCRIPT_DIR/finviz_crawler.py"
DB="$DATA_DIR/app/finviz/finviz.db"
NEWS_DIR="$DATA_DIR/app/finviz/news"
LOG_DIR="$DATA_DIR/logs/finviz"

mkdir -p "$NEWS_DIR" "$LOG_DIR"

# ── Lock check: exit if another instance is running ──
if [[ -f "$PIDFILE" ]]; then
    OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        exit 0
    fi
    # Stale pidfile — remove it
    rm -f "$PIDFILE"
fi

# ── Write our PID ──
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# ── Run one crawl cycle ──
"$VENV/bin/python3" "$CRAWLER" \
    --db "$DB" \
    --articles-dir "$NEWS_DIR" \
    --sleep 0 \
    --expiry-days 1 \
    >> "$LOG_DIR/$(date +%Y-%m-%d).log" 2>&1
