---
title: Three-Session TDD
description: Strict role separation for complex stories
---

## Three-Session TDD

For complex or security-critical stories, nax enforces strict role separation:

| Session | Role | Allowed Files |
|:--------|:-----|:--------------|
| 1 | Test Writer | Test files only — no source code |
| 2 | Implementer | Source files only — no test changes |
| 3 | Verifier | Reviews quality, auto-approves or flags |

Isolation is verified automatically via `git diff` between sessions. Violations cause an immediate failure.

---

[Back to README](../../README.md)
