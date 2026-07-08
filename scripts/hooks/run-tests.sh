#!/usr/bin/env bash
# PostToolUse hook: run fast checks after every file edit and surface
# failures back into Claude's context. Keep output short — tail only.
set -uo pipefail

# Skip until Phase 0 has installed the toolchain.
[ -f package.json ] || exit 0
[ -d node_modules ] || exit 0

OUT=$(npm run -s test -- --run --bail=1 2>&1)
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "TESTS FAILING — fix before continuing:"
  echo "$OUT" | tail -30
  exit 2   # exit 2 = blocking feedback injected into Claude's context
fi

TC=$(npm run -s typecheck 2>&1)
if [ $? -ne 0 ]; then
  echo "TYPECHECK FAILING:"
  echo "$TC" | tail -20
  exit 2
fi

exit 0
