#!/bin/bash
# Check for process.cwd() outside permitted CLI entry points.
# Permitted: src/cli/*.ts, src/commands/*.ts, src/config/loader.ts

set -euo pipefail

VIOLATIONS=$(grep -rn 'process\.cwd()' src/ \
  --include='*.ts' \
  --exclude-dir='node_modules' \
  | grep -v '^src/cli/' \
  | grep -v '^src/commands/' \
  | grep -v '^src/config/loader.ts:' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: process.cwd() found outside permitted paths (src/cli/*, src/commands/*, src/config/loader.ts):"
  echo "$VIOLATIONS"
  exit 1
fi

echo "OK: No process.cwd() violations found."
