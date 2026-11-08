---
title: Semantic Review
description: The LLM story review that checks an implementation against its acceptance criteria
---

## Semantic Review

Semantic review uses an LLM to compare the actual implementation against a story's acceptance criteria (ACs). Unlike lint or typecheck (which validate syntax and types), it validates **behavior** — checking that the implementation actually satisfies what the story asked for.

In workflow mode each story gets a fresh story review (`workflow-story-review`, `src/operations/workflow-story-review.ts`) after its implementer session. A re-review after a fix round uses `workflow-re-review`.

- **Tools.** The reviewer has `Read`, `Glob`, `Grep`, `Git` and `Bash`. Its `Bash` runs inside the sandbox (see [Sandbox and Command Safety](sandbox-and-command-safety.md)).
- **Model.** `workflow.models.storyReview`, falling back to `review.semantic.model`.
- **Timeout.** `workflow.timeouts.reviewMs`.
- **Input.** Three files: the brief (the requirements), the implementer's report, and a review package (the commits, the diff stat and the diff). A truncated diff ends with a list of files it does not show, which the reviewer reads itself.
- **Parse failure.** A reply that does not parse after one retry skips the review rather than failing open.

Workflow branch-level review is covered by the feature workflow (see [Retry Strategy](retry-strategy.md)).

---

## What the Story Review Checks

The reviewer gives two verdicts:

- **spec** — `pass` only if every acceptance criterion is implemented and covered by a test that would fail without it. Missing TDD evidence for an AC (other than an honest not-captured note), or a test that asserts nothing, is a spec failure.
- **quality** — `approved` or `changes` (correctness, error handling, edge cases, conventions of the surrounding code).

Each finding carries a severity (`critical`, `important`, `minor`) and a kind (`spec` or `quality`). A critical or important finding about what the code does carries a verbatim excerpt (`observed`) that proves it. The reviewer also lists every file it opened (`inspectedFiles`) and anything it cannot verify (`cannotVerify`). nax tells the reviewer which gates it already ran on the story (lint, typecheck, scoped tests, full suite), so those are not re-reported.

---

## Configuration

```json
{
  "review": {
    "semantic": {
      "model": "balanced"
    }
  }
}
```

| Key | Default | Effect |
|:----|:--------|:-------|
| `review.semantic.model` | `"balanced"` | Fallback model for the story review when `workflow.models.storyReview` is unset. Accepts a tier string (`"fast"`, `"balanced"`, `"powerful"`) or a `{ agent, model }` cross-agent pin |
| `review.semantic.resetRefOnRerun` | `false` | When `true`, clears `storyGitRef` on re-run so it is re-captured in the fresh execution |

The other `review.semantic.*` keys and the `review.adversarial.*` keys are accepted by the schema but the workflow story review does not read them.

---

## Plugin Mode

`review.pluginMode` controls `IReviewPlugin` reviewers, which run as a **deferred end-of-run** pass (per-story plugin gating was removed — ADR-023 / #1146):

```json
{
  "review": {
    "pluginMode": "observational"
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `observational` (default) | Plugin reviewer failures are logged + surfaced in run status but do NOT fail the run |
| `gating` | Any failing plugin reviewer marks the run failed (`RunResult.success = false`) |

---

[Back to README](../../README.md)
