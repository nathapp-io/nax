# Proposal: draining `check:test-typecheck` and `check:test-as-unknown-as` (#1514 phase 2)

Successor to `HANDOFF-1514-cast-sweep.md`. Written against `chore/1514-test-debt-drain`
at `f91e94fb2`. Every number below was measured on that tree, not recalled.

**State at hand-off:** casts **102** (from 681), typecheck errors **1946** (from 1969),
`asAny=1398`, `tsSuppress=54`, `ratchetAllow=107`, `absentValue=17`.

The cast ratchet is done — its remaining 102 are documented exceptions. The typecheck
ratchet moved **1.2%** across ten sessions. That asymmetry is the thing to explain
before proposing anything.

---

## 1. Why phase 1 stalled on typecheck

Phase 1 removed casts by substituting factory calls. A cast is a *local* lie: delete it,
call `makeX()`, done. A typecheck error is usually a *structural* one — the fixture is
the wrong shape, or the seam it is assigned into has no type that a stub can satisfy.
Substituting a factory does not reach those.

Worse, the two ratchets are **coupled in the wrong direction**. 189 of the 1946 errors
are `TS2352`, whose message text is literally:

> …may be a mistake because neither type sufficiently overlaps with the other.
> **If this was intentional, convert the expression to `unknown` first.**

TypeScript is instructing the author to write `as unknown as X`. Naively draining
typecheck pushes ~189 errors straight into the cast ratchet, which is at its floor.
Blocked there, the next cheapest move is `as any`; blocked there, `: any`. **The drain
has to be designed around this or it will just relocate the debt.**

---

## 2. The blocker (#1682) is real but is not the biggest leak

#1682 is correct: `EXEMPT_FILES` in `check-test-escape-hatches.ts` is per-file, so
`test/helpers/absent.ts` — exempted only because its two `absentValue<T>()` *declarations*
match the call-site pattern — is also invisible to `asAny`, `tsSuppress` and
`ratchetAllow`. Fix it. But the exposure is one file.

Measured against the whole of `test/`, the counters miss far more than that:

| Escape hatch | Occurrences in `test/` | Counted by |
|:--|--:|:--|
| `as any` | 1406 | `asAny` (1398 — the 8-way gap *is* `EXEMPT_FILES`) |
| **`: any` annotations** | **453** | **nothing** |
| **single `as T` casts** | **~2159** | **nothing** |
| `@ts-expect-error` / `-ignore` / `-nocheck` | 54 | `tsSuppress` |
| `as unknown as` | 102 (+107 allow-marked) | cast ratchet |

`: any` is the one that matters for *this* drain. 125 of the 1946 errors are `TS7006`
(*parameter implicitly has an `any` type*). The cheapest possible "fix" is to write
`: any` on the parameter — it clears 125 typecheck errors, moves **zero** counters, and
adds 125 units of debt. `biome`'s `noExplicitAny` would catch it, but it is `"off"` for
`test/**` in `biome.json` pending exactly this drain.

**So: the guard has to be widened before the drain starts, not after.** That is
step 0 below, and #1682 folds into it.

---

## 3. What the 1946 errors actually are

Clustered from a full `tsc -p tsconfig.test.json` run. Seven families cover 1500 of them.

| # | Family | Errors | Files | Root cause sits in |
|:--|:--|--:|--:|:--|
| F1 | `execute(input, ctx, deps)` — arity | **101** | 11 | **`src/`** — the deps param is not in the interface |
| F2 | `Cannot find name 'PRD' / 'UserStory'` | **77** | 12 | `test/` — missing `import type` |
| F3 | `mock()` assigned into a typed dep slot | **173** | ~45 | `test/` — stub returns a partial object |
| F4 | Unknown/renamed fixture fields (`TS2353`/`TS2561`) | **131** | ~55 | `test/` — dead config keys, `defaultAgent`/`defaultTier`/`turnId`… |
| F5 | Implicit-any parameters (`TS7006`) | **125** | 25 | `test/` — untyped lambdas |
| F6 | `Observation` discriminated union | **45** | 4 | `test/` — no per-`kind` factory |
| F7 | `TS2352` "convert to `unknown` first" | **189** | 60 | mixed — the trap in §1 |

### F1 is a source defect, and it is the highest-leverage thing on this list

`DeterministicOperation` declares:

```ts
execute(input: I, ctx: CallContext): Promise<O>;
```

Seven ops implement it with a third injected-deps parameter:

```ts
async execute(input, ctx, deps: VerifyScopedDeps = _verifyScopedDeps): Promise<…>
```

TypeScript ignores *optional* extra parameters when checking assignability, so `src/`
compiles clean and the deps seam is **silently erased from the operation contract**.
Every test that exercises the seam then gets `TS2554: Expected 2 arguments, but got 3`.
101 errors, and — per the handoff's own Patterns item 8 — the arity error *suppresses*
the checks behind it.

