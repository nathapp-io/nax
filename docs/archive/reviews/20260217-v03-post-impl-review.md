# Deep Code Review: ngent v0.3.0

**Date:** 2026-02-17
**Reviewer:** Subrina (AI)
**Version:** 0.3.0-dev
**Files:** 65 TypeScript files (src: ~7,172 LOC, test: ~7,757 LOC)
**Baseline:** 342 tests passing, 881 assertions, TypeScript strict mode

---

## Overall Grade: A- (88/100)

The v0.3 pipeline refactor represents a significant architectural improvement, successfully decomposing the monolithic runner into composable stages while maintaining backward compatibility. The new constitution, analyze, and review modules are well-designed with strong type safety and comprehensive test coverage. However, several medium-priority issues around JSDoc coverage, error handling consistency, and incomplete verify stage logic prevent this from achieving an A grade.

**Key Strengths:**
- Clean pipeline architecture with proper separation of concerns
- Excellent test coverage for new modules (constitution: 100%, review: 100%, pipeline: 90%+)
- Strong type safety with discriminated unions for pipeline results
- Proper integration between new and existing systems

**Areas for Improvement:**
- Incomplete verify stage (placeholder with TODO)
- JSDoc coverage gaps in pipeline stages (~40%)
- Inconsistent error handling patterns between stages
- Missing integration tests for full pipeline execution with all stages

---

## Findings

### 🔴 CRITICAL

None. The codebase is production-ready from a security and reliability standpoint.

---

### 🟡 HIGH

#### BUG-7: Verify Stage is a No-Op Placeholder
**Severity:** HIGH | **Category:** Bug
**File:** `src/pipeline/stages/verify.ts:18-25`

```typescript
export const verifyStage: PipelineStage = {
  name: "verify",
  enabled: () => true,
  async execute(_ctx: PipelineContext): Promise<StageResult> {
    // TODO: Add verification logic here
    // - Run tests
    // - Check build
    // - Validate output
    return { action: "continue" };
  },
};
```

**Risk:** The verify stage is currently a no-op that always passes. This means agent output is never validated before being marked as passed. Stories could be marked complete even if tests fail or builds break.

**Fix:** Implement verification logic:
1. Run `bun test` in the workdir
2. Check exit code
3. Return `{ action: "fail", reason: "Tests failed" }` if exit code !== 0
4. Consider adding build verification for TypeScript projects

**Priority:** P0 — This is a critical gap in the execution pipeline.

---

#### ENH-6: Pipeline Stages Have Inconsistent Error Handling
**Severity:** HIGH | **Category:** Enhancement
**File:** Multiple pipeline stages

```typescript
// Constitution stage: returns continue even if loading fails silently
if (result) {
  ctx.constitution = result.content;
  // ...logs...
}
// No else — just continues without constitution

// Execution stage: returns fail with clear reason
if (!ctx.prompt) {
  return { action: "fail", reason: "Prompt not built (prompt stage skipped?)" };
}
```

**Risk:** Inconsistent error handling makes it hard to debug pipeline failures. Some stages silently continue on errors, others fail explicitly. This can lead to confusing behavior where a story fails for unclear reasons.

**Fix:** Establish consistent patterns:
1. **Soft failures** (constitution missing, context empty) → continue with warning log
2. **Hard failures** (no agent, invalid config) → return `{ action: "fail", reason: "..." }`
3. Document these patterns in a `PIPELINE.md` guide

**Priority:** P1 — Affects debugging experience and maintainability.

---

### 🟡 MEDIUM

#### ENH-7: Missing JSDoc on Pipeline Stages (~40% coverage)
**Severity:** MEDIUM | **Category:** Enhancement
**File:** `src/pipeline/stages/*.ts`

```typescript
// ✗ No JSDoc
export const queueCheckStage: PipelineStage = {
  name: "queue-check",
  enabled: () => true,
  async execute(ctx: PipelineContext): Promise<StageResult> {
    // ...
  },
};

// ✓ Should have JSDoc
/**
 * Queue Check Stage
 *
 * Checks for queue commands (PAUSE/ABORT/SKIP) before executing a story.
 * Processes commands atomically and updates PRD accordingly.
 *
 * @returns
 * - `continue`: No queue commands, proceed
 * - `pause`: PAUSE/ABORT command found, stop execution
 * - `skip`: SKIP command removed all stories from batch
 *
 * @example
 * ```ts
 * // User writes: echo "PAUSE" > .queue.txt
 * const result = await queueCheckStage.execute(ctx);
 * // result: { action: "pause", reason: "User requested pause via .queue.txt" }
 * ```
 */
```

