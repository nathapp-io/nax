# `as unknown as` drain — closed log (101 → 0)

Lifted out of `docs/plans/STATUS-test-debt-drain.md` §8.1–§8.13 on 2026-08-26, once the
`noNonNullAssertion` drain that followed it closed. Chronological; each entry records what was
true when written and is not edited afterwards.

The ratchet is now a **closed invariant**: `scripts/baselines/test-as-unknown-as-baseline.json`
is baselined at 0 and any nonzero reading is a regression to reject, not a number to work down.

The one ruling from this drain that stayed in the live doc is in its §6: *"every route out
trades a counter" is a survey, not a proof* — earned in §8.13 below.

Batch brief: `HANDOFF-cast-drain-batch1.md`.

---

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

### 8.11 The final ruling pass — 46 → 18, at the floor (2026-08-25)

§0's "the next move is a ruling pass on the ~14 property-poke sites, not another delegated
batch" was followed literally — owner work, two commits, every remaining non-floor site ruled
and drained. **18 is the floor** (14 containment + 3 comments + 1 held); the earlier "~17"
prediction was right, and the 18th site is a held escalation with a written ruling, not a
queue item.

**The property-poke cluster (13 sites): mostly dead casts, one private reach, one held.**

- `stage-assembler.test.ts:406,418` — `config.context.v2.providerTimeoutMs` is real
  (`runtime-types-context.ts:112`, read at `stage-assembler.ts:234`); direct assignment
  typechecks. The cast was dead weight.