I prototyped the fix and measured it (then reverted; the tree is clean):

```ts
export interface DeterministicOperation<I, O, C = NaxConfig, D = void>
  extends Pick<OperationBase<I, O, C>, "name" | "stage" | "config"> {
  readonly kind: "deterministic";
  readonly timeoutMs?: never;
  execute(input: I, ctx: CallContext, deps?: D): Promise<O>;
}
```

plus `AnySlot` in `src/execution/story-orchestrator/types.ts` widened to
`DeterministicOperation<any, any, any, any>`, and `D` supplied at the seven op
declarations.

| | Result |
|:--|:--|
| `bun x tsc --noEmit` (src) | **0 errors** |
| test typecheck | **1946 → 1890 (−56)** |
| per-file gate | **`worse: 0`** |
| `TS2554 Expected 2, got 3` | 101 → **6** |
| `TS2741` (missing required property) | 79 → **118 (+39)** |

The +39 is the point, not a regression. All 39 are one field — `resolution` missing from
`ResolvedTestPatterns` — which the arity error had been hiding. One
`makeResolvedTestPatterns()` factory clears them. **Net for F1: ≈ −95, and the type
system starts enforcing the seam it is supposed to describe.**

The interface also *found* two ops I had not annotated (`mechanical-lintfix-strategy`,
`mechanical-formatfix-strategy`) — it fails closed, which the old one did not.

### F3 is where the masked defects are

The failures are not tooling noise; bun's `Mock<T>` is `T & {…}` and is assignable when
the inner signature matches. They fail because the stub is genuinely wrong. Two verbatim
examples:

```
plan-decompose-ac13-14.test.ts(156,5): Type 'Mock<() => IAgentManager>' is not assignable
  to type '(cfg: NaxConfig, wd: string, featureName: string) => NaxRuntime'.
  Type 'IAgentManager' is missing the following properties from type 'NaxRuntime':
  runId, configLoader, workdir, projectDir, and 23 more.
```

The test hands an **agent manager to a slot that takes a runtime** and passes, because
only one method is ever reached. This is the same class of finding the handoff's §7
catalogue records — the argument for the whole issue, and it is worth more than the
counter.

### One family genuinely cannot be fixed at the call site

```
Argument of type '<I, O, C>(_ctx: CallContext, _op: Operation<I,O,C>, input: DebateHybridInput)
  => Promise<{ success: boolean; rebut: string }>' is not assignable to parameter of type
  '<I, O, C>(ctx: CallContext, op: Operation<I,O,C>, input: I) => Promise<O>'
```

No cast-free stub can implement a slot whose return type the *caller* chooses. 32 errors.
These need the contained-seam pattern (§4, D3) — one cast inside a helper, none at the
sites — exactly as `makeDebateRunner` did in phase 1.

---

## 4. The proposal

Four design changes, in dependency order. D0 must land first or the rest is unverifiable.

### D0 — make the guard total before draining anything

Widen `scripts/check-test-escape-hatches.ts`:

