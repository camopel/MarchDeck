#!/usr/bin/env bash
# March Deck install script
# Supports macOS and Linux
# Usage: bash scripts/install.sh [--port PORT]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT=8800
DATA_DIR="$HOME/.march-deck"

# ── Parse args ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: bash scripts/install.sh [--port PORT]"
            echo "  --port PORT   HTTP port (default: 8800)"
            exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# ── Platform detection ─────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
    Darwin)  PLATFORM="macos" ;;
    Linux)   PLATFORM="linux" ;;
    *)       echo "❌ Unsupported platform: $OS"; exit 1 ;;
esac

echo "🏠 March Deck Install"
echo "=================="
echo "Platform : $PLATFORM"
echo "Port     : $PORT"
echo "Project  : $PROJECT_DIR"
echo "Data     : $DATA_DIR"
echo ""

# ── Helper functions ───────────────────────────────────────────────────
check_command() {
    command -v "$1" &>/dev/null
}

require_command() {
    if ! check_command "$1"; then
        echo "❌ Required command not found: $1"
        echo "   $2"
        exit 1
    fi
}

# ── 1. Python check ────────────────────────────────────────────────────
echo "🐍 Checking Python..."
PYTHON=""
for py in python3 python3.12 python3.11 python3.10 python3.9; do
    if check_command "$py"; then
        PY_VER="$($py -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
        PY_MAJOR="${PY_VER%%.*}"
        PY_MINOR="${PY_VER##*.}"
        if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 9 ]]; then
            PYTHON="$py"
            echo "  ✅ Python $PY_VER ($py)"
            break
        fi
    fi
done
if [[ -z "$PYTHON" ]]; then
    echo "❌ Python 3.9+ required. Install from https://python.org"
    exit 1
fi

# ── 2. Node.js check ───────────────────────────────────────────────────
echo ""
echo "📦 Checking Node.js..."
if check_command node; then
    NODE_VER="$(node --version)"
    echo "  ✅ Node $NODE_VER"
else
    echo "  ⚠️  Node.js not found — frontend won't be built"
    echo "     Install from https://nodejs.org"
    BUILD_FRONTEND=false
fi
BUILD_FRONTEND=${BUILD_FRONTEND:-true}

# ── 3. VAPID email prompt ──────────────────────────────────────────────
echo ""
echo "🔔 Push Notifications Setup"
echo "   A VAPID email is required to enable push notifications."
echo "   It's used only as a contact identifier — never sent anywhere."
echo ""

VAPID_EMAIL=""
# Check if already configured
CONFIG_FILE="$DATA_DIR/config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
    EXISTING_EMAIL="$(python3 -c "
import yaml, sys
try:
    d = yaml.safe_load(open('$CONFIG_FILE'))
    print(d.get('push',{}).get('vapid_email',''))
except: print('')
" 2>/dev/null || echo "")"
    if [[ -n "$EXISTING_EMAIL" && "$EXISTING_EMAIL" != "nobody@localhost" ]]; then
        echo "  ✅ Using existing VAPID email: $EXISTING_EMAIL"
        VAPID_EMAIL="$EXISTING_EMAIL"
    fi
fi

if [[ -z "$VAPID_EMAIL" ]]; then
    read -r -p "  Enter VAPID email (or press Enter for 'nobody@localhost'): " VAPID_EMAIL
    if [[ -z "$VAPID_EMAIL" ]]; then
        VAPID_EMAIL="nobody@localhost"
        echo "  Using default: $VAPID_EMAIL"
    fi
fi

# ── 4. Install Python dependencies ─────────────────────────────────────
VENV_DIR="${MARCHDECK_VENV:-$HOME/Workspace/.venv}"
echo ""
if [[ ! -d "$VENV_DIR" ]]; then
    echo "❌ Python venv not found at $VENV_DIR"
    echo "   Create one first: python3 -m venv $VENV_DIR"
    echo "   Or set MARCHDECK_VENV to your venv path"
    exit 1
