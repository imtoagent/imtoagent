#!/usr/bin/env bash
set -euo pipefail
# imtoagent task.sh - HEARTBEAT.md tasks block management
DEFAULT_WORKSPACE="$HOME/.openclaw/workspace"

usage() {
  echo "Usage: task.sh <command> [args...] [workspace]"
  echo "Commands:"
  echo "  list    [workspace]               List all tasks"
  echo "  add     <name> <params> [ws]      Add a task"
  echo "  remove  <name> [workspace]        Remove a task"
  echo "  show    <name> [workspace]        Show task details"
  echo "  enable  <name> [workspace]        Enable a disabled task"
  echo "  disable <name> [workspace]        Disable a task"
  exit 1
}

get_hb() { echo "${1:-$DEFAULT_WORKSPACE}/HEARTBEAT.md"; }

cmd_list() {
  local hb
  hb=$(get_hb "${1:-}")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  echo "=== Tasks in $hb ==="
  awk '/^## tasks|^tasks:/{f=1;next} f&&/^## /{exit} f{print}' "$hb"
}

cmd_show() {
  local name="$1" hb
  hb=$(get_hb "${2:-}")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  python3 -c "
import re, sys
with open('$hb') as f:
    lines = f.readlines()
pat = re.compile(r'^[ \t]*- name:\s*' + re.escape('$name') + r'\s*$')
for i, l in enumerate(lines):
    if pat.match(l):
        sys.stdout.write(l)
        for j in range(i+1, len(lines)):
            nl = lines[j]
            if re.match(r'^[ \t]*- name:', nl) or re.match(r'^## ', nl):
                break
            sys.stdout.write(nl)
        sys.exit(0)
print(f'Task not found: $name')
sys.exit(1)
"
}

cmd_remove() {
  local name="$1" hb
  hb=$(get_hb "${2:-}")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  python3 -c "
import re
with open('$hb') as f:
    lines = f.readlines()
pat = re.compile(r'^[ \t]*- name:\s*' + re.escape('$name') + r'\s*$')
out = []
skip = False
for l in lines:
    if pat.match(l):
        skip = True
        continue
    if skip:
        if re.match(r'^[ \t]*- name:', l) or re.match(r'^## ', l):
            skip = False
            out.append(l)
        continue
    out.append(l)
with open('$hb', 'w') as f:
    f.writelines(out)
print(f'Removed: $name')
"
}

cmd_add() {
  local name="" ws="$DEFAULT_WORKSPACE"
  local -a params=()
  for a in "$@"; do
    if [ -z "$name" ]; then name="$a"
    elif [ "$a" = "--help" ] || [ "$a" = "-h" ]; then usage
    else params+=("$a"); fi
  done
  [ -n "$name" ] || { echo "ERROR: name required"; usage; }
  local last_idx=$((${#params[@]} - 1))
  if [ $last_idx -ge 0 ] && [ -d "${params[$last_idx]}" ]; then
    ws="${params[$last_idx]}"; unset 'params[$last_idx]'
  fi
  local hb; hb=$(get_hb "$ws")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  local type="" at="" interval="" on="" prompt="" on_failure="ignore" max_runs=""
  local i=0
  while [ $i -lt ${#params[@]} ]; do
    case "${params[$i]}" in
      --type) i=$((i+1)); type="${params[$i]}" ;;
      --at) i=$((i+1)); at="${params[$i]}" ;;
      --interval) i=$((i+1)); interval="${params[$i]}" ;;
      --on) i=$((i+1)); on="${params[$i]}" ;;
      --prompt) i=$((i+1)); prompt="${params[$i]}" ;;
      --on-failure) i=$((i+1)); on_failure="${params[$i]}" ;;
      --max-runs) i=$((i+1)); max_runs="${params[$i]}" ;;
    esac
    i=$((i+1))
  done
  [ -n "$type" ] || { echo "ERROR: --type required"; exit 1; }
  [ -n "$prompt" ] || { echo "ERROR: --prompt required"; exit 1; }
  local entry="- name: $name"$'\n'"  type: $type"
  case "$type" in
    once) [ -n "$at" ] || { echo "ERROR: --at required for once"; exit 1; }
      entry+=$'\n'"  at: $at"; max_runs="${max_runs:-1}" ;;
    interval) [ -n "$interval" ] || { echo "ERROR: --interval required"; exit 1; }
      entry+=$'\n'"  interval: $interval" ;;
    scheduled) [ -n "$at" ] || { echo "ERROR: --at required"; exit 1; }
      entry+=$'\n'"  at: "$at""; [ -n "$on" ] && entry+=$'\n'"  on: $on" ;;
    *) echo "ERROR: unknown type: $type"; exit 1 ;;
  esac
  entry+=$'\n'"  prompt: "$prompt""$'\n'"  on_failure: $on_failure"
  [ -n "$max_runs" ] && entry+=$'\n'"  max_runs: $max_runs"
  python3 -c "
with open('$hb') as f:
    lines = f.readlines()
out = []; added = False
for l in lines:
    out.append(l)
    if not added and (l.strip() == '## tasks' or l.strip() == 'tasks:'):
        out.append('$entry' + '\n'); added = True
with open('$hb', 'w') as f:
    f.writelines(out)
print(f'Added: $name')
"
}

cmd_enable() {
  local name="$1" hb; hb=$(get_hb "${2:-}")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  python3 -c "
import re
with open('$hb') as f: content = f.read()
pat = re.compile(r'^[ \t]*- name:\s*' + re.escape('$name') + r'\s*$', re.MULTILINE)
mt = pat.search(content)
if not mt:
    print(f'Task not found: $name'); sys.exit(1)
start = mt.end(); end = content.find('- name:', start)
if end == -1: end = len(content)
block = content[start:end]
block = re.sub(r'\n[ \t]*disabled:\s*true', '', block)
content = content[:start] + block + content[end:]
with open('$hb', 'w') as f: f.write(content)
print(f'Enabled: $name')
"
}

cmd_disable() {
  local name="$1" hb; hb=$(get_hb "${2:-}")
  [ -f "$hb" ] || { echo "ERROR: $hb not found"; exit 1; }
  python3 -c "
import re, sys
with open('$hb') as f: lines = f.readlines()
pat = re.compile(r'^[ \t]*- name:\s*' + re.escape('$name') + r'\s*$')
for i, l in enumerate(lines):
    if pat.match(l):
        for j in range(i+1, len(lines)):
            nl = lines[j]
            if re.match(r'^[ \t]*disabled:', nl):
                print(f'Already disabled: $name'); sys.exit(0)
            if re.match(r'^[ \t]*- name:', nl) or re.match(r'^## ', nl): break
        lines.insert(i+1, '  disabled: true\n')
        with open('$hb', 'w') as f: f.writelines(lines)
        print(f'Disabled: $name'); sys.exit(0)
print(f'Task not found: $name'); sys.exit(1)
"
}

case "${1:-}" in
  list) shift; cmd_list "$@" ;;
  add) shift; cmd_add "$@" ;;
  remove|rm) shift; cmd_remove "$@" ;;
  show|info) shift; cmd_show "$@" ;;
  enable) shift; cmd_enable "$@" ;;
  disable) shift; cmd_disable "$@" ;;
  *) usage ;;
esac
