---
title: Regression Gate
description: Running full-suite regression testing after stories complete
---

## Regression Gate

After all stories pass their individual verification, nax can run a deferred full-suite regression gate to catch cross-story regressions.

```json
{
  "execution": {
    "regressionGate": {
      "mode": "deferred",
      "acceptOnTimeout": true,
      "maxRectificationAttempts": 2
    }
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `disabled` | No regression gate |
| `per-story` | Full suite after each story — higher cost and slower if stories fail regression |
| `deferred` | Full suite once after all stories pass (recommended) — **default** |

If the regression gate detects failures, nax maps them to the responsible story via git blame and attempts automated rectification. If rectification fails, affected stories are marked as `regression-failed`.

> **Smart skip (v0.34.0):** When all stories used `three-session-tdd` or `three-session-tdd-lite` in sequential mode, each story already ran the full suite gate. nax will skip the redundant deferred regression in this case.

---

[Back to README](../../README.md)
