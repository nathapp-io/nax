---
title: Test Strategies
description: Choosing a TDD strategy
---

## Test Strategies

nax selects a test strategy per story based on complexity, content, and security classification. Valid values and the planner guidance live in `src/config/test-strategy.ts` (SSOT); run-time classification lives in `determineTestStrategy()` (`src/routing/classify.ts`).

In workflow mode every story runs one implementer session with a story review and bounded fix rounds, and the implementer prompt requires per-AC TDD evidence. The strategy value is still computed by routing and stored in `routing.testStrategy`, but it does not select a session layout.

### Strategy Reference

| Strategy | When | Description |
|:---------|:-----|:------------|
| `no-test` | Config, docs, CI, pure refactors with no behavior change | No tests written or run — requires `noTestJustification` in prd.json. If ANY runtime behavior changes, use `tdd-simple` or higher. |
| `test-after` | Exploratory/prototyping | Single session, tests written after implementation. Fallback for missing or unrecognized strategy values. |
| `tdd-simple` | Simple and medium stories | Single session with TDD prompt (red-green-refactor) |
| `three-session-tdd-lite` | Complex stories | Legacy value: routed and stored, runs as one session in workflow mode |
| `three-session-tdd` | Expert stories and security-critical code | Legacy value: routed and stored, runs as one session in workflow mode |

### Complexity-Based Routing

The planner classifies each story's complexity by **scope and risk** — not acceptance criteria count. A story with 10 simple "add field" ACs is simpler than one with 3 ACs involving concurrent state management.

| Complexity | Default Strategy | Override |
|:-----------|:-----------------|:---------|
| `simple` | `tdd-simple` | `three-session-tdd` if security-critical |
| `medium` | `tdd-simple` | `three-session-tdd` if security-critical |
| `complex` | `three-session-tdd-lite` | `three-session-tdd` if security-critical |
| `expert` | `three-session-tdd` | — |

### Security Override

Security-critical stories **always** use `three-session-tdd` regardless of complexity. This applies when a story involves:

- Authentication, access control, role checks
- Credentials, tokens, sessions
- Cryptography, password hashing
- ADMIN-guarded endpoints, JWT validation, RBAC enforcement, password reset flows

At run time (`tdd.strategy: "auto"`), `isSecurityCriticalStory()` applies the same override when a story's **title or tags** contain security or public-API keywords (e.g. `auth`, `public api`, `breaking change`, `sdk`, `endpoint`). The description is deliberately ignored.

### Greenfield Override

When `tdd.greenfieldDetection` is on (default `true`) and a story routed to a three-session strategy value has **no existing test files** in its workdir, the routing stage downgrades it to `tdd-simple` (test-first, single session). Security-critical stories keep their three-session strategy. `no-test` stories are exempt.

### Configuration

Configure the default TDD behavior in `.nax/config.json`:

```json
{
  "tdd": {
    "strategy": "auto"
  }
}
```

| Value | Behaviour |
|:------|:----------|
| `auto` (default) | Per-story selection using the complexity-based routing above |
| `strict` | Always `three-session-tdd` |
| `lite` | Always `three-session-tdd-lite` |
| `simple` | Always `tdd-simple` |
| `off` | Always `test-after` |

`tdd.strategy` applies only when runtime routing classifies a story. A story whose `prd.json` already carries `routing.testStrategy` (which `nax plan` always writes) keeps that value — edit `prd.json` to change it.

### Legacy Strategy Names

These legacy values are auto-migrated:

| Legacy | Maps to |
|:-------|:--------|
| `none` | `no-test` |
| `tdd` | `tdd-simple` |
| `three-session` | `three-session-tdd` |
| `tdd-lite` | `three-session-tdd-lite` |

---

[Back to README](../../README.md)
