#!/usr/bin/env bash
# imtoagent health-check.sh — 一键健康检查
set -euo pipefail

echo "=== imtoagent Health Check ==="
echo ""

# Port 18899 (gateway)
if port=$(lsof -i :18899 -sTCP:LISTEN -t 2>/dev/null); then
  proc=$(ps -p $port -o comm= 2>/dev/null || echo unknown)
  echo "[OK]   Port 18899: LISTEN (PID $port, $proc)"
else
  echo "[FAIL] Port 18899: NOT LISTENING"
fi

# Port 4096 (OpenCode)
if lsof -i :4096 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[OK]   Port 4096: LISTEN (OpenCode backend)"
else
  echo "[OK]   Port 4096: not listening"
fi

# imtoagent process
count=$(ps aux | grep -v grep | grep -c imtoagent || true)
if [ "$count" -gt 0 ]; then
  echo "[OK]   imtoagent process: $count running"
else
  echo "[FAIL] imtoagent process: NONE"
fi

# Codex CLI version
if ver=$(codex --version 2>/dev/null); then
  echo "[OK]   Codex CLI: $ver"
else
  echo "[WARN] Codex CLI: not found"
fi

# Gateway log
log="$HOME/.imtoagent/logs/imtoagent.log"
if [ -f "$log" ]; then
  errors=$(grep -ci "error\|fail" "$log" 2>/dev/null || echo 0)
  recent=$(tail -5 "$log" 2>/dev/null | grep -ci "error\|fail" || echo 0)
  echo "[OK]   Gateway log: exists, $errors total errors, $recent recent"
else
  echo "[WARN] Gateway log: not found at $log"
fi

# Bot connection
if [ -f "$log" ]; then
  last_online=$(grep -i "online\|connected" "$log" 2>/dev/null | tail -1 || echo "")
  last_disconnect=$(grep -i "disconnect" "$log" 2>/dev/null | tail -1 || echo "")
  if [ -n "$last_online" ] && [ -z "$last_disconnect" ]; then
    echo "[OK]   Bot: last online found, no disconnect detected"
  elif [ -n "$last_online" ] && [ -n "$last_disconnect" ]; then
    echo "[WARN] Bot: disconnect detected, check log"
  else
    echo "[WARN] Bot: no connection log entries"
  fi
fi

echo ""
echo "=== Done ==="
