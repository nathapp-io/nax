---
priority: 30
appliesTo:
  - "test/**/*.ts"
stages:
  - "context"
  - "tdd-test-writer"
  - "tdd-implementer"
  - "rectify"
  - "review"
description: "Test debt ratchets (typecheck errors, as-unknown-as casts, escape hatches) and when to move their baselines"
---

# Test Debt Ratchets

Issue #1514 ships three ratchets in CI to lock in the test/ typecheck invariant:

- `check:test-typecheck` — counts TypeScript errors in `tsconfig.test.json`; fails if grown.
- `check:test-as-unknown-as` — counts `as unknown as` casts in `test/`; fails if grown.
- `check:test-escape-hatches` — counts the three ways to silence a type error that
  neither of the other two can see; fails if any of them grows.

All three behave like the existing `check:nax-error` / `check:import-cycles` ratchets: they have a `--update-baseline` to lower the threshold when intentional improvements land, and `--list` to surface offenders.

`test/` is also linted by Biome (`bun run lint`), with three rules deferred for
`test/**` in `biome.json`. Those overrides are not a licence to use what they
disable — `noExplicitAny` in particular is deferred *because* the escape-hatch
ratchet is counting it instead, and turns back on when the drain retires it.

## Why all three exist

A strict `tsconfig.test.json` gate dropped onto 2140+ errors invites the path of least resistance: more casts. The cast ratchet prevents that. But a cast is not the only side door, and the other three are wider:

| Escape hatch | Counted by | Notes |
|:--|:--|:--|
| `as unknown as T` | `check:test-as-unknown-as` | per match, not per line |
| `as any` | `check:test-escape-hatches` (`asAny`) | 1399 at the start of the drain — the biggest hatch by far |
| `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` | `check:test-escape-hatches` (`tsSuppress`) | |
| `test-ratchet-allow: as-unknown-as` | `check:test-escape-hatches` (`ratchetAllow`) | the cast ratchet's own hatch, so it is ratcheted too |

Together they enforce "tests are valid instances of the types they claim to be", and that improvement is monotonic.

## When to lower the baseline

Only when a commit reduces the count deliberately. Do NOT lower to hide regression — the ratchet will then do nothing.

```bash
bun run check:test-typecheck:update        # after fixing N typecheck errors
bun run check:test-as-unknown-as:update    # after replacing M casts with factories
bun run check:test-escape-hatches:update   # after removing `as any` / suppressions
```

Always run `bun run check:all` and see it green **before** any `--update-baseline`.
The update writes whatever it finds, a regression included.

## Allow-list escape hatch

If a cast is genuinely unavoidable, add `// test-ratchet-allow: as-unknown-as` on the
cast's line or on either neighbouring line — the formatter reflows long lines and
moves trailing comments, so all three positions count. The cast ratchet skips it, and
`check:test-escape-hatches` counts it, so reaching for this is visible rather than free.

## What NOT to do

- Don't add `as unknown as`, `as any`, or a `@ts-` suppression to "fix" a typecheck
  error. Fix the factory, add the missing field, or tighten the helper's return type.
- Don't reach for `as typeof X` (or any other single-`as` form) to dodge the cast
  regex. It is a bypass, not a fix.
- Don't reflow code to lower a count — joining two hatch-bearing lines, or splitting
  a line away from its allow marker. All the scanners count per match for this reason.
- Don't exclude files from a check, or add them to `EXEMPT_FILES`. That list is only
  for the ratchets' own test files, whose fixtures contain the literal patterns.
- Don't `--update-baseline` on a count that grew. That's a regression; revert instead.
  The one exception is a deliberate, reviewed *recount* of the same tree (as when the
  cast ratchet moved from per-line to per-match counting) — say so in the commit.
