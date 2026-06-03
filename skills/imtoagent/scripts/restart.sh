#!/usr/bin/env bash
# imtoagent restart.sh — 安全重启 imtoagent 网关
set -euo pipefail

FORCE=false
if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
  FORCE=true
fi

echo "=== imtoagent Restart ==="
echo ""

# Status check
echo "--- Current Status ---"
if port=$(lsof -i :18899 -sTCP:LISTEN -t 2>/dev/null); then
  proc=$(ps -p $port -o comm= 2>/dev/null || echo unknown)
  echo "Port 18899: LISTEN (PID $port, $proc)"
  PID=$port
else
  echo "Port 18899: NOT LISTENING"
  PID=""
fi

if [ -z "$PID" ]; then
  echo "No imtoagent process found on port 18899."
  echo "Nothing to restart."
  exit 0
fi

echo ""
echo "=== WARNING ==="
echo "Restarting imtoagent will DISCONNECT the current IM session."
echo "You will lose this conversation!"
echo ""

if [ "$FORCE" = false ]; then
  read -p "Proceed with restart? (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Cancelled."
    exit 0
  fi
fi

echo ""
echo "Sending SIGTERM to PID $PID..."
kill -TERM "$PID" 2>/dev/null || true

# Wait for graceful shutdown
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Process $PID exited."
    break
  fi
  echo "Waiting... (${i}s)"
  sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
  echo "Process still alive, sending SIGKILL..."
  kill -9 "$PID" 2>/dev/null || true
  sleep 1
fi

# Verify port released
if lsof -i :18899 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[WARN] Port 18899 still occupied."
else
  echo "[OK]   Port 18899 released."
fi

echo ""
echo "imtoagent stopped. Restart it with your preferred method:"
echo "  cd /Users/keyi/Desktop/imtoagent && bun run start"
echo ""
echo "After restart, verify:"
echo "  bash scripts/health-check.sh"
