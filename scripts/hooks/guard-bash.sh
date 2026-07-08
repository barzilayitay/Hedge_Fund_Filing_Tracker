#!/usr/bin/env bash
# PreToolUse hook for Bash: deterministic block of commands that must never
# run autonomously, regardless of what the model decides. Reads the tool
# input JSON on stdin.
set -uo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

BLOCKLIST=(
  "supabase db push"
  "vercel --prod"
  "vercel deploy --prod"
  "git push --force"
  "git push -f"
  "rm -rf /"
  "DROP DATABASE"
)

for pattern in "${BLOCKLIST[@]}"; do
  if echo "$CMD" | grep -qiF "$pattern"; then
    echo "BLOCKED by guard-bash hook: '$pattern' requires human execution (see CLAUDE.md hard rules)."
    exit 2
  fi
done

exit 0