fi
PIP="$VENV_DIR/bin/pip"
echo "📦 Installing Python dependencies into $VENV_DIR..."
$PIP install -q --upgrade pip
$PIP install -q \
    "fastapi>=0.100" \
    "uvicorn[standard]>=0.20" \
    "psutil>=5.9" \
    "pywebpush>=2.0" \
    "py-vapid>=1.9" \
    "aiofiles>=23.0" \
    "websockets>=12.0" \
    "pyyaml>=6.0" \
    "boto3>=1.28" \
    "httpx>=0.24" \
    "python-multipart>=0.0.6"
echo "  ✅ Core Python packages installed"

# ── App-specific Python dependencies ──
echo ""
echo "📦 Installing app-specific dependencies..."

# finviz: crawler deps
$PIP install -q "feedparser>=6.0" "crawl4ai>=0.3" 2>/dev/null || \
    echo "  ⚠️  Some finviz crawler deps failed — crawl4ai may need manual install"

# arxiv: FAISS + embedding
$PIP install -q "faiss-cpu>=1.7" 2>/dev/null || \
    echo "  ⚠️  faiss-cpu install failed — arxiv semantic search won't work"

# cast: Chromecast control
$PIP install -q "pychromecast>=14.0" 2>/dev/null || \
    echo "  ⚠️  pychromecast install failed — cast app won't work"

echo "  ✅ App dependencies installed"

# ── Install march-deck CLI ──
echo ""
echo "🔧 Installing march-deck CLI..."
CLI_SOURCE="$PROJECT_DIR/march-deck"
CLI_TARGET="$HOME/.local/bin/march-deck"
mkdir -p "$HOME/.local/bin"
ln -sf "$CLI_SOURCE" "$CLI_TARGET"
echo "  ✅ march-deck CLI installed → $CLI_TARGET"
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    echo "  ⚠️  Add ~/.local/bin to your PATH if not already:"
    echo "     export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Ollama for ArXiv semantic search ──
echo ""
echo "🧠 Setting up Ollama for ArXiv semantic search..."
if check_command ollama; then
    echo "  ✅ Ollama already installed"
else
    echo "  ⚠️  Ollama not found — installing..."
    if curl -fsSL https://ollama.ai/install.sh | sh; then
        echo "  ✅ Ollama installed"
    else
        echo "  ⚠️  Ollama auto-install failed"
        echo "     Install manually: https://ollama.ai"
        echo "     Then run: ollama pull nomic-embed-text"
    fi
fi

# Pull embedding model if Ollama is available
if check_command ollama; then
    echo "  Pulling embedding model..."
    ollama pull nomic-embed-text 2>/dev/null && \
        echo "  ✅ nomic-embed-text model ready" || \
        echo "  ⚠️  Could not pull nomic-embed-text — arxiv embeddings won't work until pulled"
fi

# ── 5. Create data directories ────────────────────────────────────────
echo ""
echo "📁 Setting up data directories..."
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/certs"
mkdir -p "$DATA_DIR/logs/server"
mkdir -p "$DATA_DIR/logs/finviz"
mkdir -p "$DATA_DIR/app/march"
mkdir -p "$DATA_DIR/app/finviz/news"
mkdir -p "$DATA_DIR/app/arxiv"
mkdir -p "$DATA_DIR/app/notes"
mkdir -p "$DATA_DIR/app/system"
mkdir -p "$DATA_DIR/app/files"
mkdir -p "$DATA_DIR/app/cast"
mkdir -p "$DATA_DIR/app/openclaw"
echo "  ✅ Data directories created at $DATA_DIR"

# ── Initialize ArXiv database and categories ──
echo ""
echo "📄 Initializing ArXiv database..."
ARXIV_SCRIPTS="$PROJECT_DIR/apps/arxiv/scripts"
ARXIVKB_DATA_DIR="$DATA_DIR/app/arxiv" $VENV_DIR/bin/python3 -c "
import sys; sys.path.insert(0, '$ARXIV_SCRIPTS')
from db import init_db, seed_taxonomy
db_path = '$DATA_DIR/app/arxiv/arxivkb.db'
init_db(db_path)
count = seed_taxonomy(db_path)
print(f'  ✅ ArXiv DB initialized — {count} categories seeded')
" 2>/dev/null || echo "  ⚠️  ArXiv DB init failed — categories can be added later from the app"