1. **Per-kind exemptions** (#1682, option 1 — the issue's own preference). Replace
   `EXEMPT_FILES: Set<string>` with `EXEMPT_BY_KIND: Map<string, ReadonlySet<HatchKind>>`.
   `absent.ts` becomes `{absentValue}` only; the three scanner test files keep all four.
   Add the test the issue asks for: an `as any` in an `absentValue`-exempt file **is**
   counted. Expected: **no counter moves** — if one does, the fix is wrong.
2. **Add an `anyType` counter** — an anchored type-position pattern (NOT a bare `/\bany\b/`, which also matches the English word in comments), or more simply
   let the existing `asAny` remain a subset of it. Measured baseline: **1890**. This is the counter that makes F5 honest, and it is a preview of
   `noExplicitAny` — when that rule is enabled for `test/**`, both counters retire together.
3. **Add a `looseCast` counter** — `\bas\s+[A-Z]\w*` minus `as unknown as` and `as const`.
   Baseline 2011 (after stripping the `as unknown as` tail, which the cast ratchet already counts). Not a drain target; it exists so §1's TS2352 pressure cannot escape
   silently.

Cost: one script, one test file. Nothing else in the plan is trustworthy without it.

### D1 — type the injected-deps seam in `src/`

The measured F1 fix above. Then generalise the convention: `RunOperation` and
`CompleteOperation` should get the same treatment if they grow deps params, and the rule
belongs in `.nax/rules/adapter-wiring.md` — **an injectable-deps parameter is part of the
operation's public type, not an implementation detail.**

182 files in `src/` export a `_xDeps` bag. Only the seven operation ops are structurally
erased today; the rest are plain module-level objects whose type is inferred correctly.
No change needed there.

### D2 — `makeDeps`: complete-by-construction dep stubs

The recurring shape across F1's fallout and most of F3 is a test writing a *partial*
deps object where the slot needs a total one. Today that is either a cast or an error.
Add one helper to `test/helpers/deps.ts`:

```ts
/**
 * A dep bag that is total by construction: real defaults, caller overrides on top.
 * Returns the exact dep type, so no cast is needed and a renamed member is a
 * compile error rather than a silently-ignored key.
 */
export function makeDeps<T extends object>(real: T, overrides: Partial<T> = {}): T {
  return { ...real, ...overrides };
}
```

Call site:

```ts
verifyScopedOp.execute(input, ctx, makeDeps(_verifyScopedDeps, { regression: async () => … }))
```

No cast, no missing member, and — the part that matters — **when `src/` renames a dep,
the test fails to compile instead of silently keeping the old key.** This subsumes the
ad-hoc `fakeDeps()` locals scattered through `test/unit/operations/`.

### D3 — contained seams for the unimplementable slots

Unchanged from the pattern phase 1 proved (`makeDebateRunner`, `8a42ec6f5`): the helper
holds **one** cast, the call sites hold none. Apply to the generic `callOp` slot (32
errors) and to the class-typed dep members that remain. Net cost is `+1` cast in
`test/helpers/`, `−N` errors at the sites. A seam under ~3 sites is not worth building —
write the stub out in place.

### D4 — a factory for the one discriminated union that needs it

`Observation` (F6, 45 errors, 4 files) is the case the handoff deferred as "needs a
per-kind switch — new test infra". It is a genuine gap, and it is small:

```ts
export function makeObservation<K extends Observation["kind"]>(
  kind: K,
  payload: Extract<Observation, { kind: K }>["payload"],
  overrides?: Partial<Omit<Observation, "kind" | "payload">>,
): Extract<Observation, { kind: K }>;
```

The generic ties `payload` to `kind`, so the union narrows at the call site and the
`category: string | undefined` widening that causes all 45 errors becomes impossible
to write.

---

## 5. Phasing and expected numbers

Each phase is independently landable and independently verifiable by the §1 five-step
loop in the handoff (which still applies verbatim, including "never `--update-baseline`
before `check:all` is green").

| Phase | Work | Typecheck Δ | Casts Δ | Risk |
|:--|:--|--:|--:|:--|
| **0** | D0 — per-kind exemptions (#1682) + `anyType` + `looseCast` counters | 0 | 0 | none; no counter may move |
| **1** | D1 — `DeterministicOperation<I,O,C,D>` + `AnySlot` + 7 ops + `makeResolvedTestPatterns` | **−95** *(measured)* | 0 | src type change, `src` tsc verified 0 |
| **2** | F2 — add the 12 missing `import type` lines | **−77** | 0 | none |
| **3** | D2 — `makeDeps`, applied to `test/unit/operations/**` | −60 … −120 | may go **up** by 0 | replaces `fakeDeps` locals |
| **4** | F4 — delete dead fixture keys (`defaultAgent`, `defaultTier`, `turnId`, …) | −131 | 0 | each deletion is a §7-style finding; expect fallout |
| **5** | F5 — annotate the 125 implicit-any params with **real** types | −125 | 0 | `anyType` counter from phase 0 must not move |
| **6** | D3 + D4 — seams and `makeObservation` | −77 | +2…+4 | design work |
| | **Cumulative** | **≈ −590 (1946 → ~1350, −30%)** | ≈ +3 | |

Phases 0–2 are ~172 errors of pure mechanical, zero-judgement work and should be one
session. Phase 3 onward needs the escalate discipline from handoff §5.

The residue after phase 6 is F7's harder half plus the long tail — those are the ones
where the fixture is deliberately wrong, and they should be documented as exceptions the
way §8 documented the 102 casts, not forced.

---

## 6. Definition of done, per phase

Unchanged from handoff §6, plus one new clause that is the whole point of D0:

- `bun run check:all` green and `bun run test` green **before** any baseline update.
- Per-file typecheck gate at `worse: 0`.
- `check:test-typecheck` baseline lower.
- `check:test-as-unknown-as` baseline **equal or lower**.
- **`asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`, `anyType`, `looseCast` all
  equal or lower.** No phase may trade one counter against another. A typecheck drop
  paired with an `anyType` rise is a failed phase, not a partial success.

---

## 7. What I recommend not doing

- **Do not fix F5 by annotating `: any`.** It is the single cheapest way to book −125 and
  it is pure debt. Phase 0's counter exists to make that impossible to land quietly.
- **Do not enable `noExplicitAny` for `test/**` yet.** 1406 `as any` + 453 `: any` would
  make `bun run lint` unusable. Ratchet first, flip the rule when the counters approach
  zero, retire both counters then.
- **Do not widen a `src/` type to fit a fixture.** Handoff §4 already forbids it and
  nothing enforces it; F4 will tempt hard. D1 is the counter-example of a *legitimate*
  src change: it makes the type describe what the code already does, and it makes the
  compiler stricter, not looser.
