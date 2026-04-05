# SPEC: Acceptance Bridge — Closing the Test↔Implementer↔Semantic Gap

## Summary

Bridge the three isolated AC verification systems — test generator, implementer, and semantic reviewer — so they share context instead of operating blind. Today, acceptance tests persistently fail even when the implementation is correct because: (a) the implementer never sees the generated test file, (b) test regeneration ignores the existing implementation, and (c) semantic review verdicts confirming AC correctness are garbage-collected before acceptance tests run. This spec introduces context sharing at each boundary to eliminate wasted fix retries on correct code.

Addresses GAP 1–9 from `SPEC-acceptance-gap-analysis.md`.

## Motivation

The acceptance pipeline has two fundamental disconnects:

1. **Test generator ↔ Implementer blindness.** The test generator runs pre-implementation and guesses the API surface. The implementer never sees the generated test. When they make different design choices (different function names, module paths), the test fails on import — not because the feature is wrong, but because the test assumed a different API.

2. **Semantic review ↔ Acceptance test isolation.** Semantic review (pipeline stage 10) validates each AC against the implementation diff per-story. When it passes, the LLM has confirmed the ACs are satisfied. But `iteration-runner.ts:133` garbage-collects `ctx.reviewResult` after each story. When acceptance tests then fail on a semantically-verified implementation, the system defaults to `verdict: "source_bug"` and wastes retries trying to fix correct code — the most expensive failure mode.

## Design

### Existing Types to Extend

- `PipelineContext` in `src/pipeline/types.ts` — already has `acceptanceTestPaths`, `reviewResult`, `reviewFindings`
- `GenerateFromPRDOptions` in `src/acceptance/generator.ts` — add `implementationContext` and `previousFailure` fields
- `DiagnoseOptions` in `src/acceptance/fix-diagnosis.ts` — add `semanticVerdicts` field
- `PromptBuilder` in `src/prompts/builder.ts` — add `acceptanceContext()` method
- `ExecuteSourceFixOptions` in `src/acceptance/fix-executor.ts` — add `testFileContent` field

### Integration Points

- `src/pipeline/stages/prompt.ts` → reads `ctx.acceptanceTestPaths`, loads content, passes to `builder.acceptanceContext()`
- `src/pipeline/stages/completion.ts` → after `markStoryPassed()`, persists semantic verdict from `ctx.reviewResult` before GC
- `src/execution/lifecycle/acceptance-loop.ts` → loads semantic verdicts before fix routing; short-circuits to `"test_bug"` when all verdicts passed
- `src/acceptance/fix-diagnosis.ts` → receives semantic verdicts in diagnosis prompt when available

### New File Format: Semantic Verdict

Written to `<featureDir>/semantic-verdicts/<storyId>.json`:

```json
{
  "storyId": "US-001",
  "passed": true,
  "timestamp": "2026-04-05T10:30:00.000Z",
  "acCount": 5,
  "findings": []
}
```

When semantic review fails:

```json
{
  "storyId": "US-002",
  "passed": false,
  "timestamp": "2026-04-05T10:31:00.000Z",
  "acCount": 4,
  "findings": [
    {
      "severity": "error",
      "file": "src/cache/index.ts",
      "line": 42,
      "issue": "AC-3: TTL expiry not implemented",
      "suggestion": "Add setTimeout-based expiry in set()"
    }
  ]
}
```

### New Type: SemanticVerdict

```typescript
// src/acceptance/types.ts
import type { ReviewFinding } from "../plugins/types";

interface SemanticVerdict {
  storyId: string;
  passed: boolean;
  timestamp: string;
  acCount: number;
  findings: ReviewFinding[];
}
```

### Approach

1. **Acceptance prompt injection** — `buildAcceptanceSection()` renders test file content as a markdown section in the implementer's prompt. The implementer sees exact import paths, function signatures, and assertions.
2. **Implementation-aware regeneration** — when regenerating tests post-failure, collect changed files via `git diff --name-only`, read their content, and pass as `implementationContext` to the generator. The generator writes tests against the real API surface instead of guessing.
3. **Semantic verdict persistence** — `completion.ts` reads `ctx.reviewResult.checks` for the semantic check and writes a lightweight JSON file per story before the GC in `iteration-runner.ts:133` nulls it.
4. **Diagnosis short-circuit** — when all semantic verdicts passed, skip the LLM diagnosis call and route directly to test regeneration with `verdict: "test_bug"`, `confidence: 1.0`.

### Relationship to SPEC-reviewer-implementer-dialogue

