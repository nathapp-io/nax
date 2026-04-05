# SPEC: Acceptance Bridge — Closing the Test↔Implementer Gap

## Summary

Close the critical gaps where (a) the acceptance test generator and the implementing agent operate in mutual blindness, and (b) semantic review verdicts — which already confirm AC implementation correctness — are discarded before acceptance tests run. Introduce an "acceptance bridge" that: (1) feeds acceptance test paths and content into the implementer's prompt, (2) regenerates tests using actual implementation when retrying, (3) fixes hardcoded paths in the acceptance loop, (4) enriches fix prompts with test content, (5) persists semantic review verdicts so they survive to the acceptance loop, and (6) uses semantic pass signals to short-circuit diagnosis routing when the LLM already confirmed ACs are correctly implemented.

Addresses GAP 1–9 from `SPEC-acceptance-gap-analysis.md`.

## Motivation

Today, acceptance tests persistently fail even when the feature is correctly implemented because:

1. **The implementer never sees the acceptance test file** (GAP 2, Critical). The agent builds whatever API shape makes sense from the AC text, unaware that `acceptance.test.ts` imports `{ foo } from "../src/bar"`. When the agent names the function `handleFoo` or puts it in `src/baz.ts`, the test fails on import.

2. **The test generator runs before implementation exists** (GAP 1). It guesses the API surface. When the implementer makes different design choices, the test is structurally incompatible.

3. **Test regeneration ignores the existing implementation** (GAP 5). When a test-level failure triggers regeneration, the same blind prompt runs again — producing the same bad test. The implementation now exists but isn't used.

4. **Fix prompts lack test content** (GAP 4). The fix executor tells the agent "fix the source" but doesn't include what the test actually asserts.

5. **Hardcoded `acceptance.test.ts` path** (GAP 6). The acceptance loop uses a fixed filename instead of per-package paths from `ctx.acceptanceTestPaths`.

6. **Semantic review verdicts are garbage-collected** (GAP 8, Critical). Semantic review (pipeline stage 10) validates each AC against the implementation diff per-story. When it passes, the LLM has confirmed the ACs are satisfied. But `iteration-runner.ts:133` sets `ctx.reviewResult = undefined` after each story (heap cleanup), and the acceptance loop has zero access to semantic results. When acceptance tests then fail on a semantically-verified implementation, the system defaults to "source_bug" and wastes retries fixing correct code.

7. **No semantic-aware diagnosis routing** (GAP 9). The diagnosis prompt has no information about whether semantic review already confirmed the ACs. `isTestLevelFailure()` only triggers at >80% AC failure rate. If semantic passed and 3/5 ACs fail due to test import errors (60%), the system tries to fix correct source code instead of regenerating the test.

## Design

### 1. Acceptance Context in Implementer Prompt (GAP 2)

Add an `acceptanceContext` method to `PromptBuilder` that injects acceptance test content into the implementer's prompt.

```typescript
// src/prompts/builder.ts
class PromptBuilder {
  // ... existing methods

  /** Inject acceptance test file content into the prompt */
  acceptanceContext(testPaths: Array<{ testPath: string; content: string }>): PromptBuilder;
}
```

New prompt section in `src/prompts/sections/acceptance.ts`:

```typescript
export function buildAcceptanceSection(
  testPaths: Array<{ testPath: string; content: string }>
): string;
```

The section renders as:

```markdown
# Acceptance Tests (pre-generated — your code must satisfy these)

The following acceptance test file(s) have been generated from the acceptance criteria.
Your implementation MUST be compatible with these tests — match the import paths,
function signatures, and module structure they expect.

## File: .nax/features/<feature>/.nax-acceptance.test.ts

```typescript
import { createCache } from "../../../src/cache";
// ... test content
```

**Key constraints from these tests:**
- Imports resolve from the test file location (3 levels up = package root)
- Function names and signatures must match exactly
- Module exports must be accessible from the paths used in imports
```

