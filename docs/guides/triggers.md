---
title: Interaction Triggers
description: Interactive pause-and-prompt configuration
---

## Interaction Triggers

nax can pause execution and prompt you for decisions at critical points. Configure triggers in `.nax/config.json` (or `~/.nax/config.json` globally):

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
      "story-oversized": true,
      "review-gate": true,
      "pre-merge": false,
      "merge-conflict": true
    }
  }
}
```

Out of the box (no `interaction` block), nax uses the `cli` plugin with a 600000 ms (10 min) timeout, and only `security-review` and `cost-warning` are enabled. A trigger absent from `triggers` is disabled. Each trigger takes either `true`/`false` or an object with a per-trigger override:

```json
"triggers": {
  "max-retries": { "enabled": true, "fallback": "abort", "timeout": 120000 }
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
| `review-gate` | 🟢 Green | `continue` | Code review checkpoint before proceeding |

**Safety tiers:**
- 🔴 **Red** — Critical; defaults to aborting if no response
- 🟡 **Yellow** — Caution; defaults to escalating or skipping
- 🟢 **Green** — Informational; defaults to continuing

**Fallback behaviors** (when interaction times out). Each trigger uses its own default fallback (table above) unless `interaction.defaults.fallback` or a per-trigger `fallback` is set. Red-tier triggers ignore `interaction.defaults.fallback` — only a per-trigger `fallback` changes them, so a blanket `"continue"` cannot turn a security or cost gate into approve-on-timeout:
- `continue` — proceed as normal
- `skip` — skip the current story
- `escalate` — escalate to a higher model tier
- `abort` — stop the run

**Interaction plugins:**

| Plugin | Description |
|:-------|:------------|
| `telegram` | Send prompts via Telegram bot (recommended for remote runs) |
| `cli` | Interactive terminal prompts (for local runs) |
| `webhook` | POST interaction requests to a webhook URL; responses arrive on a local HMAC-verified callback server |

The former `auto` plugin was removed and is rejected at startup (`INTERACTION_PLUGIN_REMOVED`). For auto-approval on timeout, set `interaction.defaults.fallback: "continue"`.

In headless mode the `cli` plugin is skipped (it needs a TTY); `telegram` and `webhook` still work.

**Bash approval prompts:** when a stage's `bashApproval` is `gated` or `escalate` (ADR-030) and a command reaches the `ask` tier, the approval prompt is sent through this same interaction plugin (timeout: `execution.approvalTimeout`, default 600000 ms). With no reachable human, an `ask` denies. Remembered approvals can be inspected with `nax approvals list` and removed with `nax approvals rm`. See [Permissions](permissions.md) and [ADR-030](../adr/ADR-030-bash-approval-modes.md).

[Back to README](../README.md)
