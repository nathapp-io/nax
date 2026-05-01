#!/usr/bin/env bash
# Guards against re-introduction of silent-fail `as NaxConfig` casts in
# production source. Test fixtures are excluded — those are intentional
# partial-config builders.
#
# Allowed sites (schema-derived, runtime-validated):
#   src/config/defaults.ts
#   src/config/loader.ts
set -euo pipefail

cd "$(dirname "$0")/.."

# Match `as NaxConfig` and `as unknown as NaxConfig` in src/, excluding the
# two allowed files where the cast follows a Zod parse and is runtime-safe.
matches=$(grep -RnE 'as (unknown as )?NaxConfig\b' src/ \
  --include='*.ts' \
  --exclude-dir=node_modules \
  | grep -vE '^src/config/defaults\.ts:' \
  | grep -vE '^src/config/loader\.ts:' \
  || true)

if [ -n "$matches" ]; then
  echo "[FAIL] Silent-fail NaxConfig cast(s) detected outside the allow-list:" >&2
  echo "$matches" >&2
  echo "" >&2
  echo "If a new cast is genuinely needed, add the file path to the" >&2
  echo "allow-list in scripts/check-no-silent-naxconfig-cast.sh and" >&2
  echo "document why the runtime shape is guaranteed." >&2
  exit 1
fi

echo "[OK] No silent-fail NaxConfig casts in src/."
