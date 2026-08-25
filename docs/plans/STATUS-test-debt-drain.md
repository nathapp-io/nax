# Test-debt drain — status

The live doc for draining `test/`'s type-escape hatches. Successor to
`archive/STATUS-1514-typecheck-drain.md`, which ran the typecheck half of the same effort to
completion and is closed.

**§0 is the live state and is re-measured, not carried forward. §9 onwards is a chronological
log — each entry records what was true when written and is not edited afterwards.**

---

## 0. Current state — measured 2026-08-25 on `chore/test-debt-cast-drain` @ `3785929b1`

| Counter | Value | Baseline | Drain target? |
|:--|--:|--:|:--|
| `tsc --noEmit` (src) | **0** | — | hard gate |
| `tsc --noEmit -p tsconfig.test.json` | **0** | — | hard gate |
| `as unknown as` | **47** | 47 | **yes — current target, ~17 is the floor** |
| `asAny` | 1385 | 1385 | yes, then biome `noExplicitAny` retires it |
| `anyType` | 1868 | 1868 | yes, retires with `asAny` |
| `nonNullAssert` | 827 | 827 | yes, then biome `noNonNullAssertion` |
| `asNever` | 608 | 608 | yes |
| `ratchetAllow` | 106 | 106 | yes |
| `tsSuppress` | 40 | 40 | yes |
| `absentValue` | 17 | 17 | yes |
| `looseCast` | 1879 | 1879 | **no** — guard only, see below |

`as unknown as` went **101 → 47** across four commits on this branch (§8.1–§8.4); `looseCast`
fell 1888 → 1879 as a side effect of removing 36 single casts and adding none. Every other
counter is untouched, and no counter was traded in any commit. All gates green; `check:all` is
24 checks since `check:test-typecheck` was retired.

**What is left is not a queue.** Of the 47: **18 are the floor** (15 `test/helpers/` containment
casts, §8.1, plus 3 comment matches on 2 lines — `spawn.ts:6` carries two on one line, which is
why a per-line count reads 46), **2 are held escalations** (nax#1707 and the dead
`selectNextStories` seam, §8.4), and the remaining **27 are property-poke sites and one-offs
that each need a ruling rather than a recipe**. Delegation has
stopped paying here — §8.4's batch drained 10 sites and verifying it cost about as much, which
is §6's "verifying a cluster costs as much as doing it" arriving in practice. **The next move is
a ruling pass on the ~14 property-poke sites, not another delegated batch.**

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
original start: test typecheck **2009 → 0 (−100%)**, casts **815 → 47 (−94%)**.

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

## 1. Current target — `as unknown as` 47 → ~18

Re-measured on `3785929b1`. The ratchet counts 47 matches across 46 lines: `test/helpers/spawn.ts:6`
carries two on one line.

| Cluster | N | Drainable? |
|:--|--:|:--|
| containment — `test/helpers/*` + `_cycle-fixtures.ts` | 15 | **no** — §8.1. Do not edit |
| property-poke — `(x as unknown as { k: T }).k` | 13 | needs a ruling each — **next up** |
| one-off | 13 | needs a ruling each; includes both held escalations |
| spawn-mock | 3 | may need a typed helper built first |
| doc comments (2 lines) | 3 | **no** — prose, not work |

Regenerate any time:

```bash
bun run scripts/check-test-as-unknown-as.ts --list
```

### The floor, and why it is not 0

`archive/2026-08-22-1514-phase3c-test-debt-drain.md` §6.3 says the ratchets end "baselined at
0". That was written before the containment population was understood, and **~18 is the honest
floor** unless a `makeClassStub<C>()` seam is built (§8.1 weighs it and declines: 7→1 on a
sub-ten-site cluster, which §6 says costs as much to verify as to do). Whoever closes this out
should either build that seam deliberately or amend the endgame to say 18, not quietly leave a
0 that cannot be reached.

