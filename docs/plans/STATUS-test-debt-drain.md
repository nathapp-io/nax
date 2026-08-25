# Test-debt drain — status

The live doc for draining `test/`'s type-escape hatches. Successor to
`archive/STATUS-1514-typecheck-drain.md`, which ran the typecheck half of the same effort to
completion and is closed.

**§0 is the live state and is re-measured, not carried forward. §9 onwards is a chronological
log — each entry records what was true when written and is not edited afterwards.**

---

## 0. Current state — measured 2026-08-25 on `main` @ `44bb7bfdb`

| Counter | Value | Baseline | Drain target? |
|:--|--:|--:|:--|
| `tsc --noEmit` (src) | **0** | — | hard gate |
| `tsc --noEmit -p tsconfig.test.json` | **0** | — | hard gate |
| `as unknown as` | **101** | 101 | **yes — current target** |
| `asAny` | 1385 | 1385 | yes, then biome `noExplicitAny` retires it |
| `anyType` | 1868 | 1868 | yes, retires with `asAny` |
| `nonNullAssert` | 827 | 827 | yes, then biome `noNonNullAssertion` |
| `asNever` | 608 | 608 | yes |
| `ratchetAllow` | 106 | 106 | yes |
| `tsSuppress` | 40 | 40 | yes |
| `absentValue` | 17 | 17 | yes |
| `looseCast` | 1888 | 1888 | **no** — guard only, see below |

Working tree clean, no drain branch open, nothing parked. All gates green; `check:all` is
24 checks since `check:test-typecheck` was retired.