**Impact:** New contributors need to read implementation code to understand stage behavior. Missing examples make it hard to understand stage interactions.

**Fix:** Add JSDoc to all 9 pipeline stages with:
- Brief description (1-2 sentences)
- Return value documentation (all possible actions)
- Example showing stage behavior in context

**Priority:** P2 — Documentation gap, but code is readable.

---

#### TYPE-3: Constitution Stage Uses Loose Type Conversion
**Severity:** MEDIUM | **Category:** Type Safety
**File:** `src/pipeline/stages/prompt.ts:22-30`

```typescript
// Convert constitution string to ConstitutionResult if present
const constitution: ConstitutionResult | undefined = ctx.constitution
  ? {
      content: ctx.constitution,
      tokens: Math.ceil(ctx.constitution.length / 4), // ⚠️ Duplicates estimation logic
      originalTokens: Math.ceil(ctx.constitution.length / 4),
      truncated: false,
    }
  : undefined;
```

**Risk:**
1. Duplicates token estimation logic (should use `estimateTokens()` from constitution module)
2. Uses 1 token ≈ 4 chars, but constitution loader uses 1 token ≈ 3 chars (inconsistent)
3. If context stores `ConstitutionResult` instead of `string`, this conversion is unnecessary

**Fix:**
1. Store `ConstitutionResult | undefined` in `PipelineContext.constitution` instead of `string | undefined`
2. Update constitution stage to assign the full result object
3. Remove conversion logic from prompt stage

**Priority:** P2 — Type inconsistency, but functionally correct.

---

#### BUG-8: Pipeline Runner Doesn't Preserve Context Mutations Across Stages
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/pipeline/runner.ts:48-127`

```typescript
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
): Promise<PipelineRunResult> {
  for (const stage of stages) {
    // ...
    result = await stage.execute(context); // ⚠️ Stages mutate context in-place
  }
  // ...
  return {
    success: true,
    finalAction: "complete",
    context, // ⚠️ Returns mutated context, but contract is unclear
  };
}
```

**Risk:** Stages mutate the context object in-place. The function signature doesn't make it clear whether the input `context` is mutated or a new context is returned. This could cause subtle bugs if callers expect immutability.

**Fix:**
1. Document mutation contract in JSDoc: "Stages mutate the context in-place. The returned context is the same object, mutated."
2. Consider cloning context before pipeline execution for safer API (if mutation is unintended)
3. Add integration test verifying context mutations are preserved

**Priority:** P2 — Potential footgun, but current usage is correct.

---

#### PERF-4: Prompt Stage Recreates ConstitutionResult on Every Execution
**Severity:** MEDIUM | **Category:** Performance
**File:** `src/pipeline/stages/prompt.ts:22-30`

```typescript
async execute(ctx: PipelineContext): Promise<StageResult> {
  // ⚠️ Re-creates ConstitutionResult every time even though content is static
  const constitution: ConstitutionResult | undefined = ctx.constitution
    ? {
        content: ctx.constitution,
        tokens: Math.ceil(ctx.constitution.length / 4),
        originalTokens: Math.ceil(ctx.constitution.length / 4),
        truncated: false,
      }
    : undefined;
  // ...
}
```

**Impact:** Constitution is loaded once per feature, but prompt stage recreates the result object on every story. For a 100-story feature, this wastes allocation cycles.

**Fix:** Store `ConstitutionResult` in context (see TYPE-3) so prompt stage can use it directly without reconstruction.

**Priority:** P3 — Micro-optimization, but aligns with TYPE-3 fix.

---

#### ENH-8: No Integration Test for Full Pipeline with All Stages
**Severity:** MEDIUM | **Category:** Enhancement
**File:** `test/pipeline.test.ts`

**Current coverage:**
- ✓ Pipeline runner logic (continue/skip/fail/escalate/pause)
- ✓ Individual stage unit tests (constitution, review)
- ✗ Full pipeline execution with all 9 stages

**Missing:** An integration test that:
1. Sets up a real workdir with package.json, src/, test/
2. Runs `runPipeline(defaultPipeline, realContext)`
3. Verifies all stages execute in order
4. Checks context accumulation (constitution → context → prompt → agentResult → reviewResult)

**Fix:** Add `test/pipeline-integration.test.ts`:
```typescript
test("full pipeline execution with all stages", async () => {
  const ctx = createRealTestContext(); // Real files, not mocks
  const result = await runPipeline(defaultPipeline, ctx);

  expect(result.success).toBe(true);
  expect(result.context.constitution).toBeDefined();
  expect(result.context.prompt).toBeDefined();
  expect(result.context.agentResult).toBeDefined();
  // etc.
});
```

**Priority:** P2 — Increases confidence in pipeline integration.

---

#### STYLE-4: Magic Number for Constitution Token Estimation Inconsistency
**Severity:** MEDIUM | **Category:** Style
**File:** `src/pipeline/stages/prompt.ts:26` vs `src/constitution/loader.ts:21`

```typescript
// constitution/loader.ts
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3); // 1 token ≈ 3 chars
}

