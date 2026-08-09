# Test Overlap Report

Generated: 2026-08-09T07:25:52.755Z

## REDUNDANT

No redundant integration tests found.

## PARTIAL

Found 4 integration test(s) with partial unit test coverage:

- **test/integration/pipeline/pipeline.test.ts**
  - Coverage: 13%
  - Missing: Pipeline Runner, runPipeline, isolation-violation, session-failure, tests-failing, full-suite-gate-exhausted, verifier-rejected, no failureCategory (backward compat), retryAsLite is not set for non-isolation failures
- **test/integration/pipeline/pipeline-acceptance.test.ts**
  - Coverage: 45%
  - Missing: acceptanceStage.enabled, acceptanceStage.execute, broken, BUG-083: acceptance command scoping, test-feature, test-feature
- **test/integration/cli/cli-core-logs.test.ts**
  - Coverage: 22%
  - Missing: nax logs CLI integration, basic invocation, --list flag, --run flag, --json flag, --follow mode, combined flags
- **test/integration/routing/routing-stage-greenfield.test.ts**
  - Coverage: 50%
  - Missing: Routing Stage - Greenfield Detection forces test-after strategy when no tests exist

## UNIQUE

Found 110 unique integration test(s) with no unit test coverage:

- test/integration/pipeline/gating-preservation.test.ts
- test/integration/pipeline/reporter-lifecycle-basic.test.ts
- test/integration/pipeline/hooks.test.ts
- test/integration/pipeline/pipeline-events.test.ts
- test/integration/pipeline/reporter-lifecycle-resilience.test.ts
- test/integration/context/feature-engine-read-path.test.ts
- test/integration/context/context-verification-integration.test.ts
- test/integration/context/test-coverage-parity.test.ts
- test/integration/context/context-provider-injection.test.ts
- test/integration/context/context-path-security.test.ts
- test/integration/context/context-integration.test.ts
- test/integration/config/per-story-config.test.ts
- test/integration/config/security-loader.test.ts
- test/integration/config/merger.test.ts
- test/integration/config/config-loader.test.ts
- test/integration/config/paths.test.ts
- test/integration/config/config.test.ts
- test/integration/config/profile-loader.test.ts
- test/integration/plugins/config-integration.test.ts
- test/integration/plugins/config-resolution.test.ts
- test/integration/plugins/plugins-registry.test.ts
- test/integration/plugins/validator.test.ts
- test/integration/plugins/loader.test.ts
- test/integration/plan/plan-callop-migration.test.ts
- test/integration/plan/analyze-scanner.test.ts
- test/integration/plan/plan-prd-preservation.test.ts
- test/integration/plan/plan-callop.test.ts
- test/integration/plan/plan.test.ts
- test/integration/plan/logger.test.ts
- test/integration/runtime/runtime-middleware.test.ts
- test/integration/worktree/worktree-merge.test.ts
- test/integration/worktree/manager.test.ts
- test/integration/agents/fail-stale-watchdog.test.ts
- test/integration/agents/timeout-retry-fresh-session.test.ts
- test/integration/agents/stale-then-swap.test.ts
- test/integration/agents/manager-lifetime.test.ts
- test/integration/agents/no-adapter-wrap.test.ts
- test/integration/agents/stale-retry-session-reuse.test.ts
- test/integration/cli/cli-core-headless.test.ts
- test/integration/cli/cli-routing-calibrate.test.ts
- test/integration/cli/plan-agent-selection.test.ts
- test/integration/cli/cli-precheck-run.test.ts
- test/integration/cli/cli-core-generate.test.ts
- test/integration/cli/cli-precheck-command.test.ts
- test/integration/cli/cli-core-parallel.test.ts
- test/integration/cli/cli-config-diff.test.ts
- test/integration/cli/cli-precheck-integration.test.ts
- test/integration/cli/cli-precheck-checks.test.ts
- test/integration/cli/cli-profile-flag.test.ts
- test/integration/cli/cli-core-agents.test.ts
- test/integration/cli/cli-config-explain.test.ts
- test/integration/cli/cli-plugins.test.ts
- test/integration/cli/adapter-boundary.test.ts
- test/integration/cli/cli-config-default-view.test.ts
- test/integration/cli/cli-config-command.test.ts
- test/integration/operations/run-empty-output-retry.test.ts
- test/integration/operations/complete-empty-output-retry.test.ts
- test/integration/operations/middleware-coverage.test.ts
- test/integration/verification/test-scanner.test.ts
- test/integration/verification/verification-asset-check.test.ts
- test/integration/acceptance/red-green-cycle.test.ts
- test/integration/acceptance/audit-naming.test.ts
- test/integration/acceptance/agent-file-recovery.test.ts
- test/integration/execution/runner-parallel-metrics-rectification-events.test.ts
- test/integration/execution/runner-parallel-metrics.test.ts
- test/integration/execution/runner-config-plugins.test.ts
- test/integration/execution/feature-status-write.test.ts
- test/integration/execution/prd-resolvers.test.ts
- test/integration/execution/parallel-batch-selector.test.ts
- test/integration/execution/checkpoint/reader.test.ts
- test/integration/execution/fullsuite-rectify-declaration.test.ts
- test/integration/execution/progress.test.ts
- test/integration/execution/runner-fixes.test.ts
- test/integration/execution/status-writer.test.ts
- test/integration/execution/runner-plugin-integration.test.ts
- test/integration/execution/nbf-rectify-declaration.test.ts
- test/integration/execution/status-writer-postrun.test.ts
- test/integration/execution/rectification-routing.test.ts
- test/integration/execution/verifier-findings-flow.test.ts
- test/integration/execution/parallel-batch-rectification.test.ts
- test/integration/execution/runner-parallel-metrics-cost-duration.test.ts
- test/integration/execution/execution.test.ts
- test/integration/execution/runner-escalation.test.ts
- test/integration/execution/scratch-per-role.test.ts
- test/integration/execution/parallel-batch-results.test.ts
- test/integration/execution/status-file.test.ts
- test/integration/execution/runner-queue-and-attempts.test.ts
- test/integration/execution/execution-isolation.test.ts
- test/integration/execution/deferred-review-integration.test.ts
- test/integration/execution/status-file-integration.test.ts
- test/integration/execution/parallel-batch-executor.test.ts
- test/integration/execution/prd-pause.test.ts
- test/integration/execution/verdict-cleanup.test.ts
- test/integration/review/review-config-commands.test.ts
- test/integration/review/review-config-schema.test.ts
- test/integration/review/adversarial-reprompt-telemetry.test.ts
- test/integration/review/review.test.ts
- test/integration/prompts/pb-004-migration.test.ts
- test/integration/routing/plugin-routing-advanced.test.ts
- test/integration/routing/routing-stage-final-state.test.ts
- test/integration/routing/plugin-routing-core.test.ts
- test/integration/tdd/story-orchestrator-failureCategory.test.ts
- test/integration/tdd/story-orchestrator-fallback.test.ts
- test/integration/tdd/tdd-cleanup.test.ts
- test/integration/tdd/audit-naming.test.ts
- test/integration/tdd/story-orchestrator-verdict.test.ts
- test/integration/tdd/story-orchestrator-core.test.ts
- test/integration/tdd/story-orchestrator-lite.test.ts
- test/integration/flows/pr-diffstat.test.ts
- test/integration/interaction/interaction-chain-pipeline.test.ts