`SPEC-reviewer-implementer-dialogue.md` proposes a persistent `ReviewerSession` that keeps the semantic reviewer alive for the story's lifetime — enabling re-review with context and a clarification channel between reviewer and implementer. That spec addresses the deeper root cause (semantic review uses `complete()` which cannot verify findings with tools), while this spec addresses the immediate symptom (verdicts are lost before the acceptance loop).

**Designed to upgrade:** US-003 (verdict persistence) writes verdicts by extracting from `ctx.reviewResult.checks` — a file-based approach that works today without session changes. When `SPEC-reviewer-implementer-dialogue` lands, `persistSemanticVerdict()` can be swapped to read from `reviewerSession.getVerdict()` instead. The `SemanticVerdict` type and `loadSemanticVerdicts()` consumer remain unchanged — only the producer changes.

**Note on the dialogue spec:** The dialogue spec's current design assumes `complete()` with `sessionName` reuse maintains conversation context. This is incorrect — `src/agents/acp/adapter.ts:974-975` closes the ACP session in the `finally` block after every `complete()` call. The dialogue spec should be updated to use `agent.run()` for true session persistence before implementation.

### Failure Handling

- **Test file read failure** — if acceptance test content can't be read for the prompt, log a debug warning and proceed without the section. The implementer still gets ACs as text (graceful degradation, fail-open).
- **Implementation context too large** — cap at 50KB total. Prioritize files mentioned in test imports. If over limit, truncate with `[truncated — full file at <path>]`.
- **Semantic verdict read failure** — if verdict files can't be read or parsed, return empty array. All callers fall back to current behavior (fail-open).
- **No `ctx.acceptanceTestPaths`** — fall back to legacy single-file path `path.join(ctx.featureDir, config.acceptance.testPath)`. Zero behavioral change when acceptance-setup hasn't run.
- **No semantic verdict files** — all functions fall back to current behavior. Backward compatible with disabled semantic review, first runs, or pre-upgrade code.

## Stories

### US-001: Acceptance Context in Implementer Prompt

**Dependencies:** none
**Complexity:** medium

Add `buildAcceptanceSection()` to prompt builder and wire `promptStage` to inject acceptance test content into the implementer's prompt. Also fix per-package test path resolution in `acceptance-loop.ts` (replaces hardcoded `acceptance.test.ts`).

#### Context Files
- `src/prompts/builder.ts` — existing `PromptBuilder` class to extend
- `src/prompts/sections/` — existing prompt section pattern to follow (e.g., `context.ts`, `story.ts`)
- `src/pipeline/stages/prompt.ts` — where `builder.build()` is called
- `src/execution/lifecycle/acceptance-loop.ts` — `loadAcceptanceTestContent()`, `runFixRouting()`, `generateAndAddFixStories()` use hardcoded paths

#### Acceptance Criteria
- `buildAcceptanceSection([{ testPath: "test.ts", content: "import { foo }..." }])` returns a markdown string containing the test file path as a heading and content in a fenced TypeScript code block
- `PromptBuilder.acceptanceContext()` stores test path entries and `build()` includes the acceptance section after the story section
- When `acceptanceContext()` is not called, `build()` output is identical to current behavior
- When total test content exceeds 50KB, `buildAcceptanceSection()` truncates with `[truncated — full file at <path>]` note
- `promptStage.execute()` reads each file in `ctx.acceptanceTestPaths` and calls `builder.acceptanceContext()` with `{ testPath, content }` pairs
- When `ctx.acceptanceTestPaths` is undefined or empty, `promptStage` does not call `acceptanceContext()`
- When a test file in `ctx.acceptanceTestPaths` does not exist on disk, it is skipped with a debug log
- `loadAcceptanceTestContent()` in `acceptance-loop.ts` accepts an optional `testPaths` array parameter and returns content from all per-package test files
- `runFixRouting()` uses `ctx.acceptanceTestPaths` to load test content, falling back to `path.join(ctx.featureDir, config.acceptance.testPath)` when undefined

### US-002: Implementation-Aware Test Regeneration + Enriched Fix Prompts

**Dependencies:** none
**Complexity:** medium

When regenerating acceptance tests after failure, pass the existing implementation as context. Also enrich fix executor prompts with test file content so the fix agent knows what the test asserts.

#### Context Files
- `src/acceptance/generator.ts` — `generateFromPRD()` and `GenerateFromPRDOptions`
- `src/acceptance/fix-executor.ts` — `buildSourceFixPrompt()` and `ExecuteSourceFixOptions`
- `src/execution/lifecycle/acceptance-loop.ts` — `regenerateAcceptanceTest()`, `executeFixStory()`