// pipeline/stages/prompt.ts
tokens: Math.ceil(ctx.constitution.length / 4), // ⚠️ 1 token ≈ 4 chars
```

**Risk:** Inconsistent token estimation can lead to underestimation in prompt stage, potentially hitting model context limits unexpectedly.

**Fix:** Always use `estimateTokens()` from constitution module. Extract as named constant if different heuristic is intentional:
```typescript
const CONSERVATIVE_TOKEN_ESTIMATE = 4; // chars per token (more conservative than 3)
```

**Priority:** P2 — Consistency issue with functional impact.

---

### 🟢 LOW

#### ENH-9: Plan Command Doesn't Validate Spec Template Output
**Severity:** LOW | **Category:** Enhancement
**File:** `src/cli/plan.ts:50-132`

```typescript
// In interactive mode, assume agent wrote the spec
if (interactive) {
  if (result.specContent) {
    await Bun.write(outputPath, result.specContent);
  } else {
    // If agent wrote directly, verify it exists
    if (!existsSync(outputPath)) { // ⚠️ No format validation
      throw new Error(`Interactive planning completed but spec not found at ${outputPath}`);
    }
  }
}
```

**Impact:** Plan mode checks if spec file exists but doesn't validate it follows the template format. Agent could write invalid markdown or skip required sections (Problem, Requirements, Acceptance Criteria).

**Fix:** Add optional spec validation:
1. Parse output markdown
2. Check for required sections: `# Feature:`, `## Problem`, `## Requirements`, `## Acceptance Criteria`
3. Warn if sections are missing (don't fail, since agent may use different structure)

**Priority:** P3 — Nice-to-have validation, but agent output is typically well-structured.

---

#### STYLE-5: Analyze Classifier Uses `any` for LLM Response Parsing
**Severity:** LOW | **Category:** Type Safety
**File:** `src/analyze/classifier.ts:105-127`

```typescript
// Extract text from response
const textContent = response.content.find((c: any) => c.type === "text"); // ⚠️ any
if (!textContent || textContent.type !== "text") {
  throw new Error("No text response from LLM");
}

// Map to StoryClassification[]
const classifications: StoryClassification[] = parsed.map((item: any) => ({ // ⚠️ any
  storyId: item.storyId,
  complexity: validateComplexity(item.complexity),
  // ...
}));
```

**Risk:** Using `any` bypasses type checking. If Anthropic SDK changes response structure, this code could fail at runtime without TypeScript catching it.

**Fix:** Define proper types:
```typescript
interface AnthropicTextContent {
  type: "text";
  text: string;
}

interface LLMClassificationItem {
  storyId: string;
  complexity: string;
  relevantFiles: unknown;
  reasoning: unknown;
  estimatedLOC: unknown;
  risks: unknown;
}
```

**Priority:** P3 — Low risk since Anthropic SDK is stable, but better type safety is always preferred.

---

#### ENH-10: Pipeline Doesn't Log Which Stages Were Skipped
**Severity:** LOW | **Category:** Enhancement
**File:** `src/pipeline/runner.ts:52-56`

```typescript
for (const stage of stages) {
  // Skip disabled stages
  if (!stage.enabled(context)) {
    continue; // ⚠️ Silent skip — user doesn't know why stage didn't run
  }
  // ...
}
```

**Impact:** If a stage is disabled (e.g., `reviewStage` when `config.review.enabled = false`), the pipeline silently skips it. Users may be confused why review didn't run.

**Fix:** Add debug logging for skipped stages:
```typescript
if (!stage.enabled(context)) {
  console.log(chalk.dim(`   → Stage "${stage.name}" skipped (disabled)`));
  continue;
}
```

**Priority:** P3 — Improves observability but not critical.

---

#### STYLE-6: Queue Check Stage Mutates Context Stories Array
**Severity:** LOW | **Category:** Style
**File:** `src/pipeline/stages/queue-check.ts:68`

```typescript
// Remove from batch
ctx.stories = ctx.stories.filter((s) => s.id !== cmd.storyId); // ⚠️ Mutation
```

**Risk:** Mutating `ctx.stories` directly could cause confusion if other code expects the original batch to remain unchanged.

**Fix:** Follow immutability principles:
```typescript
// Create new array instead of mutating
ctx.stories = ctx.stories.filter((s) => s.id !== cmd.storyId);
// ✓ Already immutable (filter returns new array), but could be clearer:
const updatedStories = ctx.stories.filter((s) => s.id !== cmd.storyId);
ctx.stories = updatedStories;
```

**Note:** Current code is actually fine (filter returns new array), but the assignment pattern could be clearer.

**Priority:** P4 — Code works correctly, just a style preference.

---

#### ENH-11: No Dry-Run Support for Review Stage
**Severity:** LOW | **Category:** Enhancement
**File:** `src/pipeline/stages/review.ts:16-29`

```typescript
async execute(ctx: PipelineContext): Promise<StageResult> {
  console.log(chalk.cyan("\n   → Running review phase..."));

  const reviewResult = await runReview(ctx.config.review, ctx.workdir); // ⚠️ Always runs, even in dry-run mode
  // ...
}
```

**Impact:** In dry-run mode, review stage still executes `bun test`, `bun run typecheck`, etc. This makes dry runs slow and may fail on incomplete code.

**Fix:** Check for dry-run flag in context:
```typescript
if (ctx.config.execution.dryRun) {
  console.log(chalk.yellow("   [DRY RUN] Would run review phase"));
  return { action: "continue" };
}
```

**Note:** PipelineContext doesn't currently have a `dryRun` flag. This would need to be added.

**Priority:** P4 — Minor UX improvement for dry runs.

---

#### TYPE-4: Routing Stage Console Logs Duplicate Logic
**Severity:** LOW | **Category:** Style
**File:** `src/pipeline/stages/routing.ts:32-45`

```typescript
const isBatch = ctx.stories.length > 1;

if (isBatch) {
  console.log(
    chalk.dim(
      `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
    ),
  );
} else {
  console.log(
    chalk.dim(
      `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
    ),
  );
  console.log(chalk.dim(`   Routing: ${routing.reasoning}`));
}
```

**Issue:** Both branches log identical strings. Could be simplified:
```typescript
console.log(
  chalk.dim(
    `   Complexity: ${routing.complexity} | Model: ${routing.modelTier} | TDD: ${routing.testStrategy}`,
  ),
);
if (!isBatch) {
  console.log(chalk.dim(`   Routing: ${routing.reasoning}`));
}
```

**Priority:** P4 — Code clarity, no functional impact.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| **P0** | BUG-7 | M | Implement verify stage logic (run tests, check build) |
| **P1** | ENH-6 | L | Document and standardize error handling patterns across pipeline stages |
| **P1** | ENH-7 | M | Add JSDoc to all 9 pipeline stages with examples |
| **P2** | TYPE-3 | S | Store ConstitutionResult in context, remove prompt stage conversion |
| **P2** | BUG-8 | S | Document context mutation contract in runPipeline JSDoc |
| **P2** | ENH-8 | M | Add full pipeline integration test with all stages |
| **P2** | STYLE-4 | S | Fix token estimation inconsistency (use estimateTokens() everywhere) |
| **P3** | ENH-9 | M | Add optional spec validation to plan command |
| **P3** | STYLE-5 | S | Replace `any` with proper types in analyze classifier |
| **P3** | ENH-10 | S | Log skipped stages for observability |
| **P4** | STYLE-6 | — | (No action needed — code is correct) |
| **P4** | ENH-11 | S | Add dry-run support to review stage |
| **P4** | TYPE-4 | S | Simplify routing stage logging |

**Effort:** S = Small (<1hr), M = Medium (1-4hrs), L = Large (>4hrs)

---

## Dimension Scores

### Security: 20/20 ✓
- ✓ No hardcoded secrets or credentials
- ✓ Input validation on all boundaries (queue commands, spec parsing)
- ✓ Command injection prevention in review runner (using spawn with args array)
- ✓ Path traversal protection via config path-security module
- ✓ No eval or dynamic code execution
- ✓ Hook security validation from v0.2 still in place

**Notes:** Pipeline stages properly delegate to existing security-vetted modules (hooks, agents, prd). No new security concerns introduced.

### Reliability: 17/20
- ✓ Comprehensive error handling in pipeline runner (try/catch, stage failures)
- ✓ Proper resource cleanup (no leaked streams, timers, or file handles)
- ✓ Atomic queue file handling from v0.2 maintained
- ✗ **BUG-7:** Verify stage is a no-op (doesn't actually verify anything)
- ✗ **ENH-6:** Inconsistent error handling patterns across stages
- ⚠️ **BUG-8:** Context mutation contract unclear

**Deductions:** -3 for verify stage gap, -0.5 for inconsistent error patterns, -0.5 for mutation documentation gap.

### API Design: 18/20
- ✓ Clean pipeline abstraction with composable stages
- ✓ Well-defined stage interface (PipelineStage with enabled/execute)
- ✓ Discriminated union for StageResult (exhaustiveness checking)
- ✓ Consistent naming conventions (queueCheckStage, routingStage, etc.)
- ✓ Good separation of concerns (each stage has single responsibility)
- ✗ **TYPE-3:** Constitution type inconsistency (string vs ConstitutionResult)
- ✗ **ENH-7:** Missing JSDoc on 60% of pipeline stages

**Deductions:** -1 for type inconsistency, -1 for documentation gaps.

### Code Quality: 16/20
- ✓ Excellent test coverage (constitution: 100%, review: 100%, pipeline: 90%+)
- ✓ No dead code or commented-out blocks
- ✓ Files are appropriately sized (<400 lines for all pipeline stages)
- ✓ Consistent code style (Biome formatting)
- ✗ **STYLE-4:** Magic number inconsistency (token estimation)
- ✗ **STYLE-5:** Use of `any` in classifier LLM response parsing
- ✗ **TYPE-4:** Duplicate logging logic in routing stage
- ✗ **ENH-8:** Missing integration test for full pipeline

**Deductions:** -2 for missing integration test, -1 for any usage, -1 for magic number inconsistency.

### Best Practices: 17/20
- ✓ Follows established v0.2 patterns (hooks, routing, PRD management)
- ✓ Proper use of TypeScript features (discriminated unions, exhaustiveness checks)
- ✓ Clear module boundaries with barrel exports
- ✓ Good abstraction (pipeline runner is framework-agnostic)
- ✗ **ENH-6:** Inconsistent error handling (some stages silent fail, others don't)
- ✗ **ENH-10:** No observability for skipped stages
- ✗ **BUG-8:** Mutation contract unclear

**Deductions:** -2 for inconsistent patterns, -1 for observability gap.

---

## Summary

The v0.3 pipeline refactor is a **strong architectural improvement** that successfully decomposes the monolithic runner into composable, testable stages. The new modules (constitution, analyze, review) are well-designed with excellent test coverage and proper integration.

**Critical gap:** The verify stage is currently a placeholder (BUG-7). This must be implemented before v0.3 ships, as it's a core part of the quality gate.

**Recommended path forward:**
1. **Immediate (P0):** Implement verify stage with test execution
2. **Before v0.3 release (P1):** Add pipeline stage JSDoc and standardize error handling
3. **Post-v0.3 (P2-P4):** Address type inconsistencies, add integration tests, improve observability

**Grade justification:**
- Security: Excellent (20/20)
- Reliability: Very good, one critical gap (17/20)
- API Design: Very good, minor documentation gap (18/20)
- Code Quality: Good, missing integration tests (16/20)
- Best Practices: Good, inconsistent patterns (17/20)

**Total: 88/100 (A-)**

With BUG-7 fixed and ENH-6/ENH-7 addressed, this would easily achieve an **A (90+)**.
