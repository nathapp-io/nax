# v0.19.0 Hardening & Compliance

Address Security, Reliability, and Technical Debt findings from the 2026-03-04 audit.

## Goals
- SEC-1 to SEC-5: Complete security hardening (RCE, Shell, Permissions).
- BUG-1: Fix parallel concurrency race condition.
- BUG-3, BUG-5, MEM-2: Reliability fixes (metrics, mutation, memory leak).
- Technical Debt: Replace forbidden Node.js APIs (readFileSync, etc.) with Bun-native equivalents.
- Architecture: Split 400-line files and cleanup dead code.

## Acceptance Criteria
- SEC-1/2: Dynamic imports restricted to allowed roots.
- SEC-3/4: Shell injection via backticks/dollar-signs blocked.
- SEC-5: --dangerously-skip-permissions respects config.
- BUG-1: Parallel execution respects maxConcurrency exactly.
- Node.js APIs: All readFileSync/appendFileSync/setTimeout replaced with Bun equivalents.
- Files: cli/config.ts split below 400 lines.