- `manager.test.ts:227,237` — `runAs`/`completeAs` are public methods; direct assignment.
- `phase4-registry-cleanup.test.ts:50,53` — the `_registry` reach is a deliberate private
  reach, and the repo already has the containment seam for exactly this class of touch:
  `agentManagerInternals` (`test/helpers/agent-manager-internals.ts`, "contained here once
  instead of at every site"). The internals type gained `_registry`, the two call-site casts
  went away, and the helper's own containment cast still counts once. **§1's "exactly the
  shape that produced #1702" comparison did not hold here**: #1702 was an *undeclared method
  that callers used*; `_registry` is a declared private field with no external caller, so the
  route out was containment, not interface drift.
- `manager-abort.test.ts:98` — `_testAbort` exists nowhere in `src/`; the test invented a
  private hook. The mock closes over the `AbortController`, and the signal under test IS
  `controller.signal` — `controller.abort()` is the real mechanism.
- `curator-gc.test.ts:338`, `curator-seam.test.ts:315` — the `detail`/`pad` canaries are
  fixture-invented fields (the `Observation` union deliberately has no `detail`). Reached via
  `"in"` narrowing instead of a cast — same move as §8.4 cluster B: keep the probe
  type-checked, no counter traded.
- `telegram.test.ts:486` — `InteractionResponse.value?` is declared; dead cast.
- `schemas.test.ts:349,365` — `DebateConfig.stages` is real; dead cast.
- `crash-signals-idempotency.test.ts:36` — `process.exit` assignment needs only the trailing
  `as typeof process.exit`; the `process`-wide cast was dead.
- `stage-assembler.test.ts:616` — **held, with a ruling.** `PRD.feature` is required
  (`prd/types.ts:403`) and `assembleForStage` maps it unconditionally into
  `request.featureId` (`stage-assembler.ts:215`), so the `_unattached` fallback at `:272`
  cannot fire through this function. The test pokes `prd.feature = undefined` to reach an
  impossible state. The honest `_unattached` claim lives at the pipeline stage, where it IS
  reachable (`context-us004.test.ts:350` drives it via real `featureDir: undefined`).
  Deleting the test is forbidden by §4, weakening `PRD.feature` is forbidden by §4, so the
  cast stays with this ruling attached. **The §8.6-family lesson in miniature: a fallback
  that is dead in one function can be load-bearing in a sibling, and the fix is to pin it
  where it is alive.**

**The one-offs (13 sites): every one was a ruling, and every ruling paid.**

- `telegram-timeout.test.ts:51` — the `editMessageText` branch read the request body off the
  URL (`(url as unknown as Response).arrayBuffer()` — always throws, since the plugin passes
  a string URL, and the throw was swallowed by the plugin's catch). The sibling test reads
  `init.body`. Rewritten to match; the branch was inert-but-broken, §6's inert-tests family
  with a new costume.
- `adversarial-audit-shape.test.ts:388`, `pid-registry.test.ts:403` — hand-rolled spawn
  mocks replaced with `makeSpawn` / `makeSpawnResult` from `@test/helpers` (the §8.1
  "typed helper built first" route the spawn-mock cluster was waiting on).
- `acceptance-fix.test.ts:35` — local partial-`NaxRuntime` stub swapped for the shared
  `makeMockRuntime` (built on `createRuntime`, zero cast). §8.10's "nine files hand-built
  partial runtime stubs" lesson applied one file later.
- `build-hop-callback.test.ts:62` — dead cast; the literal satisfies `AgentRunOptions`.
- `build-hop-callback.test.ts:584` — §8.2's recipe verbatim: mock typed at the real
  signature, tuple infers, cast falls out.
- `call.test.ts:948` — the `"output" in result` probe works on the real `O` type; the cast
  only existed to satisfy a probe that does not need it.
- `call-exhausted-fallback.test.ts:85` — generic-return-position cast (`output as unknown
  as O` in a fixture `parse`). Every usage of `makeOpWithFallback` drives the empty-output
  branch (the agents always return ""), so the parse never needs to succeed: it now throws
  unconditionally, its return type is `never`, and `never` is assignable to `O`. The
  non-empty-parse claim is covered by a separate inline-op test that actually exercises it.
- `spawn-client-reasoning-effort.test.ts:77` — the file's "sole bridge" cast. The dep is
  `typedSpawn` (single-signature `(cmd, opts) => SpawnResult`), not overloaded `Bun.spawn`,
  so `makeSpawn` did NOT fit — but `mock()` typed at the dep's full signature
  (`mock(impl)` with `impl: typeof _spawnClientDeps.spawn`) yields a `Mock<T>` assignable
  to `T` directly. The bridge was the wrong seam, not a necessary one.
- `profile.test.ts:299` — non-string array entry supplied via `JSON.parse`, as an untyped
  config-file caller would; `parseProfileList`'s `typeof` guard stays pinned.
- `project-profile.test.ts:35` — dead cast; a spread is already an object.
- `plugin-loader.test.ts:186` — dead cast; `dynamicImport` returns `Promise<unknown>`.
- `tracker-context-metrics.test.ts:594` — corrupt `budgetPressure` supplied via
  `JSON.parse('"not-an-object"')`; the corruption literally arrives from JSON in the real
  world, so the fixture mechanism now matches the threat model.
- `pipeline-context.ts:55` — **§1's re-check row, and directory was indeed the wrong
  test**: `} as unknown as PRD` in `makeTestPRD` is a fixture literal whose fields
  (`project`/`feature`/`branchName`/`createdAt`/`updatedAt`/`userStories`) satisfy `PRD`
  directly. Dead cast. The floor drops 15 → 14.

**The held escalation drained: `unified-executor-abort.test.ts:94`.** The §8.4 dead
`selectNextStories` mock (a key not on `_unifiedExecutorDeps`, intercepting nothing — the
real function handles the fixtures) and the `Record<string, unknown>` deps bag existed only
for it. Both removed; `runIteration` is mocked at its real signature, and the three tests
still pass for the same reason they passed before — the real `selectNextStories` never had
interception to lose. **The §8.4 "judgement call, so it stays" became easy once the ruling
question was asked the §1 way: the property (`selectNextStories` on the deps bag) should NOT
exist, and the fix was at the test.**

**Carry forward: "the cast is dead" and "the cast is load-bearing" were both over-applied
before this pass.** Nine of the twelve drained sites answered §1's question with "the
property exists, the cast does nothing" — the largest single population was dead weight, not
judgement. The remaining three were each a different shape (private reach → contain;
invented hook → use the real mechanism; impossible state → hold with a ruling). The ruling
pass was cheap because the doc's §1 question, asked at each site, sorted them in one pass.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14156 / 1136 / 38, 0 fail),
coverage OK, 101 files below floor against baseline 103. Casts **46 → 18** (two commits:
33 after the property-poke cluster, 18 after the one-offs); `ratchetAllow` 106 → 105 and
`looseCast` 1879 → 1878 as side effects of deleting real casts; no counter rose.

### 8.12 The held escalation drained — 18 → 17, the floor reached clean (2026-08-25)

§1 said the held row "stays until either the `_unattached` claim moves out of
`assembleForStage` or §4 is amended, whichever comes first." **Neither was needed. The
ruling was sound but its premise was wrong: the cast itself was never necessary.**

`stage-assembler.test.ts:616` poked `(ctx.prd as unknown as { feature?: string }).feature =
undefined` to reach the `request.featureId ?? "_unattached"` fallback at
`stage-assembler.ts:272`. §8.11 read that correctly — `PRD.feature` is required
(`prd/types.ts:403`), `assembleForStage` maps it unconditionally into `request.featureId`
(`:215`), so the poke drives an impossible state — and then reasoned about which of §4's two
forbidden moves to take (delete the test, or weaken `PRD.feature`). It held because both are
forbidden.

**Both were the wrong question.** The cast was not load-bearing for the impossible state; it
was load-bearing for *nothing*. `PRD` is structurally assignable to the weak type
`{ feature?: string }` — the target's property is optional, `string` is assignable to
`string | undefined`, and excess properties are permitted from a non-literal source — so a
widened alias needs no assertion:

```ts
const widened: { feature?: string } = ctx.prd;
widened.feature = undefined;
```

The alias is the same object, so the poke still lands; `tsc -p tsconfig.test.json` stays at 0;
all 30 tests in the file pass and the `_unattached` assertion is unchanged. No test deleted,
no `src/` type weakened, no counter traded.

**Carry forward: "this cast pins an impossible state" and "this cast is required to pin an
impossible state" are different claims, and §8.11 proved only the first.** The ruling pass
asked §1's question ("does the property exist?") and, on getting "no — and it cannot", stopped
at the forbidden-moves fork instead of asking the follow-up: *does reaching this state need an
assertion at all?* Widening to a weak alias is the third option (§6's "there is usually a
third option" in a new costume) and it costs nothing — it is not a cast, not a counter trade,
and not an escape hatch, because the alias is still fully type-checked against everything it
does have. **Where a poke narrows a type rather than fabricating one, assignability usually
already permits it; check the direction before ruling a cast necessary.**

**The `makeClassStub<C>()` seam is declined a second time, on stronger grounds.** §8.1 left it
open as a design decision deferred on §6's cost rule; §1 now closes it. A repo-wide
`makeClassStub<C>(obj): C` is an unrestricted object-to-anything escape hatch importable from
every test file. It would take the counter 17 → 10 while making the system less safe than 7
casts each sealed inside a factory whose header records why it exists — which is precisely
§4's definition of lowering the number without doing the work. **Containment is counted, not
targeted; a seam that generalises containment stops being containment.**

The drain is closed. Against the original start: casts **815 → 17 (−98%)**, test typecheck
**2009 → 0 (−100%)**. The only open item is the endgame's, not the drain's — item 4
(`noExplicitAny` / `noNonNullAssertion` for `test/**`), plus amending §6.3's "baselined at 0"
to say 17.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail).
Casts **18 → 17**; escape-hatch baseline diff is the timestamp alone — every other counter
flat (`asAny` 1377, `anyType` 1860, `nonNullAssert` 820, `asNever` 608, `ratchetAllow` 105,
`tsSuppress` 40, `absentValue` 17, `looseCast` 1878). No counter rose.

### 8.13 The floor was not a floor — 17 → 0, the ratchet closed (2026-08-25)

§0 called 17 "the honest floor", §1 said "there is no queue", and §8.1 ruled the `Mock*`
helper casts "containment, not debt — do not drain them". **All three were wrong.** Every
one of the 17 came out, by four mechanisms none of the earlier passes had tried, and no
counter rose.

**A — the six class stubs (7 casts). `Object.assign` onto a real instance.**

Each factory ended `return stub as unknown as MockX`, where `MockX = RealClass & { method:
ReturnType<typeof mock> }`. §8.1 enumerated the routes out as `Object.create(P) as C`
(`looseCast` +1) and `new C(absentValue<W>())` (`absentValue` +1), and refused both under the
closed-system rule. **It never asked what the constructor needs.** The answer was: almost
nothing. `new ContextOrchestrator([])`, `new PluginRegistry([])`, `new WorktreeManager()` →
`new MergeEngine(…)`, `new InteractionChain({ defaultTimeout, defaultFallback })`, `new
Logger({ level: "error", suppressConsole: true })` (silent: no `filePath`, so it writes
nothing), `new StatusWriter(path, makeNaxConfig(), ctx)`, and `new DebateRunner({ ctx:
makeMockCallContext(), … })` — the last on a helper that already self-registers runtime
cleanup, so it adds no leak.

The type falls out for free: **`Object.assign(target, source)` returns `T & U`, which is
exactly the shape `MockX` already declared.** Overlaying the mocks onto a real instance
*produces* the intersection rather than asserting it:

```ts
return Object.assign(new ContextOrchestrator([]), { assemble: mock(…) }, overrides);
```

One trap: `overrides` must be a separate `Object.assign` argument, not spread into the
literal. Spreading `Partial<Record<keyof X, unknown>>` collapses the mock properties to
`unknown` and the intersection loses its `Mock` types.

**This is strictly safer than the cast, not merely equal.** The real constructors now
type-check their own arguments, and immediately caught an invalid `defaultFallback:
"approve"` in the `InteractionChain` config (the type is `"continue" | "skip" | "escalate" |
"abort"`). A cast can never catch that, because a cast checks nothing.

**B — the three private reaches. Element access after `instanceof`.**

`agentManagerInternals`, `telegramInternals` and `webhookInternals` cast an instance to a view
type exposing its privates. But **TypeScript's `private` is compile-time only, and element
access (`p["_x"]`) is the language's own sanctioned way through it** — no assertion needed.
Where the parameter was already the concrete class the accessors work directly; where it was
an interface (`IAgentManager`), `instanceof AgentManager` narrows to the class first. Each
helper now returns a live getter/setter view.

Also safer: the `instanceof` guard makes a wrong argument throw a named error instead of
silently reading `undefined` off a stub, which the cast could not do. Cost: `biome`'s
`complexity/useLiteralKeys` wants `p._x` — whose "fix" would not compile, which is why biome
marks it unsafe — so `biome.json` turns that one rule off for `test/helpers/*-internals.ts`,
recorded in both file headers.

**C — the four generic-signature casts. An overload with a loose implementation signature.**

`typeof Bun.spawn` is a set of generic overloads and `CallOpFn` is generic, so no concrete
value can satisfy either — the reason §8.1 and `_cycle-fixtures.ts` both called their casts
irreducible. They are reducible: **declare the strict signature as an overload and leave the
implementation signature loose.** Callers still see `SpawnStub` / `SpawnResult` /
`CallOpFn & Mock`; only the unexported implementation works in `unknown`, and it returns what
it actually built. This also retired `deepMerge`'s array-branch cast in `mock-nax-config.ts`,
where a generic body provably cannot narrow `DeepPartial<T>` to `T` from `Array.isArray(base)`
— `looseCast` fell 1878 → 1875 as a side effect.

Note the array branch was **not** dead: a type-level probe confirmed `NaxConfig` does have
array-valued top-level keys reachable through `makeConfigSlice`, so deleting it would have
been a silent behaviour change. §6's "no caller in this file is not no caller", one level up.

**D — the three comment matches (2 lines).** Both comments described the containment design
that A and C had just removed, so leaving them would have left two false comments in the
tree. This is *not* §4's forbidden "deleting a comment that merely mentions the phrase": the
prose had to change because the code changed. **Worth stating plainly anyway — a ratchet that
greps raw text counts prose, so the last 3 of 17 fell to an edit that changed no behaviour.**
If that ever becomes the difference between green and red, fix the counter to skip comments
rather than write around it.

`makeSpawnResult` earned an honest note while being edited. Its old comment claimed the cast
"widen[ed] through Subprocess so the fields above are still checked against it" — **false; a
cast through `unknown` checks nothing.** Adding `satisfies Partial<Subprocess>` does compile
and is the way to get that checking, and it reports three genuine divergences in the fake
(`stdin: null` against `number | FileSink | undefined`; both streams'
`Uint8Array<ArrayBufferLike>` against `Uint8Array<ArrayBuffer>`). Conforming them changes what
the fake hands the code under test, so it is left as a separate, filed change and the header
now records it instead of claiming a check that was never happening.

**Carry forward: "every route out trades a counter" was a survey wearing a proof's clothes.**
§8.1 enumerated two alternatives, found both blocked, and wrote a do-not-touch ruling that
§1's hand-offs and §8.11's ruling pass then inherited without re-opening — three passes over
the same 17 sites, each reasoning inside the same three-option frame (structural stub / cast
/ src change). Nothing clever broke it. The question was "what does this constructor actually
require?", and it had a one-line answer at five of six sites. **When a ruling says a cluster
is undrainable, check whether it enumerated the options or merely the ones already in mind —
and prefer the mechanism the language provides (constructors, element access, overloads)
before concluding none exists.**

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail),
coverage OK (87.83% lines / 87.48% functions, 101 files below floor against baseline 103).
Casts **17 → 0**; `looseCast` 1878 → 1875 as a side effect; every other counter flat. The
`as unknown as` ratchet is now a zero-baselined invariant that only regressions can move.

**Correction to this entry's first version, which reported a pre-existing e2e failure.
There was none.** `bun run test:e2e` — the script CI runs — passes 30/30 locally and on the
PR. The three "failures" were an artifact of how they were invoked: a bare
`bun test test/e2e/` inherits `bunfig.toml`'s 5s per-test timeout, while every
`package.json` test script passes `--timeout=60000`. `full-suite-rectify`'s slowest case
takes ~8s, so under the bare invocation it aborted at 5s, and the aborted test left state
that failed the NEXT file — surfacing as an "unrelated cross-file failure" in
`non-blocking-fix`. Nothing was wrong with either file.

**Carry forward: reproduce against the project's own script, not a hand-rolled invocation of
the same test files.** `bun test <dir>` and `bun run test:e2e` are not the same command, and
the difference was a flag that turns a passing suite into a cascade of misleading failures.
The claim reached a commit message, a status doc and a PR body before the gate itself was
ever run. Cheapest check available: run the gate, then read its exit code.

