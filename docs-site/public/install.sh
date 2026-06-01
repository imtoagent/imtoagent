#!/usr/bin/env bash
#
# imtoagent — One-Click Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/imtoagent/imtoagent/main/docs/install.sh | bash
#
# This script detects the environment, installs dependencies, installs/upgrades
# imtoagent, and optionally runs the interactive setup wizard.
#
# Flags:
#   --non-interactive    Skip interactive setup (for CI/automated installs)
#   --skip-bun           Skip bun installation check
#   --skip-start         Don't start the gateway after install

set -euo pipefail

# ============================================================
# Colors & Helpers
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ  ${NC}$1"; }
ok()    { echo -e "${GREEN}✅ ${NC}$1"; }
warn()  { echo -e "${YELLOW}⚠️  ${NC}$1"; }
error() { echo -e "${RED}❌ ${NC}$1"; }
step()  { echo -e "\n${BOLD}${CYAN}▸ $1${NC}"; }
done_ok() { echo -e "  ${GREEN}✓${NC} $1"; }

# ============================================================
# Parse flags
# ============================================================
NON_INTERACTIVE=false
SKIP_BUN=false
SKIP_START=false
NEED_SETUP=false
SETUP_COMPLETED=false

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --skip-bun)        SKIP_BUN=true ;;
    --skip-start)      SKIP_START=true ;;
  esac
done

# ============================================================
# Banner
# ============================================================
echo ""
echo -e "${BOLD}  ┌──────────────────────────────────────────┐${NC}"
echo -e "${BOLD}  │  ${CYAN}imtoagent${NC} — IM ↔ Agent Unified Gateway${BOLD}   │${NC}"
echo -e "${BOLD}  └──────────────────────────────────────────┘${NC}"
echo ""

# ============================================================
# 1. OS Detection
# ============================================================
step "1. Detecting environment"

OS=""
ARCH=""

case "$(uname -s)" in
  Darwin*)  OS="macos" ;;
  Linux*)   OS="linux" ;;
  *)        error "Unsupported OS: $(uname -s)"; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="aarch64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)             ARCH="unknown" ;;
esac

done_ok "OS: $OS ($(uname -m))"

# ============================================================
# 2. Bun Detection & Installation
# ============================================================
if [ "$SKIP_BUN" = true ]; then
  info "Skipping bun check (--skip-bun)"
else
  step "2. Checking bun"

  BUN_BIN=""

  # Check environment variable first
  if [ -n "${BUN_BIN:-}" ] && [ -x "$BUN_BIN" ]; then
    BUN_BIN="$BUN_BIN"
  # Check common paths
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    BUN_BIN="$HOME/.bun/bin/bun"
  elif [ -x "/opt/homebrew/bin/bun" ]; then
    BUN_BIN="/opt/homebrew/bin/bun"
  elif [ -x "/usr/local/bin/bun" ]; then
    BUN_BIN="/usr/local/bin/bun"
  elif command -v bun &>/dev/null; then
    BUN_BIN="$(command -v bun)"
  fi

  if [ -n "$BUN_BIN" ]; then
    BUN_VER=$("$BUN_BIN" --version 2>/dev/null || echo "unknown")
    done_ok "bun found: $BUN_BIN (v${BUN_VER})"
  else
    warn "bun not found — installing..."
    echo ""

    if [ "$OS" = "macos" ] || [ "$OS" = "linux" ]; then
      echo "  Downloading and installing bun..."
      curl -fsSL https://bun.sh/install | bash 2>&1 | tail -5

      # Add bun to PATH for this session
      if [ -f "$HOME/.bun/bin/bun" ]; then
        BUN_BIN="$HOME/.bun/bin/bun"
        export PATH="$HOME/.bun/bin:$PATH"
      elif command -v bun &>/dev/null; then
        BUN_BIN="$(command -v bun)"
      fi

      if [ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ]; then
        BUN_VER=$("$BUN_BIN" --version 2>/dev/null || echo "unknown")
        done_ok "bun installed: v${BUN_VER}"
      else
        error "bun installation failed. Please install manually:"
        echo "   curl -fsSL https://bun.sh/install | bash"
        echo "   Then re-run this script."
        exit 1
      fi
    else
      error "Unsupported platform for automatic bun install."
      echo "   Install bun manually: https://bun.sh"
      exit 1
    fi
  fi
fi

