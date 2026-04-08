---
title: Semantic Review
description: LLM-based behavioral review against story acceptance criteria
---

## Semantic Review

Semantic review uses an LLM to compare the actual git diff against a story's acceptance criteria (ACs). Unlike lint or typecheck (which validate syntax and types), semantic review validates **behavior** — checking that the implementation actually satisfies what the story asked for.

**Status:** Built-in (v0.54.0) — opt-in via config.

---

## How It Works

```
Story ACs + production diff → LLM prompt → { passed: bool, findings: [...] }
```

1. Collects the git diff from the story's starting commit to `HEAD` (**production code only** — test files excluded)
2. Builds a prompt containing the story title, description, and ACs
3. Calls the LLM to verify each AC is correctly implemented
4. Parses the structured JSON response and reports findings

Semantic review runs **after** the story passes all other checks (typecheck, lint, test). It is a final behavioral gate.

---

## What Semantic Review Checks

Semantic review verifies **acceptance criteria implementation**:

1. **AC coverage** — each acceptance criterion is implemented, not partially or missing
2. **AC correctness** — the implementation does what the AC specifies, not something different
3. **Dead code** — new code with stubs, noops, or unreachable branches
4. **Wiring** — new functions/classes are exported and called by their callers

Semantic review does **NOT** check:

- Style, naming, or formatting (handled by lint)
- Import ordering or file length (handled by lint)
- Type correctness (handled by typecheck)
- Test quality or test conventions (handled by lint)

---

## Test File Exclusion

Test files are **excluded from the diff** sent to the LLM via configurable git pathspec patterns. The default patterns cover common test directory conventions across languages:

```json
{
  "review": {
    "semantic": {
      "excludePatterns": [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/"]
    }
  }
}
```

Override for your project's test layout:

```json
{
  "review": {
    "semantic": {
      "excludePatterns": [":!src/test/", ":!*Test.java", ":!*_test.py", ":!test_*.py"]
    }
  }
}
```

Set to `[]` to include test files in the review.

This is intentional — semantic review validates production behavior against ACs. Test style and conventions are enforced by lint.

The `git diff --stat` summary (shown on truncation) still includes all files for full context.

---

## Enabling Semantic Review

Add `"semantic"` to `review.checks` in `.nax/config.json`:

```json
{
  "review": {
    "enabled": true,
    "checks": ["typecheck", "lint", "semantic"]
  }
}
```

---

## Configuration

```json
{
  "review": {
    "semantic": {
      "modelTier": "fast",
      "rules": []
    }
  }
}
```

### `modelTier`

Controls which model runs the semantic review. Options: `"fast"` (haiku), `"balanced"` (sonnet), `"powerful"` (opus). Default: `"balanced"`.

**Recommendation:** Use `"fast"` (haiku) for most projects — semantic review is a lightweight behavioral check, not a deep reasoning task.

### Custom Rules

Append project-specific rules to the default set:

```json
{
  "review": {
    "semantic": {
      "modelTier": "fast",
      "rules": [
        "All public APIs must have JSDoc comments",
        "Error responses must use the project's standard error shape"
      ]
    }
  }
}
```

Rules are passed verbatim to the LLM prompt as additional evaluation criteria.

---

## Plugin Mode

Semantic review runs per-story by default (`review.pluginMode: "per-story"`). Set to `"deferred"` to run once after all stories:

```json
{
  "review": {
    "pluginMode": "deferred"
  }
}
```

| Mode | When it runs | Benefit |
|:-----|:-------------|:--------|
| `per-story` (default) | After each story passes | Catches semantic issues immediately |
| `deferred` | After all stories complete | Faster per-story, single LLM call |

---

## Fail-Open / Fail-Closed Behavior

Semantic review **fails open** by default — if the LLM call fails or returns truly unparseable output, the review passes with a warning. This prevents flaky LLM responses from blocking valid implementations.

```
semantic review: could not parse LLM response (fail-open)
```

