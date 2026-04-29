#!/bin/bash
# ADR-020 Wave 2 guard: dispatch-time contexts must not make agentManager nullable.

set -euo pipefail

bun x tsc --project tsconfig.dispatch-context.json --noEmit

# grep -v chains to exclude known-allowlisted files.
# Uses portable grep -v instead of a case statement inside $() to avoid
# a bash 3.2 (macOS default) syntax error with empty case arms in multi-line
# command substitutions.
MATCHES=$(grep -rnE "agentManager\?[[:space:]]*:[[:space:]]*(import\(.+\)\.)?IAgentManager" src/ --include="*.ts" \
  | grep -v "^src/runtime/index\.ts:" \
  | grep -v "^src/execution/runner-setup\.ts:" \
  | grep -v "^src/execution/lifecycle/run-setup\.ts:" \
  | grep -v "^src/execution/parallel-coordinator\.ts:" \
  | grep -v "^src/review/runner\.ts:" \
  | grep -v "^src/review/orchestrator\.ts:" \
  || true)

if [ -n "$MATCHES" ]; then
  echo "ERROR: optional agentManager found in dispatch-time source:"
  echo "$MATCHES"
  echo "Use DispatchContext.agentManager or thread runtime.agentManager explicitly."
  exit 1
fi

echo "OK: DispatchContext type and nullable-manager guards passed."
