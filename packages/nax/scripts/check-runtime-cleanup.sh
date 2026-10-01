#!/bin/bash
# CI gate: ensure test-created NaxRuntime instances are torn down.
#
# Helper-created runtimes are centrally cleaned up in test/helpers/runtime.ts.
# Tests that call createRuntime() directly must still close those runtimes
# themselves, otherwise the idle-watchdog setTimeout leaks across the suite.
#
# Usage: ./scripts/check-runtime-cleanup.sh
# Exit 0 if clean, exit 1 if any violating files found.

set -euo pipefail

HELPER_FILE="test/helpers/runtime.ts"
VIOLATIONS=()

if ! grep -q "afterEach" "$HELPER_FILE" || ! grep -qE "runtime\.close\(|Promise\.allSettled" "$HELPER_FILE"; then
  echo "ERROR: $HELPER_FILE no longer provides centralized runtime cleanup"
  echo "Restore the helper-owned afterEach teardown before merging."
  exit 1
fi

while IFS= read -r file; do
  if ! grep -qE "\.close\(" "$file"; then
    VIOLATIONS+=("$file")
  fi
done < <(grep -rln "createRuntime\(" test/ --include="*.test.ts" 2>/dev/null)

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "ERROR: the following test files call createRuntime() without local cleanup:"
  for f in "${VIOLATIONS[@]}"; do
    echo "  $f"
  done
  echo ""
  echo "Add afterEach(async () => { await runtime.close(); }) or track runtimes in the file"
  echo "and close them with Promise.allSettled in teardown."
  exit 1
fi

echo "OK: helper-managed runtimes have centralized cleanup and direct createRuntime() tests close locally"