#### Acceptance Criteria
- `GenerateFromPRDOptions` has an optional `implementationContext` field of type `Array<{ path: string; content: string }>`
- When `implementationContext` is provided, `generateFromPRD()` prompt includes an "Implementation (already exists)" section listing actual file paths and content, and instructs the LLM to "write tests against these actual modules" instead of "explore the project"
- When `implementationContext` is empty or not provided, the generator prompt is identical to current behavior
- `GenerateFromPRDOptions` has an optional `previousFailure` field; when provided, the prompt includes "Previous test failed because: ..." context
- `regenerateAcceptanceTest()` collects changed files via `git diff --name-only` against the story git ref, reads their content (capped at 50KB total), and passes them as `implementationContext`
- `buildSourceFixPrompt()` includes test file content as a fenced code block in the prompt, not just the file path
- When test file content is empty or unavailable, `buildSourceFixPrompt()` includes only the path (current behavior)
- `executeFixStory()` sets `fixContext.acceptanceTestPaths = ctx.acceptanceTestPaths` when available

### US-003: Semantic Verdict Persistence

**Dependencies:** none
**Complexity:** simple

Persist per-story semantic review verdicts to `<featureDir>/semantic-verdicts/` so they survive the GC in `iteration-runner.ts:133` and are available to the acceptance loop.

#### Context Files
- `src/pipeline/stages/completion.ts` — `markStoryPassed()` loop where verdict is persisted
- `src/pipeline/stages/review.ts` — where `ctx.reviewResult` is set (line 67)
- `src/execution/iteration-runner.ts` — GC at line 133 (`ctx.reviewResult = undefined`)
- `src/review/types.ts` — `ReviewCheckResult` shape with `check`, `success`, `findings`
- `src/acceptance/types.ts` — where `SemanticVerdict` type will be added

#### Acceptance Criteria
- `persistSemanticVerdict(featureDir, storyId, verdict)` writes a JSON file to `<featureDir>/semantic-verdicts/<storyId>.json` matching the `SemanticVerdict` schema
- `completion.ts` reads `ctx.reviewResult.checks` for the entry where `check === "semantic"` and calls `persistSemanticVerdict()` after `markStoryPassed()`
- When semantic check has `success: true`, the verdict file has `passed: true` and `findings: []`
- When semantic check has `success: false`, the verdict file has `passed: false` and the `findings` array from the check result
- When `ctx.reviewResult` is undefined or has no semantic check entry, no verdict file is written
- `loadSemanticVerdicts(featureDir)` reads all `*.json` files from `<featureDir>/semantic-verdicts/`, parses them as `SemanticVerdict[]`, and returns an empty array when the directory does not exist
- Verdict files are deleted when `acceptance-setup` regenerates tests (fingerprint mismatch), preventing stale verdicts from influencing a fresh run

### US-004: Semantic-Aware Diagnosis Routing

**Dependencies:** US-003
**Complexity:** medium

Use persisted semantic verdicts to short-circuit acceptance diagnosis when semantic review already confirmed ACs are correctly implemented.

#### Context Files
- `src/execution/lifecycle/acceptance-loop.ts` — `runAcceptanceLoop()`, `runFixRouting()`, `isTestLevelFailure()`
- `src/acceptance/fix-diagnosis.ts` — `diagnoseAcceptanceFailure()`, `buildDiagnosisPrompt()`
- `src/acceptance/types.ts` — `DiagnosisResult` with `verdict`, `confidence`, `reasoning`

#### Acceptance Criteria
- `runAcceptanceLoop()` calls `loadSemanticVerdicts(ctx.featureDir)` before entering the fix routing path
- When all loaded verdicts have `passed: true`, `runFixRouting()` skips the `diagnoseAcceptanceFailure()` LLM call and uses `{ verdict: "test_bug", confidence: 1.0, reasoning: "Semantic review confirmed all ACs are implemented — acceptance test failure is a test generation issue" }`
- When some (but not all) verdicts have `passed: true`, `buildDiagnosisPrompt()` appends: "Semantic review already confirmed these ACs are correctly implemented: [story IDs]. If the acceptance test for a confirmed AC fails, the failure is likely in the test, not the source."
- `isTestLevelFailure(failedACs, totalACs, semanticVerdicts?)` returns `true` when all semantic verdicts passed AND `failedACs.length > 0`, regardless of failure count (overrides the 80% threshold)
- When `semanticVerdicts` is undefined or empty, `isTestLevelFailure()` uses the existing `failedACs.length / totalACs > 0.8` heuristic (backward compatible)
- When no semantic verdict files exist, all functions fall back to current behavior
- Semantic short-circuit is logged: `logger.info("acceptance", "All semantic verdicts passed — routing to test regeneration", { verdictCount })`
