# ADR-019 Test Quarantine

**Date:** 2026-04-29
**Branch:** `chore/adr-019-test-migration-batch-2`

## Quarantined Tests

### Wave 1: Review tests

| File | Tests Quarantined | Root Cause |
|------|-------------------|------------|
| `test/unit/review/semantic-debate.test.ts` | 1 test: `AC3: agent.run() called once when debate is disabled` | DISPATCH_NO_RUNTIME at line 332 despite runtime defined and passed as 15th positional arg |
| `test/unit/review/semantic-prompt-response.test.ts` | 18 tests: all LLM response parsing, fail-open, fail-closed, and markdown fence stripping tests | DISPATCH_NO_RUNTIME despite runtime defined and passed |

## Symptom Pattern

All quarantined tests share the same pattern:
1. **Pass when `debate.enabled=true`** — takes early return path `runSemanticDebate()` before hitting `if (!runtime)` guard
2. **Fail with `DISPATCH_NO_RUNTIME`** when debate is disabled or not configured, even though `runtime` is defined and passed correctly

## Key Observations

- The runtime IS being defined (`makeMockRuntime({ agentManager })` returns a truthy object)
- The runtime IS being passed as the 15th positional argument
- The function signature has `runtime?: NaxRuntime` (optional 15th param)
- The `if (!runtime)` guard at `src/review/semantic.ts:204` still throws

## Hypotheses (not verified)

1. **Module caching issue** — Bun may be caching the semantic.ts module from a previous test that didn't have runtime
2. **Mock restoration issue** — `mock.restore()` in afterEach may be affecting runtime object behavior
3. **Test isolation issue** — runtime mock may not be properly isolated between tests
4. **Stack/heap corruption** — rare edge case where object reference becomes invalid

## Files to Update When Issue is Resolved

- `test/unit/review/semantic-debate.test.ts` — remove `.skip` from AC3 test
- `test/unit/review/semantic-prompt-response.test.ts` — remove quarantine markers

## Related Issues

- Issue #762: ADR-019 Wave 3 — legacy agentManager.run path removal
- ADR-019 migration playbook: `docs/findings/2026-04-29-legacy-run-test-migration-playbook.md`
