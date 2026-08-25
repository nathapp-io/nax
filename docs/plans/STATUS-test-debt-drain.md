# Test-debt drain — status

The live doc for draining `test/`'s type-escape hatches. Successor to
`archive/STATUS-1514-typecheck-drain.md`, which ran the typecheck half of the same effort to
completion and is closed.

**§0 is the live state and is re-measured, not carried forward. §9 onwards is a chronological
log — each entry records what was true when written and is not edited afterwards.**

---

## 0. Current state — measured 2026-08-25 on `fix/1707-agent-fallback-metrics-wiring`

| Counter | Value | Baseline | Drain target? |
|:--|--:|--:|:--|
| `tsc --noEmit` (src) | **0** | — | hard gate |
| `tsc --noEmit -p tsconfig.test.json` | **0** | — | hard gate |
| `as unknown as` | **46** | 46 | **yes — current target, ~17 is the floor** |
| `asAny` | 1377 | 1377 | yes, then biome `noExplicitAny` retires it |
| `anyType` | 1860 | 1860 | yes, retires with `asAny` |
| `nonNullAssert` | 820 | 820 | yes, then biome `noNonNullAssertion` |
| `asNever` | 608 | 608 | yes |
| `ratchetAllow` | 106 | 106 | yes |
| `tsSuppress` | 40 | 40 | yes |
| `absentValue` | 17 | 17 | yes |
| `looseCast` | 1879 | 1879 | **no** — guard only, see below |

`as unknown as` went **101 → 47** across four commits on this branch (§8.1–§8.4); `looseCast`
fell 1888 → 1879 as a side effect of removing 36 single casts and adding none. Every other
counter is untouched, and no counter was traded in any commit. All gates green; `check:all` is
24 checks since `check:test-typecheck` was retired.

