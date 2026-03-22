---
title: Interaction Triggers
description: Interactive pause-and-prompt configuration
---

## Interaction Triggers

nax can pause execution and prompt you for decisions at critical points. Configure triggers in `nax/config.json` (or `~/.nax/config.json` globally):

```json
{
  "interaction": {
    "plugin": "telegram",
    "defaults": {
      "timeout": 600000,
      "fallback": "escalate"
    },
    "triggers": {
      "security-review": true,
      "cost-exceeded": true,
      "cost-warning": true,
      "max-retries": true,
      "human-review": true,
      "story-ambiguity": true,
      "story-oversized": true,
      "review-gate": true,
      "pre-merge": false,
      "merge-conflict": true
    }
  }
}
```

**Available triggers:**

| Trigger | Safety | Default Fallback | Description |
|:--------|:------:|:----------------:|:------------|
| `security-review` | 🔴 Red | `abort` | Critical security issues found during review |
| `cost-exceeded` | 🔴 Red | `abort` | Run cost exceeded the configured limit |
| `merge-conflict` | 🔴 Red | `abort` | Git merge conflict detected |
| `cost-warning` | 🟡 Yellow | `escalate` | Approaching cost limit — escalate to higher model tier? |
| `max-retries` | 🟡 Yellow | `skip` | Story exhausted all retry attempts — skip and continue? |
| `pre-merge` | 🟡 Yellow | `escalate` | Checkpoint before merging to main branch |
| `human-review` | 🟡 Yellow | `skip` | Human review required on critical failure |
| `story-oversized` | 🟡 Yellow | `continue` | Story too complex — decompose into sub-stories? |
| `story-ambiguity` | 🟢 Green | `continue` | Story requirements unclear — continue with best effort? |
| `review-gate` | 🟢 Green | `continue` | Code review checkpoint before proceeding |

**Safety tiers:**
- 🔴 **Red** — Critical; defaults to aborting if no response
- 🟡 **Yellow** — Caution; defaults to escalating or skipping
- 🟢 **Green** — Informational; defaults to continuing

**Fallback behaviors** (when interaction times out):
- `continue` — proceed as normal
- `skip` — skip the current story
- `escalate` — escalate to a higher model tier
- `abort` — stop the run

**Interaction plugins:**

| Plugin | Description |
|:-------|:------------|
| `telegram` | Send prompts via Telegram bot (recommended for remote runs) |
| `cli` | Interactive terminal prompts (for local runs) |
| `webhook` | POST interaction requests to a webhook URL |
| `auto` | Auto-respond based on fallback behavior (no human prompt) |

[Back to README](../README.md)
