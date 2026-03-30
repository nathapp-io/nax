# SPEC: Semantic Review Check (REVIEW-001)

## Summary

Add an LLM-based "semantic" review check that reads the git diff of a story's changes and verifies them against the story's acceptance criteria. Unlike lint/typecheck (syntactic checks), semantic review catches logical issues: stub implementations, missing wiring, unrelated file changes, and empty config values.

## Motivation

PLUGIN-001 case study: 3/3 stories passed all existing checks (typecheck, lint, tests) but human review found 4 real issues:

1. **noopLogger** — post-run actions got a silent logger that dropped all output
2. **`version: ""`** — hardcoded empty string instead of actual version constant
3. **Unrelated `path-security.ts` changes** — agent modified files outside story scope
4. **`pluginConfig: {}`** — always empty object, never wired to real config

None of these are detectable by typecheck or lint. All are detectable by reading the diff against the ACs.

## Design

### Where It Fits

Semantic review is a new **review check** — same level as `typecheck`, `lint`, `test`, `build`. It runs inside the existing review stage via `runReview()` in `src/review/runner.ts`.

```
Pipeline: execute → verify → rectify → review → autofix
                                          ↓
                              typecheck → lint → build → semantic
```

### Config

```json
{
  "review": {
    "checks": ["typecheck", "lint", "semantic"],
    "semantic": {
      "modelTier": "balanced",
      "rules": []
    }
  }
}
```

- `"semantic"` is added to the `ReviewCheckName` union: `"typecheck" | "lint" | "test" | "build" | "semantic"`
- `review.semantic` is an optional config section (only needed when `"semantic"` is in `checks`)
- `review.semantic.modelTier` — model tier for the LLM review call (default: `"balanced"`)
- `review.semantic.rules` — optional array of custom rules (strings) appended to the default prompt. Example: `["All database queries must use parameterized statements"]`

### How It Works

1. **Check triggers** — `runReview()` encounters `"semantic"` in `config.review.checks`
2. **Collect diff** — `git diff --unified=3 <storyGitRef>..HEAD` to get the full diff with context
3. **Build prompt** — combine:
   - Story description + acceptance criteria (from `PipelineContext.story`)
   - Git diff output
   - Default review rules + any custom `semantic.rules`
4. **Call LLM** — use `modelTier` to resolve the model, call via the routing adapter
5. **Parse response** — structured JSON response with pass/fail + findings
6. **Return result** — same `ReviewCheckResult` shape as other checks; findings become `reviewFindings` on the pipeline context for autofix

### LLM Prompt Structure

```
You are a code reviewer. Review this git diff against the story's acceptance criteria.

## Story
**{story.id}: {story.title}**
{story.description}

## Acceptance Criteria
{story.acceptanceCriteria, one per line}

## Rules
Flag any of these issues:
1. Stub or noop implementations that silently discard inputs (e.g. empty logger, no-op callback)
2. Hardcoded placeholder values that should reference real constants or config ("", 0, null, {})
3. Files modified outside the story's scope (unrelated changes)
4. Config fields or constructor parameters that are never wired to actual values
5. Functions that catch errors and silently swallow them without logging
{custom rules appended here}

## Git Diff
```diff
{diff output}
```

## Response Format
Respond with JSON only:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warning",
      "file": "path/to/file.ts",
      "line": number,
      "issue": "description of the problem",
      "suggestion": "how to fix it"
    }
  ]
}

If the diff satisfies all ACs and has no issues, return {"passed": true, "findings": []}.
Only flag real problems — do not flag style preferences or suggestions.
```

### Response Handling

- `passed: true` → review check passes, continue
- `passed: false` → review check fails with structured findings
  - Findings are attached to `ctx.reviewFindings` (same as plugin reviewer findings)
  - Review stage returns `continue` → autofix stage handles retry
  - Agent receives findings as prior failure context on retry

### Failure Flow

Same as lint/typecheck failures:
1. Semantic review fails → review stage returns `continue` (built-in check failure = autofix handles it)
2. Autofix stage receives the findings and retries the story
3. Agent gets structured findings as `priorFailures` context
4. If autofix exhausted (per-cycle `maxAttempts` or global `maxTotalAttempts`) → escalate

### Token Budget

