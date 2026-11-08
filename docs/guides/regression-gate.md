---
title: Regression Gate
description: The full-suite gate in the workflow story loop
---

## Regression Gate

In workflow mode the story loop runs the full test suite before the story review in every pass whose gates are green, including re-review passes. A red suite bypasses the report check and review and goes to a fix while rounds remain, or to residual adjudication at the cap. The feature workflow then runs every configured quality command (including `quality.commands.test`) as repo gates at the start, and again as the final gates after the branch fix.

```json
{
  "execution": {
    "regressionGate": {
      "enabled": true,
      "acceptOnTimeout": true,
      "timeoutSeconds": 600
    }
  }
}
```

The values shown above are the defaults. `timeoutSeconds` accepts 10-3600. It is also the timeout for the suite-running commands the agent runs through `RunCommand` (`test`, `testScoped`, `coverage`; #2536), so the agent is never held to a shorter budget than this gate. Other declared commands keep the 120s runner default. `acceptOnTimeout` makes the gate op report a timeout as `passed-on-timeout`, but the workflow treats that status as red like `timeout`: a suite that hit its timeout is a red `full-suite` gate, because it never finished. `enabled: false` skips the in-loop full-suite gate (`fullSuiteGateOp`).

---

[Back to README](../../README.md)