# ============================================================
# 3. Node.js Check & Installation
# ============================================================
step "3. Checking node/npm"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  done_ok "node: ${NODE_VER}"
else
  warn "node not found — installing..."
  echo ""

  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      echo "  Installing Node.js via Homebrew..."
      brew install node >/dev/null 2>&1 || true
    else
      warn "Homebrew not found — installing Node.js via nvm..."
      echo "  Installing nvm..."
      export NVM_DIR="$HOME/.nvm"
      curl -fsSL https://gitee.com/RubyMetric/nvm-cn/raw/main/install.sh | bash >/dev/null 2>&1 || true
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
      echo "  Installing Node.js LTS..."
      nvm install --lts >/dev/null 2>&1 || true
    fi
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get &>/dev/null; then
      echo "  Installing Node.js via apt..."
      apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
    elif command -v dnf &>/dev/null; then
      echo "  Installing Node.js via dnf..."
      dnf install -y nodejs npm >/dev/null 2>&1 || true
    elif command -v yum &>/dev/null; then
      echo "  Installing Node.js via yum..."
      yum install -y nodejs npm >/dev/null 2>&1 || true
    else
      echo "  Installing Node.js via nvm..."
      export NVM_DIR="$HOME/.nvm"
      curl -fsSL https://gitee.com/RubyMetric/nvm-cn/raw/main/install.sh | bash >/dev/null 2>&1 || true
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
      nvm install --lts >/dev/null 2>&1 || true
    fi
  fi

  # Verify
  if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    done_ok "node: ${NODE_VER}"
  else
    error "Node.js installation failed. Please install manually."
    exit 1
  fi
fi

if command -v npm &>/dev/null; then
  NPM_VER=$(npm --version)
  done_ok "npm: v${NPM_VER}"
else
  error "npm not found — required for installation"
  exit 1
fi

# ============================================================
# 4. Install / Upgrade imtoagent
# ============================================================
step "4. Installing imtoagent"

# Check if already installed
EXISTING_VER=""
if command -v imtoagent &>/dev/null; then
  EXISTING_VER=$(imtoagent --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [ -z "$EXISTING_VER" ]; then
    EXISTING_VER=$(npm list -g imtoagent 2>/dev/null | grep 'imtoagent@' | sed 's/.*imtoagent@//' | head -1 || true)
  fi
  [ -z "$EXISTING_VER" ] && EXISTING_VER="unknown"
  warn "Already installed: v${EXISTING_VER}"
  echo ""
  if [ "$NON_INTERACTIVE" = true ]; then
    info "Non-interactive mode — upgrading"
  else
    read -rp "  Upgrade to latest? [Y/n] " UPGRADE
    case "$UPGRADE" in
      [nN]*) info "Skipping upgrade."; exit 0 ;;
    esac
  fi
fi

echo "  Running: npm install -g imtoagent"
echo ""
npm install -g imtoagent 2>&1 | tail -10

# Capture version robustly: try --version, then npm list, then fallback
INSTALLED_VER=""
if command -v imtoagent &>/dev/null; then
  INSTALLED_VER=$(imtoagent --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [ -z "$INSTALLED_VER" ]; then
    INSTALLED_VER=$(npm list -g imtoagent 2>/dev/null | grep 'imtoagent@' | sed 's/.*imtoagent@//' | head -1 || true)
  fi
fi
[ -z "$INSTALLED_VER" ] && INSTALLED_VER="unknown"
done_ok "imtoagent v${INSTALLED_VER} installed globally"

# ============================================================
# 5. Configuration Check & Setup
# ============================================================
step "5. Checking configuration"

CONFIG_DIR="$HOME/.imtoagent"
CONFIG_FILE="$CONFIG_DIR/config.json"

NEED_SETUP=true

if [ -f "$CONFIG_FILE" ]; then
  done_ok "Config found: $CONFIG_FILE"

  # Quick check if config has any bots (grep for botType field)
  if grep -q '"botType"' "$CONFIG_FILE" 2>/dev/null; then
    BOT_COUNT=$(grep -c '"botType"' "$CONFIG_FILE" 2>/dev/null || echo "0")
    done_ok "$BOT_COUNT bot(s) configured — skipping setup wizard"
    NEED_SETUP=false
  else
    warn "No bots configured in config"
  fi
else
  warn "No configuration found"
fi

if [ "$NEED_SETUP" = true ]; then
  if [ "$NON_INTERACTIVE" = true ]; then
    info "Non-interactive mode — skipping setup wizard"
    echo ""
    echo "  Run 'imtoagent setup' manually to configure."
  elif [ ! -t 0 ]; then
    # stdin is a pipe (e.g. curl | bash) — interactive setup impossible
    NEED_SETUP=true
    echo ""
    echo -e "${YELLOW}${BOLD}  📋 Setup required but not possible in this mode (no TTY detected).${NC}"
    echo -e "${YELLOW}     After this script finishes, run:${NC}"
    echo -e "${YELLOW}       ${BOLD}imtoagent setup${NC}"
    echo ""
  else
    echo ""
    echo "  Starting interactive setup wizard..."
    echo "  You'll need:"
    echo "   • IM platform credentials (Feishu App ID/Secret, Telegram Token, etc.)"
    echo "   • Agent backend (Claude Code / Codex / OpenCode)"
    echo "   • Model provider API keys"
    echo ""
    read -rp "  Start setup now? [Y/n] " START_SETUP
    case "$START_SETUP" in
      [nN]*)
        info "Skipping setup. Run 'imtoagent setup' later to configure."
        ;;
      *)
        echo ""
        imtoagent setup && { SETUP_COMPLETED=true; NEED_SETUP=false; }
        ;;
    esac
  fi
