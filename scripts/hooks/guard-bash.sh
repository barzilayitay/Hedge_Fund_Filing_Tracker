#!/usr/bin/env bash
# PreToolUse hook for Bash: deterministic block of commands that must never
# run autonomously, regardless of what the model decides. Reads the tool
# input JSON on stdin.
set -uo pipefail

INPUT=$(cat)
PYTHON=""
for candidate in python3 python; do
  if "$candidate" -c "1" 2>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "guard-bash: no working python found, skipping guard"
  exit 0
fi
CMD=$(echo "$INPUT" | "$PYTHON" -c "import sys,json;print(json.load(sys.stdin).get('tool_input',{}).get('command','').lower())" 2>/dev/null || echo "")

BLOCKLIST=(
  "supabase db push"
  "vercel --prod"
  "vercel deploy --prod"
  "git push --force"
  "git push -f"
  "rm -rf /"
  "drop database"
  "npm run seed"
)

for pattern in "${BLOCKLIST[@]}"; do
  if echo "$CMD" | grep -qF "$pattern"; then
    echo "BLOCKED by guard-bash hook: '$pattern' requires human execution (see CLAUDE.md hard rules)."
    exit 2
  fi
done

exit 0