**Integration point:** `src/pipeline/stages/prompt.ts` reads `ctx.acceptanceTestPaths`, loads file content, and passes to `builder.acceptanceContext()`.

```typescript
// src/pipeline/stages/prompt.ts — in execute()
if (ctx.acceptanceTestPaths?.length) {
  const testContents = await loadAcceptanceTestContents(ctx.acceptanceTestPaths);
  builder.acceptanceContext(testContents);
}
```

### 2. Implementation-Aware Test Regeneration (GAP 1 + GAP 5)

When regenerating acceptance tests after a failure, pass the existing implementation as context so the generator can write tests against the real API surface.

```typescript
// src/acceptance/generator.ts — add to GenerateFromPRDOptions
interface GenerateFromPRDOptions {
  // ... existing fields
  /** Existing implementation file paths + content for post-implementation regeneration */
  implementationContext?: Array<{ path: string; content: string }>;
  /** Previous test failure output (for regeneration after failure) */
  previousFailure?: string;
}
```

When `implementationContext` is provided, the generator prompt changes from "explore the project and guess the API" to:

```markdown
## Implementation (already exists — write tests against this API)

The feature has already been implemented. Write acceptance tests that import
from these actual modules:

### src/cache/index.ts
```typescript
export function createCache(options: CacheOptions): Cache { ... }
export interface CacheOptions { ttl: number; maxSize: number; }
```

Write tests that import directly from these paths. Do NOT guess different
function names or module locations.
```

**Integration point:** `acceptance-loop.ts` → `regenerateAcceptanceTest()` collects implementation files (from git diff) and passes them to `acceptanceSetupStage.execute()` via context.

```typescript
// src/execution/lifecycle/acceptance-loop.ts — in regenerateAcceptanceTest()
// Collect files changed in this feature (implementation exists now)
const changedFiles = await getChangedFilesWithContent(workdir, storyGitRef);
acceptanceContext.implementationContext = changedFiles;
```

### 3. Fix Per-Package Test Path Resolution (GAP 6)

Replace hardcoded `path.join(ctx.featureDir, "acceptance.test.ts")` with `ctx.acceptanceTestPaths` throughout `acceptance-loop.ts`.

```typescript
// BEFORE (broken for monorepos):
const { content, path: testPath } = await loadAcceptanceTestContent(ctx.featureDir);

// AFTER (uses per-package paths):
const testPaths = ctx.acceptanceTestPaths ?? [{
  testPath: path.join(ctx.featureDir!, config.acceptance.testPath),
  packageDir: ctx.workdir,
}];
```

Functions to update:
- `loadAcceptanceTestContent()` → accept `testPaths` array
- `generateAndAddFixStories()` → pass all test paths
- `runFixRouting()` → iterate over test paths
- `diagnoseAcceptanceFailure()` → receive actual test path

### 4. Enriched Fix Prompts (GAP 4)

Include test file content in the fix executor prompt so the fix agent knows what the test expects.