# ── Build initial FAISS index (if papers exist) ──
echo "  Building FAISS index..."
ARXIVKB_DATA_DIR="$DATA_DIR/app/arxiv" $VENV_DIR/bin/python3 -c "
import sys; sys.path.insert(0, '$PROJECT_DIR/apps/arxiv/scripts')
try:
    from embed import build_index
    build_index('$DATA_DIR/app/arxiv/arxivkb.db', '$DATA_DIR/app/arxiv')
    print('  ✅ FAISS index built')
except ImportError:
    print('  ⚠️  FAISS/embedding deps missing — semantic search will use text fallback')
except Exception as e:
    print(f'  ⚠️  FAISS index build skipped: {e}')
" 2>/dev/null || echo "  ⚠️  FAISS index build skipped"

# ── Initialize Finviz database ──
echo ""
echo "📰 Initializing Finviz database..."
FINVIZ_SCRIPTS="$PROJECT_DIR/apps/finviz/scripts"
$VENV_DIR/bin/python3 -c "
import sqlite3, os
db_path = '$DATA_DIR/app/finviz/finviz.db'
os.makedirs(os.path.dirname(db_path), exist_ok=True)
conn = sqlite3.connect(db_path)
conn.execute('''CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title_hash   TEXT    UNIQUE NOT NULL,
    title        TEXT    NOT NULL,
    url          TEXT    NOT NULL,
    domain       TEXT    NOT NULL DEFAULT \"unknown\",
    source       TEXT    NOT NULL DEFAULT \"unknown\",
    publish_at   TEXT    NOT NULL,
    article_path TEXT,
    fetched_at   TEXT    NOT NULL,
    crawled_at   TEXT    NOT NULL DEFAULT \"\",
    status       TEXT    NOT NULL DEFAULT \"pending\",
    retry_count  INTEGER NOT NULL DEFAULT 0,
    ticker       TEXT    DEFAULT NULL
)''')
conn.execute('CREATE INDEX IF NOT EXISTS idx_title_hash ON articles(title_hash)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_status ON articles(status)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_fetched ON articles(fetched_at)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_publish ON articles(publish_at)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_domain ON articles(domain)')
conn.execute('CREATE INDEX IF NOT EXISTS idx_ticker ON articles(ticker)')
conn.execute('''CREATE TABLE IF NOT EXISTS tickers (
    symbol   TEXT PRIMARY KEY,
    keywords TEXT DEFAULT \"[]\"
)''')
conn.commit()
conn.close()
print('  ✅ Finviz DB initialized')
" 2>/dev/null || echo "  ⚠️  Finviz DB init failed"

# ── 6. VAPID keys ─────────────────────────────────────────────────────
echo ""
echo "🔑 Setting up VAPID keys..."

VAPID_PRIVATE="$DATA_DIR/certs/vapid_private.pem"
VAPID_PUBLIC="$DATA_DIR/certs/vapid_public.txt"

if [[ -f "$VAPID_PRIVATE" && -f "$VAPID_PUBLIC" ]]; then
    echo "  ✅ VAPID keys already exist"
else
    python3 - <<'PYEOF'
import sys, os
certs_dir = os.path.expanduser('~/.march-deck/certs')
private_pem = os.path.join(certs_dir, 'vapid_private.pem')
public_txt  = os.path.join(certs_dir, 'vapid_public.txt')
try:
    from py_vapid import Vapid
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from base64 import urlsafe_b64encode
    v = Vapid()
    v.generate_keys()
    v.save_key(private_pem)
    raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    pub = urlsafe_b64encode(raw).rstrip(b'=').decode()
    open(public_txt, 'w').write(pub)
    print(f"  ✅ VAPID keys generated")
    print(f"  📄 Private: {private_pem}")
    print(f"  📄 Public:  {pub[:40]}...")
