---
title: Story Decomposition
description: Breaking oversized stories into manageable sub-stories
---

## Story Decomposition

Story decomposition is **opt-in** — disabled by default. Enable it by adding a `decompose` block to `.nax/config.json`.

When enabled, nax checks during the routing stage whether a story is oversized (complex/expert complexity with more ACs than `maxAcceptanceCriteria`). If so, an LLM breaks it into smaller sub-stories and replaces the original in the PRD.

**Configuration:**

```json
{
  "decompose": {
    "trigger": "auto",
    "maxAcceptanceCriteria": 6,
    "maxSubstories": 5,
    "maxSubstoryComplexity": "medium",
    "maxRetries": 2,
    "model": "balanced"
  }
}
```

**Trigger modes:**

| Value | Behaviour |
|:------|:----------|
| `auto` | Decompose automatically — no confirmation prompt |
| `confirm` | Show interaction prompt — you approve, skip, or continue as-is |
| `disabled` | Never decompose — log a warning if story is oversized |

> **Note:** `storySizeGate` (under `precheck`) is a separate pre-run guard that warns if stories exceed size limits before execution starts. Decomposition happens during routing, mid-run.

**How it works:**

1. An LLM generates sub-stories with IDs, titles, descriptions, acceptance criteria, and dependency ordering
2. Post-decompose validators check overlap, coverage, complexity, and dependency ordering
3. The parent story is replaced in the PRD with the validated sub-stories

---

[Back to README](../../README.md)
