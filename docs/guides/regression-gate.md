---
title: Regression Gate
description: Running full-suite regression testing after stories complete
---

## Regression Gate

After all stories pass their individual verification, nax can run a deferred full-suite regression gate to catch cross-story regressions.

> **Pipeline mode.** The `mode` and `enabled` keys below configure the pipeline's regression gate. In workflow mode (the default since 0.88.0) the story loop runs the full test suite once per story, after the story review passes and again before the residual adjudication. The feature workflow then runs every configured quality command (including `quality.commands.test`) as repo gates at the start, and again as the final gates after the branch fix. The `regressionGate.mode` values and the deferred end-of-run pass do not apply there.

```json
{
  "execution": {
    "regressionGate": {
      "enabled": true,
      "mode": "deferred",
      "acceptOnTimeout": true,
      "timeoutSeconds": 600
    }
  }
}
```

| Mode | Behaviour |
|:-----|:----------|
| `disabled` | No regression gate |
| `per-story` | Full suite after each story **and** the deferred full suite once after all stories complete — a superset of `deferred`. Higher cost and slower if stories fail regression |
| `deferred` | Full suite once after all stories pass (recommended) — **default** |

The values shown above are the defaults. `timeoutSeconds` accepts 10–3600, the same ceiling as `verificationTimeoutSeconds`. It is also the timeout for the suite-running commands the agent runs through `RunCommand` (`test`, `testScoped`, `coverage`; #2536), so the agent is never held to a shorter budget than this gate. Other declared commands keep the 120s runner default. With `acceptOnTimeout: true` a timed-out suite counts as passed in pipeline mode. Workflow mode ignores it: a suite that hit its timeout is a red `full-suite` gate, because it never finished. `enabled: false` skips the in-loop full-suite gate (`fullSuiteGateOp`) — to turn off the end-of-run pass use `mode: "disabled"`.

**Per-story full-suite gate:** three-session TDD stories always run the full-suite gate between implementer and verifier. Other strategies run it only when `mode` is `per-story`.

**The deferred pass needs a test command.** It runs `quality.commands.test` and is skipped when that is unset (and under `--dry-run`).

`per-story` is a superset of `deferred`: the per-story gate runs during the main loop, and the deferred end-of-run pass still runs afterwards. The end-of-run pass is intentionally never skipped — the post-run acceptance/hardening phase runs *after* the per-story gates, so a fix applied there can reintroduce a regression no per-story gate ever saw.

If the regression gate detects failures, nax first triages flaky tests (re-running them in isolation per `execution.flakeDetection`), then maps each remaining failing test file to the responsible story — the earliest story whose per-story gate snapshot shows that test failing, falling back to a git-recency heuristic when no snapshot matches (and always for parallel runs). Unmapped failures fail safely without rectifying an unrelated story. Each affected story gets a targeted rectification cycle, sharing the `execution.rectification.maxAttemptsTotal` budget. If rectification fails, affected stories are marked as `regression-failed`.

---

[Back to README](../../README.md)
