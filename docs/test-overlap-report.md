# Test Overlap Report

Generated: 2026-03-14T02:55:48.011Z

## REDUNDANT

No redundant integration tests found.

## PARTIAL

Found 3 integration test(s) with partial unit test coverage:

- **test/integration/pipeline/pipeline-acceptance.test.ts**
  - Coverage: 71%
  - Missing: acceptanceStage.enabled, acceptanceStage.execute
- **test/integration/pipeline/pipeline.test.ts**
  - Coverage: 11%
  - Missing: Pipeline Runner, runPipeline, isolation-violation, session-failure, tests-failing, verifier-rejected, no failureCategory (backward compat), retryAsLite is not set for non-isolation failures
- **test/integration/routing/routing-stage-greenfield.test.ts**
  - Coverage: 50%
  - Missing: Routing Stage - Greenfield Detection (BUG-010)

## UNIQUE

Found 67 unique integration test(s) with no unit test coverage:

- test/integration/pipeline/hooks.test.ts
- test/integration/pipeline/pipeline-events.test.ts
- test/integration/pipeline/reporter-lifecycle.test.ts
- test/integration/pipeline/verify-stage.test.ts
- test/integration/context/context-verification-integration.test.ts
- test/integration/context/context-provider-injection.test.ts
- test/integration/context/s5-greenfield-fallback.test.ts
- test/integration/context/context-path-security.test.ts
- test/integration/context/context-integration.test.ts
- test/integration/interaction/interaction-chain-pipeline.test.ts
- test/integration/verification/verification-asset-check.test.ts
- test/integration/verification/test-scanner.test.ts
- test/integration/cli/cli-config-explain.test.ts
- test/integration/cli/cli-config.test.ts
- test/integration/cli/cli-plugins.test.ts
- test/integration/cli/cli-precheck.test.ts
- test/integration/cli/cli-core.test.ts
- test/integration/review/review-config-schema.test.ts
- test/integration/review/review-config-commands.test.ts
- test/integration/review/review.test.ts
- test/integration/review/review-plugin-integration.test.ts
- test/integration/prompts/pb-004-migration.test.ts
- test/integration/plan/logger.test.ts
- test/integration/plan/plan.test.ts
- test/integration/plan/analyze-scanner.test.ts
- test/integration/plan/analyze-integration.test.ts
- test/integration/agents/acp/tdd-flow.test.ts
- test/integration/routing/plugin-routing-core.test.ts
- test/integration/routing/routing-stage-bug-021.test.ts
- test/integration/routing/plugin-routing-advanced.test.ts
- test/integration/config/config.test.ts
- test/integration/config/config-loader.test.ts
- test/integration/config/security-loader.test.ts
- test/integration/config/merger.test.ts
- test/integration/config/paths.test.ts
- test/integration/execution/execution.test.ts
- test/integration/execution/deferred-review-integration.test.ts
- test/integration/execution/prd-resolvers.test.ts
- test/integration/execution/runner-config-plugins.test.ts
- test/integration/execution/execution-isolation.test.ts
- test/integration/execution/status-file.test.ts
- test/integration/execution/progress.test.ts
- test/integration/execution/runner-queue-and-attempts.test.ts
- test/integration/execution/runner-plugin-integration.test.ts
- test/integration/execution/feature-status-write.test.ts
- test/integration/execution/prd-pause.test.ts
- test/integration/execution/runner-parallel-metrics.test.ts
- test/integration/execution/status-writer.test.ts
- test/integration/execution/runner-escalation.test.ts
- test/integration/execution/status-file-integration.test.ts
- test/integration/execution/runner-fixes.test.ts
- test/integration/execution/story-id-in-events.test.ts
- test/integration/execution/parallel.test.ts
- test/integration/worktree/worktree-merge.test.ts
- test/integration/worktree/manager.test.ts
- test/integration/plugins/validator.test.ts
- test/integration/plugins/plugins-registry.test.ts
- test/integration/plugins/config-integration.test.ts
- test/integration/plugins/loader.test.ts
- test/integration/plugins/config-resolution.test.ts
- test/integration/tdd/tdd-orchestrator-lite.test.ts
- test/integration/tdd/tdd-orchestrator-verdict.test.ts
- test/integration/tdd/tdd-orchestrator-core.test.ts
- test/integration/tdd/tdd-orchestrator-failureCategory.test.ts
- test/integration/tdd/tdd-orchestrator-fallback.test.ts
- test/integration/tdd/tdd-cleanup.test.ts
- test/integration/acceptance/red-green-cycle.test.ts
