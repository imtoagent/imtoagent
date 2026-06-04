#!/bin/bash
# ============================================================
# Log rotation helper — 启动时清理旧日志，运行中定期轮转
# ============================================================
LOG_DIR="$1"
if [ -z "$LOG_DIR" ]; then
  LOG_DIR="$HOME/.imtoagent/logs"
fi

MAX_SIZE=${MAX_LOG_SIZE:-10485760}  # 10MB
MAX_ROTATED=${MAX_LOG_FILES:-5}     # 保留 5 个备份
RETENTION_DAYS=${LOG_RETENTION:-7}  # 7 天

rotate_file() {
  local file="$1"
  [ -f "$file" ] || return
  local size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
  [ "$size" -lt "$MAX_SIZE" ] && return

  # 轮转: file.5→删, file.4→file.5, ..., file→file.1
  for i in $(seq $((MAX_ROTATED - 1)) -1 1); do
    local src="${file}.$i"
    local dst="${file}.$((i + 1))"
    [ -f "$src" ] || continue
    if [ $((i + 1)) -gt "$MAX_ROTATED" ]; then
      rm -f "$src"
    else
      mv "$src" "$dst"
    fi
  done
  mv "$file" "${file}.1"
  touch "$file"
  echo "[log-rotate] Rotated $(basename "$file") ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B"))"
}

cleanup_old() {
  local dir="$1"
  find "$dir" -name "*.log.*" -mtime +${RETENTION_DAYS} -delete 2>/dev/null
  # 清理死掉的 stdout.log（超过 1 天未更新）
  if [ -f "${dir}/stdout.log" ]; then
    local mtime=$(stat -f%m "${dir}/stdout.log" 2>/dev/null || stat -c%Y "${dir}/stdout.log" 2>/dev/null)
    local now=$(date +%s)
    local age=$(( (now - mtime) / 3600 ))
    if [ "$age" -gt 24 ]; then
      rm -f "${dir}/stdout.log"
      echo "[log-rotate] Deleted stale stdout.log (${age}h old)"
    fi
  fi
}

# 启动时立即执行
cleanup_old "$LOG_DIR"
rotate_file "${LOG_DIR}/imtoagent.log"
rotate_file "${LOG_DIR}/events.jsonl"
