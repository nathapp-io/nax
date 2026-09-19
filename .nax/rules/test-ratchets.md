---
priority: 30
appliesTo:
  - "test/**/*.ts"
stages:
  - "tdd-test-writer"
  - "rectify"
  - "review"
description: "Test debt ratchets (as-unknown-as casts, escape hatches), the hard tsconfig.test.json gate that replaced the typecheck ratchet, and when to move the baselines"
---

# Test Debt Ratchets

**`test/` must typecheck clean.** `bun run typecheck` compiles `tsconfig.test.json`
alongside `tsconfig.json`; any error fails CI. There is no allowance and no baseline to
raise — fix the fixture.

It is a hard gate, not a ratchet. **That makes the counters below more necessary, not
less**: with no error budget left, a cast is the only way to buy a green typecheck.

## The two counted hatches

| Escape hatch | Counted by | Baseline |
|:--|:--|:--|
| `as unknown as T` | `check:test-as-unknown-as` (per match, not per line) | **0.** Any nonzero reading is a regression to fix at the site, never a number to work down or re-baseline |
| `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` | `check:test-escape-hatches` (`tsSuppress`) | **0.** Anchored to the comment opener, so prose *about* a directive does not count |
| `test-ratchet-allow: as-unknown-as` | `check:test-escape-hatches` (`ratchetAllow`) | **25, and that floor is not zero** — each site builds a deliberately-illegal value for a function whose job is surviving contract violations, so the cast *is* the test. Draining it deletes the coverage |
| single `as T` casts | `check:test-escape-hatches` (`looseCast`) | **Not a drain target.** `TS2352` pushes debt toward casts; this counter makes that visible. The `as unknown as` tail is stripped first, so no double-count |

Routes that replaced the last `as unknown as` casts: construct the real class and
`Object.assign` mocks over it (`Object.assign` returns `T & U`); element access (`p["_x"]`)
for a `private` reach; an overload whose implementation signature is loose where the public
one cannot be satisfied by any concrete value.

Both ratchets have `--update-baseline` to lower the threshold and `--list` to surface
offenders, like `check:nax-error` / `check:import-cycles`.

**The counters are a closed system: no change may trade one against another.** Clearing a
typecheck error by raising `looseCast` is a failed change, not partial progress.

## What biome gates instead

These shapes have a parser behind them at `error` severity, and **the parser is the
measure**. Do not reintroduce a counter for any of them — fix the rule instead.

| Shape | Gated by | Sanctioned replacement |
|:--|:--|:--|
| `as any`, `any` in type position | `suspicious/noExplicitAny` | Give the real type. Annotating `: any` to clear a `TS7006` is the cheapest non-fix |
| postfix `!` (non-null assertion) | `style/noNonNullAssertion` | `assertDefined()` from `test/helpers/assert-defined.ts` — it narrows *and* throws |
| `@ts-ignore` | `suspicious/noTsIgnore`, repo-wide | Fires on the phrase in **prose** too — a comment cannot discuss it |
| `as never` | `biome-plugins/no-as-never.grit` | There is no sanctioned `as never` |
| `absentValue<T>()` / `nullValue<T>()` | `biome-plugins/no-absent-value.grit` | See *Deliberately-absent values* |
| undocumented `} catch {}` | `biome-plugins/no-empty-catch.grit` | See *Empty catches* |

`test/**` defers exactly one biome rule (`performance/noDelete`), plus a narrower override:
`complexity/useLiteralKeys` is off for `test/helpers/*-internals.ts`, where element access
is what makes a `private` member reachable and the rule's "fix" would not compile.

Do not weaken a rule to make room. The severities and all three plugins are pinned behind
their own tests (`test/unit/scripts/biome-test-severity.test.ts`,
`biome-no-as-never-plugin.test.ts`, `biome-no-absent-value-plugin.test.ts`,
`biome-no-empty-catch-plugin.test.ts`), which assert the diagnostic *and* biome's exit code.

## Empty catches

`} catch {}` with **no comment and no statement** is a lint error. The error disappears with
no trace and the block can never fail. Ways out, in order of preference:

1. **Give the catch a reason** — a comment saying why nothing can be done, or a real log.
   A comment is enough; this is the intended route and what 204 of the repo's 214 empty
   catches already do.
2. **`await p.catch(() => {})`** when you simply do not care whether a promise rejected.
   Not a catch clause, so the plugin does not see it.
3. `// biome-ignore lint/plugin: <reason>` on the line **above the `try`** (not above the
   `catch` — the diagnostic spans the whole try statement).

## When to lower the baseline

Only when a commit reduces the count deliberately. Do NOT lower to hide a regression — the
ratchet will then do nothing.

```bash
bun run check:test-as-unknown-as:update    # after replacing M casts with factories
bun run check:test-escape-hatches:update   # after removing suppressions / allow markers / casts
```

Always run `bun run check:all` and see it green **before** any `--update-baseline`.
The update writes whatever it finds, a regression included.

## Deliberately-absent values

When the absence *is* the assertion — "what happens when this required argument is
missing?" — use `absentValue<T>()` / `nullValue<T>()` from `test/helpers/absent.ts`
rather than `undefined as unknown as T`. That file holds the project's only sanctioned
generic type-lie, contained in one place and flagged at every call site. It needs no
exemption from its own gate: the file *declares* the two functions rather than calling them.

Exemptions in `EXEMPT_BY_KIND` are per-kind, never per-file (GitHub #1682).

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
  cheapest possible non-fix; `noExplicitAny` catches exactly it. Give the real type.
- Don't reach for `as never` or a postfix `!`. Both are lint errors now. For `!`, the
  sanctioned replacement is `assertDefined(value, label)`; there is no sanctioned `as never`.
- Don't exclude files from a check, or add them to `EXEMPT_BY_KIND`. That map is only for
  the ratchets' own test files, whose fixtures contain the literal patterns.
- Don't resolve a conflict in `scripts/baselines/*.json` with `--update-baseline`. It
  writes whatever it measures, so a merge that lost fixes is recorded as the new floor
  with every gate still green. Resolve to the elementwise minimum of both sides (a file
  absent from a side's `byFile` means **zero**, not unknown), then prove the tree meets
  it. See `docs/plans/archive/HANDOFF-1514-phase2-delegable.md` § *Baseline conflicts*.
- Don't `--update-baseline` on a count that grew. That's a regression; revert instead.
  The one exception is a deliberate, reviewed *recount* of the same tree — say so in the commit.

## Rationale, adoption logs and biome-config maintenance

Out of scope for authoring a test; all of it is recorded elsewhere. Tier 1/2/3 rule
promotions and their drain numbers, the `useAwaitThenable` / `useArraySortCompare` false
positives, `linter.domains.types`, and the GritQL capture-group trap:
`docs/plans/biome-v2-rule-gaps.md`. Retired counters and what replaced them:
`docs/findings/2026-08-28-check-gate-retirement-sweep.md`. Drain history:
`docs/plans/STATUS-test-debt-drain.md`.