```typescript
// src/acceptance/fix-executor.ts — buildSourceFixPrompt()
function buildSourceFixPrompt(options: ExecuteSourceFixOptions): string {
  let prompt = `ACCEPTANCE TEST FAILURE:\n${options.testOutput}\n\n`;

  if (options.diagnosis.reasoning) {
    prompt += `DIAGNOSIS:\n${options.diagnosis.reasoning}\n\n`;
  }

  // NEW: Include test file content so the agent knows what to satisfy
  prompt += `ACCEPTANCE TEST FILE: ${options.acceptanceTestPath}\n\n`;
  prompt += `ACCEPTANCE TEST CONTENT:\n\`\`\`\n${options.testFileContent}\n\`\`\`\n\n`;

  prompt += "Fix the source implementation to make these tests pass. Do NOT modify the test file.";
  return prompt;
}
```

### 5. Acceptance Context Forwarding to Fix Stories (GAP 7)

Pass `acceptanceTestPaths` through to fix story pipeline context.

```typescript
// src/execution/lifecycle/acceptance-loop.ts — in executeFixStory()
const fixContext: PipelineContext = {
  // ... existing fields
  acceptanceTestPaths: ctx.acceptanceTestPaths, // NEW: forward from parent
};
```

### 6. Semantic Review Verdict Persistence & Diagnosis Short-Circuit (GAP 8 + GAP 9)

Semantic review (pipeline stage 10) already validates each AC against the implementation diff. When it passes, the LLM has confirmed the ACs are correctly implemented. But `iteration-runner.ts:133` garbage-collects `ctx.reviewResult` after each story, so the acceptance loop operates blind.

#### 6a. Persist Per-Story Semantic Verdicts

After the review stage completes (and before the GC in `iteration-runner.ts:133`), write a lightweight verdict file per story:

```typescript
// Written to: <featureDir>/semantic-verdicts/<storyId>.json
interface SemanticVerdict {
  storyId: string;
  passed: boolean;
  timestamp: string;
  acCount: number;
  findings: ReviewFinding[];  // empty when passed
}
```

**Integration point:** `src/pipeline/stages/completion.ts` — after `markStoryPassed()`, read `ctx.reviewResult` to extract the semantic check result and persist it. At this point `ctx.reviewResult` is still alive; it's only nulled in `iteration-runner.ts:133` AFTER the full pipeline completes.

```typescript
// src/pipeline/stages/completion.ts — in execute(), after markStoryPassed()
if (ctx.featureDir && ctx.reviewResult) {
  const semanticCheck = ctx.reviewResult.checks?.find(c => c.check === "semantic");
  if (semanticCheck) {
    await persistSemanticVerdict(ctx.featureDir, completedStory.id, {
      storyId: completedStory.id,
      passed: semanticCheck.success,
      timestamp: new Date().toISOString(),
      acCount: completedStory.acceptanceCriteria.length,
      findings: semanticCheck.findings ?? [],
    });
  }
}
```

#### 6b. Load Semantic Verdicts in Acceptance Loop

In `acceptance-loop.ts`, before running fix routing, load all persisted verdicts:

```typescript
// src/execution/lifecycle/acceptance-loop.ts — before fix routing
const semanticVerdicts = await loadSemanticVerdicts(ctx.featureDir);
const allSemanticPassed = semanticVerdicts.length > 0
  && semanticVerdicts.every(v => v.passed);
