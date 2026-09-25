---
title: Story Decomposition
description: Breaking oversized stories into manageable sub-stories
---

## Story Decomposition

Story decomposition breaks an oversized story into smaller sub-stories. It runs as a **plan-time** operation, invoked explicitly via the `nax plan` command — it is not a mid-run pipeline stage.

```bash
nax plan -f <feature> --decompose <storyId>
```

An LLM (`decomposeOp` in `src/operations/decompose.ts`) breaks the target story into smaller sub-stories with IDs, titles, descriptions, acceptance criteria, routing, and dependency ordering. The parent story is marked `decomposed` and the validated sub-stories are added to the PRD. Sub-stories inherit the parent's `workdir` and agent assignment (ADR-025). A story that is already `decomposed` is rejected.

**Sizing thresholds** come from `precheck.storySizeGate` in `.nax/config.json` — there is no separate `decompose` config block:

```json
{
  "precheck": {
    "storySizeGate": {
      "enabled": true,
      "maxAcCount": 10,
      "maxDescriptionLength": 3000,
      "maxBulletPoints": 12,
      "action": "block",
      "maxReplanAttempts": 3
    }
  }
}
```

The values above are the defaults. A pending story is flagged when **any** signal exceeds its threshold: acceptance-criteria count (`maxAcCount`), description length in characters (`maxDescriptionLength`), or bullet points in the description (`maxBulletPoints`).

**`action` modes** (what `storySizeGate` does when a story is flagged):

| Value | Behaviour |
|:------|:----------|
| `block` | Precheck reports a blocker naming the `nax plan --decompose` command for each flagged story. Under `nax run --plan --from <spec>`, the replan loop decomposes flagged stories automatically (up to `maxReplanAttempts` rounds) before the confirmation gate |
| `warn` | Report a warning but continue |
| `skip` | Skip the size check entirely |

> **Note:** `storySizeGate` (under `precheck`) is the pre-run guard that detects oversized stories before execution starts (`src/precheck/story-size-gate.ts`). Decomposition is the remedy — run `nax plan -f <feature> --decompose <storyId>`, or let the `block` action drive the replan loop (`runReplanLoop` in `src/cli/plan-decompose.ts`).

**How it works:**

1. The LLM generates sub-stories, each capped at `maxAcCount` acceptance criteria, with dependency ordering
2. Structural validation fails immediately (no retry) when a sub-story lacks `complexity`/`testStrategy` or reuses an existing story ID
3. A repair loop re-prompts (up to `maxReplanAttempts` total attempts) when any sub-story still exceeds `maxAcCount`; exhausting the budget fails with `DECOMPOSE_VALIDATION_FAILED`
4. The parent story is marked `decomposed` and the validated sub-stories are written to the PRD

---

[Back to README](../../README.md)
