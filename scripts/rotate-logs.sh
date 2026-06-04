#!/usr/bin/env bash
# ============================================================
# 日志轮转脚本 — stdout.log / imtoagent.log 启动时调用
# ============================================================
LOG_DIR="${IMTOAGENT_LOG_DIR:-$(cd "$(dirname "$0")/.." && pwd)/logs}"
MAX_SIZE=${MAX_LOG_SIZE:-10485760}  # 10MB
MAX_FILES=${MAX_LOG_FILES:-5}

rotate_if_needed() {
  local file="$1"
  if [ ! -f "$file" ]; then
    return
  fi

  local size
  size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
  if [ "$size" -lt "$MAX_SIZE" ]; then
    return
  fi

  # 轮转：file.5 删除，file.4→file.5, ..., file→file.1
  for i in $(seq $((MAX_FILES - 1)) -1 1); do
    local src="${file}.$i"
    local dst="${file}.$((i + 1))"
    if [ -f "$src" ]; then
      if [ $((i + 1)) -gt "$MAX_FILES" ]; then
        rm -f "$src"
      else
        mv "$src" "$dst"
      fi
    fi
  done

  mv "$file" "${file}.1"
  echo "[rotate] Rotated $(basename "$file") (${size} bytes → ${file}.1)"
}

# 启动时清理旧轮转文件（超过 7 天的）
cleanup_old() {
  local file="$1"
  local base
  base=$(basename "$file")
  for f in "${LOG_DIR}/${base}".*; do
    if [ -f "$f" ]; then
      # macOS stat -f%m 返回修改时间戳
      local mtime
      mtime=$(stat -f%m "$f" 2>/dev/null || stat -c%Y "$f" 2>/dev/null)
      local now
      now=$(date +%s)
      local age_days=$(( (now - mtime) / 86400 ))
      if [ "$age_days" -gt 7 ]; then
        rm -f "$f"
        echo "[rotate] Deleted old file: $f (${age_days} days old)"
      fi
    fi
  done
}

# 清理死掉的 stdout.log（如果不再被写入）
if [ -f "${LOG_DIR}/stdout.log" ]; then
  local_mtime=$(stat -f%m "${LOG_DIR}/stdout.log" 2>/dev/null || stat -c%Y "${LOG_DIR}/stdout.log" 2>/dev/null)
  now=$(date +%s)
  age_hours=$(( (now - local_mtime) / 3600 ))
  if [ "$age_hours" -gt 24 ]; then
    rm -f "${LOG_DIR}/stdout.log"
    echo "[rotate] Deleted stale stdout.log (${age_hours}h old)"
  fi
fi

for log in "${LOG_DIR}/imtoagent.log" "${LOG_DIR}/cc-gateway.log"; do
  cleanup_old "$log"
  rotate_if_needed "$log"
done
