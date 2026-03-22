---
title: Test Strategies
description: Choosing a TDD strategy
---

## Test Strategies

nax selects a test strategy per story based on complexity and tags:

| Strategy | Sessions | When | Description |
|:---------|:---------|:-----|:------------|
| `no-test` | 1 | Config, docs, CI, pure refactors with no behavior change | No tests written or run — requires `noTestJustification` in prd.json |
| `test-after` | 1 | Refactors, deletions | Single session, tests written after implementation |
| `tdd-simple` | 1 | Simple stories | Single session with TDD prompt (red-green-refactor) |
| `three-session-tdd-lite` | 3 | Medium stories | Three sessions, relaxed isolation rules |
| `three-session-tdd` | 3 | Complex/security stories | Three sessions, strict file isolation |

Configure the default TDD behavior in `.nax/config.json`:

```json
{
  "tdd": {
    "strategy": "auto"
  }
}
```

See [TDD strategy options](#tdd-strategy-options) for all values.

---

[Back to README](../../README.md)