One row to re-check rather than assume: **`test/helpers/pipeline-context.ts:55` is
`} as unknown as PRD`** — a fixture literal that happens to live in a helper, not a containment
cast against a class with private state. `makePRD` exists. It was swept into the out-of-scope
list by directory, and directory is the wrong test. Verify before ruling it in or out.

### Next — the property-poke ruling pass (13 sites, owner work)

`(x as unknown as { k: T }).k = v` — reaching a property the declared type does not carry. Each
needs the same question answered, and the answer differs per site: **should that property exist
on the type?**

- If yes, it is `src/` interface drift — file it, do not edit the fixture. Two rows
  (`phase4-registry-cleanup.test.ts:50,53`, reaching `_registry`) are exactly the shape that
  produced #1702, and the nax#1707 investigation shows how fast this pays off.
- If no, the test is reaching through a seam it should not, and the fix is at the test.
- If the property is real but private, that is a third case — a deliberate test-only reach, and
  the honest outcome may be to leave it.

**Do not delegate this.** §8.4 is the evidence: a delegated batch drained 10 sites and verifying
it cost about as much. Below roughly ten sites, or where every site is a judgement call, the
review pass finishes the work anyway.

### Held, pending a ruling elsewhere

| Site | Blocked on |
|:--|:--|
| `fallback-aggregates.test.ts:146` | **nax#1707** — the fixture pins an impossible state; the wiring fix comes first |
| `unified-executor-abort.test.ts:91` | the dead `selectNextStories` seam (§8.4) — removing the mock likely drains the cast, but it changes the test's setup |

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

**That framing was wrong, and filing it properly overturned it — see 8.3.** The "records
deserialized from disk" premise the test comment states matches no code path that exists.
The cast stays, but for a different reason than the one written here.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14130 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103 — identical to `main`, no branch effect.
Casts **91 → 57**; `looseCast` **1888 → 1879** (fell, 36 single casts removed and none added);
every other counter flat. No counter traded.


### 8.3 Filing the escalation overturned it — nax#1707

Writing 8.2's escalation up as an issue meant grepping at repo scope instead of reading the two
files the error named, and the finding changed shape entirely.

**`ctx.agentFallbacks` has no writer.** `src/metrics/tracker.ts:295` reads it inside
`collectStoryMetrics(ctx: PipelineContext, …)`; `src/pipeline/types.ts:311` declares it; and
nothing in `src/` ever assigns it. The populated field is `AgentResult.agentFallbacks`, written
at `src/agents/manager.ts:656` — a different object, and `agentResult` is already a local nine
lines above the read. So ADR-012 PR-2's run-level swap-cost visibility is inert: `StoryMetrics.fallback`
is never emitted and `RunMetrics.fallback.totalWastedCostUsd` is never computed.

It survived because the field is conditionally spread — `...(ctx.agentFallbacks?.length && …)` —
so a never-populated field silently omits the metric instead of failing.

**The `costUsd` story was backwards.** 8.2 said the absence was reachable because the hops come
off persisted metrics. They do not: `deriveRunFallbackAggregates` is called at
`run-completion.ts:437` with the in-memory `allStoryMetrics` built during the same run, and no
`JSON.parse` of `StoryMetrics` exists anywhere in `src/metrics/`. `costUsd` is required on both
the producer and consumer types. So `aggregator.ts:237`'s `?? 0` guards an absence that is
currently unreachable, and the fixture pins an impossible state — **the same §6 ruling as the
`TestPatternConfig` case, not its mirror image.**

The cast still stays: removing it needs `absentValue<T>()` or a single `as X`, both trades. But
it stays as an impossible-state fixture awaiting the wiring fix, not as evidence of interface
drift.

**Carry forward: "escalate it" and "write it up" are different amounts of rigour.** The
escalation was produced by a delegate reading two files and was accepted at face value; the
issue needed a repo-scope grep, and that grep found a real inert feature underneath. Related to
§6's "no caller in this file is not no caller" — this is the same lesson arriving from the
other direction: **a field with no writer reads exactly like a field with a tolerated absence.**

