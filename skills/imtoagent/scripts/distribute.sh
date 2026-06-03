#!/usr/bin/env bash
# distribute.sh — 将 imtoagent skill 从源码分发到 ~/.agents/skills/
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${HOME}/.agents/skills/imtoagent"

echo "Source: $SOURCE"
echo "Dest:   $DEST"
echo ""

if [ "$SOURCE" = "$DEST" ]; then
  echo "Already at destination. Nothing to do."
  exit 0
fi

# Rsync (or cp) the skill
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SOURCE"/SKILL.md "$SOURCE"/references "$SOURCE"/scripts "$DEST"/

echo "Distributed to $DEST"
echo ""
echo "Files:"
find "$DEST" -type f | sort

echo ""
echo "NOTE: Restart Codex to pick up the new skill."
