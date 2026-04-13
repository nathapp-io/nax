---
title: Test Strategies
description: Choosing a TDD strategy
---

## Test Strategies

nax selects a test strategy per story based on complexity, content, and security classification. The routing logic lives in `src/config/test-strategy.ts` (SSOT).

### Strategy Reference

| Strategy | Sessions | When | Description |
|:---------|:---------|:-----|:------------|
| `no-test` | 1 | Config, docs, CI, pure refactors with no behavior change | No tests written or run — requires `noTestJustification` in prd.json. If ANY runtime behavior changes, use `tdd-simple` or higher. |
| `test-after` | 1 | Exploratory/prototyping | Single session, tests written after implementation. Fallback for unrecognized strategy values. |
| `tdd-simple` | 1 | Simple and medium stories | Single session with TDD prompt (red-green-refactor) |
| `three-session-tdd-lite` | 3 | Complex stories | Three sessions (test-writer → implementer → verifier), relaxed isolation: test-writer may create minimal `src/` stubs for imports |
| `three-session-tdd` | 3 | Expert stories and security-critical code | Three sessions, strict isolation: test-writer writes failing tests only (no `src/` changes), implementer makes them pass without modifying test files |

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

The strict three-session isolation ensures test-implementation separation for security-critical code paths.

### Configuration

Configure the default TDD behavior in `.nax/config.json`:

```json
{
  "tdd": {
    "strategy": "auto"
  }
}
```

When `strategy` is `"auto"` (default), the planner selects the strategy per story using the complexity-based routing above. Set to a specific strategy value to override for all stories.

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
