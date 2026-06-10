---
title: Story Decomposition
description: Breaking oversized stories into manageable sub-stories
---

## Story Decomposition

Story decomposition breaks an oversized story into smaller sub-stories. It runs as a **plan-time** operation, invoked explicitly via the `nax plan` command — it is not a mid-run pipeline stage.

```bash
nax plan --decompose <storyId>
```

An LLM (`decomposeOp` in `src/operations/decompose.ts`) breaks the target story into smaller sub-stories with IDs, titles, descriptions, acceptance criteria, and dependency ordering. The parent story is marked `decomposed` and the validated sub-stories replace it in the PRD.

**Sizing thresholds** come from `precheck.storySizeGate` in `.nax/config.json` — there is no separate `decompose` config block:

```json
{
  "precheck": {
    "storySizeGate": {
      "enabled": true,
      "maxAcCount": 10,
      "action": "block",
      "maxReplanAttempts": 3
    }
  }
}
```

**`action` modes** (what `storySizeGate` does when a story exceeds `maxAcCount`):

| Value | Behaviour |
|:------|:----------|
| `block` | Block the run and replan/decompose oversized stories (up to `maxReplanAttempts`) |
| `warn` | Log a warning but continue |
| `skip` | Skip the size check entirely |

> **Note:** `storySizeGate` (under `precheck`) is the pre-run guard that detects oversized stories before execution starts. Decomposition is the remedy — run `nax plan --decompose <storyId>`, or let the `block` action drive the replan loop in `src/cli/plan-decompose.ts`.

**How it works:**

1. The LLM generates sub-stories, each capped at `maxAcCount` acceptance criteria, with dependency ordering
2. A repair loop re-prompts (up to `maxReplanAttempts`) any sub-story that still exceeds `maxAcCount`
3. Post-decompose validators check overlap, coverage, complexity, and dependency ordering
4. The parent story is marked `decomposed` and replaced in the PRD with the validated sub-stories

---

[Back to README](../../README.md)
