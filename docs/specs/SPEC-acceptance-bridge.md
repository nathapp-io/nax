# SPEC: Acceptance Bridge — Closing the Test↔Implementer Gap

## Summary

Close the critical gap where the acceptance test generator and the implementing agent operate in mutual blindness. Introduce an "acceptance bridge" that: (1) feeds acceptance test paths and content into the implementer's prompt, (2) regenerates tests using actual implementation when retrying, (3) fixes hardcoded paths in the acceptance loop, and (4) enriches fix prompts with test content.

Addresses GAP 1–7 from `SPEC-acceptance-gap-analysis.md`.

## Motivation

Today, acceptance tests persistently fail even when the feature is correctly implemented because:

1. **The implementer never sees the acceptance test file** (GAP 2, Critical). The agent builds whatever API shape makes sense from the AC text, unaware that `acceptance.test.ts` imports `{ foo } from "../src/bar"`. When the agent names the function `handleFoo` or puts it in `src/baz.ts`, the test fails on import.

2. **The test generator runs before implementation exists** (GAP 1). It guesses the API surface. When the implementer makes different design choices, the test is structurally incompatible.

3. **Test regeneration ignores the existing implementation** (GAP 5). When a test-level failure triggers regeneration, the same blind prompt runs again — producing the same bad test. The implementation now exists but isn't used.

4. **Fix prompts lack test content** (GAP 4). The fix executor tells the agent "fix the source" but doesn't include what the test actually asserts.

5. **Hardcoded `acceptance.test.ts` path** (GAP 6). The acceptance loop uses a fixed filename instead of per-package paths from `ctx.acceptanceTestPaths`.

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
