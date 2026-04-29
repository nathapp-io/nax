#!/bin/bash
# CI gate: prevent wrapAdapterAsManager from re-entering production code.
# ADR-020 Wave 2 — wrapAdapterAsManager is privatized; all agent dispatch
# must flow through the AgentManager middleware chain.
#
# Usage: ./scripts/check-no-adapter-wrap.sh
# Exit 0 if clean, exit 1 if forbidden symbol found.

set -euo pipefail

# Match any occurrence of the forbidden symbol, then strip comment-only lines.
# grep output is "filename:line:content" — strip the prefix to test content.
MATCHES=$(grep -rn "wrapAdapterAsManager" src/ --include="*.ts" --include="*.tsx" | while IFS= read -r line; do
  content=$(echo "$line" | sed 's/^[^:]*:[0-9]*://')
  if ! echo "$content" | grep -qE "^[[:space:]]*(//|\*)"; then
    echo "$line"
  fi
done || true)

if [ -n "$MATCHES" ]; then
  echo "ERROR: wrapAdapterAsManager usage found in src/:"
  echo "$MATCHES"
  echo "Remove it and use createRuntime(...).agentManager or fakeAgentManager() instead."
  exit 1
fi

echo "OK: no wrapAdapterAsManager usage in src/"
