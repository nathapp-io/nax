# SPEC: Semantic Review Session Continuity

## Summary

Make the implementer session name consistent across all four execution strategies (`no-test`, `test-after`, `three-session-tdd-lite`, `three-session-tdd`) and keep that session open through the review stage so the reviewer resumes it as a continuation. The reviewer inherits full implementation context — code written, commands run, design decisions — without re-reading from a diff.

This applies to both code paths:
- **Non-debate:** the semantic reviewer replaces the current isolated `agent.complete()` call with `agent.run()` that resumes the implementer session.
- **Debate (`synthesis`/`custom` resolver):** the resolver — the single LLM entity that renders the final verdict — resumes the implementer session. Individual debaters run in isolation against the diff only. `majority` resolver type has no LLM call and is not affected.

## Motivation

Three problems today:

1. **Inconsistent session naming.** TDD strategies pass `sessionRole: "implementer"` to `agent.run()`, producing `nax-<hash>-<feature>-<storyId>-implementer`. Single-session strategies (`no-test`, `test-after`) pass no role, producing `nax-<hash>-<feature>-<storyId>`. Semantic review cannot reliably target the implementer session because the name differs by strategy.

2. **Semantic review runs blind.** `semantic.ts:473` calls `agent.complete()` with a hardcoded session name `nax-semantic-${story.id}` — bypassing `buildSessionName()` entirely, no `featureName`, no `workdir` hash. A fresh isolated session is opened with zero knowledge of what the implementer wrote. The reviewer works only from a git diff and cannot ask clarifying questions, check rationale, or look at adjacent code the implementer already read.