```

#### 6c. Semantic-Aware Diagnosis Short-Circuit

When semantic review passed for **ALL stories** and acceptance tests fail:
- Skip the LLM diagnosis call entirely
- Set verdict to `"test_bug"` with `confidence: 1.0` and reasoning: `"Semantic review confirmed all ACs are implemented — acceptance test failure is a test generation issue"`
- Route directly to test regeneration with implementation context (US-003)

When semantic review passed for **SOME stories**:
- Include semantic verdicts in the diagnosis prompt as strong prior context
- Append to diagnosis prompt: `"Semantic review already confirmed these ACs are correctly implemented: [list]. If the acceptance test for a confirmed AC fails, the failure is likely in the test, not the source."`

```typescript
// src/execution/lifecycle/acceptance-loop.ts — in runFixRouting()
if (allSemanticPassed) {
  logger?.info("acceptance", "All semantic verdicts passed — routing to test regeneration");
  const diagnosis: DiagnosisResult = {
    verdict: "test_bug",
    reasoning: "Semantic review confirmed all ACs are implemented — acceptance test failure is a test generation issue",
    confidence: 1.0,
  };
  // Route to test regeneration (skip LLM diagnosis call)
  ...
}
```

#### 6d. Smarter `isTestLevelFailure()` Heuristic

Currently `isTestLevelFailure()` triggers only at >80% AC failure rate. With semantic verdicts:

```typescript
// src/execution/lifecycle/acceptance-loop.ts
export function isTestLevelFailure(
  failedACs: string[],
  totalACs: number,
  semanticVerdicts?: SemanticVerdict[],
): boolean {
  if (failedACs.includes("AC-ERROR")) return true;

  // NEW: semantic review passed → any acceptance failure is a test-level failure
  const allSemanticPassed = semanticVerdicts?.length
    && semanticVerdicts.every(v => v.passed);
  if (allSemanticPassed && failedACs.length > 0) return true;

  if (totalACs === 0) return false;
  return failedACs.length / totalACs > 0.8;
}
```

This prevents the scenario where 3/5 ACs fail (60%) due to test import errors on a semantically-verified implementation, bypassing the heuristic and triggering source fixes on correct code.

#### 6e. Cleanup

Verdict files are cleaned up when `acceptance-setup` regenerates tests (fresh fingerprint mismatch). This ensures stale verdicts from a previous run don't influence a new run where the implementation may have changed.

### Failure Handling

- **Test file read failure:** If acceptance test content can't be read for the prompt, log a warning and proceed without the section. The implementer still gets ACs as text (current behavior — graceful degradation).
- **Implementation context too large:** Cap at 50KB total. Prioritize files with the most AC-relevant exports (heuristic: files mentioned in test imports).
- **No `ctx.acceptanceTestPaths`:** Fall back to legacy single-file path. Zero behavioral change when acceptance-setup hasn't run.

## Stories

### US-001: Acceptance Prompt Section

**Dependencies:** none  
**Complexity:** simple

Add `buildAcceptanceSection()` to `src/prompts/sections/` and wire it into `PromptBuilder`.

**Acceptance Criteria:**
- `buildAcceptanceSection([{ testPath: "test.ts", content: "import..." }])` returns a markdown section containing the test file path and content
- `PromptBuilder.acceptanceContext()` stores test paths and `build()` includes the acceptance section between the story section and isolation rules
- When `acceptanceContext()` is not called, `build()` output is unchanged (backward compatible)
- The acceptance section wraps content in USER-SUPPLIED DATA comment markers (same pattern as context markdown)
- When test content exceeds 50KB total, it is truncated with a `[truncated — full file at <path>]` note

### US-002: Prompt Stage Loads Acceptance Test Content

**Dependencies:** US-001  
**Complexity:** simple

Wire `promptStage.execute()` to read acceptance test files from `ctx.acceptanceTestPaths` and pass content to the builder.

**Acceptance Criteria:**
- When `ctx.acceptanceTestPaths` has entries, `promptStage` reads each test file and calls `builder.acceptanceContext()` with path + content pairs
- When `ctx.acceptanceTestPaths` is undefined or empty, prompt stage behavior is unchanged
- When a test file doesn't exist (e.g., deleted between stages), it is skipped with a debug log
- The resulting `ctx.prompt` includes acceptance test content between the story section and isolation rules

### US-003: Implementation-Aware Test Regeneration

**Dependencies:** none  
**Complexity:** medium

When regenerating acceptance tests in the acceptance loop, collect implementation file content from the git diff and pass it to the generator so it writes tests against the real API surface.

**Acceptance Criteria:**
- `GenerateFromPRDOptions` accepts an optional `implementationContext` field of type `Array<{ path: string; content: string }>`
- When `implementationContext` is provided, `generateFromPRD()` prompt includes an "Implementation (already exists)" section listing actual file paths and their content
- When `implementationContext` is provided, the prompt instructs the LLM to "write tests against these actual modules" instead of "explore the project"
- `regenerateAcceptanceTest()` in `acceptance-loop.ts` collects changed files via `git diff --name-only` against the story git ref, reads their content (capped at 50KB total), and passes them as `implementationContext`
- When `implementationContext` is empty or not provided, the generator prompt is unchanged (backward compatible)
- `previousFailure` field, when provided, is included in the prompt as "Previous test failed because: ..." context

### US-004: Fix Per-Package Test Paths in Acceptance Loop

**Dependencies:** none  
**Complexity:** medium

Replace all hardcoded `acceptance.test.ts` references in `acceptance-loop.ts` with `ctx.acceptanceTestPaths` resolution.

**Acceptance Criteria:**
- `loadAcceptanceTestContent()` accepts an optional `testPaths` array and returns content from all per-package test files (concatenated with path headers)
- `generateAndAddFixStories()` passes all per-package test file paths to `generateFixStories()` (not just the first)
- `runFixRouting()` iterates over `ctx.acceptanceTestPaths` to load test content for diagnosis, falling back to `path.join(ctx.featureDir, "acceptance.test.ts")` when `acceptanceTestPaths` is undefined
- `diagnoseAcceptanceFailure()` receives the actual test file path and content matching the failing package
- When `ctx.acceptanceTestPaths` is undefined, all functions fall back to the legacy single-file path (backward compatible)

### US-005: Enriched Fix Executor Prompt + Context Forwarding

**Dependencies:** US-004  
**Complexity:** simple

Include test file content in `buildSourceFixPrompt()` and forward `acceptanceTestPaths` to fix story pipeline contexts.

**Acceptance Criteria:**
- `buildSourceFixPrompt()` includes test file content in the prompt as a fenced code block, not just the file path
- `executeFixStory()` in `acceptance-loop.ts` sets `fixContext.acceptanceTestPaths = ctx.acceptanceTestPaths` when available
- When test file content is empty or unavailable, `buildSourceFixPrompt()` omits the content section and includes only the path (current behavior)
- Fix story pipeline contexts have access to acceptance test paths for prompt injection (via US-001/US-002 wiring)

### US-006: Semantic Verdict Persistence

**Dependencies:** none  
**Complexity:** simple

Persist per-story semantic review verdicts to `<featureDir>/semantic-verdicts/` so they survive the GC in `iteration-runner.ts:133` and are available to the acceptance loop.

**Acceptance Criteria:**
- After review stage completes, completion stage reads `ctx.reviewResult.checks` for the semantic check and writes a `<storyId>.json` verdict file to `<featureDir>/semantic-verdicts/`
- Verdict file contains `{storyId, passed, timestamp, acCount, findings}`
- When semantic review fails (findings with blocking severity), the verdict records `passed: false` with the findings array
- When semantic review passes, the verdict records `passed: true` with an empty findings array
- When review stage is skipped or semantic check is disabled in config, no verdict file is written
- `ctx.reviewResult` is read in `completion.ts` before the GC in `iteration-runner.ts:133` nulls it — verified by code path ordering
- Verdict files are cleaned up when `acceptance-setup` regenerates tests (fingerprint mismatch triggers fresh run)
- A `loadSemanticVerdicts(featureDir)` utility returns all verdict files as `SemanticVerdict[]`, returning an empty array when the directory doesn't exist

### US-007: Semantic-Aware Diagnosis Routing

**Dependencies:** US-006  
**Complexity:** medium

Use persisted semantic verdicts to short-circuit acceptance diagnosis when semantic review already confirmed ACs are correctly implemented.

**Acceptance Criteria:**
- `runAcceptanceLoop()` loads semantic verdicts from `<featureDir>/semantic-verdicts/` before entering the fix routing path
- When ALL semantic verdicts have `passed: true`, acceptance test failure routes directly to test regeneration with verdict `"test_bug"` (confidence 1.0) — the LLM diagnosis call in `diagnoseAcceptanceFailure()` is skipped entirely
- When SOME semantic verdicts have `passed: true`, the diagnosis prompt in `buildDiagnosisPrompt()` includes: "Semantic review already confirmed these ACs are correctly implemented: [list]. If the acceptance test for a confirmed AC fails, the failure is likely in the test, not the source."
- `isTestLevelFailure()` accepts an optional `semanticVerdicts` parameter; when all verdicts passed AND any acceptance test fails, it returns `true` regardless of failure count (overrides the 80% threshold)
- When no semantic verdict files exist (disabled, first run, pre-US-006 code), all functions fall back to current behavior (backward compatible)
- Test regeneration uses implementation context per US-003 when available
- Semantic short-circuit is logged: `logger.info("acceptance", "All semantic verdicts passed — routing to test regeneration", { storyId, verdictCount })`
