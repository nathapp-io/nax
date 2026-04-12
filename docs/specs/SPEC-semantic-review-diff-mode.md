# SPEC: Semantic Review Diff Mode (REVIEW-002)

## Summary

Add a configurable `diffMode` to semantic review that controls how the reviewer accesses the git diff. Two modes:

- **`embedded`** (default, current behaviour): Pre-collect the diff, truncate to `DIFF_CAP_BYTES`, embed it in the prompt. The reviewer may miss changes beyond the truncation boundary.
- **`ref`**: Pass only the `storyGitRef` and a `--stat` summary in the prompt. The reviewer uses its tool access (`git diff`, `git log`, `READ`, `GREP`) to inspect the full diff on demand. No truncation.

Both modes also receive **attempt context** — escalation history and prior failure stages — so the reviewer understands what attempt this is.

This is behind a config flag so the two approaches can be compared on real runs before committing to one.

## Motivation

### Problem 1: Diff truncation on escalated stories

`DIFF_CAP_BYTES = 51_200` in `src/review/semantic.ts` truncates diffs that exceed 50KB. When a story escalates through fast → balanced → powerful, each tier's agent commits additional changes. The `storyGitRef..HEAD` diff grows monotonically (net diff, not intermediate history). On a 3-tier escalation the diff can exceed the cap, causing the reviewer to see a truncated diff that hides later files.

Example from a real run: a 22-file story escalated twice. By the powerful tier, the diff was ~68KB. The reviewer only saw 15 of 22 files, missing 3 production files that contained AC-critical logic. Review passed incorrectly.

### Problem 2: Reviewer already has tool access

Since SPEC-semantic-session-continuity, the non-debate reviewer runs via `agent.run()` targeting the implementer session — full tool access (READ, GREP, bash). The debate resolver also runs via `agent.run()`. Under ACP (the default and only supported protocol going forward — CLI is deprecated), even one-shot calls create a tool-enabled session. The reviewer *can* fetch its own diff but currently never does because the diff is embedded.

### Problem 3: No escalation awareness

The reviewer prompt has no concept of attempt history. On attempt 3 (powerful tier) after two prior failures, the reviewer doesn't know:
- That this is a retry, not a first attempt
- Which stages failed previously (verify? review? lint?)
- That the diff may contain net changes from multiple tiers

This information would help the reviewer use its tools more effectively — e.g. checking `git log` to understand the commit history, or focusing verification on ACs that prior attempts failed on.

## Design

### Config

Add `diffMode` to `SemanticReviewConfigSchema`:

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic"],
    "semantic": {
      "modelTier": "balanced",
      "diffMode": "embedded",
      "rules": []
    }
  }
}
```

- `diffMode`: `"embedded"` | `"ref"` (default: `"embedded"`)
  - `"embedded"`: current behaviour — diff collected, truncated, embedded in prompt
  - `"ref"`: stat summary + storyGitRef in prompt; reviewer self-serves full diff via tools

### Prompt Changes (both modes)

#### Attempt context section (new)

When the story has `priorFailures`, append to the prompt:

```
## Attempt Context
This is escalation attempt 3. Prior attempts failed at stages: verify, review.
The diff shows the NET result of all changes since story start — verify against the current codebase state.
```

Built from `story.priorFailures` (available via `UserStory` on `PipelineContext`). When `priorFailures` is empty or undefined, this section is omitted.

#### Mode: `embedded` (current behaviour + attempt context)

Prompt structure unchanged except for the new attempt context section:

```
{SEMANTIC_ROLE}

## Story: {title}
### Description
{description}
### Acceptance Criteria
{acList}
{customRulesBlock}
{attemptContext}         ← NEW

## Git Diff (production code only — test files excluded)
```diff
{truncated diff}
```

{SEMANTIC_INSTRUCTIONS}
{SEMANTIC_OUTPUT_SCHEMA}
```

`DIFF_CAP_BYTES`, `collectDiff()`, `truncateDiff()` remain as-is.

#### Mode: `ref`

```
{SEMANTIC_ROLE}

## Story: {title}
### Description
{description}
### Acceptance Criteria
{acList}
{customRulesBlock}
{attemptContext}

## Changed Files
```
{stat summary from git diff --stat}
```