3. **Debate path has the same blind-reviewer problem and an additional bug.** The debate branch at `semantic.ts:382` passes `featureName: story.id` — the story ID is used as the feature name, which is wrong. The debate resolver (`synthesis`/`custom` type) also runs blind: it synthesizes N debater proposals without knowing what the implementer actually did. The resolver IS the single LLM entity making the final verdict — it needs the same implementer context as the non-debate reviewer.

   The TDD implementer session already supports `keepSessionOpen: true` ([session-runner.ts:171](src/tdd/session-runner.ts#L171)) for rectification reuse. The same mechanism can keep it open through review, eliminating the blind-reviewer problem.

## Design

### Existing Types to Extend

- `agent.run()` options in `src/agents/types.ts` — already has `keepSessionOpen?: boolean` and `sessionRole?: string`
- `runSemanticReview()` in `src/review/semantic.ts` — add `featureName` param, replace `complete()` with `run()`
- `src/pipeline/stages/execution.ts` — add `sessionRole: "implementer"` and conditional `keepSessionOpen`
- `src/tdd/session-runner.ts:171` — extend `keepSessionOpen` condition to cover review stage, not just rectification

### Integration Points

- `src/pipeline/stages/execution.ts:251-275` — the single-session `agent.run()` call; add `sessionRole: "implementer"` and `keepSessionOpen: true` when review is enabled
- `src/tdd/session-runner.ts:171` — extend `keepSessionOpen` to also cover `config.review.enabled` (not just rectification)
- `src/review/semantic.ts:472-478` — replace `agent.complete()` with `agent.run()` using `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")`
- `src/review/semantic.ts:382-393` — fix `featureName: story.id` bug in debate path (story.id is not the feature name); pass correct `featureName`
- `src/review/runner.ts` — pass `featureName` into `runSemanticReview()` (currently missing)
- `src/pipeline/stages/review.ts` — pass `ctx.prd.feature` as `featureName` to the review runner
- `src/debate/session-helpers.ts:176-235` — extend `resolveOutcome()` to accept `workdir` and `featureName`; pass `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` to `synthesis` and `custom` resolver calls

### Existing Patterns to Follow

- `src/tdd/rectification-gate.ts:152` — `buildSessionName(workdir, featureName, story.id, "implementer")` to resume implementer session in rectification (exact pattern to replicate for semantic review)
- `src/tdd/session-runner.ts:167-171` — `keepSessionOpen` conditional pattern
- `src/pipeline/stages/autofix.ts:301` — `sessionRole: "implementer"` in autofix rectification (already consistent with TDD)

### Session Name After This Spec

All strategies produce the same implementer session name:

```
nax-<hash8>-<feature>-<storyId>-implementer
```

| Stage | Session name | keepSessionOpen |
|:------|:-------------|:----------------|
| Execution (all strategies) | `nax-<hash>-<feature>-<storyId>-implementer` | `true` |
| Verify | separate session or stateless | — |
| Rectify (TDD) | `nax-<hash>-<feature>-<storyId>-implementer` | `true` |
| Review — semantic (non-debate) | resumes `nax-<hash>-<feature>-<storyId>-implementer` | `false` (last user) |
| Review — debate resolver (`synthesis`/`custom`) | resumes `nax-<hash>-<feature>-<storyId>-implementer` | `false` (last user) |
| Review — debate debaters | own session per debater (`debate-review-N`) | `false` |
| Review — debate resolver (`majority`) | no LLM call — not applicable | — |
| Autofix rectification | `nax-<hash>-<feature>-<storyId>-implementer` | per attempt |
| Completion | — | session closed |

### Approach

The semantic reviewer resumes the implementer's ACP session by passing `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` directly to `agent.run()`. The ACP adapter's `ensureAcpSession()` will resume the open session rather than create a new one. The reviewer runs its verification prompt as a new turn in that session — it sees the implementer's full conversation history, file reads, and reasoning.

When semantic review is the last consumer of the session (no autofix needed), it closes the session naturally (`keepSessionOpen` defaults to `false`). When autofix follows, the session stays open through review and autofix closes it on the final attempt.

### Failure Handling

- **Session not found (strategy mismatch or session expired):** `ensureAcpSession()` falls back to creating a new session. Semantic review runs without implementation context — same as current behavior (fail-open, no regression).
- **`keepSessionOpen` not respected by adapter:** The session closes after execution. Semantic review falls back to a new session (same fail-open as above).
- **`featureName` missing on review call:** `buildSessionName()` omits the feature segment — session name won't match. Guard with `featureName ?? ""` and log a warning when empty.
- **Debate mode enabled:** When `config.debate.stages.review.enabled` is true, semantic review uses `DebateSession`. This story (US-003) only changes the non-debate path. Debate resolver integration is covered in US-004.

## Stories

### US-001: Normalize Implementer Session Role in Execution Stage

**Dependencies:** none
**Complexity:** simple

Add `sessionRole: "implementer"` and `keepSessionOpen: true` to the single-session `agent.run()` call in `execution.ts` so no-test and test-after produce the same session name as TDD strategies.

#### Context Files
- `src/pipeline/stages/execution.ts:251-275` — the single-session `agent.run()` call to update
- `src/tdd/session-runner.ts:167-171` — the TDD `keepSessionOpen` pattern to replicate
- `src/tdd/rectification-gate.ts:150-152` — shows how `buildSessionName(..., "implementer")` is used to resume the session in rectification
- `src/agents/types.ts:90-100` — `RunOptions` interface (`sessionRole`, `keepSessionOpen`)

#### Acceptance Criteria
- `execution.ts` passes `sessionRole: "implementer"` to `agent.run()` for all test strategies it handles (`no-test`, `test-after`)
- `execution.ts` passes `keepSessionOpen: true` when `ctx.config.review.enabled` is `true` or `ctx.config.execution.rectification?.enabled` is `true`
- When both review and rectification are disabled, `keepSessionOpen` is `false` (no dangling sessions)
- `buildSessionName(storyWorkdir, ctx.prd.feature, ctx.story.id, "implementer")` resolves to the same name that autofix uses at `autofix.ts:301` for the same story
- TDD strategies (`three-session-tdd`, `three-session-tdd-lite`) are not modified — they already pass `sessionRole: "implementer"` via `session-runner.ts:191`

### US-002: Pass `featureName` Through Semantic Review Call Chain and Fix Debate Path Bug

**Dependencies:** none
**Complexity:** simple

Thread `featureName` from `PipelineContext` through the review runner into `runSemanticReview()` so `buildSessionName()` can construct the correct implementer session name. Also fix the hardcoded `nax-semantic-${story.id}` session name and the `featureName: story.id` bug in the debate path (`semantic.ts:393`), where the story ID is incorrectly passed as the feature name.

#### Context Files
- `src/review/semantic.ts:472-478` — the `agent.complete()` call with hardcoded session name to fix
- `src/review/semantic.ts:382-393` — the debate branch with `featureName: story.id` bug to fix
- `src/review/runner.ts:255-285` — where `runSemanticReview()` is called (check which params are passed)
- `src/pipeline/stages/review.ts` — where `ctx.prd.feature` is available to forward
- `src/agents/acp/adapter.ts:184-202` — `buildSessionName()` function

#### Acceptance Criteria
- `runSemanticReview()` signature adds `featureName?: string` parameter
- The `complete()` call's `sessionName` changes from `\`nax-semantic-${story.id}\`` to `buildSessionName(workdir, featureName, story.id, "semantic")`
- The debate branch at `semantic.ts:393` changes `featureName: story.id` to `featureName: featureName ?? ""`
- `reviewStage.execute()` passes `ctx.prd.feature` as `featureName` to the review runner
- When `featureName` is undefined or empty, `buildSessionName()` is still called (omits the feature segment) and a `debug` log is emitted: `"featureName missing — semantic session name will not include feature"`
- The session name `nax-semantic-${story.id}` no longer appears anywhere in the codebase
- The literal `story.id` no longer appears as the `featureName` argument in the debate branch

### US-003: Semantic Review Resumes Implementer Session

**Dependencies:** US-001, US-002
**Complexity:** medium

Replace `agent.complete()` in semantic review with `agent.run()` that targets the implementer session by name. The reviewer inherits the implementer's full session context.

#### Context Files
- `src/review/semantic.ts:469-490` — the `agent.complete()` call to replace with `agent.run()`
- `src/tdd/rectification-gate.ts:150-207` — exact pattern for resuming implementer session via `buildSessionName(..., "implementer")` + `agent.run()`
- `src/pipeline/stages/autofix.ts:285-305` — autofix `agent.run()` call with `sessionRole: "implementer"` (parallel pattern)
- `src/agents/acp/adapter.ts:208-230` — `ensureAcpSession()` which resumes an existing session or creates a new one
- `src/review/runner.ts` — where `runSemanticReview()` is invoked, to pass `workdir` and `featureName`

#### Acceptance Criteria
- `runSemanticReview()` calls `agent.run()` with `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` instead of `agent.complete()` with a hardcoded session name
- The `agent.run()` call passes `keepSessionOpen: false` (semantic review is the last consumer; autofix will open its own turn if needed)
- `runSemanticReview()` receives `workdir` as a required parameter (was already present) and `featureName` from US-002
- When `ensureAcpSession()` cannot find the implementer session (e.g., session expired or strategy mismatch), `agent.run()` creates a new session — semantic review continues without implementation context and logs at `debug` level: `"implementer session not found — semantic review running in new session"`
- The debate path (`reviewDebateEnabled` branch at `semantic.ts:382`) is not modified by this story — it continues using `DebateSession` unchanged (covered by US-004)
- Semantic review result shape (`ReviewCheckResult`) is unchanged — callers are unaffected

### US-004: Debate Resolver Resumes Implementer Session

**Dependencies:** US-001, US-002
**Complexity:** medium

The debate resolver (`synthesis` and `custom` resolver types) is the single LLM entity that renders the final verdict in debate mode. It is architecturally equivalent to the non-debate semantic reviewer: both are the sole authority on pass/fail. Extend `resolveOutcome()` to pass `workdir` and `featureName` so the resolver can resume the implementer session before synthesizing debater proposals into a verdict.

`majority` resolver type performs pure vote counting — no LLM call — and is not affected by this story.

#### Context Files
- `src/debate/session-helpers.ts:176-235` — `resolveOutcome()` function; extend signature with `workdir` and `featureName`, pass `acpSessionName` to `synthesisResolver()` and `judgeResolver()`
- `src/debate/session-stateful.ts:267-276` — call site of `resolveOutcome()`; passes `ctx.storyId`, `ctx.config`, `ctx.stageConfig` — extend to pass `ctx.workdir` and `ctx.featureName`
- `src/debate/types.ts` — `StatefulCtx` type; add `workdir` and `featureName` fields (both optional)
- `src/review/semantic.ts:382-393` — debate branch that creates `DebateSession`; already has `workdir` and the corrected `featureName` from US-002 — verify these are forwarded into `StatefulCtx`
- `src/tdd/rectification-gate.ts:150-152` — `buildSessionName(..., "implementer")` pattern to replicate in resolver
- `src/agents/acp/adapter.ts:208-230` — `ensureAcpSession()` resumes open session or creates new (fail-open)

#### Acceptance Criteria
- `resolveOutcome()` signature adds `workdir?: string` and `featureName?: string` parameters
- `StatefulCtx` adds `workdir?: string` and `featureName?: string` fields
- `synthesisResolver()` receives `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` in its `completeOptions` when `workdir` is defined
- `judgeResolver()` receives `acpSessionName: buildSessionName(workdir, featureName, storyId, "implementer")` in its `completeOptions` when `workdir` is defined
- `majority` resolver type is not modified — it performs no LLM call
- The resolver uses `keepSessionOpen: false` (it is the last consumer; no subsequent stage resumes this session)
- When `ensureAcpSession()` cannot find the implementer session (session expired or strategy mismatch), the resolver creates a new session — debate continues without implementation context and logs at `debug` level: `"implementer session not found — debate resolver running in new session"`
- Individual debaters are not modified — they continue to operate against the diff in their own per-debater sessions
- When `resolveOutcome()` is called with `workdir` defined but resolver type is `majority`, emit a `warn` log: `"majority resolver does not support implementer session resumption — switch to synthesis or custom resolver for context-aware semantic review"` and proceed with vote counting unchanged
- `DebateResult` shape is unchanged — callers are unaffected