**Exception:** If the LLM returns truncated JSON that contains `"passed": false`, the review **fails closed** — the LLM clearly intended to fail the review but output was cut off mid-response. Treating this as a pass would be incorrect.

```
semantic review: LLM response truncated but indicated failure (passed:false found in partial response)
```

---

## Diff Truncation

Production diffs are truncated to **~50 KB** to stay within LLM context and reduce output truncation risk. When truncated, a `git diff --stat` summary (all files including tests) is prepended so the reviewer always knows which files changed.

```
## File Summary (all changed files)
 src/execution/parallel-batch.ts        | 200 +++
 src/execution/merge-conflict-rectify.ts |  45 +
 test/integration/parallel.test.ts      | 120 ++
 3 files changed, 365 insertions(+)

## Diff (truncated — 2/3 files shown)
...
```

Since test files are excluded from the diff, the 50KB budget goes entirely to production code — equivalent to ~100KB of mixed diff.

---

## Example Output

```
Semantic review failed:

[error] src/auth/login.ts:42 — AC-2 not implemented: catch block silently swallows login errors instead of returning error response
  Suggestion: Add error handling that returns the standard error shape per AC-2
[warn] src/auth/session.ts:18 — createSession() is defined but never called from the login flow
  Suggestion: Wire createSession() into the login handler after successful auth
```

---

## Requirements

Semantic review requires a git history — it compares `${storyGitRef}..HEAD`. If no git ref exists for the story (e.g., first run on a new branch), the check is skipped.

The LLM model must be configured in `models` for the chosen `modelTier`.

---

## Behavior Matrix — Review Stage

The review stage behavior depends on three flags: `debate.enabled` + `debate.stages.review.enabled` (shown as **debate**), `review.dialogue.enabled` (shown as **dialogue**), and the debate `sessionMode`.

| debate | dialogue | sessionMode | Reviewer | Resolver | Tools | Clarify | Re-review ctx |
|:---:|:---:|:---:|:---|:---|:---:|:---:|:---:|
| off | off | — | `agent.run()` resumes implementer session | N/A (single reviewer) | No | No | No |
| off | on | — | `ReviewerSession.review()` | N/A (single reviewer) | Yes | Yes | Yes |
| on | off | one-shot | N debaters via `agent.complete()` | Stateless (`majorityResolver` / `synthesisResolver` / `judgeResolver`) | No | No | No |
| on | off | stateful | N debaters via `agent.run()` + rebuttal loop | Stateless (resolver resumes implementer session) | No | No | No |
| on | **on** | one-shot | N debaters via `agent.complete()` | **`reviewerSession.resolveDebate()`** — all resolver types | **Yes** | **Yes** | **Yes** |
| on | **on** | stateful | N debaters via `agent.run()` + rebuttal loop | **`reviewerSession.resolveDebate()`** — all resolver types | **Yes** | **Yes** | **Yes** |

**Key:** Tools = READ/GREP tool access for the resolver. Clarify = `CLARIFY:` relay from autofix implementer. Re-review ctx = session continuity across autofix re-review rounds.

When both `debate` and `dialogue` are enabled, a `ReviewerSession` is created and stored on `ctx.reviewerSession`. Individual debaters remain stateless — only the resolver gains session continuity and tool access. All three resolver types (`majority`, `synthesis`, `custom`) go through `reviewerSession.resolveDebate()`:

- **majority** — raw vote tally is computed first, then passed as context to `resolveDebate()` so the reviewer can verify disputed findings with tools before giving the authoritative verdict.
- **synthesis** — reviewer synthesises N proposals into a single coherent, tool-verified verdict.
- **custom** — reviewer acts as an independent judge, evaluating proposals and verifying claims with tools.

If `resolveDebate()` throws, the review stage falls back to the stateless resolver path (current behavior pre-dialogue). `ctx.reviewerSession` remains set so the `CLARIFY:` channel is still available.

See also: [Debate Resolver Reference](./debate.md#resolver-types).
