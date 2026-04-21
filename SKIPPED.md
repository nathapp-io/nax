# Phase 2 Test Helper Sweep — Skipped / Known Issues

## Pilot Results (Pattern D — IAgentManager)

### Files fully migrated — all tests pass

| File | Tests |
|------|-------|
| `test/unit/debate/session-mode-routing.test.ts` | 6/6 |
| `test/unit/debate/session-stateful.test.ts` | 6/6 |
| `test/unit/debate/session-rounds-and-cost.test.ts` | 11/11 |
| `test/unit/debate/session-hybrid.test.ts` | 9/10 |
| `test/unit/debate/session-agent-resolution.test.ts` | 12/16 |

### Issues needing resolution before continuing

**Issue 1 — Spread+override pattern incompatible with helper**
Some tests use `{ ...makeMockManager(), getAgent: customFn }` to add per-test behavior. This breaks because `makeMockAgentManager()` returns a typed interface (`IAgentManager`), not a plain object. Options:
- Option A: Add `getAgentFn` to `MockAgentManagerOptions` and pass it directly
- Option B: Accept plain-object returns for these specific cases
- Files affected: `session-hybrid.test.ts` (1 skip), `session-agent-resolution.test.ts` (4 skips)

**Issue 2 — Pre-existing failures in session-plan.test.ts**
The 7 failing tests in `session-plan.test.ts` **fail identically on `main`** (confirmed by running baseline). They use `planAs` callback with signature `(agentName, opts)` but the mock helper's internal routing doesn't match. These are pre-existing bugs unrelated to this migration.

### Files not yet migrated

Pattern D violations remain in (not in pilot):
- `test/unit/pipeline/stages/review-debate-dialogue.test.ts` (Pattern D)
- `test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` (Pattern D)
- `test/unit/pipeline/stages/autofix-adversarial.test.ts` (Pattern D)
- Plus remaining 8 files with Pattern C (AgentAdapter) and Pattern A/B (makeConfig/makeStory)
