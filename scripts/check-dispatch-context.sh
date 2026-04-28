#!/bin/bash
# ADR-020 Wave 2 guard: dispatch-time contexts must not make agentManager nullable.

set -euo pipefail

bun x tsc --project tsconfig.dispatch-context.json --noEmit

MATCHES=$(grep -rnE "agentManager\\?[[:space:]]*:[[:space:]]*(import\\(.+\\)\\.)?IAgentManager" src/ --include="*.ts" | while IFS= read -r line; do
  case "$line" in
    src/runtime/index.ts:*) ;;
    src/execution/runner-setup.ts:*) ;;
    src/execution/lifecycle/run-setup.ts:*) ;;
    src/execution/parallel-coordinator.ts:*) ;;
    src/review/runner.ts:*) ;;
    src/review/orchestrator.ts:*) ;;
    *) echo "$line" ;;
  esac
done || true)

if [ -n "$MATCHES" ]; then
  echo "ERROR: optional agentManager found in dispatch-time source:"
  echo "$MATCHES"
  echo "Use DispatchContext.agentManager or thread runtime.agentManager explicitly."
  exit 1
fi

echo "OK: DispatchContext type and nullable-manager guards passed."