- Diff: cap at ~4000 tokens (~12KB). If larger, truncate with "... (truncated, showing first N files)"
- Story context: ~200-400 tokens
- Rules: ~200 tokens
- Total prompt: ~5000 tokens max
- Response: ~500 tokens max

At `balanced` tier (Sonnet): ~$0.03-0.05 per story.

## Stories

### US-001: Add `"semantic"` to review check types and config

**Dependencies:** None

**Description:** Extend the `ReviewCheckName` type to include `"semantic"`. Add `SemanticReviewConfig` to the config schema with `modelTier` (default: `"balanced"`) and `rules` (default: `[]`). Add `semantic?: SemanticReviewConfig` to `ReviewConfig`.

**Acceptance Criteria:**
- `ReviewCheckName` type in `src/review/types.ts` includes `"semantic"` as a valid value
- `SemanticReviewConfig` interface exists with `modelTier: ModelTier` and `rules: string[]` fields
- `ReviewConfig` in `src/config/runtime-types.ts` has optional `semantic?: SemanticReviewConfig` field
- `ReviewConfigSchema` in `src/config/schemas.ts` validates `semantic` with `modelTier` defaulting to `"balanced"` and `rules` defaulting to `[]`
- `config-descriptions.ts` documents `review.semantic.modelTier` and `review.semantic.rules`
- When `review.checks` includes `"semantic"` and `review.semantic` is omitted, defaults are used (`modelTier: "balanced"`, `rules: []`)

**Context Files:**
- `src/review/types.ts`
- `src/config/runtime-types.ts`
- `src/config/schemas.ts`
- `src/config/defaults.ts`

### US-002: Implement semantic review runner

**Dependencies:** US-001

**Description:** Add `runSemanticReview()` function that collects the git diff, builds the LLM prompt with story context and rules, calls the model, and parses the structured JSON response. Wire it into `runReview()` so it runs when `"semantic"` is in the checks list.

**Acceptance Criteria:**
- `runSemanticReview()` in `src/review/semantic.ts` accepts `(workdir, storyGitRef, story, config, modelResolver)` and returns `ReviewCheckResult`
- `runSemanticReview()` calls `git diff --unified=3 <storyGitRef>..HEAD` to collect the diff
- When the diff exceeds 12KB, `runSemanticReview()` truncates it and appends a `"... (truncated)"` marker
- When `storyGitRef` is undefined, `runSemanticReview()` returns a passing `ReviewCheckResult` with output `"skipped: no git ref"`
- The LLM prompt includes the story title, description, acceptance criteria, default rules, and any custom `config.semantic.rules`
- `runSemanticReview()` parses the LLM response as JSON with `{ passed: boolean, findings: [...] }` structure
- When the LLM returns `passed: false`, the `ReviewCheckResult.success` is `false` and `output` contains the formatted findings
- When the LLM response is not valid JSON, `runSemanticReview()` returns a passing result with a warning log (fail-open — don't block on parse errors)
- `runReview()` in `src/review/runner.ts` calls `runSemanticReview()` when the check name is `"semantic"` instead of running a shell command

**Context Files:**
- `src/review/runner.ts`
- `src/review/orchestrator.ts`
- `src/review/types.ts`
- `src/utils/git.ts`

### US-003: Wire semantic findings into autofix context

**Dependencies:** US-002

**Description:** When semantic review fails, attach the structured findings to the pipeline context so the autofix stage can pass them to the agent as retry context. Convert semantic findings to the existing `ReviewFinding` format.

**Acceptance Criteria:**
- When `runSemanticReview()` returns `success: false`, the review stage populates `ctx.reviewFindings` with findings converted to `ReviewFinding[]` format
- Each semantic finding maps to `ReviewFinding` with `source: "semantic-review"`, `severity`, `file`, `line`, `message` (from `issue`), and `ruleId: "semantic"`
- When the agent retries after semantic review failure, `priorFailures` context includes the semantic findings with `stage: "review"` and the finding details
- When semantic review passes, no findings are added to `ctx.reviewFindings`

**Context Files:**
- `src/pipeline/stages/review.ts`
- `src/context/elements.ts`
- `src/plugins/types.ts` (ReviewFinding interface)

---

*Spec written 2026-03-25. Estimated effort: 3-4 days.*
