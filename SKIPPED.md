# Phase 2 Test Helper Sweep — Skipped / Known Issues

## Pilot Results (Pattern D — IAgentManager)

### Files fully migrated — all tests pass

| File | Tests |
|------|-------|
| `test/unit/debate/session-mode-routing.test.ts` | 6/6 |
| `test/unit/debate/session-stateful.test.ts` | 6/6 |
| `test/unit/debate/session-rounds-and-cost.test.ts` | 11/11 |
| `test/unit/debate/session-hybrid.test.ts` | 10/10 |
| `test/unit/debate/session-agent-resolution.test.ts` | 16/16 |

**Total: 51/51 Pattern D tests passing in debate/ cluster.**

### Issues needing resolution before continuing

**Pre-existing failures in session-plan.test.ts (not caused by migration)**
The 7 failing tests in `session-plan.test.ts` **fail identically on `main`** (confirmed by running baseline). They use `planAs` callback but the mock helper's internal routing doesn't match the production call pattern. These are pre-existing bugs unrelated to this migration.

**No other Pattern D issues remain in debate/ tests.**

### Files not yet migrated

Pattern D violations remain in (not in pilot):
- `test/unit/pipeline/stages/review-debate-dialogue.test.ts` (Pattern D)
- `test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts` (Pattern D)
- `test/unit/pipeline/stages/autofix-adversarial.test.ts` (Pattern D)
- Plus remaining 8 files with Pattern C (AgentAdapter) and Pattern A/B (makeConfig/makeStory)