**What is left is not a queue.** Of the 46: **18 are the floor** (15 `test/helpers/` containment
casts, §8.1, plus 3 comment matches on 2 lines — `spawn.ts:6` carries two on one line, which is
why a per-line count reads 45), **1 is a held escalation** (the dead `selectNextStories`
seam, §8.4 — nax#1707 is resolved, §8.5), and the remaining **27 are property-poke sites and
one-offs that each need a ruling rather than a recipe**. Delegation has
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

## 1. Current target — `as unknown as` 46 → ~18

The ratchet counts 46 matches across 45 lines: `test/helpers/spawn.ts:6` carries two on one line.

| Cluster | N | Drainable? |
|:--|--:|:--|
| containment — `test/helpers/*` + `_cycle-fixtures.ts` | 15 | **no** — §8.1. Do not edit |
| property-poke — `(x as unknown as { k: T }).k` | 13 | needs a ruling each — **next up** |
| one-off | 12 | needs a ruling each; includes the one remaining held escalation |
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

### 8.5 nax#1707 fixed, and the issue's own fix was wrong — 47 → 46 (2026-08-25)

The held cast is drained, but not the way §8.3 predicted. **Reading `agentResult.agentFallbacks`
instead of `ctx.agentFallbacks` — the fix the issue proposed — would have left the metric just
as inert.**

`ctx.agentResult` is not the object AgentManager returned. `post-run.ts:140` *rebuilds* an
`AgentResult` from `planResult.phaseOutputs[implementerOp.name]`, which carries `success`,
`filesChanged`, `estimatedCostUsd` and `durationMs` and nothing else. Anything the manager
attached upstream is gone before `collectStoryMetrics` runs. One level further up, `callOp`
receives `outcome.fallbacks` from `runWithFallback` (`call.ts:413`) and **discards it** — it
returns only the parsed op output. `onSwapAttempt` has zero subscribers in `src/`, so the event
side was not a sink either. The hops died at `callOp`, two layers below where §8.3 was looking.

The fix is a writer, not a redirected read: a run-scoped `agentFallbacks: Map<string,
AgentFallbackRecord[]>` on `NaxRuntime`, appended by `callOp` and read by `collectStoryMetrics`.
That is the shape three sibling fields already use (`adversarialIterations`,
`semanticIterations`, `rectificationOscillations`), and because `makeMockRuntime` is built on
`createRuntime` it cost no mock churn. It also counts more than the issue's version would:
`callOp` runs for *every* op, so a swap during review or verification is attributed to the
story, where a rebuilt `ctx.agentResult` could only ever have carried the implementer's.

`ctx.agentFallbacks` is deleted rather than wired. A declared field with no writer and no reader
is what let this sit undetected; leaving it would invite the same bug back.

**`costUsd` stays required, and the `?? 0` is gone.** §8.3's re-analysis held up under the
wiring fix: the mapper fills `costUsd` from `AgentFallbackRecord`, where it is required, and
`deriveRunFallbackAggregates` still only ever sees in-memory metrics. So no ADR check was
needed — the guard was removed rather than the type loosened, and the impossible-state fixture
it justified was replaced by the *reachable* zero-cost case (an adapter that reported no cost,
which the manager records as `costUsd: 0`). That is §6's "third option" again: the test now
pins something true instead of being deleted or kept as fiction.

`timestamp` is dropped in the mapping. Nothing reads it, the hop shape already omitted it, and
`MAX_RETAINED_RUNS`'s own doc comment names `fallback.hops` as a size driver in metrics.json.

**Carry forward: a wrong reader and a missing writer look identical from the read site.** §8.3
grepped at repo scope and still landed on the wrong fix, because "the populated field is right
there on the line above" is a very convincing shape. What distinguishes them is following the
*value* forward from its producer, not the *name* backward from its consumer — the name matched
in two places and the value reached neither.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14135 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103 — identical to `main`, no branch effect.
Casts **47 → 46**; `nonNullAssert` 827 → 820 as a side effect of rewriting the retargeted
assertions from `metrics.fallback!.hops` to `metrics.fallback?.hops`. No counter rose.

### 8.6 The #1707 shape swept for, and three more found (2026-08-25)

§8.5's carry-forward — *a wrong reader and a missing writer look identical from the read
site* — is mechanisable. The signature is **a field that is declared, read, and assigned only
by tests**: the test's own write is the only source, so the assertion round-trips its setup and
the suite stays green while the metric is permanently wrong.

Swept 127 fields across `PipelineContext`, `StoryMetrics`, `RunMetrics`, `CallContext` and
`AgentResult`. Three live instances, all in metrics, all fixed here.

**`ctx.rectifyAttempt` — the two halves had different names.** `post-run.ts` wrote the count to
an *undeclared* `rectificationIterationCount` through `(ctx as unknown as Record<string,
unknown>)`, which nothing read; the tracker read the *declared* `rectifyAttempt`, which nothing
wrote. `firstPassSuccess` was therefore never disqualified by rectification — the entire point
of BUG-067 / #679. **The cast in `src/` is what let the two names drift**: a declared-field
assignment would not have compiled. Fixed by writing the declared field.

**`ctx.storyRuntimeCrashes` — the counter existed, in the wrong shape.** `StoryMetrics.runtimeCrashes`
was always 0. Crash retries *were* counted, in `_runtimeCrashRetryCounts`, but that is a
*consecutive* counter which any ordinary outcome clears so the retry cap measures a streak — the
wrong source for a per-story total. Fixed with a run-scoped cumulative `runtime.runtimeCrashRetries`,
tallied in `pipeline-result-handler` where `outcome === "retry-same"` is observed (that outcome is
returned only by the crash branch, and only when a retry actually happens — a capped crash pauses).

**`autofixAttempt` — never existed at all.** Not on `PipelineContext`, not anywhere in `src/`. It
entered through `makeCtx(story, overrides: Record<string, unknown>)` and was inert; the test
comment claimed a second gate that was never built. Column dropped, and the overrides bag
tightened to `Partial<PipelineContext>` so the next phantom fails to compile.

**Threading `runtime` fixed a fourth thing nobody was looking for.** `EscalationHandlerContext.runtime`
is optional and its only caller never passed it — so `tier-outcome.ts`'s four
`ctx.runtime?.costAggregator.byStory()[…] ?? ctx.totalCost` reads had *always* taken the fallback,
and escalation failure costs (which feed `accumulatedAttemptCost`) were the coarser number.

**Carry forward: the sweep's own control failed, and that is the useful part.** Run against
`main` it reports `agentFallbacks src-writers=1` — it would **not** have caught #1707, because
`manager.ts:656` writes the same field name onto a different type. Name-matching finds
zero-writer fields; it cannot find wrong-writer ones. Those needed a hand pass over every field
in the 1–2-writer band, checking whether the writer targets *this* type. **A field-name grep is a
lower bound on this class of bug, never a clean bill of health.**

Still open at the time of writing: `ctx.autofixPriorIterations` (closed in §8.8), and
`verifyPassed` / `semanticReviewResult`, written through the same
`(ctx as unknown as Record<string, unknown>)` cast as `rectificationIterationCount` was
(closed in §8.7).

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14138 / 1136 / 38, 0 fail),
coverage 101 files below floor against baseline 103. `asAny` 1385 → 1383 and `anyType` 1868 →
1866 from replacing `(ctx as any)` reads with typed ones; no counter rose.

