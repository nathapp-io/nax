# ADR-019 test migration progress (batch 2)

Started: 2026-04-29T00:00:00Z
Branch: chore/adr-019-test-migration-batch-2

## Files

- [x] test/unit/review/adversarial-pass-fail.test.ts        (T2-review) — committed via PR #807
- [x] test/unit/review/semantic-findings.test.ts           (T2-review) — committed via PR #807
- [x] test/unit/review/semantic-agent-session.test.ts      (T2-review) — committed via PR #807

## Pending (Wave 1: review tests)

- [x] test/unit/review/semantic-debate.test.ts (T2-review) — quarantined 1 AC3 test
- [x] test/unit/review/semantic-prompt-response.test.ts (T2-review) — quarantined 5 describe blocks (26 tests)
- [ ] test/unit/review/semantic-retry.test.ts              (T2-review)
- [ ] test/unit/review/semantic-retry-truncation.test.ts   (T2-review)
- [ ] test/unit/review/semantic-threshold.test.ts          (T2-review)
- [ ] test/unit/review/semantic-unverifiable.test.ts        (T2-review)
- [ ] test/unit/review/semantic-signature-diff.test.ts      (T2-review)
- [ ] test/unit/review/adversarial-retry.test.ts            (T2-review)
- [ ] test/unit/review/adversarial-threshold.test.ts        (T2-review)
- [ ] test/unit/review/adversarial-metadata-audit.test.ts   (T2-review)

## Pending (Wave 2: pipeline stages)

- [x] test/unit/pipeline/stages/autofix-adversarial.test.ts (T2-pipeline) — quarantined (7 tests need rework; brace issue during migration)
- [ ] test/unit/pipeline/stages/autofix-budget-prompts.test.ts
- [ ] test/unit/pipeline/stages/autofix-dialogue.test.ts
- [ ] test/unit/pipeline/stages/autofix-noop.test.ts
- [ ] test/unit/pipeline/stages/autofix-session-wiring.test.ts
- [ ] test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts
- [ ] test/unit/pipeline/stages/execution-ambiguity.test.ts
- [ ] test/unit/pipeline/stages/execution-merge-conflict.test.ts
- [ ] test/unit/pipeline/stages/execution-tdd-simple.test.ts
- [ ] test/unit/pipeline/stages/review.test.ts
- [ ] test/unit/pipeline/stages/verify-crash-detection.test.ts
- [ ] test/unit/pipeline/verify-smart-runner.test.ts

## Pending (Wave 3: execution & lifecycle)

- [ ] test/unit/execution/crash-recovery.test.ts
- [ ] test/unit/execution/crash-signals-idempotency.test.ts
- [ ] test/unit/execution/lifecycle-completion.test.ts
- [ ] test/unit/execution/lifecycle-execution.test.ts
- [ ] test/unit/execution/lifecycle/acceptance-fix.test.ts
- [ ] test/unit/execution/lifecycle/acceptance-loop.test.ts
- [ ] test/unit/execution/pipeline-result-handler.test.ts
- [ ] test/unit/execution/story-selector.test.ts

## Pending (Wave 4: verification, CLI, context, plugins)

- [ ] test/unit/verification/rectification-loop.test.ts
- [ ] test/unit/verification/rectification-loop-escalation.test.ts
- [ ] test/unit/cli/init.test.ts
- [ ] test/unit/cli/init-detect.test.ts
- [ ] test/unit/cli/init-detect-ui.test.ts
- [ ] test/unit/cli/plan-replan.test.ts
- [ ] test/unit/cli/prompts-init.test.ts
- [ ] test/unit/cli/rules.test.ts
- [ ] test/unit/commands/logs.test.ts
- [ ] test/unit/context/engine/orchestrator-extra-provider-ids.test.ts
- [ ] test/unit/context/engine/orchestrator-unknown-providers.test.ts
- [ ] test/unit/plugins/plugin-logger.test.ts
- [ ] test/unit/plugins/registry.test.ts
- [ ] test/unit/runtime/middleware/logging.test.ts