`looseCast` is not a target. It exists so the TS2352 population ("convert the expression to
`unknown` first") cannot escape into unmarked single casts while the cast ratchet sits at its
floor. Driving it down is not progress; keeping it flat while `as unknown as` falls is.

### What is already done

The typecheck half is finished and gated. `bun run typecheck` compiles all three projects:

```
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.contracts.json && bun x tsc --noEmit -p tsconfig.test.json
```

`check:test-typecheck`, its baseline and its parser are deleted — a counting ratchet at zero
reports a number where `tsc` reports a file and a line. Issue #1514 is closed. Against the
original start: test typecheck **2009 → 0 (−100%)**, casts **815 → 101 (−88%)**.

### The endgame, unchanged

From `archive/2026-08-22-1514-phase3c-test-debt-drain.md` §6, with steps 1–3 and 5 done:

1. ~~wire `tsconfig.test.json` into `typecheck`~~ done
2. ~~delete `check:test-typecheck` and its baseline~~ done
3. ~~keep the two cast ratchets as the permanent invariant~~ done — **and they are now more
   load-bearing, not less: with typecheck a hard gate at zero, a cast is the only remaining
   way to buy a green build.** They are what stops that trade.
4. **not done** — drop the `noExplicitAny: off` override for `test/**` in `biome.json`, which
   requires `asAny`/`anyType` at 0 and retires both counters properly. Same shape for
   `noNonNullAssertion` and `nonNullAssert`.
5. ~~update `.nax/rules/test-ratchets.md`, close #1514~~ done

---

## 1. Current target — `as unknown as` 101 → 0

**98 of the 101 are real casts. 3 are the phrase appearing in doc comments**
(`test/helpers/spawn.ts:6` ×2, `test/helpers/mock-logger.ts:16`) — the ratchet is a line
scan and counts prose. **Do not delete those comments to lower the number.** They document
why the helper exists; removing them is the counter going down with no work done, and both
comments are the kind that stop the cast being re-added. Leave them and land at 3, or replace
the phrase only if the surrounding sentence stays true.

Concentration is low: 66 files, the largest carrying 5. This does not cluster by file. It
clusters by **cast target**, which is where the leverage is.

| Cluster | N | Files | Shape |
|:--|--:|--:|:--|
| other / one-off | 49 | 33 | no shared cause — read each |
| `Record<string, …>` | 18 | 12 | reaching a private/index shape through a widened map |
| config shapes | 9 | 6 | `NaxConfig` and its slices — `makeNaxConfig` already exists |
| `Mock*` helper-internals | 7 | 7 | one per `test/helpers/*.ts`, casting the helper's own return |
| `Parameters<typeof f>[n]` | 6 | 3 | usually a defaulted param yielding `… \| undefined` |
| spawn-mock | 5 | 4 | `typeof Bun.spawn` / `ReturnType<typeof Bun.spawn>` |
| `PipelineContext` | 4 | 4 | `test/helpers/pipeline-context.ts` has a real `makeTestContext()` |

Regenerate this table any time:

```bash
bun run scripts/check-test-as-unknown-as.ts --list
```

### Order of work

1. **`Mock*` helper-internals (7)** — one cast per helper, in the helper itself. A cast on a
   shared helper's return hides an interface defect from every consumer *and* from the
   ratchets; fixing the interface makes the cast fall out. Highest signal per site, and it
   unblocks call sites elsewhere.
2. **`PipelineContext` (4) and config shapes (9)** — the "a correct factory already exists and
   the call site routes around it" shape. Migrate the call site; do not touch the helper.
3. **`Record<string, …>` (18)** — the largest single cluster and the most likely to be
   uniform. Prototype one before delegating the rest.
4. **`Parameters<typeof f>[n]` (6) and spawn-mock (5)** — these two may legitimately need a
   typed helper built first. `Parameters<…>[0]` on a defaulted parameter yields
   `… | undefined`; that is an indexing bug at the test site, not a src gap.
5. **other (49)** — the grind, last, once the recipes above are proven.

### Two things this population has already taught

- **The blast radius is what the edit changes, not what the file is.** A cast inside a shared
  helper's body is not a change to the helper's exported type.
- **Read which property the conversion error names, not which types the message prints.** A
  cast of a whole dep bag to `{ oneKey?: Mock<…> }` fails on that one key; the generic printed
  in the error text is a red herring.

---

## 2. The loop — per unit of work

```bash
# 1. see this unit's casts
grep -n 'as unknown as' <path>

# 2. fix (see forbidden list)

# 3. this file still passes
bun test <path> --timeout=60000
```

## 3. The loop — per commit, in this order

```bash
bun run typecheck        # src + contracts + test, all three must be 0
bun run check:all        # 24 gates green BEFORE any --update-baseline
bun run test             # full suite green
bun run check:test-as-unknown-as:update
bun run check:test-escape-hatches:update
git diff scripts/baselines/   # the target count DOWN, every other counter FLAT
```

**Never run `--update-baseline` before `check:all` is green.** The update writes whatever it
finds, including a regression.

Run `bun run test:coverage` as well, not just the suite, whenever an edit changes a value that
a classifier or switch reads (a status string, an outcome, a story/PRD shape). A per-file
coverage floor catches what a typecheck cannot: correcting an impossible fixture value can
delete a default branch's only coverage.

Commit as `test: <what>` with a body line `casts: P → Q`.

## 4. Forbidden — these lower the number without doing the work

- Adding `as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or `as never`.
- Adding `// test-ratchet-allow: as-unknown-as`.
- Replacing `as unknown as X` with `as typeof X` or any other single cast.
- Deleting a comment that merely *mentions* the phrase.
- Joining two cast-bearing lines into one, or reflowing to lower a count.
- Deleting, skipping, or `.skip`-ing a test, or narrowing a `describe`.
- Excluding a file from `tsconfig.test.json`.
- Weakening a **source** type in `src/` so a fixture fits. The fixture is wrong, not the type.
- Trading one counter for another. The system is closed: no counter may rise so another can
  fall. `git diff scripts/baselines/` is the check.
- Running `--update-baseline` on a count that grew.

The escape-hatch ratchet enforces the first two mechanically. The rest are on review.

**The right fix, every time:** the test claims to hold a `T`. Make it actually hold a `T` —
complete the fixture, tighten the helper's return type, correct the arity, import the type.
If the compiler is right that the mock is incomplete, complete the mock.

## 5. Escalate instead of guessing when

- The error says a **source** type is wrong, not the fixture. (This has produced real issues
  twice — #1702 was two of them.)
- Removing the cast changes what the test asserts.
- A fixture change makes a *different* test fail. That test was relying on the wrong shape;
  report it, do not paper over it.
- Removing the cast reveals the mock cannot satisfy the interface at all.
- The same file fails twice in a row. Two attempts, then hand it back.

## 6. Rulings carried forward from the typecheck drain

These cost real time to learn and apply unchanged here. Full accounts in
`archive/STATUS-1514-typecheck-drain.md` at the sections named.

- **Re-check the ratchet slack before every hand-off** (§0). Every drain commit that lowers a
  counter without re-baselining re-opens headroom a delegate can spend without noticing. This
  re-opened and was reclaimed seven times on the last issue.
- **There is usually a third option** (§44, §47). Between "delete the test" and "widen `src/`
  to fit the fixture" sits "assert what is true now". Four inert `try {} catch {}` tests
  became one executable one that fails the day the feature is wired.
- **A defensive `?.` is not evidence of a tolerated absence** (§44). If the schema carries
  `.default()`, the key is always present after parse and the fixture was pinning an
  impossible state.
- **You do not have to reach a value through the seam that broke** (§44). The error names the
  seam, not the fix. Exporting the op was additive and loosened nothing.
- **"No caller in this file" is not "no caller"** (§47a). Scope the grep to the repo before
  concluding a feature is missing. This produced a wrong entry in a status doc and a wrong
  claim in a commit message.
- **An accepted exception is a ruling, not a law** (§47). A tier-3 "undrainable" ruling turned
  out to be an argument against `mock()`, not against the assignment; a plain generic arrow
  satisfied the slot.
- **Inert tests are the third population.** `try { … } catch {}` bodies outlive the refactors
  that invalidate them precisely because they cannot fail.
- **Verifying a cluster costs about as much as doing it.** Delegate a proven recipe with many
  sites left, not a small cluster — under roughly ten sites the review pass finishes the work.

## 7. Where the archived detail lives

| Doc | Holds |
|:--|:--|
| `archive/STATUS-1514-typecheck-drain.md` | the full 47-section log of the typecheck drain |
| `archive/2026-08-22-1514-phase3c-test-debt-drain.md` | the parent plan — gate inventory, biome interaction, phasing |
| `archive/PLAN-1514-callop-seam.md` | the `callOp` generic-in-return-position analysis |
| `archive/HANDOFF-1514-*.md` | eleven completed delegation briefs and their recipes |
| `.nax/rules/test-ratchets.md` | the live rule the gates enforce |

---

## 8. Log

### 8.1 Recipes A and B, and the helper-containment ruling (101 → 91, 2026-08-25)

Two shapes drained, both by **deleting** the cast rather than replacing it:

- **A — `DEFAULT_CONFIG` spread (6 sites, 4 files).** `...(DEFAULT_CONFIG as unknown as
  Record<string, unknown>)` → `...DEFAULT_CONFIG`. Spreading a typed object into an untyped
  literal never needed the widening.
- **B — `expect(x as unknown as Record<…>).toHaveProperty(…)` (4 sites, 1 file).**
  `toHaveProperty` takes any object. `loader-legacy-shim.test.ts` already used the bare form
  at two other lines, which is what proved the recipe before it was applied.

**The first question at every site is "is this cast doing anything at all?"** Ten of the first
ten answered no. Neither recipe needed a replacement construct, so neither could trade a
counter — the reason both landed clean on the first gate run.

### The seven `Mock*` helper casts are containment, not debt — do not drain them

§1's first-listed cluster was wrong and is corrected here. Each `test/helpers/*.ts` factory
ends with one `return x as unknown as MockY`, and each header says why: the real type is a
class with private state (`MergeEngine`'s `private worktreeManager`, `StatusWriter`'s private
state), so a stub cannot satisfy it structurally. The cast is the deliberate single
containment point for what used to be 12–17 casts at call sites — `makeStatusWriter`'s header
records "17 casts for one missing helper".

Every route out trades a counter: `Object.create(P) as C` is `looseCast` +1,
`new C(absentValue<W>())` is `absentValue` +1. Both are refused by the closed-system rule. A
shared `makeClassStub<C>()` would legitimately take 7 → 1, but that is a design decision on a
sub-ten-site cluster, which §6 says costs as much to verify as to do. Left alone, ruled
out of scope, and written into the handoff's §1 so a delegate does not rediscover it.

**Carry forward: a cast inside a shared helper is load-bearing in a way a cast at a call site
is not.** Count it, but do not target it — the number going down would mean the containment
was broken, not that the debt was paid.

Gates: typecheck 0 (all three projects), `check:all` 24/24, suite green (unit / 1173
integration / 38 ui, 0 fail). Casts **101 → 91**; every other counter flat.

### 8.2 Batch 1 delegated — two clusters, 91 → 57 (2026-08-25)

Two agents on disjoint file sets, working from `HANDOFF-cast-drain-batch1.md`, neither
committing or updating baselines. 40 sites drained across 23 files.

**Cluster 1 — typed-mock tuples (6 sites, 2 files).** `timeoutRetryMock` and `runPlanMock`
were untyped `mock(() => …)`, so every `.mock.calls[0]` read needed a hand-written tuple cast.
Typing the mocks at the real signatures (`TimeoutRetryInput`, `Parameters<DebateRunner["runPlan"]>`)
made the tuples infer and the casts fall out. **The fix was at the mock, not at the read** —
the brief said so and it held.

**Cluster 2 — incomplete fixture literals (29 sites, 21 files).** Mostly shape (a): a correct
factory existed and the call site routed around it (`makeTestContext`, `makePRD`, `makeStory`,
`makeNaxConfig`, the config selectors). Two new factories were added to
`test/helpers/mock-nax-config.ts` — `makeAdversarialReviewConfig`, `makeSemanticReviewConfig` —
built once because three files needed the same literal, per the brief's "propose a factory
rather than completing it five times".

Three sites are worth naming because the cast was load-bearing on nothing:
`post-run-inspection-exhaustion.test.ts:370` flowed through an untyped overrides bag;
`machine-invariants.test.ts:289` only needed the literal hoisted to a variable (TS
excess-property-checks fresh literals, not variables); `merge.test.ts` ×4 needed a *complete*
`context` because the signature is a shallow `Partial<NaxConfig>`, not a deep one.

### The gate the delegates were told not to run is the one that caught the breach

Both agents ran typecheck and their own tests, and both were green. `check:all` was not — a
cluster-2 edit pushed `curator.test.ts` to **809 lines against the 800 hard limit**, and four
files needed formatting. Compacted to 799 (typecheck 0, 23 tests pass) and `lint:fix` run.

Holding `check:all` and the full suite back bought parallel agents on one worktree, and the
cost was finding the breach at integration instead of at the edit. **`lint` and
`check:file-sizes` take seconds and belong in the delegate loop; only the six-minute chain and
the full suite are worth withholding.** Fixed in the next brief.

### Escalation — `AgentFallbackHop.costUsd` is required but read defensively

`test/unit/metrics/fallback-aggregates.test.ts:146` omits `costUsd` to simulate a record
deserialized from disk from before the field existed. `src/metrics/types.ts:120` declares
`costUsd: number` **required**; `src/metrics/aggregator.ts:237` reads `h.costUsd ?? 0`.

This is the mirror image of §6's "a defensive `?.` is not evidence of a tolerated absence" —
there the schema's `.default()` made the absence unreachable. Here the hops come off persisted
metrics and are **never zod-parsed**, so the absence is genuinely reachable and the interface
has drifted from what the code handles. Same family as #1702. `src/` decision, not a fixture
edit: the cast stays until it is ruled on, and per §6 loosening a field wants an ADR check
first.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14130 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103 — identical to `main`, no branch effect.
Casts **91 → 57**; `looseCast` **1888 → 1879** (fell, 36 single casts removed and none added);
every other counter flat. No counter traded.