## Git Baseline: `{storyGitRef}`

To inspect the implementation:
- Full production diff: `git diff --unified=3 {storyGitRef}..HEAD -- . ':!.nax/' ':!test/' ':!tests/' ':!*.test.ts' ':!*.spec.ts'`
- Full diff (including tests): `git diff --unified=3 {storyGitRef}..HEAD`
- Commit history: `git log --oneline {storyGitRef}..HEAD`

Use these commands to inspect the code. Do NOT rely solely on the file list above — read the actual diff and files to verify each AC.

{SEMANTIC_INSTRUCTIONS}
{SEMANTIC_OUTPUT_SCHEMA}
```

The `ref` mode:
- Embeds the `--stat` summary (file list + change counts, typically 1–3KB — never triggers truncation)
- Gives the reviewer the exact `storyGitRef` and pre-built commands
- Includes the `excludePatterns` from config in the production diff command (matching current `collectDiff` behaviour)
- Relies on the reviewer's tool access to fetch and inspect the full diff

### Code Changes

#### 1. Schema — `src/config/schemas.ts`

Add `diffMode` to `SemanticReviewConfigSchema`:

```typescript
const SemanticReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  diffMode: z.enum(["embedded", "ref"]).default("embedded"),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
  excludePatterns: z.array(z.string()).default([...]),
});
```

#### 2. Types — `src/review/types.ts`

Add `diffMode` to `SemanticReviewConfig`:

```typescript
export interface SemanticReviewConfig {
  modelTier: import("../config/schema-types").ModelTier;
  diffMode: "embedded" | "ref";
  rules: string[];
  timeoutMs: number;
  excludePatterns: string[];
}
```

#### 3. Prompt builder — `src/prompts/builders/review-builder.ts`

Extend `buildSemanticReviewPrompt` to accept options and branch on mode:

```typescript
interface SemanticReviewPromptOptions {
  /** diff mode: embedded includes diff in prompt, ref includes git ref + stat */
  mode: "embedded" | "ref";
  /** Pre-collected diff (used when mode = "embedded") */
  diff?: string;
  /** Git baseline ref (used when mode = "ref", optional for "embedded") */
  storyGitRef?: string;
  /** Git diff --stat output (used when mode = "ref") */
  stat?: string;
  /** Prior failure context for attempt awareness */
  priorFailures?: Array<{ stage: string; modelTier: string }>;
  /** Exclude patterns for the self-serve diff command (mode = "ref") */
  excludePatterns?: string[];
}

buildSemanticReviewPrompt(
  story: SemanticStory,
  semanticConfig: SemanticReviewConfig,
  options: SemanticReviewPromptOptions,
): string;
```

Signature change is backward-incompatible — all call sites must update. There are 3:
- `src/review/semantic.ts:292` (standard path)
- Tests in `test/unit/prompts/review-builder.test.ts`

The builder:
- Always emits the attempt context section when `options.priorFailures` is non-empty
- When `mode === "embedded"`: emits the diff block (same as today)
- When `mode === "ref"`: emits the stat + ref + commands block

#### 4. Semantic runner — `src/review/semantic.ts`

Branch on `semanticConfig.diffMode`:

```typescript
// Both modes: collect stat (lightweight, always needed)
const stat = await collectDiffStat(workdir, effectiveRef);

let prompt: string;
if (semanticConfig.diffMode === "ref") {
  // ref mode: no diff collection, no truncation
  prompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(story, semanticConfig, {
    mode: "ref",
    storyGitRef: effectiveRef,
    stat,
    priorFailures: storyPriorFailures,
    excludePatterns: semanticConfig.excludePatterns,
  });
} else {
  // embedded mode: collect + truncate diff (current behaviour)
  const rawDiff = await collectDiff(workdir, effectiveRef, semanticConfig.excludePatterns);
  const diff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined);
  if (!diff) {
    return { check: "semantic", success: true, ... output: "skipped: no production code changes" };
  }
  prompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(story, semanticConfig, {
    mode: "embedded",
    diff,
    storyGitRef: effectiveRef,
    priorFailures: storyPriorFailures,
  });
}
```

The `ref` mode skips the "no production code changes" early return — the reviewer can determine this itself from the stat. If stat is empty, we still skip (no files changed at all).

#### 5. Remove `complete()` fallback — `src/review/semantic.ts`

CLI is deprecated; ACP is the default protocol. The `complete()` fallback at lines 487-499 (for "CLI adapter without run() support") is dead code. Remove it:

```typescript
// Before: try run() → catch → complete() fallback → catch → fail-open
// After:  run() → catch → fail-open

