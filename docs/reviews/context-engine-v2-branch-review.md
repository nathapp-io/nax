# Context Engine v2 Review And Remediation Report

Date: 2026-04-16
Branch: `feat/context-engine-v2`
Base: `main`

## Scope

Reviewed against:

- `docs/specs/SPEC-context-engine-v2.md`
- `docs/specs/SPEC-context-engine-v2-amendments.md`
- `docs/specs/SPEC-context-engine-v2-compilation.md`
- `docs/adr/ADR-010-context-engine.md`

## Findings Reviewed

The latest branch review identified four active gaps:

1. Three-session TDD was preassembling all bundles up front, so implementer/verifier runs could not learn from earlier sessions.
2. Pull-tool descriptors were assembled but never actually executable at agent runtime.
3. Story-level scratch aggregation was not wired into production context assembly.
4. Context manifests were only available in memory; there was no durable inspect flow.

## Remediation Implemented

### 1. TDD bundle assembly is now just-in-time

- `runThreeSessionTdd()` now supports lazy per-role bundle assembly.
- `runThreeSessionTddFromCtx()` now assembles `test-writer`, `implementer`, and `verifier` bundles sequentially instead of precomputing them in parallel.
- Each completed TDD sub-session writes a `tdd-session` scratch entry immediately, so later sessions can consume the discoveries.
- Per-stage digests are persisted alongside those TDD scratch updates.

Key files:

- `src/tdd/orchestrator.ts`
- `src/tdd/session-runner.ts`
- `src/tdd/types.ts`
- `src/session/scratch-writer.ts`
- `src/context/engine/providers/session-scratch.ts`

### 2. Pull tools are now live in ACP runs

- `AgentRunOptions` now carries `contextPullTools` and `contextToolRuntime`.
- Added a context-tool runtime bridge for `query_neighbor` and `query_feature_context`.
- The ACP adapter now supports a constrained text tool-call loop using `<nax_tool_call ...>` / `<nax_tool_result ...>` blocks.
- Execution, TDD, semantic review, and adversarial review now pass pull-tool descriptors and runtime handlers into `agent.run()`.

Key files:

- `src/agents/types.ts`
- `src/agents/acp/adapter.ts`
- `src/context/engine/tool-runtime.ts`
- `src/pipeline/stages/execution.ts`
- `src/tdd/session-runner.ts`
- `src/review/semantic.ts`
- `src/review/adversarial.ts`

### 3. Story-level scratch aggregation now uses SessionManager in production

- `PipelineContext` now carries an in-process `sessionManager`.
- `iteration-runner` creates a `SessionManager` per story pipeline run.
- `SessionManager.create()` can now derive a session scratch directory automatically from `projectDir + feature + sessionId`.
- The context stage registers the main story session through `SessionManager` when available.
- `assembleForStage()` now aggregates scratch dirs from `sessionManager.getForStory(storyId)` plus the current session scratch dir.

Key files:

- `src/pipeline/types.ts`
- `src/execution/iteration-runner.ts`
- `src/session/types.ts`
- `src/session/manager.ts`
- `src/pipeline/stages/context.ts`
- `src/context/engine/stage-assembler.ts`

### 4. Manifest auditability is now persisted and inspectable

- Added durable per-stage manifest persistence under:
  - `.nax/features/<feature>/stories/<story>/context-manifest-<stage>.json`
- Added manifest discovery helpers.
- Added CLI support via `nax context inspect <storyId>`.

Key files:

- `src/context/engine/manifest-store.ts`
- `src/cli/context.ts`
- `src/cli/index.ts`
- `bin/nax.ts`

## Verification

Commands run:

```bash
bun run typecheck
bun test test/unit/agents/acp/adapter-session.test.ts test/unit/context/engine/providers/session-scratch.test.ts test/unit/context/engine/manifest-store.test.ts test/unit/session/manager.test.ts test/unit/context/engine/orchestrator.test.ts test/unit/pipeline/stages/context-digest.test.ts --timeout=30000
```

Result:

- `typecheck`: passed
- targeted tests: `119 passed, 0 failed`

## Residual Notes

- Review runners synthesize a minimal `UserStory` shape for `query_feature_context` pull-tool calls because review inputs use the narrower `SemanticStory` type.
- Session-manager-backed scratch aggregation is now active for normal story execution; contexts constructed outside the main story pipeline still fall back gracefully to direct scratch-dir usage when no manager is present.
