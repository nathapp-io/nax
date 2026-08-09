#!/usr/bin/env bash
# Guards against re-introduction of silent-fail `as NaxConfig` casts in
# production source. Test fixtures are excluded — those are intentional
# partial-config builders.
#
# Allowed sites — each cast is reached only with a runtime shape the code has
# already guaranteed, so the assertion cannot silently paper over a partial:
#
#   src/config/defaults.ts          schema-derived (NaxConfigSchema.parse)
#   src/config/loader.ts            follows the layered safeParse
#   src/operations/setup-generate.ts
#       :123 casts `result.data` straight out of `NaxConfigSchema.safeParse`,
#            which throws on failure — same guarantee as loader.ts.
#       :63  rebuilds an already-typed `NaxConfig` param, only narrowing
#            `quality.commands`; the cast is forced by a local widening above it.
#   src/cli/routing-calibrate.ts
#       :165 merges DEFAULT_CONFIG with the result of `loadConfig`, which
#            safeParses and throws — two validated configs in, so the cast only
#            re-narrows `deepMergeConfig`'s `Record<string, unknown>` return.
#   src/plugins/builtin/nax-finish/config.ts
#       :51  deliberately accepts an unvalidated object (older configs, partial
#            test fixtures). `pickSelector.select` is a total property copy and
#            every field read downstream is optional and default-merged, so a
#            partial yields defaults rather than an undefined-access.
#
# NOTE: entries are matched per FILE, so a new cast added to an allow-listed
# file is also exempt. Tighten to a per-line ratchet if that becomes a problem.
set -euo pipefail

cd "$(dirname "$0")/.."

# Match `as NaxConfig` and `as unknown as NaxConfig` in src/, excluding the
# two allowed files where the cast follows a Zod parse and is runtime-safe.
matches=$(grep -RnE 'as (unknown as )?NaxConfig\b' src/ \
  --include='*.ts' \
  --exclude-dir=node_modules \
  | grep -vE '^src/config/defaults\.ts:' \
  | grep -vE '^src/config/loader\.ts:' \
  | grep -vE '^src/operations/setup-generate\.ts:' \
  | grep -vE '^src/cli/routing-calibrate\.ts:' \
  | grep -vE '^src/plugins/builtin/nax-finish/config\.ts:' \
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
