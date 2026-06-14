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
      "timeoutSeconds": 120
    }
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `disabled` | No regression gate |
| `per-story` | Full suite after each story **and** the deferred full suite once after all stories complete — a superset of `deferred`. Higher cost and slower if stories fail regression |
| `deferred` | Full suite once after all stories pass (recommended) — **default** |

`per-story` is a superset of `deferred`: the per-story gate runs during the main loop, and the deferred end-of-run pass still runs afterwards. The end-of-run pass is intentionally never skipped — the post-run acceptance/hardening phase runs *after* the per-story gates, so a fix applied there can reintroduce a regression no per-story gate ever saw.

If the regression gate detects failures, nax maps them to the responsible story via git blame and attempts automated rectification. If rectification fails, affected stories are marked as `regression-failed`.

---

[Back to README](../../README.md)
