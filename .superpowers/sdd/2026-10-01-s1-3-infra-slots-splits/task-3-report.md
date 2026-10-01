# Task 3 report: logger slot and redact relocation

## Implementation

- Added `AgentLogger`, `setAgentLogger`, `getSafeLogger`, and silent-unset `getLogger` in `src/agents/infra/agent-logger.ts`, exported through the infra barrel.
- Wired `initLogger` and `resetLogger` to install and clear the slot.
- Moved `redact.ts` to `src/utils/redact.ts`; updated logger exports/imports, the moved subject test, manifest entry, and the helper-process/secret-spans imports.
- Retargeted all 32 imports reported by `check-agent-boundary.ts --list` from `src/logger/index.ts` to the infra slot or utils redactor. Boundary baseline decreased from 59 to 27.
- Port-cut the failed-taint warning test in `dispatch-ask.test.ts` to install the infra logger slot. It observes the moved `approvals-taint.ts` consumer.

## RED/GREEN and focused tests

- RED: the two new slot test files errored because `getLogger`/`getSafeLogger` were not exported from `@/agents/infra`.
- GREEN: focused slot and wiring tests: 7 passed, 0 failed.
- Mutation: temporarily removed `setAgentLogger(instance)`; the wiring test failed in both init cases as expected. Restored the production line.
- `dispatch-ask.test.ts`: 32 passed, 0 failed.
- `redact.test.ts`: 65 passed, 0 failed.

## Package suite and gates

- Initial `bun run test`: unit phase passed; sandboxed integration phase failed (22 failures) on environment restrictions, including Bun tempdir write `EPERM`, sandbox-wrap `EPERM`, and local server startup errors.
- Escalated integration retry, `bun test test/integration/ --timeout=60000`: 1,538 passed, 38 skipped, 0 failed across 147 files.
- `bun run typecheck`: passed.
- `bun run check:import-cycles`: passed, 0 cycles.
- `bun run check:alias-internals`: passed.
- `bun scripts/check-agent-boundary.ts --list`: 27 edges; no remaining edge to `src/logger/index.ts`.
- `bun run lint`: passed, including Biome and package lint checks.

## Test changes and review

The logger redaction test import changed because its subject moved. The dispatch warning test changed because the code under test moved to the infra logger slot; it now installs and clears that slot directly. No other existing test was changed. New tests avoid capitalized import aliases to stay within the loose-cast ratchet.

No behavior changes were identified in the logger slot: unset `getSafeLogger()` is `null`, unset `getLogger()` is silent, and init/reset keep the slot aligned with the logger singleton. `src/utils/git.ts` was not modified.

The package suite did not complete as a single green `bun run test` under the sandbox. Its unit phase passed, and the failing integration phase passed on the authorized escalated retry described above.

## Follow-up fix: preserve the logger barrel API

Removed the unintended `redactEntry` export from `src/logger/index.ts`. The function remains exported from `src/utils/redact.ts`; `@/logger` retains its prior redaction names, `redactSecrets` and `SECRET_VALUE_PATTERNS`, plus `SecretValuePattern`.

Covering verification:
- `bun x biome check --write src/logger/index.ts`: passed; no fixes required.
- `bun test test/unit/logger/redact.test.ts --timeout=60000`: 65 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed, including package lint checks.
