#!/bin/bash
# Issue #1514 Phase 2 gate: scripts/ tree must typecheck cleanly.
# Mirrors scripts/check-dispatch-context.sh.
set -euo pipefail

bun x tsc --project tsconfig.scripts.json --noEmit

echo "OK: scripts/ typecheck passes."