except Exception as e:
    print(f"  ⚠️  VAPID key generation failed: {e}")
    print("     Run scripts/install.py manually after install.")
PYEOF
fi

# ── 7. LLM provider selection ──────────────────────────────────────────
echo ""
echo "🧠 LLM Configuration"
echo "   Choose your LLM provider:"
echo "   1) ollama      — Local models via Ollama (free, no API key)"
echo "   2) bedrock     — AWS Bedrock (uses ~/.aws credentials, no API key)"
echo "   3) openai      — OpenAI API (GPT-4o, o1, etc.)"
echo "   4) claude      — Anthropic Claude direct API"
echo "   5) litellm     — LiteLLM proxy (routes to Bedrock, Azure, etc.)"
echo "   6) openrouter  — OpenRouter (many models, one API key)"
echo "   7) skip        — Configure later in ~/.march-deck/config.yaml"
echo ""
read -r -p "   Select [1-7, default 1]: " LLM_CHOICE
LLM_CHOICE="${LLM_CHOICE:-1}"

LLM_YAML=""

case "$LLM_CHOICE" in
    1)
        read -r -p "   Ollama endpoint [http://localhost:11434]: " OLLAMA_EP
        OLLAMA_EP="${OLLAMA_EP:-http://localhost:11434}"
        read -r -p "   Model [llama3]: " OLLAMA_MODEL
        OLLAMA_MODEL="${OLLAMA_MODEL:-llama3}"
        LLM_YAML="llm:
  type: ollama            # bedrock | ollama | openai | claude | litellm | openrouter
  endpoint: $OLLAMA_EP
  model: $OLLAMA_MODEL
  temperature: 0.7
  streaming: true"
        ;;
    2)
        echo "   Bedrock uses your AWS credentials (~/.aws/config)."
        echo "   The model should be an inference profile ARN."
        read -r -p "   Model profile ARN: " BEDROCK_MODEL
        if [[ -z "$BEDROCK_MODEL" ]]; then
            echo "   ⚠️  Model profile ARN required. Skipping LLM config."
            LLM_YAML="llm: {}"
        else
            LLM_YAML="llm:
  type: bedrock           # bedrock | ollama | openai | claude | litellm | openrouter
  model: $BEDROCK_MODEL
  temperature: 0.7
  streaming: true"
        fi
        ;;
    3)
        read -r -p "   OpenAI API key: " OPENAI_KEY
        if [[ -z "$OPENAI_KEY" ]]; then
            echo "   ⚠️  API key required for OpenAI. Skipping LLM config."
            LLM_YAML="llm: {}"
        else
            read -r -p "   Model [gpt-4o]: " OPENAI_MODEL
            OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o}"
            LLM_YAML="llm:
  type: openai            # bedrock | ollama | openai | claude | litellm | openrouter
  api_key: \"$OPENAI_KEY\"
  model: $OPENAI_MODEL
  temperature: 0.7
  streaming: true"
        fi
        ;;
    4)
        read -r -p "   Anthropic API key: " CLAUDE_KEY
        if [[ -z "$CLAUDE_KEY" ]]; then
            echo "   ⚠️  API key required for Claude. Skipping LLM config."
            LLM_YAML="llm: {}"
        else
            read -r -p "   Model [claude-sonnet-4-20250514]: " CLAUDE_MODEL
            CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"
            LLM_YAML="llm:
  type: claude            # bedrock | ollama | openai | claude | litellm | openrouter
  api_key: \"$CLAUDE_KEY\"
  model: $CLAUDE_MODEL
  temperature: 0.7
  streaming: true"
        fi
        ;;
    5)
        read -r -p "   LiteLLM proxy endpoint: " LITELLM_EP
        if [[ -z "$LITELLM_EP" ]]; then
            echo "   ⚠️  Endpoint required for LiteLLM. Skipping LLM config."
            LLM_YAML="llm: {}"
        else
            read -r -p "   API key (optional): " LITELLM_KEY
            read -r -p "   Model: " LITELLM_MODEL
            LITELLM_MODEL="${LITELLM_MODEL:-gpt-4o}"
            LLM_YAML="llm:
  type: litellm           # bedrock | ollama | openai | claude | litellm | openrouter
  endpoint: $LITELLM_EP
  model: $LITELLM_MODEL
  temperature: 0.7
  streaming: true"
            if [[ -n "$LITELLM_KEY" ]]; then
                LLM_YAML="$LLM_YAML
  api_key: \"$LITELLM_KEY\""
            fi
        fi
        ;;
    6)
        read -r -p "   OpenRouter API key: " OR_KEY
        if [[ -z "$OR_KEY" ]]; then
            echo "   ⚠️  API key required for OpenRouter. Skipping LLM config."
            LLM_YAML="llm: {}"
        else
            read -r -p "   Model [anthropic/claude-sonnet-4]: " OR_MODEL
            OR_MODEL="${OR_MODEL:-anthropic/claude-sonnet-4}"
            LLM_YAML="llm:
  type: openrouter        # bedrock | ollama | openai | claude | litellm | openrouter
  api_key: \"$OR_KEY\"
  model: $OR_MODEL
  temperature: 0.7
  streaming: true"
        fi
        ;;
    7)
        echo "   Skipping LLM config — edit ~/.march-deck/config.yaml later."
        LLM_YAML="llm: {}"
        ;;
    *)
        echo "   Invalid choice. Skipping LLM config."
        LLM_YAML="llm: {}"
        ;;