Filed as **nax#1707** with the ordering trap written down: reconcile `AgentFallbackRecord` and
`AgentFallbackHop` (`storyId` optional vs required, `timestamp` present vs dropped) before
touching `costUsd`, and do not loosen `costUsd` to optional as a standalone change — with the
wiring broken there is no evidence either way.

### 8.4 Batch 2 delegated — `Parameters<…>` and capture-widening, 57 → 47 (2026-08-25)

Ten sites drained, one escalated, one gate breach caught at integration again.

**Cluster A — `Parameters<typeof f>[n]` (6/6).** The four `model-resolution.test.ts` sites took
`makeNaxConfig()`, which satisfies the real `Pick<NaxConfig,…> | Partial<NaxConfig>` parameter.
**Neither of the other two hit the defaulted-parameter trap §1 warned about** — both
`runOrchestratorE2E`'s `config` and `productionTriageSeam`'s `ctx` are non-defaulted, and both
fixture literals were already structurally complete instances of the real type. The casts were
dead weight. The trap is real but it was not this cluster's cause; that ruling is now spent.

**`makeNaxConfig` deep-merges, and that is a trap of its own.** The fourth site needs
`models.claude` to carry `fast` *only*, to prove the function throws. `deepMerge` fully replaces
a key only when the override is an **empty** object, so a non-empty override merged into
`DEFAULT_CONFIG.models.claude.balanced: "sonnet"` and the test would have silently stopped
exercising the throw path — green, and no longer testing anything. `makeSparseNaxConfig` (total
replace, no defaults merged) is the right helper for an intentional sparse override. **A factory
migration can quietly delete a test's reason to exist; check what the fixture was *omitting*,
not just what it sets.**

**Cluster B — capture-into-`Record<string, unknown>` (4/5).** Fix at the declaration, not the
assignment: `ResolvedPermissions`, `HookContext`, `SelectScopedTestsInput`. One needed
`DeferredRegressionOptions & Record<string, unknown>` because the assertion deliberately probes
a key the interface does not declare, to prove a legacy field is never passed — the intersection
keeps that probe type-checked instead of casting it away.

### Escalation — a dead mock in `unified-executor-abort.test.ts:91`

`deps.selectNextStories = mock(…)` assigns to a key that is not on the real
`_unifiedExecutorDeps`. `selectIndependentBatch` *is* injected (`unified-executor.ts:258`), but
`selectNextStories` is imported directly at `:36` and called at `:583`, so **the mock intercepts
nothing** and the three tests pass because the real function handles the fixture PRD correctly.

Verified independently before accepting it. This is the "inert tests" family from §6 seen in a
new place — not a test that cannot fail, but a *seam* that was never wired. Removing the dead
assignment would likely drain the cast too, but that changes the test's setup and is a judgement
call, so it stays for now.

### The third gate breach, and the pattern behind it

Batch 1 breached `check:file-sizes`; batch 2 breached `check:deep-relatives`
(`import … from "../../helpers/mock-nax-config"` instead of `@test/helpers`) — even though the
brief had added `lint` and `check:file-sizes` to the delegate loop after batch 1. **Each batch
breached a *different* gate that was not in its loop.** Adding gates one incident at a time is
the wrong shape of fix; `check:all` minus the six-minute lint chain is what belongs in the loop,
and the next brief says that instead of naming individual scripts.

Fixed by the owner (one-line import swap, `check:deep-relatives` back to 0, 6 tests pass).

Casts **57 → 47**. Remaining: 17 are the floor (15 containment + 2 comments), ~14 property-poke,
~13 one-offs and spawn-mock, 2 held escalations (`#1707`, the dead mock). **Realistic target is
~17, not 0**, and everything left needs a ruling rather than a recipe.
