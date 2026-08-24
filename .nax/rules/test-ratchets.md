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
- `check:test-escape-hatches` — counts the **eight** ways to silence a type error that
  neither of the other two can see; fails if any of them grows.

All three behave like the existing `check:nax-error` / `check:import-cycles` ratchets: they have a `--update-baseline` to lower the threshold when intentional improvements land, and `--list` to surface offenders.

`test/` is also linted by Biome (`bun run lint`), with three rules deferred for
`test/**` in `biome.json`. Those overrides are not a licence to use what they
disable — `noExplicitAny` in particular is deferred *because* the escape-hatch
ratchet is counting it instead (as `anyType`), and turns back on when the drain
retires it.

## Why all three exist

A strict `tsconfig.test.json` gate dropped onto 2140+ errors invites the path of least resistance: more casts. The cast ratchet prevents that. But a cast is not the only side door, and the others are wider:

| Escape hatch | Counted by | Notes |
|:--|:--|:--|
| `as unknown as T` | `check:test-as-unknown-as` | per match, not per line |
| `as any` | `check:test-escape-hatches` (`asAny`) | 1399 at the start of the drain — the biggest hatch by far |
| `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` | `check:test-escape-hatches` (`tsSuppress`) | |
| `test-ratchet-allow: as-unknown-as` | `check:test-escape-hatches` (`ratchetAllow`) | the cast ratchet's own hatch, so it is ratcheted too |
| `absentValue<T>()` / `nullValue<T>()` | `check:test-escape-hatches` (`absentValue`) | the sanctioned idiom for "this argument is deliberately missing" (`test/helpers/absent.ts`). Ratcheted, not free — see *Deliberately-absent values* below |
| `any` in type position — `: any`, `<any>`, `Record<string, any>` | `check:test-escape-hatches` (`anyType`) | a **superset** of `asAny`. Added in phase 2: `: any` was counted by nothing, and annotating a parameter is the cheapest way to clear a `TS7006` without fixing it |
| single `as T` casts | `check:test-escape-hatches` (`looseCast`) | **not a drain target.** 189 `TS2352` errors say *"convert the expression to `unknown` first"*, so draining typecheck pushes debt toward casts; this counter makes that visible. The `as unknown as` tail is stripped before counting so the cast ratchet does not double-count it |
| `as never` | `check:test-escape-hatches` (`asNever`) | the bottom type is assignable to **everything**, so one word silences any assignment error. `looseCast` anchors on `as [A-Z]` and missed it for two phases; 619 had accumulated when the counter landed |
| postfix `!` (non-null assertion) | `check:test-escape-hatches` (`nonNullAssert`) | clears `TS18047`/`TS18048` with no runtime check. Biome's `noNonNullAssertion` is **off** for `test/**`, so before this counter nothing in the repo saw it at all; 827 had accumulated. Use `assertDefined()` from `test/helpers/assert-defined.ts` instead — it narrows *and* throws |

Together they enforce "tests are valid instances of the types they claim to be", and that improvement is monotonic.

**The counters are a closed system: no change may trade one against another.** A typecheck
drop paired with an `anyType` rise is a failed change, not partial progress.

## When to lower the baseline

Only when a commit reduces the count deliberately. Do NOT lower to hide regression — the ratchet will then do nothing.

```bash
bun run check:test-typecheck:update        # after fixing N typecheck errors
bun run check:test-as-unknown-as:update    # after replacing M casts with factories
bun run check:test-escape-hatches:update   # after removing `as any` / `: any` / suppressions
```

Always run `bun run check:all` and see it green **before** any `--update-baseline`.
The update writes whatever it finds, a regression included.

## Deliberately-absent values

When the absence *is* the assertion — "what happens when this required argument is
missing?" — use `absentValue<T>()` / `nullValue<T>()` from `test/helpers/absent.ts`
rather than `undefined as unknown as T`. That file holds the project's only sanctioned
generic type-lie, contained in one place and counted at the call site.

`test/helpers/absent.ts` is exempt from the `absentValue` counter **only** — its own
declarations match the call-site pattern and would inflate it by two forever. Every other
counter still grades that file (GitHub #1682). Exemptions are per-kind; do not add a
whole-file one.

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
- Don't annotate a parameter `: any` to clear a `TS7006` implicit-any error. That is the
  cheapest possible non-fix; `anyType` exists to catch exactly it. Give the real type.
- Don't reach for `as never` or a postfix `!`. Both were uncounted through phases 1–2 and
  are the cheapest fixes for the two error families left in the residue — a `Mock<() => X>`
  in a typed dep slot, and `TS18047`/`TS18048`. Both are counted now. For `!`, the sanctioned
  replacement is `assertDefined(value, label)`; there is no sanctioned `as never`.
- Don't exclude files from a check, or add them to `EXEMPT_BY_KIND`. That map is only for
  the ratchets' own test files, whose fixtures contain the literal patterns — plus
  `test/helpers/absent.ts`, exempt from one counter and one counter only.
- Don't resolve a conflict in `scripts/baselines/*.json` with `--update-baseline`. It
  writes whatever it measures, so a merge that lost fixes is recorded as the new floor
  with every gate still green. Resolve to the elementwise minimum of both sides (a file
  absent from a side's `byFile` means **zero**, not unknown), then prove the tree meets
  it. See `docs/plans/HANDOFF-1514-phase2-delegable.md` § *Baseline conflicts*.
- Don't `--update-baseline` on a count that grew. That's a regression; revert instead.
  The one exception is a deliberate, reviewed *recount* of the same tree (as when the
  cast ratchet moved from per-line to per-match counting) — say so in the commit.