esac

# ── 8. Write config.yaml ──────────────────────────────────────────────
echo ""
echo "⚙️  Writing config..."
if [[ ! -f "$CONFIG_FILE" ]]; then
    cat > "$CONFIG_FILE" <<YAMLEOF
# March Deck configuration

server:
  host: 0.0.0.0
  port: $PORT

push:
  vapid_email: "$VAPID_EMAIL"

# Translation language (ISO 639-1 code). Default: en
language: en

$LLM_YAML

apps:
  march:
    api_url: http://localhost:8101
  finviz:
    crawl_interval: 7200
  arxiv:
    embedding_model: nomic-embed-text
  files:
    root: /
    show_hidden: false
YAMLEOF
    echo "  ✅ Config written to $CONFIG_FILE"
else
    echo "  ✅ Config already exists at $CONFIG_FILE"
fi

# ── 9. Build all frontends ─────────────────────────────────────────────
if [[ "$BUILD_FRONTEND" == "true" ]]; then
    echo ""
    echo "🔨 Building shell frontend..."
    FRONTEND_DIR="$PROJECT_DIR/frontend"
    if [[ -f "$FRONTEND_DIR/package.json" ]]; then
        (cd "$FRONTEND_DIR" && npm install --silent && npm run build)
        echo "  ✅ Shell frontend built → static/dist/"
    else
        echo "  ⚠️  frontend/package.json not found — skipping shell build"
    fi

    echo ""
    echo "🔨 Building app frontends..."
    for APP_DIR in "$PROJECT_DIR"/apps/*/; do
        APP_NAME="$(basename "$APP_DIR")"
        APP_FRONTEND="$APP_DIR/frontend"
        if [[ -f "$APP_FRONTEND/package.json" ]]; then
            echo "  📦 Building $APP_NAME..."
            (cd "$APP_FRONTEND" && npm install --silent && npm run build)
            echo "  ✅ $APP_NAME built"
        fi
    done
    echo "  ✅ All app frontends built"
fi

# ── 10. Finviz crawler setup ─────────────────────────────────────────
echo ""
echo "📰 Setting up Finviz crawler..."
CRAWLER_CRON="$PROJECT_DIR/apps/finviz/scripts/finviz_cron.sh"
ALERT_CRON="$PROJECT_DIR/apps/finviz/scripts/finviz_alert.sh"
mkdir -p "$DATA_DIR/app/finviz/news"

if [[ -f "$CRAWLER_CRON" ]]; then
    chmod +x "$CRAWLER_CRON"
    echo "  ✅ Finviz crawler script ready"
fi
if [[ -f "$ALERT_CRON" ]]; then
    chmod +x "$ALERT_CRON"
    echo "  ✅ Finviz alert script ready"
fi
echo "  ℹ️  Enable crawler and alerts from the Finviz app settings"

# ── 11. Tailscale ──────────────────────────────────────────────────────
echo ""
echo "🌐 Tailscale..."
if check_command tailscale; then
    echo "  ✅ Tailscale found"
    read -r -p "  Set up Tailscale HTTPS? [y/N]: " SETUP_TS
    SETUP_TS="${SETUP_TS:-N}"
    if [[ "$SETUP_TS" =~ ^[Yy] ]]; then
        HTTPS_PORT=443
        if sudo tailscale serve --bg --https "$HTTPS_PORT" "http://127.0.0.1:$PORT" 2>/dev/null; then
            echo "  ✅ Tailscale serve configured (HTTPS on :$HTTPS_PORT)"
        else
            HTTPS_PORT=$((PORT + 443))
            if sudo tailscale serve --bg --https "$HTTPS_PORT" "http://127.0.0.1:$PORT" 2>/dev/null; then
                echo "  ✅ Tailscale serve configured (HTTPS on :$HTTPS_PORT)"
            else
                echo "  ⚠️  Tailscale serve failed. Try manually:"
                echo "     sudo tailscale serve --bg --https 443 http://127.0.0.1:$PORT"
            fi
        fi
        TS_HOST="$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || echo "")"
        if [[ -n "$TS_HOST" ]]; then
            echo ""
            echo "  📱 Open on your phone: https://$TS_HOST/"
        fi
    else
        echo "  Skipping Tailscale serve setup."
    fi
else
    echo "  ℹ️  Tip: Install Tailscale for remote HTTPS access (https://tailscale.com)"
fi

# ── 12. System service ─────────────────────────────────────────────────
echo ""
echo "🔄 Setting up system service..."

SERVER_CMD="$VENV_DIR/bin/python3 $SCRIPT_DIR/server.py"

if [[ "$PLATFORM" == "linux" ]]; then
    SERVICE_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"
    SERVICE_FILE="$SERVICE_DIR/marchdeck.service"
    cat > "$SERVICE_FILE" <<SVCEOF
[Unit]
Description=March Deck Personal Dashboard
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$SERVER_CMD
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
SVCEOF
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable marchdeck.service 2>/dev/null || true
    echo "  ✅ systemd service installed: marchdeck.service"
    echo "     Start:   systemctl --user start marchdeck"
    echo "     Status:  systemctl --user status marchdeck"
    echo "     Logs:    journalctl --user -u marchdeck -f"

elif [[ "$PLATFORM" == "macos" ]]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$PLIST_DIR"
    PLIST_FILE="$PLIST_DIR/com.marchdeck.server.plist"
    LOG_FILE="$HOME/Library/Logs/marchdeck.log"
    cat > "$PLIST_FILE" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.marchdeck.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>python3</string>
        <string>$SCRIPT_DIR/server.py</string>
    </array>
    <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG_FILE</string>
    <key>StandardErrorPath</key><string>$LOG_FILE</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONUNBUFFERED</key><string>1</string>
    </dict>
</dict>
</plist>
PLISTEOF
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE" 2>/dev/null || true
    echo "  ✅ launchd plist installed: com.marchdeck.server"
    echo "     Start:  launchctl load $PLIST_FILE"
    echo "     Stop:   launchctl unload $PLIST_FILE"
    echo "     Logs:   tail -f $LOG_FILE"
fi

# ── 13. Done ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║        ✅ March Deck Installed!         ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Start the server:"
echo "  $VENV_DIR/bin/python3 $SCRIPT_DIR/server.py"
echo ""
echo "Then open http://localhost:$PORT in your browser."
echo ""
echo "📱 Add to Home Screen:"
echo "  iOS Safari  → Share → Add to Home Screen"
echo "  Android     → Chrome menu → Add to Home Screen"
echo ""