const runResult = await agent.run({ ... });
rawResponse = runResult.output;
llmCost = runResult.estimatedCost ?? 0;
```

The outer `catch` at line 501 already handles `run()` failure with fail-open. The `complete()` fallback added no value under ACP (both `run()` and `complete()` create tool-enabled sessions).

#### 6. Thread `priorFailures` to semantic review

`runSemanticReview()` needs access to the story's `priorFailures` for the attempt context. Two options:

**Option A (minimal):** Add `priorFailures` to the function signature. Callers already have the story object:
- `src/review/runner.ts` — passes `story.priorFailures` (story is available from `ReviewRunnerContext`)
- `src/review/orchestrator.ts:206` — passes from `ctx.story.priorFailures`

**Option B:** Extend `SemanticStory` type to include optional `priorFailures`. Prefer Option A — `SemanticStory` is intentionally minimal (review-scoped fields only).

#### 7. Debate path — `src/review/semantic.ts` + `src/debate/session-helpers.ts`

The debate path at `semantic.ts:309-313` passes `diff` to `resolverContextInput`. For `ref` mode, pass `storyGitRef` + `stat` instead:

```typescript
resolverContextInput: resolverSession
  ? {
      ...(semanticConfig.diffMode === "ref"
        ? { storyGitRef: effectiveRef, stat }
        : { diff }),
      story: { id: story.id, title: story.title, acceptanceCriteria: story.acceptanceCriteria },
      semanticConfig,
      resolverType: reviewStageConfig.resolver.type,
      isReReview,
    }
  : undefined,
