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
Story ACs + git diff → LLM prompt → { passed: bool, findings: [...] }
```

1. Collects the git diff from the story's starting commit to `HEAD`
2. Builds a prompt containing the story title, description, ACs, and review rules
3. Calls the LLM with a structured output schema
4. Parses the response and reports findings

Semantic review runs **after** the story passes all other checks (typecheck, lint, test). It is a final behavioral gate.

---

## Default Rules

Every semantic review evaluates against these 5 rules:

1. **No stubs or noops** — No empty implementations, placeholder functions, or TODO comments left in production code
2. **No placeholder values** — No hardcoded dummy data, magic numbers, or test-only constants in production paths
3. **No out-of-scope changes** — No unrelated changes outside the story's feature boundary
4. **All new code is wired** — New functions/classes are properly exported and called by their callers
5. **No silent error swallowing** — No `catch` blocks that silently discard errors without logging

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
      "modelTier": "fast",     // Model tier for LLM calls (default: "balanced")
      "rules": []              // Custom rules appended to default rules
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
        "No new console.log / console.error statements in production code",
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

## Fail-Open Behavior

Semantic review **fails open** — if the LLM call fails or returns unparseable output, the review passes with a warning in the output. This prevents a flaky LLM response from blocking a valid implementation.

```
semantic review: could not parse LLM response (fail-open)
```

---

## Diff Truncation

Diffs are truncated to ~12 KB to stay within the LLM token budget. If truncated, the review covers the first files in the diff only.

---

## Example Output

```
Semantic review failed:

[error] src/auth/login.ts:42 — catch block silently swallows the error
  Suggestion: Add logger.error("Login failed", { err }) or re-throw
[warn] src/auth/session.ts:18 — hardcoded 3600 used instead of SESSION_TTL constant
  Suggestion: Extract to config constant SESSION_TTL
```

---

## Requirements

Semantic review requires a git history — it compares `${storyGitRef}..HEAD`. If no git ref exists for the story (e.g., first run on a new branch), the check is skipped.

The LLM model must be configured in `models` for the chosen `modelTier`.