### 8.7 The other two AC9 fields were dead, not miswired (2026-08-25)

§8.6 left `verifyPassed` and `semanticReviewResult` flagged. Checked, and they are a
**different outcome from `rectifyAttempt` despite an identical appearance** — worth recording,
because the shared appearance is what makes this class expensive to triage.

All three were added in one commit (#1084) under an AC that reads, verbatim:
*"AC9: applyPostRunInspection sets verifyPassed, semanticReviewResult,
rectificationIterationCount"*. **The AC pinned a write and no AC pinned a reader**, so the
tests pinned the write too and everything stayed green. That is the root cause of the whole
§8.6 cluster, not an accident of naming.

The three then diverged:

| Field | Declared? | Reader | Outcome |
|:--|:--|:--|:--|
| `rectificationIterationCount` | no (cast key) | none — but the declared `rectifyAttempt` had a starving reader | **wire** (§8.6) |
| `verifyPassed` | no (cast key) | none, anywhere, ever | **delete** |
| `semanticReviewResult` | no (cast key) | none, anywhere, ever | **delete** |

`rectifyAttempt` was a *miswiring*: a real consumer existed and was starved. These two are
simply *dead*: no declared counterpart, no consumer, and no duplicated logic elsewhere that
they were caching. Verify outcome already reaches routing through `tdd-failure-category.ts`
and review outcome through the findings pipeline. Checked for dynamic key reads (`ctx[...]`)
and for `{ ...ctx }` spreads into hooks or events before concluding — a name grep alone would
not settle "no reader" for a cast-written key.

Deleting them removed the last two `(ctx as unknown as Record<string, unknown>)` writes from
`post-run.ts`, which is the construct that let `rectificationIterationCount` drift from
`rectifyAttempt` in the first place: **a declared-field assignment would not have compiled.**

**The coverage ratchet fired, and the number was misleading.** `post-run.ts` fell 57.07% →
56.07%. Measured rather than assumed: `LF` 396 → 387, `LH` 226 → 217 — both down exactly 9,
and **uncovered lines 170 → 170, unchanged**. Deleting covered dead code shrinks the
denominator, so the percentage drops while nothing loses coverage. Baseline lowered for that
one file only; `--update-baseline` also swept in four unrelated pre-existing improvements and
dropped two files entirely, all reverted per §3's "every other counter FLAT".

**Carry forward: "no reader" is a stronger claim than "no writer" and needs more evidence.**
A missing writer shows up as a wrong value at a known read site. A missing reader shows up as
nothing at all, so ruling a field dead means excluding dynamic access and context spreads too —
and the fix is deletion, which the ratchets read as a regression until you check the absolute
numbers.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14133 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. `asAny` 1383 → 1377 and `anyType`
1866 → 1860 from the four deleted `(ctx as any)` assertions; no counter rose.

### 8.8 `autofixPriorIterations` — superseded, a third diagnosis (2026-08-25)

The last field flagged in §8.6, and it lands on **neither** of the previous two answers. Three
fields with one appearance have now produced three different correct actions:

| Field | Diagnosis | Action |
|:--|:--|:--|
| `rectifyAttempt` | miswired — real reader, starved | wire the writer (§8.6) |
| `verifyPassed`, `semanticReviewResult` | dead — no reader ever existed | delete (§8.7) |
| `autofixPriorIterations` | **superseded** — the feature shipped in another shape | delete |

`docs/specs/2026-05-02-adr-022-implementation-plan.md:909,922` shows the planned wiring
(`ctx.autofixPriorIterations = result.iterations` and `iterations: ctx.autofixPriorIterations ?? []`).
Neither line was ever implemented. ADR-022's carry-forward shipped instead as the run-scoped
`runtime.adversarialIterations` / `runtime.semanticIterations` maps, read and written at
`story-orchestrator/run-phase.ts:173-222` — the same run-scoped-map shape §8.5 and §8.6 reached
for independently, and for the same reason: `PipelineContext` is rebuilt every attempt.

So this is not a missing feature. The field is the residue of a design that shipped differently,
and its only `src/` mention besides the declaration was `ctx.autofixPriorIterations = undefined`
in `releaseHeavyPipelineContext` — a memory-release of something never populated. Deleting it
also retired a now-unused `Iteration` import in `pipeline/types.ts`.

**Carry forward: check whether the feature shipped elsewhere before calling a field dead.**
"No reader" and "no writer" are both satisfied by a superseded field, so neither test
distinguishes it from genuine dead code — but the actions differ in what you should look for
first. The plan doc named the intended wiring, and grepping the *shipped* mechanism from it
(`adversarialIterations`) settled in one step what field-name greps could not.

**The coverage ratchet fired again, the same way.** `iteration-runner.ts` 12.32% → 12.01%.
Measured: `LF` 284 → 283, `LH` 35 → 34, both down 1, **uncovered 249 → 249, unchanged** — the
one deleted line was covered. Baseline lowered for that file alone. This is now twice in three
commits: **deleting covered dead code always trips a per-file percentage ratchet, and the
absolute uncovered count is the number that decides whether it is real.**

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14133 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. No escape-hatch counter moved.

### 8.9 What code review caught that the sweep did not (2026-08-25)

An independent review of the branch found three defects the field sweep could not, because
none of them is a field-name problem.

**`rectifyAttempt` undercounted.** `runRectification` re-enters within a single attempt
(`execution-plan.ts:201,257,367`) and `phaseOutputs.rectification` is last-write-wins, so a
later cycle exiting with 0 iterations erased an earlier cycle's 2 — restoring the #679
disqualification in name only. Fixed by accumulating at the source; `iterationCount` had
exactly one reader, so the semantics change was safe. The existing envelope test in
`story-orchestrator.test.ts` asserted `1` and now asserts `2`, which is the honest number:
the plan runs two cycles and the stub reports one iteration each.

**Threading `runtime` would have switched on a billable LLM call.** `tryLlmBatchRoute` bails
without a runtime (`router.ts:361`), and `handleTierEscalation`'s only caller never passed one,
so the hybrid post-escalation re-route has never run. The threading added for cost attribution
would have activated it — a real LLM dispatch per escalation whose result lands in
`runtime.routingCache` and can change the tier the retry runs at. Deliberately **not**
forwarded; filed as nax#1710.

**The fix does not reach failed or parallel stories.** `collectStoryMetrics` runs only on the
success path (`backfill-story-metrics.ts:6` says so outright), and parallel mode builds its
`StoryMetrics` literals inline (`unified-executor.ts:413,436`) without ever calling it. So
`deriveRunFallbackAggregates`'s exhausted rule — `!story.success && lastHop.category ===
"availability"` — is structurally dead, and `parallelCount > 1` runs write both new maps and
read neither. Filed as nax#1709; the code comments now say "sequential success path" rather
than "every op".

**Carry forward: a mechanical sweep finds a shape, not a defect class.** §8.6's sweep was built
to find "declared, read, written only by tests" and it found exactly that — three times, all
correctly. It could not find a field that *is* written correctly but by a last-write-wins path,
nor one whose reach stops at a path boundary, nor a side effect on an unrelated inert feature.
**Every one of the review's findings was about reach or timing, not naming.** Pair the sweep
with a reviewer that follows the value to its consumer.

One review finding was itself wrong and worth recording: it reported the changed `story:paused`
/ `story:failed` cost source as unpinned by any test. The sibling emitter in
`preIterationTierCheck` *is* pinned in both directions
(`tier-escalation-story-failed.test.ts:161,203`) — it was `tier-outcome.ts`'s four sites that
were uncovered, and those now have a test each way. **Verify the reviewer too.**

### 8.10 Closing #1709 — the metric now reaches failed and parallel stories (2026-08-25)

§8.9 filed the two reach gaps rather than fixing them. Fixed here, because "the metric is
wired" and "the metric works" turned out to be different claims.

**Failed stories.** `synthesizeBackfillMetric` is already the single source of truth for the
`execution-failed` synthesis and already hardcoded `runtimeCrashes: 0`, so it was the right
seam: it now takes `fallbackHops` and `runtimeCrashes` and emits them. The caller reads the
run-scoped stores, which outlive the per-attempt `PipelineContext` — that property, chosen in
§8.5 for a different reason, is what makes the failure path recoverable at all. Completion-phase
spend still carries neither, correctly: nothing executed.

This makes `deriveRunFallbackAggregates`'s exhausted rule reachable for the first time. It
requires `!story.success`, and before this only successful stories ever carried hops, so the
branch was dead the day it was written. Now pinned by a test that builds a failed story through
the real back-fill.

**Parallel stories.** The two inline `StoryMetrics` literals in `unified-executor.ts` are
extracted to `synthesizeParallelStoryMetric` — the same pure-function shape as the back-fill.
The extraction was not optional: `unified-executor.ts` is grandfathered at 768 lines, so the
ratchet forbade adding two fields to two literals, and the rule's prescribed remedy is to split
by concern. **The size gate pushed the change toward the better design**, which is the second
time on this branch (§8.7's `post-run.ts` was the first, in the opposite direction).

**Nine test files hand-built a partial `runtime` stub** and broke the moment the executor read
a new field off it. That is the cost of inline mocks the repo already gates against
(`check:test-mocks`) — a real helper would have picked the fields up for free.

**The escape-hatch ratchet refused the obvious test.** A new executor-level integration test
costs two `as never` casts, because `makeCtx` returns a partial stub that cannot satisfy
`SequentialExecutionContext`. Typing the helper properly is the rule's prescribed fix and is not
tractable here; adding a containment cast would trade one counter for another, which the closed
system forbids. **So the assertions were folded into the existing test that already pins the
parallel metric entry's shape** — same claim, same setup, zero new casts. Worth naming as a
pattern: when the ratchet blocks a new test, look for the existing test making the same claim
before reaching for a cast.

Gates: typecheck 0 (all three), `check:all` 24/24 with **every counter flat**, suite green
(14149 / 1136 / 38, 0 fail), coverage OK, 101 files below floor against baseline 103.