```

Update `ResolverContext` in `src/debate/session-helpers.ts`:

```typescript
interface ResolverContext {
  // Mode: embedded
  diff?: string;
  // Mode: ref
  storyGitRef?: string;
  stat?: string;
  // Common
  story: { id: string; title: string; acceptanceCriteria: string[] };
  semanticConfig: SemanticReviewConfig;
  labeledProposals: Array<{ debater: string; output: string }>;
  resolverType: ResolverType;
  isReReview?: boolean;
}
```

Making `diff`, `storyGitRef`, and `stat` all optional keeps backward compatibility — existing debate code that reads `resolverContext.diff` continues to work in `embedded` mode.

The debate resolver prompt builders (`src/prompts/builders/debate-builder.ts`) that consume `resolverContext.diff` must be updated to handle the `ref` case — when `diff` is absent, include `storyGitRef` + `stat` + commands instead.

#### 8. Config descriptions — `src/cli/config-descriptions.ts`

Add entry for `review.semantic.diffMode`:

```
"review.semantic.diffMode": "How the semantic reviewer accesses the git diff. 'embedded' (default) includes the diff in the prompt (truncated at 50KB). 'ref' passes only the git ref and file list — the reviewer fetches the full diff via tools. Use 'ref' for large stories or multi-tier escalations where truncation loses context."
```

### Files Changed

| File | Change |
|:-----|:-------|
| `src/config/schemas.ts` | Add `diffMode` to `SemanticReviewConfigSchema` |
| `src/review/types.ts` | Add `diffMode` to `SemanticReviewConfig` |
| `src/prompts/builders/review-builder.ts` | New `SemanticReviewPromptOptions`, branch on mode, add attempt context |
| `src/review/semantic.ts` | Branch on `diffMode`, remove `complete()` fallback, thread `priorFailures` |
| `src/review/runner.ts` | Pass `priorFailures` to `runSemanticReview()` |
| `src/debate/session-helpers.ts` | Make `diff` optional in `ResolverContext`, add `storyGitRef?` + `stat?` |
| `src/cli/config-descriptions.ts` | Add `review.semantic.diffMode` description |
| `test/unit/prompts/review-builder.test.ts` | Update for new signature + snapshot for both modes |
| `test/unit/review/semantic.test.ts` | Add tests for `ref` mode path |

| `src/prd/index.ts` | Clear `storyGitRef` in `resetFailedStoriesToPending()` |
| `src/execution/lifecycle/paused-story-prompts.ts` | Clear `storyGitRef` on resume |

### What Does NOT Change

- `storyGitRef` capture, persistence, and scope — unchanged (correct as established)
- `DIFF_CAP_BYTES`, `collectDiff()`, `truncateDiff()` — preserved for `embedded` mode
- `collectDiffStat()` — used by both modes
- Smart test runner, acceptance context, plugin reviewers — unaffected (they don't use the prompt diff)
- `priorErrors` / `priorFailures` accumulation — unaffected
- Review stage pipeline flow — unchanged (review.ts passes ref, semantic.ts branches internally)

## Stories

### US-001: Add `diffMode` config and schema

**Dependencies:** None

**Description:** Add `diffMode: "embedded" | "ref"` to `SemanticReviewConfigSchema` with default `"embedded"`. Extend `SemanticReviewConfig` type. Add config description.

**Acceptance Criteria:**
- `SemanticReviewConfigSchema` in `src/config/schemas.ts` accepts `diffMode` with values `"embedded"` and `"ref"`, defaulting to `"embedded"`
- `SemanticReviewConfig` in `src/review/types.ts` includes `diffMode: "embedded" | "ref"`
- When `review.semantic.diffMode` is omitted, `NaxConfigSchema.parse({...})` produces `diffMode: "embedded"`
- When `review.semantic.diffMode` is `"invalid"`, `NaxConfigSchema.safeParse()` returns validation error
- `config-descriptions.ts` has entry for `review.semantic.diffMode`

**Context Files:**
- `src/config/schemas.ts`
- `src/review/types.ts`
- `src/cli/config-descriptions.ts`

### US-002: Update ReviewPromptBuilder for both modes + attempt context

**Dependencies:** US-001

**Description:** Refactor `buildSemanticReviewPrompt` to accept `SemanticReviewPromptOptions`. Implement both `embedded` (current behaviour with diff) and `ref` (stat + storyGitRef + commands) prompt variants. Add attempt context section when `priorFailures` is provided.

**Acceptance Criteria:**
- `buildSemanticReviewPrompt(story, config, { mode: "embedded", diff: "..." })` produces a prompt containing the embedded diff block (matching current output)
- `buildSemanticReviewPrompt(story, config, { mode: "ref", storyGitRef: "abc123", stat: "..." })` produces a prompt containing the stat summary, git baseline ref, and self-serve diff commands
- `buildSemanticReviewPrompt(story, config, { mode: "ref", storyGitRef: "abc123", stat: "...", excludePatterns: [":!test/"] })` includes the exclude patterns in the self-serve diff command
- When `priorFailures` is provided with 2 entries (stages: "verify", "review"), the prompt includes an "Attempt Context" section stating "This is escalation attempt 3" and listing the failed stages
- When `priorFailures` is empty or undefined, no attempt context section appears
- The `ref` mode prompt includes the instruction "Use these commands to inspect the code. Do NOT rely solely on the file list above"
- Existing snapshot tests are updated (signature change is intentionally breaking)

**Context Files:**
- `src/prompts/builders/review-builder.ts`
- `test/unit/prompts/review-builder.test.ts`

### US-003: Branch semantic.ts on diffMode and remove complete() fallback

**Dependencies:** US-002

**Description:** Update `runSemanticReview()` to read `semanticConfig.diffMode` and branch: `embedded` collects + truncates diff (current path), `ref` collects only stat and passes ref. Remove the `agent.complete()` fallback (dead code under ACP-only). Thread `priorFailures` from callers.

**Acceptance Criteria:**
- When `diffMode === "embedded"`, `runSemanticReview()` collects diff via `collectDiff()`, truncates via `truncateDiff()`, and embeds in prompt (identical to current behaviour)
- When `diffMode === "ref"`, `runSemanticReview()` does NOT call `collectDiff()` — only calls `collectDiffStat()`
- When `diffMode === "ref"` and stat is empty (no files changed), returns passing result with output `"skipped: no changes detected"`
- When `diffMode === "ref"`, the prompt passed to `agent.run()` contains the `storyGitRef` and stat but no diff block
- The `agent.complete()` fallback block (lines ~487-499) is removed; `run()` failure falls through to the existing fail-open catch
- `runSemanticReview()` accepts optional `priorFailures` parameter and passes it to the prompt builder
- `src/review/runner.ts` passes `story.priorFailures` to `runSemanticReview()`

**Context Files:**
- `src/review/semantic.ts`
- `src/review/runner.ts`
- `src/review/orchestrator.ts`

### US-004: Update debate resolverContextInput for ref mode

**Dependencies:** US-003

**Description:** Update the debate path in `semantic.ts` and `ResolverContext` in `session-helpers.ts` to support `ref` mode. When `diffMode === "ref"`, pass `storyGitRef` + `stat` instead of `diff`. Update debate prompt builders that consume `resolverContext.diff`.

**Acceptance Criteria:**
- `ResolverContext` in `src/debate/session-helpers.ts` has `diff?: string`, `storyGitRef?: string`, `stat?: string` (all optional)
- When `diffMode === "embedded"`, `resolverContextInput` includes `diff` (unchanged)
- When `diffMode === "ref"`, `resolverContextInput` includes `storyGitRef` and `stat` but not `diff`
- Debate resolver prompt builders handle the case where `diff` is undefined — emit ref + stat + commands block instead
- `resolveDebate()` and `reReviewDebate()` in `src/review/dialogue.ts` pass the correct context shape based on mode

**Context Files:**
- `src/review/semantic.ts` (debate path at ~line 309)
- `src/debate/session-helpers.ts`
- `src/review/dialogue.ts`
- `src/prompts/builders/debate-builder.ts`

## Story Execution Order and storyGitRef Integrity

### Within a Single Run (Flow 1 — OK)

When a story fails and escalates, the **same story retries immediately** before the runner moves to the next story.

**Trace:** `getNextStory(prd, lastStoryId)` in `src/prd/index.ts:87` scans the PRD array for the first pending story. After `handleTierEscalation` resets `attempts: 0` and updates `modelTier` (without changing `status` from `"pending"`), the escalated story is still the first pending in the array → it is selected again.

**Implication:** `storyGitRef..HEAD` in sequential mode contains **only the current story's own changes**. No other story's commits interleave between escalation attempts.

**Parallel mode:** stories run in separate git worktrees. Commits don't interleave. Parallel failures pass `storyGitRef: null` and re-queue for sequential retry.

### On Re-Run After Exhaustion (BUG — critical, fixed by US-005)

When multiple stories exhaust all tiers and are marked `"failed"`, then the user re-runs `nax run`:

1. `initializeRun()` calls `resetFailedStoriesToPending()` — sets `status: "pending"` but does **NOT** reset `storyGitRef`
2. Stories re-enter the queue with their original `storyGitRef` from Run 1
3. `iteration-runner.ts:70` finds `story.storyGitRef` valid → reuses it

**Result:** `git diff storyGitRef..HEAD` now includes commits from ALL stories that ran after the ref was captured, not just the current story.

Example with 3 exhausted stories:
```
Run 1: US-001(ref=A) → commits B..F, US-002(ref=F) → commits G..J, US-003(ref=J) → commits K..M
Run 2: US-001 re-runs, ref=A still set → git diff A..HEAD = US-001 + US-002 + US-003 changes
```

**Impact:** Semantic review sees unrelated story changes. Smart test runner maps files from all stories. Acceptance context includes all stories' diffs. This is cross-story pollution.

**Fix (US-005):** Clear `storyGitRef` when resetting failed stories to pending, forcing re-capture on the next iteration.

### US-005: Configurable storyGitRef reset on re-run

**Dependencies:** US-001 (uses the same `SemanticReviewConfigSchema` extension point)

**Description:** Add `resetRefOnRerun: boolean` (default: `false`) to `SemanticReviewConfigSchema`. When enabled and `resetFailedStoriesToPending()` resets a story from `"failed"` to `"pending"`, also clear `storyGitRef` so it is re-captured at the start of the next run. This prevents cross-story diff pollution on re-runs after multiple story exhaustion, at the cost of losing full story scope (the reviewer only sees the new attempt's delta).

Default is `false` (current behaviour preserved) because resetting has known side effects:
- Semantic reviewer loses full story scope — only sees the re-run delta, not the original implementation
- Smart test runner under-scopes — only maps tests for files changed in re-run attempt
- `outputFiles` / `diffSummary` (ENH-005) only captures re-run files, not full story output
- Acceptance context loses implementation scope

Users running multi-story features that frequently exhaust tiers should enable this. The long-term solution is per-story worktree isolation (see SPEC-sequential-worktree-isolation.md).

**Config:**
```json
{
  "review": {
    "semantic": {
      "resetRefOnRerun": false
    }
  }
}
```

**Acceptance Criteria:**
- `SemanticReviewConfigSchema` in `src/config/schemas.ts` accepts `resetRefOnRerun` boolean, defaulting to `false`
- `SemanticReviewConfig` in `src/review/types.ts` includes `resetRefOnRerun: boolean`
- When `resetRefOnRerun` is `false` (default), `resetFailedStoriesToPending()` does NOT clear `storyGitRef` — current behaviour preserved
- When `resetRefOnRerun` is `true`, `resetFailedStoriesToPending()` sets `story.storyGitRef = undefined` for each story it resets
- The config value is threaded from `initializeRun()` context to `resetFailedStoriesToPending()` (currently takes only PRD, needs config param)
- On the next `nax run` with `resetRefOnRerun: true`, `iteration-runner.ts` falls to the `else` branch (line 72) and captures fresh HEAD as the new `storyGitRef`
- Stories with `status: "passed"` retain their `storyGitRef` regardless of config (not reset — used by output file capture)
- Stories with `status: "paused"` that are resumed also get `storyGitRef` cleared when `resetRefOnRerun: true` (check `paused-story-prompts.ts` resume path)
- `config-descriptions.ts` has entry for `review.semantic.resetRefOnRerun`

**Context Files:**
- `src/config/schemas.ts`
- `src/review/types.ts`
- `src/prd/index.ts` (`resetFailedStoriesToPending`)
- `src/execution/iteration-runner.ts` (storyGitRef capture logic)
- `src/execution/lifecycle/run-initialization.ts` (calls `resetFailedStoriesToPending`)
- `src/execution/lifecycle/paused-story-prompts.ts` (resume path)
- `src/cli/config-descriptions.ts`

## Migration

- Default is `"embedded"` — zero-change upgrade for all existing users
- To opt in: set `review.semantic.diffMode: "ref"` in project config
- Once `ref` mode is validated across real runs, a future change can flip the default

## Observability

Both modes log via the existing `logger.info("review", "Running semantic check", {...})` path. Add `diffMode` to the log data so runs can be compared:

```typescript
logger?.info("review", "Running semantic check", {
  storyId: story.id,
  modelTier: semanticConfig.modelTier,
  diffMode: semanticConfig.diffMode,
});
```

## Risks

| Risk | Mitigation |
|:-----|:-----------|
| `ref` mode reviewer doesn't actually run `git diff` (ignores instructions) | Fail-closed: if reviewer returns `passed: true` with 0 findings but ACs are complex, the existing AC-count heuristic in post-run acceptance catches it |
| `ref` mode is slower (reviewer runs git commands = more tool turns) | Timeout already configured via `semanticConfig.timeoutMs` (default 600s). Monitor cost/duration in metrics. |
| `embedded` mode users see no benefit | They continue with current behaviour — no regression |
| Prompt builder signature change breaks external callers | `ReviewPromptBuilder` is internal (not exported from barrel). Only `semantic.ts` and tests call it. |
| Re-run after exhaustion: storyGitRef pollution | US-005 mitigates via `resetRefOnRerun` config (opt-in, default off). Full solution: per-story worktree isolation (SPEC-sequential-worktree-isolation.md). |

## Relationship to Other Specs

- **SPEC-sequential-worktree-isolation.md (EXEC-002):** Per-story worktree isolation (`execution.storyIsolation: "worktree"`) eliminates the re-run storyGitRef pollution bug at the execution level. When worktree isolation is active, `resetRefOnRerun` (US-005) becomes unnecessary because storyGitRef is always story-scoped. The two configs are independent — users can enable either or both.

---

*Spec written 2026-04-12.*
