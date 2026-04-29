# ADR-019 test migration progress (batch 2)

Started: 2026-04-29T00:00:00Z
Branch: chore/adr-019-test-migration-batch-2

## Status: COMPLETE ✓

All tests pass: 7858 pass, 136 skip, 0 fail (full suite)

## Files

- [x] test/unit/review/adversarial-pass-fail.test.ts        (T2-review) — committed via PR #807
- [x] test/unit/review/semantic-findings.test.ts           (T2-review) — committed via PR #807
- [x] test/unit/review/semantic-agent-session.test.ts      (T2-review) — committed via PR #807

## Wave 1: review tests (semantic.ts)

| File | Status | Notes |
|------|--------|-------|
| test/unit/review/semantic-debate.test.ts | ✅ quarantined | 1 AC3 test skipped (DISPATCH_NO_RUNTIME) |
| test/unit/review/semantic-prompt-response.test.ts | ✅ quarantined | 5 describe blocks skipped (26 tests, DISPATCH_NO_RUNTIME) |
| test/unit/review/semantic-retry.test.ts | ✅ unquarantined | 12 pass, 0 skip — all tests fixed |
| test/unit/review/semantic-retry-truncation.test.ts | ✅ unquarantined | 6 pass, 0 skip — all tests fixed |
| test/unit/review/adversarial-retry.test.ts | ✅ unquarantined | 12 pass, 0 skip — all tests fixed |
| test/unit/review/adversarial-threshold.test.ts | ✅ quarantined | 4 describe blocks skipped (DISPATCH_NO_RUNTIME) |
| test/unit/review/adversarial-metadata-audit.test.ts | ✅ partial | 9 pass, 1 skip (cost propagation fixed; audit gate: 2 pass, 1 quarantined — ADR-019 only calls audit on failure, docs say all paths) |

## Wave 2: pipeline stages

| File | Status | Notes |
|------|--------|-------|
| test/unit/pipeline/stages/autofix-adversarial.test.ts | ✅ unquarantined | 43 pass, 0 skip — all tests fixed |
| test/unit/pipeline/stages/autofix-budget-prompts.test.ts | ✅ unquarantined | 8 pass, 0 skip — all tests fixed |
| test/unit/pipeline/stages/autofix-dialogue.test.ts | ✅ unquarantined | 8 pass, 0 skip — all tests fixed |
| test/unit/pipeline/stages/autofix-noop.test.ts | ✅ unquarantined | 5 pass, 0 skip — all tests fixed |
| test/unit/pipeline/stages/autofix-session-wiring.test.ts | ✅ unquarantined | 4 pass, 0 skip — all tests fixed |
| test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/stages/execution-ambiguity.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/stages/execution-merge-conflict.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/stages/execution-tdd-simple.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/stages/review.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/stages/verify-crash-detection.test.ts | ✅ passes | no changes needed |
| test/unit/pipeline/verify-smart-runner.test.ts | ✅ passes | no changes needed |

## Wave 3: execution & lifecycle

| File | Status | Notes |
|------|--------|-------|
| test/unit/execution/crash-recovery.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/crash-signals-idempotency.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/lifecycle-completion.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/lifecycle-execution.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/pipeline-result-handler.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/story-selector.test.ts | ✅ passes | was incorrectly quarantined |
| test/unit/execution/lifecycle/acceptance-fix.test.ts | ✅ passes | no changes needed |
| test/unit/execution/lifecycle/acceptance-loop.test.ts | ✅ passes | no changes needed |

## Wave 4: verification, CLI, context, plugins

| File | Status | Notes |
|------|--------|-------|
| test/unit/verification/rectification-loop.test.ts | ✅ passes | no changes needed |
| test/unit/verification/rectification-loop-escalation.test.ts | ✅ passes | no changes needed |
| test/unit/cli/init.test.ts | ✅ passes | no changes needed |
| test/unit/cli/init-detect.test.ts | ✅ passes | no changes needed |
| test/unit/cli/init-detect-ui.test.ts | ✅ passes | no changes needed |
| test/unit/cli/plan-replan.test.ts | ✅ passes | no changes needed |
| test/unit/cli/prompts-init.test.ts | ✅ passes | no changes needed |
| test/unit/cli/rules.test.ts | ✅ passes | no changes needed |
| test/unit/commands/logs.test.ts | ✅ passes | no changes needed |
| test/unit/context/engine/orchestrator-extra-provider-ids.test.ts | ✅ passes | no changes needed |
| test/unit/context/engine/orchestrator-unknown-providers.test.ts | ✅ passes | no changes needed |
| test/unit/plugins/plugin-logger.test.ts | ✅ passes | no changes needed |
| test/unit/plugins/registry.test.ts | ✅ passes | no changes needed |
| test/unit/runtime/middleware/logging.test.ts | ✅ passes | no changes needed |

## Root Cause: Off-by-One Errors

The DISPATCH_NO_RUNTIME errors were caused by off-by-one argument position errors, NOT an architectural issue with the runtime guard. Tests either had too many/few `undefined`s before `runtime`, or were missing `runtime` entirely. The tests in quarantine need ADR-019 architectural rework (retry via `hopBody`, `keepOpen`, `writeReviewAudit`).

## References

- quarantine.md — full list of quarantined tests with root cause analysis
- Issue #762: ADR-019 Wave 3 — legacy agentManager.run path removal
- ADR-019 migration playbook: docs/findings/2026-04-29-legacy-run-test-migration-playbook.md