fi

# ============================================================
# 6. Start Gateway (optional)
# ============================================================
if [ "$SKIP_START" = true ]; then
  info "Skipping gateway start (--skip-start)"
else
  step "6. Starting gateway"

  # Check if already running
  if imtoagent status 2>/dev/null | grep -q "running"; then
    warn "Gateway already running"
    imtoagent status 2>/dev/null || true
  else
    # Skip gateway start if setup is still needed — the gateway won't work without config
    if [ "$NEED_SETUP" = true ] && [ -t 0 ]; then
      read -rp "  Skip gateway start and run setup now? [Y/n] " SKIP_GW
      case "$SKIP_GW" in
        [nN]*)
          info "Not starting. Run 'imtoagent start' when ready."
          ;;
        *)
          echo ""
          imtoagent setup && SETUP_COMPLETED=true
          # Re-check if config now exists before trying to start
          if [ -f "$CONFIG_FILE" ] && grep -q '"botType"' "$CONFIG_FILE" 2>/dev/null; then
            read -rp "  Start gateway now? [Y/n] " START_GATEWAY
            case "$START_GATEWAY" in
              [nN]*) info "Not starting now. Run 'imtoagent start' when ready." ;;
              *)
                imtoagent start
                sleep 3
                imtoagent status 2>/dev/null || true
                ;;
            esac
          fi
          ;;
      esac
    else
      # Non-TTY or non-interactive: skip gateway start entirely
      if [ "$NEED_SETUP" = true ]; then
        info "Gateway not started — run 'imtoagent setup' first, then 'imtoagent start'"
      else
        if [ "$NON_INTERACTIVE" = true ]; then
          info "Non-interactive mode — starting gateway in background"
          imtoagent start
          sleep 3
          imtoagent status 2>/dev/null || true
        else
          read -rp "  Start gateway now? [Y/n] " START_GATEWAY
          case "$START_GATEWAY" in
            [nN]*)
              info "Not starting. Run 'imtoagent start' when ready."
              ;;
            *)
              imtoagent start
              sleep 3
              imtoagent status 2>/dev/null || true
              ;;
          esac
        fi
      fi
    fi
  fi
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${BOLD}  ──────────────────────────────────────────${NC}"
echo -e "${GREEN}${BOLD}  Installation Complete!${NC}"
echo -e "${BOLD}  ──────────────────────────────────────────${NC}"
echo ""
echo "  Version:  v${INSTALLED_VER}"
echo "  Config:   ${CONFIG_FILE}"
echo "  Logs:     ${CONFIG_DIR}/logs/"
echo ""

if [ "$NEED_SETUP" = true ]; then
  echo -e "${YELLOW}${BOLD}  ⚠️  Setup Required${NC}"
  echo ""
  echo "  You need to configure at least one bot before the gateway can start."
  echo ""
  echo "  Quick commands:"
  echo -e "    ${GREEN}${BOLD}imtoagent setup${NC}       Interactive configuration wizard"
  echo -e "    ${BOLD}imtoagent start${NC}       Start gateway in background"
  echo -e "    ${BOLD}imtoagent status${NC}      Check gateway status"
  echo -e "    ${BOLD}imtoagent stop${NC}        Stop the gateway"
  echo ""
else
  echo "  Quick commands:"
  echo -e "    ${BOLD}imtoagent status${NC}      Check gateway status"
  echo -e "    ${BOLD}imtoagent stop${NC}        Stop the gateway"
  echo -e "    ${BOLD}imtoagent setup${NC}       Add more bots"
  echo -e "    ${BOLD}imtoagent restore${NC}     Hot reload"
  echo ""
  echo "  Send ${BOLD}/help${NC} to your Bot in IM to see available commands."
fi

echo "  Docs: https://github.com/imtoagent/imtoagent"
echo ""
