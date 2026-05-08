#!/bin/bash
# CI gate: ensure test files that create NaxRuntime instances clean them up.
#
# Files that call makeTestRuntime() or makeMockRuntime() must have an
# afterEach (or afterAll) that calls .close() on the runtimes they create.
# Without this, the idle-watchdog setTimeout inside each runtime fires
# indefinitely, leaking ~40GB RAM across a full bun test test/unit/ run.
#
# Usage: ./scripts/check-runtime-cleanup.sh
# Exit 0 if clean, exit 1 if any violating files found.

set -euo pipefail

VIOLATIONS=()

while IFS= read -r file; do
  # File imports or uses makeTestRuntime / makeMockRuntime → it creates runtimes
  if ! grep -qE "afterEach|afterAll" "$file"; then
    VIOLATIONS+=("$file")
  fi
done < <(grep -rln "makeTestRuntime\|makeMockRuntime" test/ --include="*.test.ts" 2>/dev/null)

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "ERROR: the following test files create NaxRuntime instances without afterEach/afterAll cleanup:"
  for f in "${VIOLATIONS[@]}"; do
    echo "  $f"
  done
  echo ""
  echo "Add afterEach(async () => { await runtime.close(); }) or use the createdRuntimes"
  echo "tracking-array pattern — see test/unit/operations/semantic-review.test.ts for an example."
  exit 1
fi

echo "OK: all test files with runtime creation have afterEach/afterAll cleanup"
