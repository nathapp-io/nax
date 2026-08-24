# #1514 test-debt drain — status

Written 2026-08-23 to resume later. Supersedes nothing; it points at the docs that hold detail.

**Sections are a chronological log — §2, §24, §31 and the rest record what was true when they
were written and are not edited afterwards.** For the live state, read §0 and the last section.

---

## 0. Current state — measured 2026-08-24 on `chore/1514-tail-batch3-prep` @ `d5016b4e6`

Every number re-measured on a clean tree, not carried forward from a section below.

| | value | baseline |
|:--|--:|--:|
| `tsc --noEmit` (src) | **0** | — |
| test typecheck | **289** | 289 |
| `as unknown as` casts | **102** | 102 |
| `asAny` | 1386 | 1386 |
| `tsSuppress` | 40 | 40 |
| `ratchetAllow` | 106 | 106 |
| `absentValue` | 17 | 17 |
| `anyType` | 1875 | 1875 |
| `looseCast` | 1923 | 1923 |
| `asNever` | 619 | 619 |
| `nonNullAssert` | 827 | 827 |

Against the original #1514 start: casts **815 → 102 (−87%)**, typecheck **2009 → 289 (−86%)**.

All 25 gates green, every counter sitting **at** its baseline — there is no headroom left in the
ratchets for a delegate to spend. (§32's slack was reclaimed once in `b552fce6a` and it had
re-opened by 4 points; `4723c7a7a` reclaimed it again. **Re-check this before every hand-off** —
it re-opens every time a drain commit lowers a counter without re-baselining.)

The residue is 289 errors across 150 files. Clusters B and E are handed off in
`HANDOFF-1514-tail-recipes-batch3.md`; §38 has the histogram and §39 has the review that
re-scoped it.

## ✅ The dead-fixture-keys handoff is COMPLETE

`HANDOFF-1514-dead-fixture-keys.md` finished on 2026-08-23: all 10 keys, 38 errors, fully
gate-verified. Every commit below was run through the full six-step loop (src tsc, test
typecheck, per-file gate `worse: 0`, `check:all`, full suite, baseline update).

## ✅ The mechanical-fixture-fields handoff is COMPLETE

`HANDOFF-1514-mechanical-fixture-fields.md` finished on 2026-08-23 on
`chore/1514-implicit-any-params` (head `b5fb516`): all 3 clusters, **91 errors**
(1351 → 1260), fully gate-verified. Same six-step loop per commit. Details in §2b/§3b.

## ✅ The tail-recipes batch-2 handoff is COMPLETE (A–F)

`HANDOFF-1514-tail-recipes-batch2.md` finished on 2026-08-24 on
`chore/1514-tail-recipes-batch2` (head `e72ff2835`): clusters A–F, **28 edits, 27 errors,
17 files, 17 commits, 383 → 356 exactly** — the whole-batch measurement reproduced, not a
single-site estimate. `verifier-pick.test.ts` landed flat as §2B predicted (its dead key was
masked by a sibling TS2322) and was committed anyway; no second edit was hunted. Cluster G
(precheck config fixtures) is **not** in that number — it was left to the owner per §5, still
unmeasured. Details and the coverage gate in §34.

## 1. Where the work stands

| Phase | State | PR |
|:--|:--|:--|
| casts sweep (681 → 102) | ✅ merged | #1683 |
| escape-hatch guard, `DeterministicOperation<D>`, type imports | ✅ merged | #1683 |
| `config-slices` (`makeConfigSlice`) | ✅ merged | #1684 |
| `callop-seam` (monomorphic dep bags) | ✅ merged | #1684 |
| **`dead-fixture-keys`** | ✅ merged | #1686 |
| implicit-any params (`TS7006` → 0) | ✅ merged | #1687 |
| dead-config-keys (ADR-012 legacy) | ✅ merged — 40 errors (1260 → 1220) | #1688 |
| `ConfigSelector` variance | ✅ merged — 72 errors (1220 → 1148) | #1689 |
| **dead `@ts-expect-error` suppressions** | ✅ **done — 16 errors (1148 → 1132), tsSuppress 54 → 40** | — |
| Lane A (`HANDOFF-1514-lane-a.md`, §28–§30) | ✅ merged — 692 → 474 | #1695 |
| owner-only residue (§31) | ✅ merged — 474 → 415 | #1696 |
| escape-hatch guard + tail recipes B/C (§32) | ✅ merged — 415 → 393 | #1697 |
| **tail cluster A (`_planDeps.createRuntime`)** | ✅ **done — 393 → 383; §4 of the handoff was wrong, see §33** | #1697 |
| `DispatchContext` fixtures | ~~18~~ → **3 left**, drained incidentally by Lane A | — |
| ~~`makeObservation` (~90)~~ — ~~**really 9**~~ | ✅ **0 left** — drained incidentally; do not reopen | — |
| **tail recipes batch 2 (~40 errors, 8 clusters)** | handoff written, not started | — |

**Branches:** all merged as of 2026-08-24; nothing is parked locally.
- `chore/1514-dead-fixture-keys` — merged as #1686 (`e915b47e1`); branch gone.
- `chore/1514-implicit-any-params` — merged as #1687; branch gone.
- `chore/1514-guard-before-delegation` / `chore/1514-tail-recipes` — merged as #1697
  (`b552fce6a`); branches gone.

## 2. Last numbers I verified personally (at `d38bbb87`, branch head)

| | value |
|:--|--:|
| `tsc --noEmit` (src) | **0** |
| test typecheck | **1594** |
| `as unknown as` casts | **102** |
| `asAny` | 1394 |
| `tsSuppress` | 54 |
| `ratchetAllow` | 107 |
| `absentValue` | 17 |
| `anyType` | 1886 |
| `looseCast` | 2008 |

Against the original #1514 start: casts **815 → 102 (−87%)**, typecheck **2009 → 1594**.

## 2b. Numbers measured on `chore/1514-implicit-any-params` (branch head `b5fb516`)

| | before (at `666b9e0a7`) | after (at `b5fb516`) |
|:--|--:|--:|
| `tsc --noEmit` (src) | **0** | **0** |
| test typecheck | **1351** | **1260** |
| `as unknown as` casts | 102 | **102** |
| `asAny` | 1393 | **1388** |
| `tsSuppress` | 54 | 54 |
| `ratchetAllow` | 106 | 106 |
| `absentValue` | 17 | 17 |
| `anyType` | 1885 | **1880** |
| `looseCast` | 2008 | **2007** |

**−91 errors, exactly the handoff's estimate.** Every counter flat or lower — no trade.

## 3. The commits on the branch

**Handoff groundwork (verified by me):**

- `59674c69b` — dropped the dead `turnId` fixture key, supplied `internalRoundTrips`
  (1645 → 1633). The worked example for the handoff.
- `38de504e8` — the dead-fixture-keys handoff (initial, 49 errors).
- `a2547c3aa` — **corrected** that handoff to 38 errors after review found three bad verdicts.

**Dead-fixture-keys execution (all gate-verified end-to-end):**

- `d174bdc4f` — drop dead `skipGeneratedVerificationTests` / `minTestCoverage` (+ maxCostUSD)
- `1d997a92f` — drop dead `dangerouslySkipPermissions` / `getAll`
- `38da84486` — drop dead `estimatedComplexity` / `onWatchdogRegister`
- `fbaaa8a57` — drop dead `timeoutRetryCountMap` (1612 → 1610); deletion unmasked required
  `agentManager`/`sessionManager`/`abortSignal` on `PipelineHandlerContext`, supplied from
  `makeMockRuntime()` per §1 of the handoff
- `7400726e` — rename `ruleId` → `rule` on `Finding` fixtures, add `makeFinding`
  (`test/helpers/finding.ts`, same shape as `makeTurnResult`) (1610 → 1598); the rename
  unmasked required `source`/`category` on 10 literals in 4 files — **escalated per §7,
  user approved the factory** (59674c69b precedent)
- `d38bbb87` — rename `cacheCreationTokens`/`cacheReadTokens` → `*InputTokens` (1598 → 1594)

**Mechanical-fixtures execution (all gate-verified end-to-end, tag `#1514 mechanical-fixtures`):**

- `d7fd5b1` — cluster A: supply `maxScanFiles: 200` on `SmartTestRunnerConfig` fixtures
  (1351 → 1339, −12; schema default at `src/config/schemas-execution.ts:114`)
- `d6a39d4` — cluster B: supply `workdir: "/tmp/test"` on `AdversarialReviewInput` /
  `SemanticReviewInput` fixtures (1339 → 1329, −10; required at `src/review/adversarial.ts:77`)
- `e68d4dd` — cluster C: migrate 17 files' hand-rolled spawn fakes to the existing
  `makeSpawn` helper (1329 → 1273, −56); mock call-count assertions moved to `stub.calls`
- `b5fb516` — cluster C residue: close the last 13 spawn seams test-side (1273 → 1260):
  `treeDeps()` plain-arrow wrapper in resume-hydrate (10), `FakeProcSpec` gained
  `killResolvesExited` + `stdoutError` (3). **The `FakeProcSpec` extension was an approved
  escalation, ratified after the fact on 2026-08-23** — see §4a. It breached the handoff's
  §2 cluster-C bar as executed; the ratification is the record, not a waiver of the bar.

## 4. Revealed findings worth recording

- **`dangerouslySkipPermissions` documented as live, is not.** `CLAUDE.md` still says it is
  "deprecated — the resolver handles it", but it has **zero** occurrences in `src/`,
  including `src/config/`. **To file separately** — deliberately not touched (handoff §6).
- **The handoff's `ruleId` count (10) undercounted by 2**: `semantic-verdict.test.ts` also
  had two TS2551 property *reads* (`.ruleId`) alongside the three TS2561 literals; renaming
  only the literals would have broken the reads at runtime. All five renamed.
- **The handoff's landing estimate held**: 1633 → ~1595 predicted, landed 1594.
- **The mechanical handoff's cluster-C arithmetic was off by 2/2.** The handoff claimed 69
  errors across 17 files; the live tree had **71 across 19**. Two extra files
  (`test/helpers/fake-agent-manager.ts` `onPidSpawned`, `spawn-client-pid-callback.test.ts`
  `null`→`number`) were different error classes and correctly left out. The 71/17 counts in
  its per-file table otherwise matched.
- **`typeof Bun.spawn` is not assignable to `CaptureTreeStateDeps.spawn`.** The deps type is
  declared `(cmd: string[], opts: unknown) => unknown` (resume-hydrate.ts:5), and the strict
  overload rule rejects `typeof Bun.spawn` against it — even the real `_gitDeps` fails. src
  already wraps the seam at `run-phase.ts:56-58`; the test now wraps the `makeSpawn` stub the
  same way via a cast-free `treeDeps()` helper (single-arg call picks the `(cmd, opts?)`
  overload). Worth remembering: **`makeSpawn(...).spawn` is not universally assignable — check
  the target deps type before assuming the mechanical migration applies.**
- **Two hang tests needed a kill contract `FakeProcSpec` did not model.** `git.test.ts`'s
  SIGKILL test and `worktree/dependencies.test.ts`'s timeout test both require `kill()` to
  *resolve* `exited` (real Bun.spawn behaviour); `hang` only made it never settle. Fixed by
  adding `killResolvesExited` to `FakeProcSpec` (the worktree one already used the sanctioned
  `test-ratchet-allow` cast and was left alone). `otel-resource-git`'s two erroring-stdout
  fakes drove the new `stdoutError` field.

## 4a. The one escalation that was taken without asking — ratified 2026-08-23

`HANDOFF-1514-mechanical-fixture-fields.md` §2 (cluster C) rules a file **out of scope**
when its local fake models something `FakeProcSpec` does not, and names three examples:
a custom `kill` observer, a stdout that changes between calls, **a stream that errors**.
`b5fb516` hit two of the three — the `git.test.ts` / `worktree/dependencies.test.ts` kill
contract, and `otel-resource-git`'s erroring stdout — and instead of leaving those files
for a design pass, **extended the shared `FakeProcSpec`** (69 consumer files). §6's
"unmask exceeds ~2 sites with no existing factory" trigger also applied. The earlier
`makeFinding` factory (`7400726e`) is the precedent for how this should have gone: escalate
first, then build.

**Ruling: ratified.** 13 of the 91 errors rest on it and they stay. The evidence checked
before ratifying, not after:

- All 69 `makeSpawn` consumers green — **896 pass, 0 fail**.
- Behaviour-preserving for every existing caller. Both fields are optional and default off.
  The `exited` rewrite (a deferred `resolveExited` promise replacing `Promise.resolve(exitCode)`)
  is equivalent on both prior paths: non-hang resolves synchronously at construction;
  `hang: true` without the new flag never settles, exactly as `new Promise(() => {})` did.
- No `src/` change in any of the four commits — that §6 trigger was respected.
- Cluster A's one judgement call was handled correctly and independently confirmed: the only
  test asserting on the `maxScanFiles` cap is `test/unit/verification/import-grep-fallback.test.ts:35`,
  which sets its own value and is not among the 5 files touched. No fixture got a guessed 200
  where the cap mattered.

The breach was procedural, not technical. `b5fb516`'s commit **body** does disclose both new
fields; only its subject line is silent.

**The rule this leaves behind:** a handoff written for cheap mechanical execution must name
its shared helpers as off-limits, not merely say the *file* is out of scope. Extending a
69-consumer helper is design judgement wearing a mechanical fix's clothes.

## 5. Next actions, in order

1. ~~Open a PR for `chore/1514-dead-fixture-keys`.~~ **Done — merged as #1686** (`e915b47e1`).
2. **Open a PR for `chore/1514-implicit-any-params`** (14 commits, never pushed). Call out
   the `test/helpers/spawn.ts` contract change (§4a) in the PR body — the subject line of
   `b5fb516` does not mention it and a reviewer would miss it.
3. ~~Dead config keys.~~ **Done** — see §8.
4. ~~`ConfigSelector<Pick<…>>` variance.~~ **Done** — see §9.
5. ~~Dead `@ts-expect-error` directives.~~ **Done** — see §10.
6. **Then continue.** The mechanical slice is done (91 of 1351
   errors). The residue at `b5fb516` is **1260 errors**, and per `HANDOFF-1514-mechanical-fixture-fields.md`
   §7 the overwhelming majority is design work, not mechanical: `as unknown as`-shaped
   (190, concentrated in 6 files), `ConfigSelector<Pick<…>>` variance (32), the
   `CompleteOperation` vs `RunOperation` union (15), and ~30 dead config keys
   (`defaultAgent`/`defaultTier`/`timeout` — the dead-fixture-keys method applies, see
   `HANDOFF-1514-dead-fixture-keys.md`). Plan each cluster the same way: measure, prototype,
   then decide what is genuinely delegable.
7. Then the `DispatchContext` fixture cluster (18) — needs a factory decision, see §10.

**Re-cluster before starting any of them — the handoff's numbers have already moved.**
Measured on branch head `12651f098`: `TS2352` is **149**, not the 190 the handoff recorded,
and **`TS7006` is 0** — implicit-any params, this branch's nominal target, is fully drained.
Live top offenders are `parallel-batch` 36, `config/merger` 35, `cli-plugins` 35,
`story-orchestrator-resume-integration` 33, `story-orchestrator-run-phase-events` 28.
Ranked pick: dead config keys (~30, proven method) → `ConfigSelector` variance (32, the
`callop-seam` precedent applies) → `TS2352` (149, per-file seam design) → the
`CompleteOperation`/`RunOperation` union (15, explicitly not mechanical) last.

## 6. Traps this branch has already hit — do not relearn them

- **Deleting a dead key unmasks a second bug.** TypeScript reports an unknown property
  *instead of* a missing required one, so the typecheck total often does not drop by the
  number of keys removed. That is expected. The real gates are `src` tsc 0, per-file
  `worse: 0`, suite green. When the unmask exceeds ~2 sites with no factory, **escalate —
  do not invent values** (the `makeFinding` decision was an approved escalation).
- **Never regex over a nested object literal.** A non-greedy pattern matches the inner
  `JSON.stringify({…})` brace and shreds the file. Tell: the typecheck count collapses to a
  single digit, because tsc aborts at the first parse error.
- **`check:file-sizes` rejects line-adding fixes to grandfathered files.**
  `story-orchestrator.test.ts` is capped at 2006 lines; fixes there must be line-neutral.
- **A grep-based negative is not proof.** This misled me three times in one session:
  a `\b` word boundary silently fails on a quoted key (`"on-story-complete"`), a plain
  substring search over-matches (`getAll` "hits" `getAllAgents`), and "no fixture supplies a
  non-empty X" does not mean X is untested when a sibling file builds X from real inputs.
  Check the *consumers*, and use two independent greps.
- **A split commit needs its baseline regenerated at the intermediate state.** Committing
  the `ruleId` work while `fail-stale-complete.test.ts` still carried its 4 errors would
  have left the baseline claiming 0 for that file — the per-file gate would fail at the
  intermediate commit. Stash the later key's file, update the baseline, commit, pop.
- **No change may trade one counter against another.** A typecheck drop paired with an
  `anyType` or `looseCast` rise is a failed step. The `looseCast` counter has already
  rejected one of my own commits, correctly.

## 7. Doc map

| Doc | Holds |
|:--|:--|
| `PROPOSAL-1514-phase2-typecheck-drain.md` | the root-cause analysis and per-phase status |
| `HANDOFF-1514-dead-fixture-keys.md` | **done** — 38 errors, per-key verdicts, evidence, worked example |
| `HANDOFF-1514-mechanical-fixture-fields.md` | **done** — 91 errors, 3 clusters, traps (§5), escalation bar (§6) |
| `HANDOFF-1514-config-slices.md` | done — `makeConfigSlice` |
| `HANDOFF-1514-callop-seam.md` | done — monomorphic dep bags |
| `PLAN-1514-callop-seam.md` | the three-tier analysis behind it |
| `HANDOFF-1514-cast-sweep.md` | the original cast sweep, kept as the worked record |

Commit tags for un-started work are **descriptive** (`#1514 dead-fixture-keys`,
`#1514 mechanical-fixtures`), never `phase N` — the original #1514 plan already used
"phase 3a"/"phase 3c" for unrelated work.

## 8. dead-config-keys — done (1260 → 1220, −40)

On `chore/1514-dead-config-keys`, two commits, both through the full six-step loop.

`autoMode.defaultAgent`, `autoMode.fallbackOrder`, `routing.defaultTier` and
`execution.timeout` are absent from the runtime types. The first two are not merely dead:
`src/config/config-guards.ts` **rejects** them as pre-migration ADR-012 Phase 6 keys, so
every fixture carrying them described a config the loader would refuse to load. That made
the deletion verdict evidence-backed rather than a judgement call.

- `cd56ec941` — **27 of the 30 were one 14-line literal copy-pasted 9× in
  `cli-plugins.test.ts`.** `pluginsListCommand` reads only `plugins` and `disabledPlugins`
  (`src/cli/plugins.ts:27,33,48`), so all nine collapse to `makeNaxConfig({…})` carrying
  just those. Behaviour-identical — `DEFAULT_CONFIG` leaves both `undefined`, verified
  before the edit. Plus 4 inert `defaultAgent`/`fallbackOrder` fixture keys in 4 files.
- `59d90eb81` — retargeted `merger.test.ts`'s deep-merge test at live keys (−10).

### Three things worth keeping

- **TypeScript reports only the FIRST excess property per object literal.** Clearing
  `defaultAgent` alone unmasks `fallbackOrder` at zero net gain — they had to go together.
  This is the §6 unmask trap, hit *prospectively* for once instead of after the fact.
- **A cluster counted by error can be one fixture by cause.** "~30 per-key judgements" in
  the handoff was really one duplicated literal plus five strays. **Group the error list by
  file before estimating effort** — the 27/9 concentration was invisible in the key counts.
- **A stale fixture hides more than the key it names.** `merger.test.ts` also carried the
  wrong `models` shape (`ModelsConfig` is `Record<agentName, Record<ModelTier, ModelEntry>>`,
  `schema-types.ts:29`), and its `override` was typed `Partial<NaxConfig>` when a merge
  override is a `DeepPartial`. Fixing the two dead keys cleared **10** errors, not 2.
- **Negative control before committing a rewritten assertion.** Flipping the `tierOrder`
  expectation to `attempts: 5` failed the test (20 pass / 1 fail), proving the retargeted
  assertions bite rather than passing vacuously. A rewritten test that still passes proves
  nothing on its own.


## 9. ConfigSelector variance — done (1220 → 1148, −72)

On `chore/1514-config-selector-variance`, one commit through the full six-step loop.

**The handoff sized this at 32; live it was 73 across 24 files.** Re-measure before planning —
that is now twice this has mattered (`TS2352` was 149, not 190).

Root cause, single: `OperationBase.config` is declared
`ConfigSelector<C> | readonly (keyof NaxConfig)[]` (`src/operations/types.ts:102`) while
`ConfigSelector<C>` is **covariant** in `C` (`select(config): C` puts C in output position).
So `ConfigSelector<Pick<NaxConfig, "execution">>` is not assignable to
`ConfigSelector<NaxConfig>` — the assignment runs the wrong way down the subtype order.

Three patterns, **zero casts added** — the `callop-seam` precedent (fix the type, don't
contain a cast) held for all of them:

1. **`view.select(op.config)` — the union is a dead end at the call site (~40).**
   `test/helpers/config-selector.ts` narrows on the discriminant:
   `if (!("select" in config)) throw …; return config`. The `in` operator narrows the union
   cast-free, and `C` is **inferred** from the argument rather than asserted.
2. **Fixtures declared the wrong `C` (32).** All 8 story-orchestrator-family files typed
   their ops `typeof DEFAULT_CONFIG` while the selector was `pickSelector(…, "execution")`.
   Fixed by deriving C from the selector: `type TestOpConfig = ReturnType<(typeof testSel)["select"]>`.
3. **Two debate fakes stubbed `select` as `(_sel: unknown) => fullConfig`** — it never
   projected anything. Replaced with a faithful `(sel) => sel.select(fullConfig)`.

### Worth keeping

- **A narrowing cast that restates the type parameter silently kills the check it looks like
  it is preserving.** The three `finish-*` tests used `op.config as ConfigSelector<FinishConfig>`.
  Because the cast re-asserts `C`, a selector whose real slice drifted from `FinishConfig`
  stopped being a compile error — the cast was load-bearing in the wrong direction.
  `looseCast` 2006 → 2003 when they moved to the helper.
- **Derive a fixture's type parameter from the fixture, not from a constant.** `typeof DEFAULT_CONFIG`
  looked like "the config type" and was really "the widest possible slice". `ReturnType<(typeof sel)["select"]>`
  cannot drift from the selector it describes. Bonus: it is shorter than `typeof DEFAULT_CONFIG`,
  so the change stayed line-neutral inside the grandfathered `story-orchestrator.test.ts` cap.
- **Check the arithmetic before keeping an unmask.** Making `select` faithful in
  `runner-hybrid-coordinator` unmasked a `PackageRegistry`/`AbortSignal`/readonly cluster in
  the same fake. Kept because the file still went **6 → 4**; had it gone the other way the
  right move was to revert and leave the variance errors. The unmasked class is a different
  cluster and is left for its own pass.


## 10. Dead `@ts-expect-error` suppressions — done (1148 → 1132, −16)

On `chore/1514-dead-suppressions`, one commit. **`TS2578` is now 0** and `tsSuppress`
went **54 → 40** — a typecheck drop that also retires debt on a second counter, which no
earlier phase managed.

15 `TS2578` "unused directive" errors. 14 were genuinely stale — the thing each one was
waiting for had shipped:

- 10 in `on-all-stories-complete.test.ts` — "not yet in HookEvent"; it is, at
  `src/hooks/types.ts:16`.
- 3 in `interaction-chain-pipeline.test.ts` — one waited on `PipelineContext.interaction`,
  which exists at `src/pipeline/types.ts:143`.
- 1 in `story-orchestrator-resume-integration.test.ts` — on a reset loop whose body is a
  no-op.

### The one that was not stale — and the bug it was hiding

`run-regression.test.ts` AC3/AC4 is a **negative type test**: a deliberately-invalid literal
whose `@ts-expect-error` is the assertion. Its header documents the RED/GREEN contract
explicitly. The directive was unused **not because the guard passed, but because it was on
the wrong line** — TypeScript reports the excess-property error at the `agentManager:`
property (line 590), not at the `const` declaration (586) where the directive sat. So the
directive asserted nothing *and* the real error went unsuppressed, showing up as a plain
`TS2353` in the baseline.

Fixed by **moving** it onto the property, not deleting it. −2 for that file, and the AC4
guard actually guards now.

**The rule:** an unused `@ts-expect-error` is not automatically dead. Check whether the error
it wanted still exists *somewhere else in the same statement* before deleting — a directive
one line off is indistinguishable from a stale one by its own error code, and deleting it
silently retires a compile-time AC.

## Re-measurement, third time

`makeObservation` was carried as **~90**. Live it is **9** (`merge.test.ts` 7,
`effective-config` 1, `curator-gc` 1). Every handoff estimate so far has been wrong in a
different direction — 32→73, 190→149, 90→9. **Measure the cluster before writing the plan.**

The real next cluster is `DispatchContext` fixtures: **18 errors** (`plugin-routing-core` 12,
`interaction-chain-pipeline` 5, plus 4 singles) all missing
`agentManager`/`sessionManager`/`runtime`/`abortSignal`. The 12 in `plugin-routing-core` are
one identical line; the rest are heterogeneous. `makeTestContext`
(`test/helpers/pipeline-context.ts:61`) papers over the same four fields with its own
`as PipelineContext`, so the open question is whether to build a real `makeDispatchContext()`
from `makeMockRuntime()` — which touches runtime lifecycle and must satisfy
`check:runtime-cleanup`. **Not mechanical; plan it.**

## 11. `DispatchContext` fixtures — done (1132 → 1067, −65)

On `chore/1514-dispatch-context`, one commit. The largest single drop of the drain so far,
and the first to retire debt on **four** counters at once: `asAny` 1393 → 1388,
`anyType` 1885 → 1880, `looseCast` 2008 → 1994, `tsSuppress` 54 → 40 (the last carried
over from §10, whose baseline update had missed the escape-hatch file).

### The estimate was wrong again — and this time in the useful direction

§10 carried this cluster as **18 errors**. Live it was **46**, across **38 files**. The
handoff had counted only the two files someone had looked at. Fourth estimate, fourth
miss: 32→73, 190→149, 90→9, 18→46.

### The helper

`test/helpers/dispatch-context.ts` — `makeDispatchContext()` returns the four ADR-020
fields as a spreadable object. The design decision that matters:

```ts
const runtime = opts.runtime ?? makeMockRuntime(opts);
return { runtime, agentManager: runtime.agentManager, sessionManager: runtime.sessionManager, ... };
```

The three object fields come from **one** runtime, not three independent mocks. In
production `ctx.agentManager === ctx.runtime.agentManager`; a fixture that breaks that
identity lets a test pass while the code under test dispatches through a manager the test
never observes. Where a file already had a runtime, it is threaded in
(`makeDispatchContext({ runtime })`) rather than a second one being built beside it.

`check:runtime-cleanup` was the flagged hazard and turned out not to bind: it polices
direct `createRuntime()` calls in test files only, and helper-built runtimes are tracked
and closed by the central `afterEach` in `test/helpers/runtime.ts`.

### `makeTestContext` was lying, and it was the cheapest 13 errors

`test/helpers/pipeline-context.ts` returned `... as PipelineContext` while supplying none
of the four fields. Making it spread `makeDispatchContext()` let the cast be **deleted
outright**, and 13 errors in files that never touched the helper disappeared with it. The
full suite passed unchanged, so no test was depending on those fields being `undefined`.

This is the `callop-seam` precedent again: the shared helper was the fix, not each call site.

### Three bugs the casts were hiding

1. **`interaction-chain-pipeline.test.ts`** — seven assertions read the field under test
   through `(ctx as Record<string, unknown>).interaction`. The cast is what let the
   literals compile while missing four required fields; once the fixtures were honest the
   cast itself stopped compiling. Reading `ctx.interaction` directly is both the fix and a
   strictly stronger assertion — the test claims to verify that `PipelineContext` *has* the
   field, and now it does so through the type. Seven `looseCast` retired.
2. **`runner-stateful-coordinator.test.ts`** — `as Parameters<typeof runStateful>[0]` was
   masking `config: sliceConfig.debate`, where `DebateConfig` is
   `Pick<NaxConfig, "agent" | "debate">` — the *slice*, not the inner object. The fixture
   had been passing the wrong shape. Replacing the cast with a return-type annotation, the
   hand-rolled `callContext` with `makeMockCallContext({ runtime: dispatch.runtime })`, and
   the config with the real slice makes the concurrency test meaningful again: `ctx.config`
   (99) and the runtime's config (2) now genuinely diverge, so the assertion that the cap
   comes from `runtime.configLoader.current()` actually discriminates.
3. **`acceptance-missing-target` / `acceptance.test.ts`** — fixing the dispatch fields
   unmasked a missing `projectDir`. Real gap, added.

### Not fixed: a src/test contradiction worth its own issue

`run-completion-session-close.test.ts` test 2 is *"does not call closeAllRunSessions when
sessionManager is omitted"*. `RunCompletionOptions extends DispatchContext`, so
`sessionManager` is **required** — yet `src/execution/lifecycle/run-completion.ts:403` still
guards with `if (options.sessionManager)`. The test pins a branch the type says is
unreachable.

Making it compile needs `absentValue<ISessionManager>()`, which trades a typecheck error for
an `absentValue` increment — **the one thing this drain does not do**. Left erroring (1 of
the 1067). The decision belongs with whoever owns ADR-020: either the runtime guard is dead
and should go, or the type is wrong.

### Rules

- **Fix the shared helper before the call sites.** 13 of the 65 came from one cast deletion
  in `makeTestContext`, in files that were never edited.
- **A fixture's cast is load-bearing evidence.** Every cast removed here was hiding a second
  defect — a wrong config shape, a missing field, or an assertion reading around the type it
  claimed to test. Budget for the unmask; do not assume the cast was merely cosmetic.
- **Derive related fixture fields from one source.** Three mocks that *should* be the same
  object will silently stop being the same object.

## Next

`makeObservation` (9), and the `semantic-*` review mock-signature cluster surfaced while
working here (~9 in three files, all `CompleteResult` shape drift). Both small. The
`run-completion-session-close` contradiction above needs a decision, not a fix.

## 12. Void-return handlers + `makeDebateRunner` — done (1067 → 1030, −37)

Two mechanical clusters, cleared together as the worked example for
`docs/plans/HANDOFF-1514-delegable-clusters.md`.

- **30 errors, 5 files** — `(e) => received.push(e)` returns `number` where the listener
  wants `void | Promise<void>`. Braces discard it; `void x.push(e)` where braces do not fit
  (and `void` is not a counted hatch).
- **7 sites, 1 file** — `createDebateRunner = mock(() => ({ runPlan }))`. `DebateRunner` is a
  class with eight `private readonly` fields, so a bare literal can never satisfy it
  structurally; `makeDebateRunner()` has existed for this since §3c-ii and was simply not
  being used. `plan-debate.test.ts` 22 → 15.

All six counters flat. Full suite green, 25 gates green.

### The near-miss worth recording: a syntax error reads as a triumph

A regex introduced `TS1005` into `otel-heartbeat.test.ts`. The project-wide count went
**1067 → 16**. Nothing was fixed — a parse failure stops `tsc` reporting *semantic* errors
across the whole project, so 1051 real errors just stopped being counted. Had that been
committed on the strength of the number, the typecheck baseline would have been rewritten to
16 and the drain would have "finished" with ~1000 errors invisible behind one broken file.

**The guard, now G1 in the handoff:** after any edit, `grep -E "error TS1[0-9]{3}:"` must
print nothing, and any drop larger than the cluster you touched is a bug report about
yourself. (`TS18046`/`18047`/`18048` are five digits and are *not* syntax errors.)

### Regex is for finding, not for fixing

The same regex approach applied to the PRD/UserStory literals in
`reporter-lifecycle-basic.test.ts` took it from **10 errors to 19** — the story literals nest
inside the PRD literal and brace-matching went wrong. Reverted. Flat call expressions are
safe to rewrite mechanically; nested object literals are not.

### The uncounted hole: `!`

`TS18046/18047/18048` ("possibly undefined", 43 errors) is the most inviting-looking cluster
left and is deliberately **not** delegated. The natural fix `foo!.bar` is matched by none of
the six escape-hatch patterns, so it would retire 43 typecheck errors and create 43 pieces of
debt no gate can ever see. `expect(x).toBeDefined()` does not narrow, and `foo?.bar` inside an
assertion can make it vacuously true. Needs a per-site decision or a counted helper.

## Next

Delegable, with validated recipes, in `docs/plans/HANDOFF-1514-delegable-clusters.md`:
`createDebateRunner` (2 files left) and the PRD/UserStory literals (~11, hand-edit only).

Explicitly not delegable, with reasons: the `!` cluster above (43), `plugins/loader.test.ts`
(22, needs a `makeOptimizerResult()` helper designed first), and the `Mock<() => X>` signature
drift in `parallel-batch` / `story-orchestrator-*` / the config suites (170+, no single recipe).

## 13. `createDebateRunner` residue — done (1030 → 1029, −1)

On `chore/1514-delegable-clusters`, one commit. The §2 follow-up from the
delegable-clusters handoff.

**The estimate was right for the wrong reason.** The handoff listed 2 files: `plan-callop.test.ts`
(1) and `plan-decompose-ac-repair.test.ts` (0, masked by `as never`). Cluster B was **1 typecheck
error**, not 7 (the 7 from the prior commit had already cleared). `as never` is matched by none
of the six escape-hatch patterns, so the second site left no measurable debt — only the cast
itself, which the conversion retires.

- `plan-callop.test.ts:364` — `{ runPlan: ... }` literal → `makeDebateRunner({ runPlan })`.
  Removes 1 DebateRunner-shape `TS2322`. Two unrelated errors in this file
  (`InteractionChain` `Mock<() => X>`, `'tier' not in DeepPartial<Debater>`) are
  §5.3-class.
- `plan-decompose-ac-repair.test.ts:120` — same recipe. 0 typecheck errors before
  (`as never` was masking); 0 after. The conversion retires the `as never` cast and
  aligns the pattern with the 7 sites already cleared in `plan-debate.test.ts`.

`makeDebateRunner` was added to the existing `@test/helpers` import in both files (per
the handoff: "do not add a second import line").

Verify: G1 stayed flat at 1 (pre-existing `TS1355` in `smart-runner.test.ts:516`). All
six counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17,
anyType=1880, looseCast=1994`). Full suite green; 25/25 gates green.

## 14. PRD/UserStory literals — done (1029 → 1016, −13)

On `chore/1514-delegable-clusters`, one commit. The §3 follow-up from the
delegable-clusters handoff.

**The estimate was right for one cluster, wrong for the rest.** Handoff listed 11 errors
across 4 files. Live count was **13 across 6 files** — `verdict.test.ts` and
`utils-helpers.test.ts` were not in the handoff, but matched the recipe exactly
(UserStory missing `escalations, attempts`; PRD missing `project, branchName, createdAt,
updatedAt`). Fifth time the re-measure rule has mattered; see §11 and §12.

Each literal converted to `makePRD({ userStories: [makeStory({ ... })] })` and dropped
`as const` from `status` (the parameter type supplies the contextual type, so it is
not needed). Hand-edited one literal at a time per G6:

- `reporter-lifecycle-basic.test.ts` — 6 PRD literals at lines 154, 208, 255, 313, 353, 387.
  File 10 → 4 typecheck errors. The two `paused`-status literals at 313/353 dropped their
  `tags: []` (the field is required on `UserStory` and `makeStory()` supplies it).
- `reporter-lifecycle-resilience.test.ts` — `minimalPrd()` helper (line 82) refactored;
  three call sites inherit the fix. File 7 → 4.
- `storyid-events.test.ts` — `mockStory` literal (line 53). File 2 → 1.
- `subscribers/interaction.test.ts` — `createStoryFailedEvent`'s `story` literal (line 53).
  File 1 → 0.
- `verdict.test.ts` (new since handoff) — `mockStory` literal (line 6). File 1 → 0.
- `utils-helpers.test.ts` (new since handoff) — `createMockPRD` helper (line 43)
  refactored. File 1 → 0.

No `as const` is removed by any counter — `as const` matches none of the six patterns
intentionally. They were a counted form of debt only in the sense that the literal
they guarded would not typecheck without them.

Verify: G1 stayed flat at 1 (same pre-existing `TS1355`). All six counters flat
(`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1880, looseCast=1994`).
47 tests pass across the 6 touched files; full suite 1174 pass across 116 files; 25/25
gates green.

### One mild near-miss

The handoff's two recipes worked. The third possibility — running a single `sed` over
nested literals — was correctly NOT attempted (G6), and that decision saved a repeat
of the §3 recorded failure (10 → 19 errors). Each PRD literal here nests one or two
`userStories` items, exactly the shape that defeated the prior regex.

## Next

Delegable clusters B and C are now drained. What remains from `HANDOFF-1514-delegable-clusters.md`:

- **§5.1 — `TS18046/18047/18048` (`!` cluster, 43 errors).** Not delegable. Needs a per-site
  decision or a counted helper designed first.
- **§5.2 — `plugins/loader.test.ts` (22 errors).** Needs a `makeOptimizerResult()` helper,
  which is a `test/helpers/` change forbidden by G5. Escalate.
- **§5.3 — `parallel-batch.test.ts` (36), `story-orchestrator-*` (73), config suites (63+).**
  `Mock<() => X>` values assigned to multi-parameter function slots, plus config-shape drift.
  No single recipe.

Total residue at this commit: **1016 errors across 271 files** (was 1030/276 at the start of
`chore/1514-delegable-clusters`). −14 errors, −5 files, both clusters delegated, two
follow-up commits per the handoff's "one cluster per commit" rule.

## 15. `plugins/loader.test.ts` optimizer stubs — done (1016 → 994, −22)

On `chore/1514-delegable-clusters`, one commit. This is the §5.2 escalation from the
delegable-clusters handoff, **taken with explicit approval**: G5 (no `test/helpers/` edits)
was lifted by the user for this one helper, and for nothing else.

**The first estimate that did not move.** Handoff said 22 errors; live count was 22; the
fix removed 22. Five prior clusters drifted on re-measure (§11–§14) — this one did not,
because the errors all came from one copy-pasted stub rather than from drift accumulating
across unrelated files.

### What was actually wrong

The stubs returned `{ optimizedPrompt, estimatedTokens, tokensSaved, appliedStrategies }`
and read `input.estimatedTokens`. The real `PromptOptimizerResult`
(`src/optimizer/types.ts:34`) is `{ prompt, originalTokens, optimizedTokens, savings,
appliedRules }`, and `PromptOptimizerInput` has never had an `estimatedTokens` field. So
each of 11 byte-identical stubs produced exactly 2 errors: one `TS2322` on the return
shape, one `TS2339` on the phantom input field.

**No test ever calls `optimize()`.** The stub exists only so `provides: ["optimizer"]`
validates and the plugin loads. That is why the wrong shape survived an interface change
undetected — nothing exercised it, and the file's 17 tests all passed throughout.

### The helper

`test/helpers/optimizer-result.ts` — `makeOptimizerResult(overrides?)`, exported from the
barrel. Defaults describe a no-op optimizer: prompt echoed, `originalTokens ===
optimizedTokens` via the real `estimateTokens()`, `savings: 0`, `appliedRules: []`.

Unlike `makeDebateRunner`, it needs **no cast** — `PromptOptimizerResult` is a plain
interface, so the factory satisfies it structurally. `as unknown as` stayed flat at 102,
which is the measurable form of that claim.

### The two sites tsc could not see

`writePluginFile()` (line ~44) and the inline `pluginCode` template (line ~427) emit the
*same* stale shape into generated plugin source. They are string literals, so they
contributed 0 typecheck errors and would have survived a fix that only chased the count.
Both were corrected to the real shape inline (a generated file cannot import a helper).
Behaviour is unchanged — nothing calls the generated `optimize()` either — but the
fixtures no longer teach a shape that has not existed for several releases.

Verify: G1 flat at 1 (same pre-existing `TS1355` in `smart-runner.test.ts:516`). Drop is
exactly cluster-sized, 1016 → 994, files 271 → 270, `loader.test.ts` 22 → 0. All six
counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1880,
looseCast=1994`); `as unknown as` flat at 102. 17 tests pass in the touched file; full
suite green across all three phases; 25/25 gates green, including
`check-inline-test-mocks --strict`, which the new helper satisfies rather than evades.

## Next

- **§5.1 — `TS18046/18047/18048` (`!` cluster).** Re-measured at this commit: still **43**.
  Not delegable. The `!` fix is invisible to all six counters, so it needs a per-site
  decision or a *counted* helper designed first — the same approval §15 just used.
- **§5.3 — `Mock<() => X>` drift.** Re-measured: `parallel-batch.test.ts` **36**,
  `story-orchestrator-*` **89**, config suites **146**. No single recipe; each needs the
  real signature read and the mock's parameters annotated individually.

Residue at this commit: **994 errors across 270 files.** The branch has taken 1030 → 994
(−36) over four commits.

## 16. The `possibly-undefined` cluster — done (994 → 950, −44)

On `chore/1514-delegable-clusters`, one commit. This is §5.1, the cluster the handoff
explicitly refused to delegate. It was right to refuse, but not for the reason it gave.

### It was never one cluster

The handoff treated all 43 `TS18046/18047/18048` as one problem with one trap (`!`).
Enumerating them first split them into five causes with five different correct fixes —
and one that has no test-side fix at all:

| Cause | Count | Fix |
|:---|---:|:---|
| `verify()` returns `O \| null` | 15 | `assertDefined(out)` |
| Zero-arg `mock()` → `calls[0]` is the empty tuple | 5 | type the mock with the real signature |
| `result.hooks` optional on merged config | 6 | `assertDefined(result.hooks)` |
| `require()` erases the class to `any` | 2 | use the static import already at the top of the file |
| Optional fields / unnarrowed `safeParse` | 5 | per-site |
| **Zod `z.preprocess` type erasure** | **10** | **none — see below** |

**The `!` trap was real but narrower than described.** `!` is genuinely uncounted by all six
ratchets, and it would have been the "obvious" fix for the 26 nullability errors. It would
*not* have worked on the 12 `TS18046` ones — `foo!` does not narrow `unknown`, so that
sub-cluster could only ever have been hidden with a cast, which `looseCast` does count.

### The helper

`test/helpers/assert-defined.ts` — `assertDefined(value, label)` and `firstCall(mock, label)`,
both barrel-exported. G5 was lifted for §5.2's helper; this extends that, since §5.1 is
unfixable without it by the handoff's own analysis.

`assertDefined` uses an `asserts value is NonNullable<T>` signature: it narrows for
TypeScript *and* throws at runtime. That is why it is **not** an escape hatch and why no
new counter was added for it — unlike `absentValue`, it contains no type-lie, casts
nothing, and makes the test fail louder than the code it replaces. `out!.passed` on a null
`out` gives an opaque `TypeError`; `assertDefined(out, "verify() result")` names the thing
that was missing.

The two alternatives the handoff worried about were both confirmed bad:
`expect(out).not.toBeNull()` does not narrow, and `expect(out?.passed).toBe(x)` can go
**vacuously true** — if the value really is null, `out?.passed` is `undefined`, and an
expectation of `undefined` passes.

`firstCall` exists because `expect(m).toHaveBeenCalledTimes(1)` does not narrow
`m.mock.calls[0]` either, and under `noUncheckedIndexedAccess` destructuring it yields
possibly-undefined elements.

### What the drain unmasked

- **`plan-debate.test.ts` went 15 → 1.** Only 5 of its errors were §5.1; the rest were
  §5.3-class, and all had the *same* root cause — `mock(async () => RESULT)` declares a
  zero-arg mock, so `calls[0]` is `[]` and every downstream assertion breaks. Typing it
  `mock(async (..._args: Parameters<DebateRunner["runPlan"]>) => ...)` cleared all of them.
  **This is a working recipe for part of §5.3.**
- **Three `createDebateRunner` sites §13 missed.** §13's grep was
  `createDebateRunner = mock(() => ({`; these bind to a variable first
  (`const createDebateMock = mock(() => ({ runPlan: ... }))`) and so never matched. The §13
  recipe applied unchanged. Grep patterns anchored on an assignment target miss the
  bind-then-assign form.
- **`require("@/execution/story-orchestrator")` in `story-orchestrator.test.ts`** while the
  class is statically imported at line 27. `require()` returns `any`, which is what made
  `Object.values(result.phaseCosts)` land as `unknown[]` even though `phaseCosts` is
  `Record<string, number>`. One site fixed (the one that errored); **three more remain** at
  lines 261, 280, 720 — they compile only because nothing downstream reads through them.

### What is NOT fixable in test/ — escalate

The 10 remaining `TS18046` are a **src/ type-inference defect**, not a test defect. Probed
directly:

```
Debate["stages"]["plan"] = Record<string, unknown> | { enabled; resolver; ... }
```

`makeDebateStageSchema` in `src/config/schemas-debate.ts` wraps every stage in
`z.preprocess(toObject, ...)` where `toObject: (val: unknown) => unknown`. Under Zod 4 the
result is a **union with `Record<string, unknown>`**, so *every* field of a debate stage
infers as `unknown` — `plan.resolver`, `plan.sessionMode`, all of them. The tests only
error where they read a property *through* one (`plan?.resolver.type`); `expect(plan?.sessionMode)`
accepts `unknown` silently, which is why this looked like it affected only `resolver`.

No test-side fix exists. `"resolver" in plan` does not narrow away an index-signature
member, so the only test-layer option is a cast — real `looseCast` debt for a defect
whose home is `src/`. Fixing it properly means making `makeDebateStageSchema` generic over
its `extensions` shape and typing `toObject`, which is a `src/` change and out of scope for
this drain. **Filed as the one genuine escalation from §5.1.**

Verify: G1 flat at 1 (same pre-existing `TS1355`). 994 → 950, files 270 → 267; the
`TS18046/47/48` cluster 43 → 10, and no file regressed (per-file counts diffed against the
994 baseline). All six counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106,
absentValue=17, anyType=1880, looseCast=1994`); `as unknown as` flat at 102.

**Non-null assertions in `test/` went 831 → 832.** The +1 is the string `out!.passed`
inside the new helper's docstring, where it is quoted as the *wrong* fix. No `!` was added
to any code path — the whole point of the cluster. A future reader re-running that count
should expect this one.

203 tests pass across the 10 touched files; full suite green across all three phases;
25/25 gates green.

## Next

- **§5.3 — `Mock<() => X>` drift.** Re-measured: `story-orchestrator-*` **87**, config
  suites **146**, `parallel-batch.test.ts` **36**. §16 produced a real recipe for part of
  it (type the mock from `Parameters<T["method"]>`), and `plan-debate.test.ts` 15 → 1 is
  the worked example.
- **Escalation — Zod stage-schema erasure (10 errors).** `src/config/schemas-debate.ts`.
  Needs a `src/` fix; out of scope for a test drain. Nothing else in this file's remaining
  residue is blocked on it.
- **Leftovers named above:** three `require()` sites in `story-orchestrator.test.ts`, and
  a `TS2554` at `plan-debate.test.ts:326` on a local `makeMockPlanManager` helper.

Residue at this commit: **950 errors across 267 files.** The branch has taken 1030 → 950
(−80) over six commits.

## 17. §5.3 part 1 — parallel-batch dep stubs — done (950 → 914, −36)

On `chore/1514-delegable-clusters`, one commit. `parallel-batch.test.ts` **36 → 0**.

Three causes, all "a stub cast into a dep slot it cannot satisfy structurally":

- **16 `createWorktreeManager` stubs** — `{ create, remove }` cast with `as typeof …`,
  two already downgraded to a ratcheted double cast. Added `makeWorktreeManager()`,
  mirroring the existing `makeMergeEngine`.
- **16 `createMergeEngine` stubs** — same shape, and **the helper already existed**.
  `makeMergeEngine` was written for `pipeline-result-handler.test.ts` in §3c-ii and
  simply never reached this file. Worth remembering: check `test/helpers/` before
  concluding a cluster needs a new factory.
- **4 shape mismatches** — `mock(async () => ({ success: true, … }))` widens `success`
  to `boolean`, so it misses the `RectificationResult` *discriminated union*. Annotating
  the mock's return type (`async (): Promise<RectificationResult> => …`) fixes it with no
  cast. Plus one stale import (`PipelineRunResult` moved to the pipeline barrel) and one
  param-arity mismatch on `loadConfigForWorkdir`.

**Counters went down.** `ratchetAllow` 106 → 105 and `as unknown as` held at 102 while
16 call-site casts were deleted — the helper keeps one marked cast in place of sixteen.

## 18. §5.3 part 2 — story-orchestrator dep stubs — done (914 → 886, −28)

On `chore/1514-delegable-clusters`, one commit. Four causes, two fixed, **two escalated**.

### Fixed

- **13 `runFixCycle` stubs (−13).** Two problems at once: `exitReason` is required and
  the fixtures predate it, *and* the dep slot is **generic**
  (`<F extends Finding>(…) => Promise<FixCycleResult<F>>`), so even a complete
  `FixCycleResult<Finding>` is not assignable — `F` could be narrower. This is the shape
  the handoff called "`Mock<() => X>` assigned to a multi-parameter slot"; the parameters
  were never the problem, the **type parameter** was. Added `makeFixCycleResult()` +
  `makeIteration()`, and stub with a generic arrow so `F` flows through:
  `async <F extends Finding>() => makeFixCycleResult<F>()`.
- **7 `callOp` stubs (−7).** The stub returns a fixed envelope for non-deterministic ops,
  which is not `O`, so the return type widens to a union. Added `makeCallOp({ fallback,
  onDispatch })`; deterministic ops still dispatch to their real `execute`.
- **4 sync `buildResumePlan` stubs + 1 `SessionRole` widening (−5).** The dep slot is
  `async`; the stubs were sync. And a local `makeRunOp(name, sessionRole: string, …)`
  widened the role — typing the parameter `SessionRole` fixes it at the source.
- **3 `AnySlot` imports (−3).** `AnySlot` exists and is exported — from
  `@/execution/story-orchestrator`, not the `@/execution` barrel the tests reached for.

### What the drain unmasked

Rewriting the `runFixCycle` stubs turned **1 error into 4** in `story-orchestrator.test.ts`
before the file came out ahead. The old fixture had `findingsBefore: 1` and `startedAt: 0`
where `Iteration` wants `F[]` and an ISO string — nonsense that survived because the
enclosing object was already failing to typecheck *as a whole*, so TypeScript never
reported the fields individually. The test only asserts `iterationCount === 1`, so nothing
ever caught it at runtime either. That fixture is now `makeIteration()`.

**This is the general hazard of factory conversion:** replacing a wholesale-rejected
literal with a typed `Partial<>` override moves errors from one-per-object to
one-per-field. A file can legitimately get worse for a step before it gets better.

### Escalated — both need `src/` changes, both out of scope by G5

1. **Builder slot overloads are narrower than the runtime they front — 50 errors.**
   `addLintCheck`/`addVerifier`/`addFullSuiteGate`/… declare
   `<I, O, C>(slot: OrchestratorSlot<I, O, C>)`, and `OrchestratorSlot.op` is a
   `RunOperation`. But the implementation calls `setPhase(…: AnySlot)`, and `AnySlot`
   is `RunOperation | DeterministicOperation`. So passing a deterministic op — which the
   orchestrator runs perfectly well — fails the public overload and falls through to the
   input-only one, whose error ("`op` does not exist in type `LintCheckInput`") is what
   gets reported. Fix is to widen the slot overloads to `AnySlot`. **50 errors across 10
   files, one root cause, one-line-per-method fix in `src/execution/story-orchestrator/builder.ts`.**
   This is the single largest remaining item in the whole drain.
2. **Zod stage-schema erasure — 10 errors.** Unchanged from §16.

### A counter note worth recording

Three new helpers each need one genuine cast (a class, and two caller-chosen type
parameters), which would have pushed `ratchetAllow` 106 → 107 — a G4 violation. Rather
than raise the baseline, two things closed the gap honestly:

- `makeIteration` was rewritten to need **no cast at all**: every default is an empty
  array, and `never[]` is assignable to `F[]` whatever `F` is.
- A **stale marker** was removed at `cycle.test.ts:799` — `callOp: makeCallOpMock(), //
  test-ratchet-allow: as-unknown-as` guards a line with no cast on it, copy-pasted from
  the line above. It was inflating the counter while protecting nothing.

`story-orchestrator.test.ts` also breached the file-size ratchet (2006 → 2020) because the
factory form is taller than the literal. Dropping overrides that merely restate the
helper's defaults, plus `makeIteration()`, brought it back to exactly 2006.

Verify: G1 flat at 1 (same pre-existing `TS1355`). 950 → 886 across both commits, files
267 → 263; no file regressed (per-file counts diffed against the 950 baseline). All six
counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1880,
looseCast=1994`); `as unknown as` flat at 102. Full suite green across all three phases;
25/25 gates green.

## Next

- **Builder slot overloads (50 errors).** The largest single win left, and it is a `src/`
  fix — see §18. Nothing in `test/` can address it without casting.
- **Zod stage-schema erasure (10 errors).** `src/config/schemas-debate.ts`, see §16.
- **Config suites (~146) and the story-orchestrator remainder.** Not yet enumerated by
  cause; every cluster so far has decomposed into 3–5 distinct causes on inspection, and
  none of the handoff's original size estimates survived contact.

Residue at this commit: **886 errors across 263 files.** The branch has taken 1030 → 886
(−144) over eight commits.

---

## 19. Builder slot overloads — done (886 → 838, −48)

On `chore/1514-builder-slot-overloads`, one commit (`55c22ae35`). The first `src/` fix in
this drain, and the escalation §18 filed. **No test file was touched** — 48 test errors
across 9 files cleared by making one public signature honest.

### The defect

`StoryOrchestratorBuilder.addX()` declared its slot overload as
`OrchestratorSlot<I, O, C>`, whose `op` is a bare `RunOperation`. The implementation calls
`setPhase(…: AnySlot)`, and `AnySlot.op` is `RunOperation | DeterministicOperation`. The
orchestrator dispatches deterministic ops through `callOp` exactly as it does run ops — so
the **public signature was strictly narrower than the runtime it fronts**, and a
deterministic op fell through to the input-only overload. The reported error
(`'op' does not exist in type 'FullSuiteGateInput'`) named the wrong problem entirely,
which is why this cluster read as ten unrelated fixture bugs for so long.

### The fix

`OrchestratorSlot` gained a fourth type parameter `D` for the deterministic op's deps seam,
defaulting to `void` — the `DeterministicOperation` default — so an existing three-argument
`OrchestratorSlot<I, O, C>` keeps its exact previous meaning. `op` widened to the same union
`AnySlot` uses. The 12 `addX` overloads and `isSlot` carry `D` through. **Zero casts added**
in `src/` or `test/`; the compiler got stricter, not looser, because the slot overload now
matches instead of silently deferring to a wrong one.

This is the third confirmation of the phase-3 ruling in `PROPOSAL-1514-phase2-typecheck-drain.md`:
**prefer fixing the type over containing a cast.** config-slices, callop-seam, and now this.

### Files cleared outright

`story-orchestrator-resume-guard` 12 → 0, `story-orchestrator-resume-integration` 10 → 0,
`story-orchestrator-carveout-staleness` 7 → 0, `story-orchestrator-check-ops` 3 → 0,
`verifier-findings-flow` 4 → 0.

### 48 of 50, and what the other 2 were hiding

`story-orchestrator-logs.test.ts:304` and `:373` still fail — but on a **different cause the
overload error was masking**. Their `semanticConfig` fixture supplies only `model` and
`timeoutMs`; `SemanticReviewConfig` (`src/review/types.ts:77`) also requires `diffMode`,
`resetRefOnRerun` and `rules`. That belongs to the fixture-completeness cluster.

Same lesson as §18's `runFixCycle` unmask, from the other direction: **a wholesale overload
rejection reports one error per call, so it hides every field-level error underneath it.**
Sizing a cluster by its error count under-counts what is actually there — here by 2, in §18
by 3. Expect the residue to fall slightly short of the estimate, every time.

A third file, `test/unit/tdd/orchestrator-totals.test.ts:119`
(`'rectificationEnabled' does not exist in type 'FullSuiteGateInput'`), looks like this
cluster but is a `TS2353` dead fixture key and was never part of the 50.

Verify: src tsc **0** including `tsconfig.contracts.json`. 886 → 838, files 263 → 258;
per-file gate `worse: 0`. All six counters flat (`asAny=1388, tsSuppress=40,
ratchetAllow=106, absentValue=17, anyType=1880, looseCast=1994`); `as unknown as` flat at
102. 25/25 gates green; full suite green (1137 + 38 pass, 0 fail).

---

## 20. Debate stage-schema erasure — done (838 → 818, −20)

On `chore/1514-builder-slot-overloads`, one commit (`fbb0be4af`). The second `src/` fix and
the last named escalation. **No test file was touched.** `TS18046` went **10 → 0**;
`debate-schema.test.ts` 11 → 0 and `schemas-debate.test.ts` 9 → 0, both cleared outright.

### §16's diagnosis was wrong, and the wrong part was the mechanism

§16 recorded: "`makeDebateStageSchema` wraps every stage in `z.preprocess(toObject, …)`
where `toObject: (val: unknown) => unknown`. Under Zod 4 the result is a **union with
`Record<string, unknown>`**." The *symptom* was right; the *cause* was not.

Probed directly, `z.preprocess` is innocent — with an `(v: unknown) => unknown` transform it
infers its inner schema exactly:

```ts
const P = z.preprocess((v: unknown): unknown => v ?? {}, z.object({ a: z.string() }));
// z.infer<typeof P> === { a: string }   — no union, nothing erased
```

The erasure came from the **ternary**:

```ts
const extended = extensions ? base.extend(extensions.shape) : base.extend({ evidenceMode: z.undefined() });
```

`extensions` was typed `z.ZodObject<z.ZodRawShape>`. `z.ZodRawShape` is an index signature,
so `extensions.shape` is `Record<string, ZodType>` and `base.extend()` of *that* widens the
entire object to `Record<string, unknown>` — isolated to one branch and confirmed:

```ts
declare const anyExt: z.ZodObject<z.ZodRawShape>;
base.extend(anyExt.shape)              // => Record<string, unknown>      ← the erasure
base.extend({ evidenceMode: z.undefined() })  // => { …, evidenceMode: undefined }  ← precise
```

A ternary types as the union of both branches, so the erased branch unioned into **every**
stage — which is why the plan-only extension broke `review`, `acceptance`, `rectification`
and `escalation` too. §16 read that breadth as evidence for a `preprocess`-level cause. It
was evidence for a union, and a union has more than one source.

**The lesson:** "the inferred type is `X | Record<string, unknown>`" localises the defect to
*a union*, not to any particular combinator. Two three-line probes separated the innocent
combinator from the guilty one in about a minute; a whole phase was mis-scoped for want of
them. Probe each combinator in isolation before naming one.

### The fix

Make `makeDebateStageSchema` generic over `E extends z.ZodRawShape`, and pass the non-plan
`{ evidenceMode: z.undefined() }` as a real `NonPlanStageExtensions` object rather than an
inline ternary branch. Same schema, same runtime, **no cast**. This is the fourth
confirmation of **prefer fixing the type over containing a cast**.

### The honest type immediately found two things

- **`NaxConfigSchema`'s hand-written `debate` default literal was missing `evidenceMode` on
  all five stages.** It only typechecked because the target had been
  `Record<string, unknown>`. Supplied on each; consumers only test
  `evidenceMode !== "asymmetric"`, so an explicit `undefined` is a no-op.
- **`DebateStageConfig` already declares `evidenceMode?`** (`src/debate/types.ts:99`), so the
  `DebateStageConfig & { evidenceMode?: … }` intersection in `debate.ts` and
  `debate-composition.ts` was intersecting a type with itself, and its `as` cast existed only
  to bridge the erased schema type. Both removed — **one src cast deleted**. The
  schema-inferred stage now satisfies the hand-written interface directly, which is a real
  agreement between schema and interface that the erasure had been hiding.

That second point is the general shape of these fixes: **an erased type does not merely lose
information, it suppresses the checks that would have caught the drift underneath it.** §19
found the same thing (a fixture with `findingsBefore: 1` where `F[]` was wanted).

### Recorded, not fixed

`NaxConfigSchema`'s `debate` default is a ~60-line hand-maintained literal, which
`.claude/rules/config-patterns.md` names as the anti-pattern ("defaults live in the Zod
schema… never a hand-maintained literal"). Every field it sets already has a `.default()` on
the inner schema, and `toObject` already maps `undefined → {}`, so
`DebateConfigSchema.parse(undefined)` should reproduce it. It has already drifted once
(`evidenceMode`), and it omits `debaters`, `selector`, `preDebatePhase` and
`postDebateVerifier` entirely. Deleting it is a separate concern from this type fix and
belongs in its own commit with its own before/after parse comparison.

Verify: src tsc **0** including `tsconfig.contracts.json`. 838 → 818, files 258 → 256;
per-file gate `worse: 0`. All six counters flat (`asAny=1388, tsSuppress=40,
ratchetAllow=106, absentValue=17, anyType=1880, looseCast=1994`); `as unknown as` flat at
102 in `test/`, one fewer in `src/`. 25/25 gates green; full suite green
(14127 + 1137 + 38 pass, 0 fail).

## 21. G5 re-ruled — `src/` is in scope for the owner, never for a delegate

§18 filed two clusters as "out of scope by G5". §19 and §20 both crossed that line and both
landed clean. G5 needs to say what it actually means rather than be inherited by default.

### What G5 always was

G5 lives in `HANDOFF-1514-delegable-clusters.md` — a **delegate brief**, not project policy.
Its own text names the remedy: *"If a cluster seems to need a helper change, that is the
signal to stop and escalate, not to make the change."* Escalation is a route to the owner,
so a rule that forbids a delegate from editing `src/` says nothing about whether the owner
may. §18 read the bar as absolute and parked 60 errors behind it; that was the misreading.

**G5 stands unchanged for delegates.** It has earned its place twice — it caught the
`FakeProcSpec` breach (§4a) and it correctly routed these two clusters to escalation instead
of to casts. Nothing here loosens it.

### The re-ruling

> **G5 (amended).** A delegate may not edit `test/helpers/` or `src/` — escalate instead.
> The owner may take an escalated `src/` fix when **all** of the following hold. Any one
> failing sends it back to escalation.
>
> 1. **The root cause is verified by probe, not inferred from the error message.** Both
>    §19 and §20 reported errors that named the wrong thing entirely (`'op' does not exist
>    in type 'FullSuiteGateInput'`; a union blamed on `z.preprocess`). Write the minimal
>    probe that isolates the combinator or signature, and keep it in the write-up.
> 2. **The change makes the type stricter or more accurate — never wider to fit a fixture.**
>    Already `PROPOSAL-1514-phase2-typecheck-drain.md` §7. §19 and §20 both narrowed what
>    compiles.
> 3. **Zero casts added, in `src/` or `test/`.** The G4 counters are unchanged by the fact
>    that the edit is in `src/`.
> 4. **The full suite runs, not just the gates.** A test-fixture edit cannot change runtime
>    behaviour; a `src/` edit can. This is the clause that makes a `src/` fix cost more than
>    a test fix, and it is the reason it cannot be delegated cheaply.
> 5. **The write-up names what the fix unmasked.** Both of these fixes exposed latent defects
>    the erased type had been suppressing. That is the point of the work, and it is lost if
>    only the error delta is recorded.

### Why this is not a licence to drift into `src/`

The bar is deliberately expensive: a probe, a suite run, and a write-up per fix. It is
payable when one signature is wrong and 50 test errors are downstream of it. It is not
payable to shave a handful off the count, which is the failure mode the original G5 was
guarding against. **The test for whether a `src/` fix belongs to this drain is that `test/`
cannot express the correct code without a cast** — that was true of both, and it is why
neither could have been "fixed" in `test/` except by adding the debt the drain exists to
remove.

---

## 22. The `Record<string, unknown>` cast cluster — done (818 → 792, −26)

On `chore/1514-builder-slot-overloads`, one commit (`bf055736a`). Back in `test/`, and the
first change on this branch to move `looseCast`: **1994 → 1958, 36 casts deleted and none
added**. `config/schemas.test.ts` 21 → 0.

### The cluster

`TS2352` is the largest remaining error code (110). Grouping it by *conversion target* rather
than by file found one shape holding 34 of them:

| target | count |
|:--|--:|
| `Record<string, unknown>` | **34** |
| `ParseFn` | 15 |
| `Logger` | 5 |
| everything else | ≤5 each |

and 18 of the 34 were `NaxConfig → Record<string, unknown>`. **Cluster by what the type
*is*, not by which file it is in** — the file view had this spread thinly across 12 files
and invisible as a cluster.

### Almost none of these casts did anything

They sit on the **source of a spread** feeding `NaxConfigSchema.safeParse`, which takes
`unknown`:

```ts
...(DEFAULT_CONFIG as Record<string, unknown>),   // before
...DEFAULT_CONFIG,                                // after — parses identically
```

The cast was load-bearing only where a helper *annotated its return type*
`Record<string, unknown>`; dropping the annotation drops the cast with it. Six
clone-and-override helpers also mutated their copy (`base.execution = { ...execution, … }`),
which is what needed a `Record` view to assign through — rewritten as immutable literals,
they need neither the cast nor the mutation and are shorter.

Two more were casts around properties the type **already has** (`result.data.profile`,
`config.execution?.rectification?.storyScopedFixBudget`), and one cast through a `| undefined`
that `expect(adv).toBeDefined()` does not narrow — `if (!adv) return;` narrows it properly.

**No cast was contained in a helper here.** Unlike §17's `makeMergeEngine` or §18's
`makeCallOp`, every one of these was removable outright. Worth checking for before designing
a seam: *is this cast doing anything at all?*

### What it unmasked

`generate-config-schema.test.ts` had `const allAgents = [...] as const`, which `toEqual`
cannot accept against the schema's narrow agent union — invisible while the receiver came
through a `Record`. Now annotated `NonNullable<NonNullable<NaxConfig["generate"]>["agents"]>`,
which **pins the literal to the schema** instead of restating it: add an agent to the enum and
this test still compiles, drop one and it fails.

### The near-miss: a botched multi-line replacement that typechecks

Rewriting the six clone-and-override helpers by scripted replacement, one replacement block
omitted the function's trailing `return base;`. The result was a function with a `return`
followed by a stale `return base;`. **Unreachable code after a `return` is not a TypeScript
error and Biome does not flag it** — in a file where `base` was still in scope this would
have compiled, passed the suite, and sat there as dead code forever. It was caught by reading
the file after the edit, not by any gate.

§18's G6 says "regex is for finding, hand-editing is for fixing". This is the softer version
of the same failure: a scripted *exact-string* replacement is safe from the nested-brace
problem, but not from omitting a line that the block needed to swallow. **Print the touched
region after every scripted edit.** The two seconds cost less than the gate that cannot see
this.

Verify: src tsc **0** including `tsconfig.contracts.json`. 818 → 792, files 256 → 252;
per-file gate `worse: 0`. `looseCast` **1994 → 1958**; all other counters flat
(`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1880`);
`as unknown as` flat at 102. 25/25 gates green; full suite green
(14127 + 1137 + 38 pass, 0 fail).

---

## 23. The `ParseFn` alias — done (792 → 777, −15)

One commit (`ff1826591`). `verify-op-normalized-findings.test.ts` **15 → 0**;
`looseCast` **1958 → 1932**.

The file declared its own `type ParseFn = (output: string, input: unknown, ctx: unknown) =>
{ normalizedFindings: readonly unknown[] } & Record<string, unknown>` and cast
`verifierOp.parse as ParseFn` at 15 sites. The alias describes the real signature *less*
precisely than the real signature: `VerifierOutput` already has `normalizedFindings`, typed
`Finding[]` rather than `readonly unknown[]`. Delete the alias, call `verifierOp.parse`
directly, no cast.

**Two causes again, not one.** Removing the alias took the file 15 → 11 and unmasked 11
`result.normalizedFindings[i] as Record<string, unknown>` reads — §22's cast family,
invisible while the elements were `unknown`. With the element typed `Finding`, `.source` /
`.category` read directly and those casts went too.

This is the same shape as §19 and §20: **a hand-written local type standing in for a real one
does not merely lose precision, it suppresses the checks underneath it.** Three phases in a
row now.

Verify: src tsc **0** incl. contracts. 792 → 777, files 252 → 251, per-file `worse: 0`.
`looseCast` −26, all other counters flat; `as unknown as` 102. 25/25 gates green; full suite
green (14127 + 1137 + 38 pass, 0 fail).

## 24. What is left, and who should do it

`HANDOFF-1514-cast-and-fixture-residue.md` carries the detail. **Every recipe in it was
prototyped on this tree and reverted**, so the delegable/not-delegable split is measured
rather than guessed:

| Cluster | Count | Verdict | Why |
|:--|--:|:--|:--|
| `plugins/config-resolution` optimizer fake | 16 | ✅ delegable | One dead interface, four identical blocks, field-by-field mapping supplied. One trap: the same shape lives in an **untypechecked template string** |
| `story-orchestrator-logs` `semanticConfig` | 2 | ✅ delegable | Five named required fields |
| `Record<…>` residue (bakeoff dep-bags) | 4 | 🟡 measure | Needs a helper whose `Object.keys` boundary costs one cast — a design call, not a recipe |
| `config/merger` | 19 | 🔴 owner | **The obvious recipe was prototyped and backfired** — see below |
| `merger` dead keys (`ConstitutionConfig.content` ×4, `NaxConfig.value`/`.config`) | 6 | 🔴 owner | Per-key dead-or-missing verdicts |

### The merger recipe that backfired — recorded so nobody retries it

`deepMergeConfig<T = NaxConfig>` defaults its return to `NaxConfig`, and the tests merge
arbitrary objects, so 12 `TS2769`. The obvious fix is a type argument at all 29 call sites:

```ts
deepMergeConfig<Record<string, unknown>>(base, override)   // ← wrong
```

19 → 15, **but it introduced six `TS2339` (`'hooks' does not exist on type '{}'`) and six
`TS18046` (`'result.constitution' is of type 'unknown'`)**. Some call sites merge real
`NaxConfig` and need the typed result; a blanket argument destroys that. The cluster needs a
per-call-site decision.

**This is the argument for prototyping before handing off, not after.** Delegated as a
one-line recipe, it would have read as a −4 win while quietly trading four error kinds for
two worse ones, and the count gate would not have flagged it.

---

## 25. Reviewing the handoff before delegating — the review paid for itself

The user asked for a review of `HANDOFF-1514-cast-and-fixture-residue.md` before handing it to
a cheaper model. It found three defects in a document that read as authoritative, and the
first was in its own headline.

**1. The doc claimed "every recipe below was prototyped and then reverted". It was false.**
Two recipes had been prototyped — the `ParseFn` one (which was then simply finished) and the
`deepMergeConfig` one (which backfired and was recorded as a warning). The two clusters
actually marked ✅ for the delegate — the only two it would have run — were **not** prototyped
at all. The strongest sentence in the document was true of the parts nobody was going to
execute and false of the parts somebody was.

**2. "Four identical blocks" was eight.** `config-resolution.test.ts` was sized from its
*error lines*. Four of the eight obsolete optimizer fixtures contributed no diagnostic until
the first four were fixed, because tsc stops reporting a rejected literal once an earlier one
in the same overload resolution fails. A delegate would have fixed four, found errors
remaining, and improvised.

**3. "Verified safe: I grepped every reference."** The grep used line-range exclusions that
could have skipped the assertions it was claiming did not exist. Running the file's 13 tests
after the change is what actually established it.

Prototyping both ✅ clusters to fix the doc **executed them** — 16 → 0 and 2 → 0, committed as
`99329ad71`. That is the general result: **for mechanical work, verifying a recipe well
enough to delegate it costs about what executing it costs.** Delegation pays on volume
(many files, one proven recipe), not on correctness-checking a recipe once.

### The residue is now a long tail, and that changes the handoff's shape

759 errors / 249 files = **3.0 per file**. 184 files hold ≤3 (319 errors); only 19 hold ≥8
(207 errors). The big single-cause clusters are gone. The handoff was rewritten from "three
clusters with recipes" to **"a proven recipe library plus a ranked file list, one file per
commit"**, with an explicit evidence table separating what was *proven* (the R1–R5 recipes,
each of which landed a commit) from what is a *hypothesis from reading one error* (the cause
column of the file table) from what is *uninspected* (everything else).

That table is the part worth keeping. A handoff that does not distinguish its proven claims
from its guesses invites the reader to treat all of it as proven — which is exactly what the
first draft did.

## 26. Optimizer fixture + semanticConfig — done (777 → 759, −18)

Commit `99329ad71`, the two clusters above, verified as described.

- **`config-resolution.test.ts` 16 → 0.** Eight fake `IPromptOptimizer` plugins returning
  `{ optimizedPrompt, estimatedTokens, tokensSaved, appliedStrategies }` where
  `PromptOptimizerResult` wants `{ prompt, originalTokens, optimizedTokens, savings,
  appliedRules }`. `estimatedTokens` was read off the **input**, where it has never existed.
  A ninth copy lives inside a template string that `writePluginFile` writes to disk as a real
  plugin (lines 54–65) — **tsc cannot see it**, so fixing the typed blocks alone would have
  left it silently diverged. The file's 13 tests exercise that written plugin and pass.
- **`story-orchestrator-logs.test.ts` 2 → 0.** `semanticConfig` needs `diffMode`,
  `resetRefOnRerun` and `rules` as well as `model`/`timeoutMs`. These were the two §19
  unmasked.

Verify: src tsc **0** incl. contracts. 777 → 759, files 251 → 249, per-file `worse: 0`. All
counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1880,
looseCast=1932`); `as unknown as` 102. 25/25 gates green; full suite green.

---

## 27. The six ✅ rows of `HANDOFF-1514-cast-and-fixture-residue.md` — done (759 → 692, −67)

Six commits, one file pair per commit, each through the full loop (src tsc 0, per-file
`worse: 0`, full suite, 25/25 gates, `check:test-typecheck:update` last). 759 → 692 across
249 → 241 files. All counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106,
absentValue=17, anyType=1880, looseCast=1932`); `as unknown as` 102.

- **`commands/curator` + `curator-gc` 15 → 0 (759 → 744).** R1 at 14 sites — `resolveProject`
  was a sync mock in an async slot. The handoff's 13-×-TS2322 hypothesis held, but there was
  a 15th error it hadn't counted: a `TS2353` in `curator-gc` where an oversized-row fixture
  carried an unmodeled `detail` field (used to inflate the rollup past the 4 MB flush
  boundary). Bound the row to a `const` before pushing it `as Observation` to lose freshness —
  the `as Observation` still does work (the union excludes `detail`), so it was kept.
- **`execution/lifecycle/run-regression-flake-triage` 10 → 0 (744 → 734).** Cause was *not*
  the plain-R1 hypothesis: two defects. (a) Six `triageFlakyFindings` mocks declared their
  input as a strict subset (`{ findings }`) of the real 8-field `FlakeTriageInput`, so they
  were contravariantly unassignable — typed the param as `FlakeTriageInput`. (b) The `shell`
  quality-command fixture was `false` where the schema wants a string (`/bin/sh`) — two real
  config defects the typecheck caught. One unmasked `TS2322`: `input.findings` is
  `readonly`, the slot wants `Finding[]` — `[...input.findings]`.
- **`review/scoped-lint` 9 → 0 (734 → 725).** The `runLintCommand` mocks returned 5 of the 7
  required `QualityCommandResult` fields (`commandName`, `timedOut` missing) — completed all
  six. Three `lintOutputFormat: "eslint"` were a fixture defect: `LintOutputFormat` has no
  such member (`"auto" | "eslint-json" | "biome-json" | "text" | "none"`). The faithful fix was
  `"auto"`, NOT `"text"`: at runtime the bogus `"eslint"` had fallen through to the full
  auto chain (`eslint-json → biome-json → ruff → text-block`), so `"text"` would have stripped
  the eslint-json strategy from the path and dropped `src/review/lint-parsing/strategies/
  eslint-json.ts` (grandfathered at 32.5%) below its baseline — a coverage-gate failure the
  PR's CI caught. `"auto"` is the same call chain with a valid member.
- **`metrics/tracker-context-metrics` 10 → 0 (725 → 715).** The R4 hypothesis held only part
  way: `budgetPressure: Record<string, unknown>` became `ProviderBudgetPressure` for the six
  well-formed fixtures (which then needed `droppedIds: []` — full required shape). Two
  adversarial tests can't be expressed through the strict field at all (they feed `"lots"` as
  `droppedTokens`), so they were rewired to inject **raw manifest JSON text** via
  `mockManifests` (widened to accept pre-serialized strings) — the disk form the tracker
  actually parses. The `"not-an-object"` case kept its `as unknown as` but re-targeted it to
  `ProviderBudgetPressure` (TS2739 fixed, counter flat).
- **`cli/plan-decompose-regression` 7 → 0 (715 → 708).** R3 via the existing
  `makeMockRuntime({ agentManager })` helper (same template `plan-decompose-ac-repair.test.ts`
  already used): `createRuntime` slots want `(cfg, wd, featureName) => NaxRuntime`; the tests
  stubbed a zero-arg mock returning a bare `IAgentManager`.
- **`debate/session-helpers` + `responder-model` 16 → 0 (708 → 692).** The
  `resolveOutcome` signature grew to 12 required positional params (workdir/featureName/
  promptSuffix/debaters/agentManager appended); the tests had calls at 7, 9 and 14 args. 7/9
  → 12 by appending the missing args (capture-manager reuse via hoisted locals — no new
  casts; `as NonNullable` is a counted `looseCast`); 14 → 12 by dropping two `undefined`s.
  Fixing the arity **unmasked three `undefined` passed for `config: DebateConfig`** — replaced
  with `DEFAULT_DEBATE_CONFIG`. The shared `makeCaptureManager` return was an older
  `CompleteResult` shape (`{ output, costUsd, source }` — `costUsd`/`source` never existed);
  replaced with `{ output, tokenUsage, estimatedCostUsd }`.

Residue at these commits: **692 errors across 241 files.** 886 → 692 (−194) over eleven
fixes on the branch. Against the original #1514 start: typecheck **2009 → 692 (−66%)**,
casts **815 → 102 (−87%)**, `looseCast` **1994 → 1932** with none added.

---

## Next

- **Done:** all six ✅ rows (see §27). Next delegates should take the **uninspected ≤8-error
  files** next, one file per commit, applying the province-proven R1–R6 recipes per file.
- **Owner only:** `config/merger` 19 (§24 — blanket recipe proven wrong),
  `story-orchestrator-run-phase-events` 15 (`Operation` includes `CompleteOperation`,
  `AnySlot` excludes it — likely a `src/` question under amended G5), `config/merge` 17,
  and the `debate` default literal (§20).
- **Method:** cluster by *conversion target* and *missing-property → target type*, never by
  file. And count **constructs, not diagnostics** — see §25 defect 2.

Residue at this commit: **692 errors across 241 files.** The branch has taken 886 → 692
(−194) over eleven fixes. Against the original #1514 start: typecheck **2009 → 692 (−66%)**,
casts **815 → 102 (−87%)**, `looseCast` **1994 → 1932** with none added.

---

## 28. Lane A Batch 1 — done (692 → 610, −82)

Ten commits on `chore/1514-lane-a-drain`, one file per commit, each through the full loop
(src tsc 0, per-file `worse: 0`, targeted test, 25/25 gates, `bun run test`, `bun run
test:coverage` at 103/103, `check:test-typecheck:update` last). 692 → 610 across 241 → 231
files. All six escape-hatch counters flat (`asAny=1388, tsSuppress=40, ratchetAllow=106,
absentValue=17, anyType=1880, looseCast=1932`); `as unknown as` 102. Covered exactly the 82
errors the plan's Batch 1 table predicted; the cause columns read right in seven of ten files
and were partially or fully wrong in three — recorded per file below.

- **`execution/session-manager-runtime` 15 → 0 (692 → 677).** Cause column was **partly
  wrong**. The 15 split 10× `AgentGetFn` + 5× `SessionManagerLike`, not the plan's 13+2. The
  plan's R3 move — `makeAgentAdapter({ closePhysicalSession })` — **does not compile**:
  `AgentAdapter` has no `closePhysicalSession` (it is the `LegacySessionCloser` cast seam in
  `src/execution/session-manager-runtime.ts`), and the helper's own copy is a cast-through
  field that the `Partial` override rejects by excess-property check. Used
  `{ ...makeAgentAdapter(), closePhysicalSession }` (spread + additive field) — same proven
  factory, no `test/helpers/` change. R5 held: local `SessionManagerLike` deleted in favour of
  `makeSessionManager`. What the fix unmasked: the helper `mock-agent-adapter.ts` returns a
  `closePhysicalSession` field that is structurally *extra* to its declared type — worth a
  look in a later pass, not this one.
- **`cli/status-cost` 12 → 0 (677 → 665).** Cause column **mostly right** (R2 zero-arg
  `mock.calls` tuples), with one unmasked defect the plan did not record: `projectOutputDir`
  grew a second required param (`outputDirOverride`), so `projectOutputDir("workdir")` was
  `TS2554` — fixed with `(…, undefined)`. R2 typed `loadRuns`/`stdout`/`toCostReport` from the
  `CostReportEmitDeps` signatures; R6 deleted the four bridges (`as string` ×3 and an
  `as {…}`). Note the `as {…}` never counted as `looseCast` (the pattern requires an
  uppercase-initial cast type), so the escape-hatch counters were flat here, as required.
  Trap 3 respected: types only, no fixture values — coverage stayed 103/103.
- **`integration/cli/cli-plugins` 8 → 0 (665 → 657).** Cause column right; **Trap 1
  confirmed exactly**: five `estimatedTokens` constructs, four typed. The fifth lives in
  `writePluginFile`'s `extensionsCode` template string that is written to disk as a real
  plugin — tsc cannot see it, and it cannot import the helper, so it was completed inline to
  `{ prompt, originalTokens: 0, optimizedTokens: 0, savings: 0, appliedRules: [] }`, matching
  the already-fixed `loader.test.ts` precedent. The four typed stubs use
  `makeOptimizerResult({ prompt: input.prompt })`. The file's 9 tests exercise the written
  plugin and pass.
- **`runtime/cost-aggregator` 8 → 0 (657 → 649).** Cause column right: fixtures omitted the
  `kind: "error"` discriminant of `CostErrorEvent` (5 sites), and `resolveWrite` was
  declared `() => void` while the `Promise` executor hands `r` a `(value: number |
  PromiseLike<number>) => void`. Fixed to the codebase's own external-resolution idiom
  (`let resolveWrite: (value: …) => void` + `resolveWrite!(0)` — cf. `merge.test.ts`). The `!`
  is the pre-existing definite-assignment assertion, not a newly introduced silencer.
- **`execution/unified-executor-dispatch` 8 → 0 (649 → 641).** Cause column **partly wrong**:
  the real defect was the file-local `makePendingStory` returning a legacy-shaped story
  (`priorFailures` — a field the `UserStory` type no longer has — and no `escalations`).
  Typed it `(): UserStory` (drops the dead field), and annotated the routing-bearing consts
  `const us000: UserStory` so the `routing` literal narrows contextually to `StoryRouting`
  instead of `{ complexity: string; … }`. The `pipelineEventBus.emit` mock: R4 (param typed as
  `PipelineEvent`) + R6 (both the `as typeof pipelineEventBus.emit` and the `event as never`
  cast deleted — mock's call signature is assignable to the method's).
- **`cli/plan-decompose-ac13-14` 7 → 0 (641 → 634).** Cause column right: R3 via the existing
  `makeMockRuntime({ agentManager })` at the four `createRuntime` slots (the §27
  `plan-decompose-regression` template). The "plus one `(string | ContextFileEntry)[]` into
  `string[]`" was `toDecomposedStory.contextFiles` — resolved by mapping entry objects to
  `f.path`. Two unmasked: `scanSourceRoots` literal widening (annotated
  `Promise<SourceRoot[]>`), and a `decomposeFn` fixture returning `UserStory[]` where
  `DecomposedStory[]` was wanted (missing `.map(toDecomposedStory)`) — a real fixture
  defect, not a type-only gap.
- **`review/orchestrator-wrapper-parity` 6 → 0 (634 → 628).** Cause column right for three
  (semantic fixtures missing `acDropped`); the three `completeFn`/`completeWithFallbackFn`/
  `completeAsFn` mismatches were the *legacy `{ output, costUsd, source }` `CompleteResult`
  shape* — the same defect §27 had already hit in `session-helpers.ts`, now fixed by
  returning a real `CompleteResult` (`tokenUsage`/`estimatedCostUsd`; the extra `costUsd`/
  `source` fields are never read by the ops). **Cross-file residue:** the identical legacy
  shape still lives in ~6 more review test files (`adversarial-verifiedby`, `semantic-threshold`,
  `semantic-unverifiable`, `adversarial-metadata-audit`, …) — those are Batch 3 tail files;
  this is the recipe to apply.
- **`cli/plan-monorepo` 6 → 0 (628 → 622).** Cause column exactly right: `SourceRoot.language`
  literal widening. Annotated each `scanSourceRoots` mock return as `Promise<SourceRoot[]>`.
- **`context/engine/tool-runtime` 6 → 0 (622 → 616).** Cause column right: `undefined` passed
  for the required `ContextToolRuntimeConfig` slices. The plan suggested `makeConfigSlice`;
  the faithful fix selects the real typed defaults through the production selector —
  `contextToolRuntimeConfigSelector.select(makeNaxConfig())` — since the runtime needs all
  four slices at once. 8 tests still pass: the config only changes which defaults exist,
  and `createContextToolRuntime` returns `undefined` on an empty `pullTools` bundle either way.
- **`utils/process-kill` 6 → 0 (616 → 610).** Cause column exactly right: the recorder array
  was narrower than the `process.kill` overload's inferred `signal: string | number | undefined`.
  Widened `killCalls` to `signal?: string | number`. Left the `as typeof process.kill` cast and
  the `as NodeJS.ErrnoException` alone — both counted `looseCast`s doing real work.

Constructs tsc could not see across the batch: the template-string optimizer stub in
`cli-plugins` (Trap 1) and the dead `priorFailures` field that only existed in the fixture's
local helper. Landing point matches the plan: **692 → ~610**.

## Next

- **Done:** Lane A Batch 1 (§28). Next take **Batch 2** top to bottom:
  `operations/autofix-implementer-strategy` + `operations/full-suite-rectify` (10+7, shared
  `Promise<X> | X` + `await` cause), `execution/runner-plugin-integration` (10),
  `execution/nbf-readonly-flake-triage` (9, **read then escalate** — a possible `CallContext`
  vs `FixCycleContext` `src/` contradiction), `bakeoff/run-action` (8, `measure first, then
  ask`), `plan/pipeline-strategy` (7), `operations/debate-rebut` + `debate-propose` (7+6,
  `callOp` seam — check which side of the tier-3 accepted exceptions these fall on).
  `unit/debate/pre-phase/grounder` (6) is escalation-only, not a fix.
- **Owner only:** `config/merger` 19, `config/merge` 17, `story-orchestrator-run-phase-events` 15.

## 29. Lane A Batch 2 — done (610 → 546, −64)

Six commits on `chore/1514-lane-a-drain`, one file pair per commit, each through the full loop
(src tsc 0, per-file `worse: 0`, targeted test, 25/25 gates, `bun run test`, `bun run
test:coverage` at 103/103, `check:test-typecheck:update` last). **610 → 546** across
241 → 223 files — exactly the batch's predicted −64. All six escape-hatch counters went down
or flat, never up: `asAny` reached **1387**, `anyType` **1878**, `looseCast` **1927**
(from 1932 at batch start), `tsSuppress`/`ratchetAllow`/`absentValue` flat, `as unknown as`
flat at 102. The cause columns read right in four of six batches and were **wrong in a
load-bearing way twice** — see below.

- **`operations/autofix-implementer-strategy` + `full-suite-rectify` 10+7 → 0 (610 → 593).**
  Cause column right. The shared `Promise<{…}> | {…}` + missed `await` held in both files.
  On the plan's open question — "is the extra arg dead or did the signature move?" — the
  third `extractApplied` arg was **dead**: `runFixCycle` calls `extractApplied(output, input)`
  (cycle.ts:285) and no implementation reads anything but `output`. Tests swapped the phantom
  `(output, findings, ctx)` for `(output, realInput)` via `strategy.buildInput([])`; the
  two property-reading tests became `async` + `await`. One unmask in `full-suite-rectify`: a
  `TestEditDeclaration` fixture carried `reason: "required_infrastructure_missing"` — a value
  that **exists nowhere in `src/`** (the union is `prd_contract | lint_only | sibling_scope |
  mock_structure`). Replaced with the real `prd_contract`; the AC8-priority test only asserts
  the declaration flows through, so the specific reason was incidental.
- **`integration/execution/runner-plugin-integration` 10 → 0 (593 → 583).** All three cause
  columns right, one unmask per §19's shape. `hooks: { hooks: [] }` ×8 — `HooksConfig.hooks`
  is now a `Partial<Record<HookEvent, HookDef>>`; an empty array is a dead shape for a Record
  (`{}` is the empty fixture). The `as NaxConfig` config literal was stale in **five** keys
  (`autoMode.defaultAgent` dead, `analyze` not a `NaxConfig` key at all, `tdd.mode`/
  `testStrategy`/`testCommand` no such fields, `acceptance.testCommand` dead) — rebuilt via
  `makeNaxConfig` with only the two behavioral overrides, and the `getAgentSpy: any` + `as any`
  spy value went with it (`asAny`/`anyType` first drops of the batch). `spyOn(agentModule,
  "getAgent")` names an export that no longer exists — runner.ts resolves
  `runtime.agentManager.getAgent` (line 243), and the module-level spy bound a symbol nothing
  reads, so deleting it was behaviour-neutral (8 tests pass unchanged). **The unmask:** fixing
  the hooks shape short-circuited the report of a genuinely missing required `RunOptions.statusFile`
  — all 8 `run()` calls gained `statusFile` into the temp dir.
- **`execution/nbf-readonly-flake-triage` 9 → 0 (583 → 574).** The plan flagged this as a
  possible `CallContext.storyId?` vs `FixCycleContext.storyId: string` **src contradiction —
  read then escalate**. Read it; **it is not a contradiction.** `FixCycleContext`
  (`cycle-types.ts:131`) declares the narrowing with intent ("parallel logging discipline"),
  `runFixCycle` reads `ctx.storyId` unconditionally (cycle.ts:130), and `rectification.ts:283`
  deliberately guards `if (!ctx.storyId) return {}` before dispatching the cycle. The runtime
  genuinely guarantees storyId at the cycle boundary; the test's fixture **already supplies
  `storyId: "US-1404"`** — only its declared return type (`CallContext`) failed to say so.
  Annotated `makeCtx(): FixCycleContext` and deleted the `as CallContext` cast. The two `as
  typeof _storyOrchestratorDeps.triage` casts (TS2352) were the tuple-inference trap — a mock
  returning `[A, B]` mixed into `(A | B)[]`; an `: Promise<TriageResult>` return annotation
  fixed the tuple with no cast. **Four TS2345 on `Partial<NonBlockingFixDeps>` the plan did
  not predict:** the dep bag's `captureSnapshotRef` returned `Promise<string>` where the seam
  wants `Promise<SnapshotRef>` (`{ sha, untrackedBefore }`); one fix in the base `deps` const
  cleared all four sites.
- **`bakeoff/run-action` 8 → 0 (574 → 566).** The 🟡 "measure first, then ask"
  item. Measured: the feared "one cast at the Object.keys boundary" is **zero casts** — the
  whole-bag spread idiom (`const saved = { ..._bakeoffCliDeps }; Object.assign(_bakeoffCliDeps,
  overrides); …Object.assign(_bakeoffCliDeps, saved)`) replaces both `_bakeoffCliDeps as
  Record<string, unknown>` sites, and is the exact pattern `full-suite-rectify.test.ts:364`
  already uses for `_repoScopedFixDeps`. Approved by the user before committing. The other 6
  were plain R2 + R6: zero-arg `runBakeoffSpy` ⇒ `calls[0]` is `[]` ⇒ three `.mock.calls[0][0]
  as {…}` bridges; typed the spies from `Parameters<BakeoffCliDeps["runBakeoff"]>[0]` and
  deleted the bridges — `calls[0][0]` became `BakeoffOptions` directly.
- **`plan/pipeline-strategy` 7 → 0 (566 → 559).** Cause column right (`Partial PackageSummary`
  cast + dep bag missing `getLogger`). `makeLogger()` (the test/helpers intersection) matches
  the `single.test.ts` precedent. The four `runPlanCritic` mock casts were the `string`-widening
  trap (`outcome: "passed"` → `string` cannot overlap the verdict's narrow union) — R2'd the
  return annotation and moved the arbitrary `prd` literals to `makePRD()`/`makeStory()`. Two
  unmasks: `PlanModeContext.profileName` is required and the base fixture omitted it (masked
  while `getLogger` was the reported error — supplied `"default"`, the fallback the runtime
  documents), and `complexity: "low"` is a **phantom `StoryRouting` value** (the union is
  `simple|medium|complex|expert`) that only compiled inside the cast-overloaded `callOp` mock —
  now `"simple"`. The identical `complexity: "low"` literal in the `callOp` draft mock still
  slips through untypechecked (`CallOpFn` inference): Batch 3 tail residue. One near-miss:
  my import insertion put `@/plan/critic` after `@/plan/strategies/types`, and the long ADR-025
  mock needed the formatter — `check:all` correctly failed on `organizeImports` until reordered.
- **`operations/debate-propose` + `debate-rebut` 7+6 → 0 (559 → 546).** **The plan's
  hypothesis was wrong in the direction that matters.** It read the TS2349 "expression is not
  callable" as the `callOp` seam and warned to check the tier-3 line. It is **not** the callOp
  seam: the tier-3 sites are the generic `_callOp` dep bags in `story-orchestrator-resume-integration`
  and `story-orchestrator`, and these two files are monomorphic. Two real causes, shared 1:1
  across both files: (a) **9 × TS2345** — `makeBuildCtx` passed `config: DEFAULT_CONFIG.debate`,
  the *inner* `DebateConfig`, where `build`/`model`/`parse` want
  `BuildContext<Pick<NaxConfig, "agent" | "debate">>` (both ops declare `C` via
  `debateConfigSelector = pickSelector("debate", "debate", "agent")` — the §9 pattern-2 fix,
  derive C from the selector); (b) **4 × TS2349** — `op.model` is an `OperationModel` union
  (`ConfiguredModel | resolver`), so `op.model?.(…)` is structurally uncallable; narrowed with
  a `typeof === "function"` guard and called the narrowed resolver — no cast. There is nothing
  polymorphic here to exempt.

### Escalation recorded, not fixed — `debate/pre-phase/grounder` (6)

`unit/debate/pre-phase/grounder` still has 6 × `TS2339: 'packageView' does not exist on type
'NaxRuntime'` at lines 28/65/99/136/168/212 — the shared `ctx.ctx.runtime.packageView`
construction in every test. Per the plan's explicit ruling (write up, do not add the field, do
not cast it away), **untouched**. The evidence for the owner's decision:

- `NaxRuntime` (`src/runtime/index.ts:114`) exposes `packages: PackageRegistry` (line 130) and
  **no** `packageView`; a `PackageView` is obtained as `runtime.packages.repo()` /
  `.resolve()`. `CallContext.packageView` (operations/types.ts:17) is required but the grounder
  and its pre-phase resolver **never read it** (grep of `src/debate/pre-phase/*.ts` is empty).
- So the fixture is not merely hitting a renamed field; it asserts a `CallContext` that must
  carry a `PackageView` while the only field it reaches for is one `NaxRuntime` has never had.
  The resolution is a design call: thread the `PackageView` (or drop the requirement) rather
  than add a field to `NaxRuntime` or cast. 6 errors stay in the 546 baseline.

### Constructs tsc could not see

- The disjointed `hooks: []`→`statusFile` unmask in `runner-plugin-integration` — a wholesale
  shape error suppressing the missing-property report beneath it (§19's trap, third time).
- The phantom `reason: "required_infrastructure_missing"` and `complexity: "low"` values that
  only ever lived in fixtures whose enclosing literal was failing to typecheck as a whole, or
  inside cast-shielded `callOp` mocks. The `complexity: "low"` copy in the draft mock still
  does today.

Residue at these commits: **546 errors across 223 files.** The branch has taken
692 → 546 (−146) across the two batches, matching the lane-a plan's Batch 1 + Batch 2 landing
point (692 → ~610 → ~546). Against the original #1514 start: typecheck **2009 → 546 (−73%)**,
casts **815 → 102 (−87%)**, `looseCast` **1994 → 1927** with none added.

## 30. Lane A Batch 3 — the tail (546 → 474, −72)

21 commits on `chore/1514-lane-a-drain`, one file per commit, each through the full loop
(src tsc 0, per-file `worse: 0`, targeted test, 25/25 gates, `bun run test`, `bun run
test:coverage` at ≤103/103, `check:test-typecheck:update` last). **546 → 474** across
223 → 202 files. All six escape-hatch counters flat or lower — `looseCast` **1927 → 1925**
(the only mover, both cast deletions from `parallel-worker`), `as unknown as` flat at 102.
This is the Batch 3 tail: every file ≤3–6 errors, no table, `grep` the file → read the error
→ apply a proven recipe or move on.

### The CompleteResult legacy shape — 10 files, the batch's biggest cluster (−27)

`{ output, costUsd, source }` is the pre-`CompleteResult` shape (`src/agents/types.ts:319`
wants `{ output, tokenUsage, estimatedCostUsd }`). §27 named ~6 surviving review files; the
live count was **10**, all with the identical `makeAgentManager` fixture:

`semantic-unverifiable`, `semantic-threshold`, `adversarial-verifiedby`,
`adversarial-metadata-audit`, `adversarial-pass-fail`, `semantic-debate`,
`semantic-findings`, `semantic-parsing`, `semantic-prompt-response`,
`semantic-signature-diff`. Each `completeFn`/`completeWithFallbackFn`/`completeAsFn` got
`tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: cost`. No counter moved —
the `costUsd`/`source` phantom fields were never read by the ops (§27 confirmed). One
extra per file: `adversarial-metadata-audit` carried a `naxConfig` key that
`RunAdversarialReviewOptions` calls `config` (TS2561), renamed; `semantic-signature-diff`
had a stale "accepts five parameters" compile check for a `runSemanticReview` that now takes
an options object — rewritten to the real `RunSemanticReviewOptions` form.

### Recipes reused from the province

- **`PlanDeps.getLogger` + `PlanModeContext.profileName`** — `debate-strategy`,
  `refine-strategy`, `single-strategy`, `strategies.test` all had the §28/§29 pair: missing
  `getLogger` (fixed with `makeLogger`) and optional-`profileName` (fixed with `"default"`,
  the runtime's documented fallback). Four files, one recipe.
- **`PackageSummary` casts** — `refine-strategy`/`single-strategy` cast
  `{ path, packageName, stackSummary }` to `PackageSummary`; `packageName`/`stackSummary`
  don't exist on it (the fields are `name`/`keyDeps` etc.). Completed the literal.
- **`createDebateRunner` stubs** — `debate-strategy`'s `mock(() => ({ runPlan }))` →
  `mock(() => makeDebateRunner({ runPlan }))` (§13 recipe; keeping the outer `mock` preserves
  `toHaveBeenCalledTimes`). Also replaced the hand-rolled `makeRuntime` (missing 8 `NaxRuntime`
  fields after the deps fix) with `makeMockRuntime()` + `runtime.close = closeImpl`.
- **`callOp` args via `firstCall`** — three files read `mock.calls[0] as [Record<string,
  unknown>, unknown, Record<string, unknown>]`. The `as` failed (CallContext has no index
  signature) and the mock was zero-arg so `calls[0]` was `[]`. R2'd the mock
  (`..._args: Parameters<typeof deps.callOp>`) and read via `firstCall` (§16 helper). One
  unmask: `expect(op).toBe(planInteractiveOp)` then fails on the generic `Operation` variance,
  so the identity assertion widens the op through a `const dispatchedOp: unknown` — the op
  itself is now properly typed as `Operation<unknown, unknown, unknown>` instead of `unknown`.
- **`setPostRunPhase` overloads** — `runner-completion-postrun` and
  `lifecycle/run-completion-postrun` both assigned `mock((phase: string, update: { status:
  string }) => …)` to the overloaded `StatusWriter.setPostRunPhase`. `phase: string` is too
  wide for the `"acceptance"|"regression"|"finish"` literals, and `{ status: string }` can't
  overlap `Partial<AcceptancePhaseStatus>` (`status?` is optional). The clean fix is the
  helper's sanctioned override path: `makeStatusWriter({ setPostRunPhase: mock(…) })` — the
  `unknown`-typed override param skips the overload check entirely and keeps `update.status:
  string` in the bodies. 6 sites across 2 files. Two `new Date(x as string)` round-trip
  assertions per file were reworked to `assertDefined(passedCall)` +
  `assertDefined(passedCall.lastRunAt)` — **the `as string` casts deleted outright**.
- **`RoutingDecision` mocks** — `parallel-worker` returned `{ complexity, modelTier,
  testStrategy }` missing `reasoning`; annotated `(): RoutingDecision` and dropped the two
  `as typeof` casts (R6 — the mock is now directly assignable).

### What the fixes unmasked (each a real defect, none added a counter)

- **`runner.test.ts`** — the `rectification: { maxIterations: 3 }` dead key was a wholesale
  rejection hiding **13 required `RectificationConfig` fields** and a `RegressionGateConfig`
  missing `timeoutSeconds`; the whole `executionConfig` literal was missing 6 `ExecutionConfig`
  fields. `{ ...DEFAULT_CONFIG.execution }` + explicit overrides. And `modelTier: "powerful"`
  on `SemanticReviewConfig` is `model:` — the fixture's own `objectContaining` assertion
  mirrored the phantom key, so both had to change or the assertion would fail at runtime.
- **`plan-inputs-review-wiring`** — `inlineReview: true` is a **removed legacy key** US-005c
  (`compat-shims.ts:239` strips it with a warning); the rectification gate only reads
  `execution.rectification.enabled`. Dropped. The `excludePatterns: undefined` "derive" state
  (ADR-009 §4.4) can't be spelled as a spread of the interface-typed
  `DEFAULT_CONFIG.review.semantic` — **spreading an interface-typed value with an optional-key
  path loses required-field requiredness** (probe-verified; `exactOptionalPropertyTypes` is
  off, so this is spread semantics, not the flag). File-local `withoutExcludePatterns()`
  destructures the key out cast-free.
- **`semantic-categories`** — `outcome: "fixes-applied"` is a phantom `IterationOutcome`
  (the union is `resolved|partial|regressed|unchanged|regressed-different-source`);
  `countPriorAppearances` never reads `outcome`, so `"unchanged"` is faithful. The
  `test.each` tuples widened `expected` to `string`; annotating
  `test.each<[unknown, SemanticCategory | ""]>` pins it.
- **`debate-strategy`** — dropping the `as never` on the old `createDebateRunner` stub
  surfaced the 8-field `NaxRuntime` gap and the generic `Operation` variance.

### Constructs tsc could not see

- **`runner-language-fallback.test.ts` (2 errors) — SKIPPED, needs a design decision.** The
  dep slot is `_reviewRunnerDeps.file = Bun.file` (a 3-overload `typeof` type); the tests mock
  it with `{ text: () => Promise<…> }` cast `as typeof _reviewRunnerDeps.file`. The cast now
  fails with TS2352 because `{ text }` cannot overlap `BunFile`. No cast-free test-side fix
  exists: `as unknown as` would raise the 102 counter (G4), narrowing the dep is `src/` (G5),
  and `Bun.file(new Blob([…]))` throws in this Bun (only path/fd overloads accept).
  `Bun.file` on a real temp file is the only overlap-valid path but changes runtime behaviour
  per scenario — not a typing commit. **2 errors stay in the 474 baseline.** The right fix is
  either narrowing `_reviewRunnerDeps.file` to `(path: string) => Pick<BunFile, "text">` in
  `src/review/runner/index.ts`, or a counted helper.
- **`debate/pre-phase/grounder` (6) — untouched per the plan's explicit ruling** (§29
  escalation: `NaxRuntime` has no `packageView`; resolution is a design call for the owner).

### Transient artifact worth recording (NOT a #1514 issue)

During this batch's full-suite runs, `deferred-review-integration` (and the run it drives)
intermittently wrote run artifacts to a **literal `undefined/` directory** at the repo root
(`undefined/nax-deferred-review-integration-*/test-feature-run-test-123/meta.json`). One such
run swept 35 `meta.json` files into a `git add -A` commit; the commit was caught, reset, the
junk purged, and the commit re-done with explicit file staging. The trigger is a test-isolation
bug (a temp base resolving to the string `"undefined"`), **not** caused by any drain change and
not reproducible in isolation. Unrelated to the typecheck drain; filed here so nobody blames a
`git add -A` in a later lane. **Lesson for this branch: stage files explicitly, never `-A`.**

Verify: src tsc **0** incl. contracts. 546 → 474, files 223 → 202, per-file `worse: 0`. All six
counters flat or lower (`asAny=1387, tsSuppress=40, ratchetAllow=106, absentValue=17,
anyType=1878, looseCast=1925`); `as unknown as` flat at 102. 25/25 gates green; full suite green
across all three phases; `test:coverage` at 102/103 below-floor (one file moved above its floor —
strictly better, never worse). The branch has taken 692 → 474 (−218) across Batches 1–3.

## 31. The owner-only residue — the two escalations and the excluded trio (474 → 415, −59)

Branch `chore/1514-owner-residue`, cut from `main` after PR #1695 merged Lane A. Five files,
five commits, one file per commit, each through the full loop. **474 → 415** across 202 → 197
files. Every counter flat or lower: `asAny` **1387 → 1386**, `anyType` **1878 → 1877**, the
other four unchanged, `as unknown as` flat at 102.

The headline finding: **four of the five were misdiagnosed as needing a `src/` decision, and
did not.** Only one needed a `src/` change at all, and it was a two-line narrowing.

### The two escalations

**`review/runner-language-fallback` (2) — the one real `src/` fix.** `_reviewRunnerDeps.file`
was declared `Bun.file`, i.e. the three-overload `(string | URL | TypedArray | number, options?)
=> BunFile` signature. `loadPackageJson` only ever calls it as `file(path).text()`. The gap made
the file untestable cast-free: `{ text }` cannot overlap `BunFile`, so the existing
`as typeof _reviewRunnerDeps.file` failed TS2352, `as unknown as` would raise the cast ratchet,
narrowing was `src/`, and `Bun.file(new Blob([…]))` throws in this Bun. §30 recorded exactly
this and left the 2 errors in the baseline. Narrowing the slot to
`(path: string) => Pick<BunFile, "text">` states the module's real dependency; `Bun.file` stays
assignable, so runtime behaviour is identical, and **both test-side casts were deleted rather
than rewritten.** The `import type { BunFile } from "bun"` must sit in Biome's third import
group (after `@/…`), not first — organizeImports rejects the natural placement.

**`debate/pre-phase/grounder` (6) — not a contradiction.** §29 escalated this as "the test
asserts `NaxRuntime.packageView`, a field the runtime does not have — a design call for the
owner." Reading it settles it in one grep: `packageView` is a **required** field of
`CallContext` (`src/operations/types.ts:11`) and is very much real. Only the fixture's accessor
was stale — the PackageView comes from `runtime.packages.resolve(packageDir?)`, which is what
all thirteen production call sites use. Six identical fixture lines. **The escalation was
right to stop rather than cast it away, and wrong about the cause** — "the runtime has no such
field" was true of the accessor, not of the concept.

### The excluded trio

**`execution/story-orchestrator-run-phase-events` (15) — an alias derived from the wrong
function.** The plan called this an `Operation`/`AnySlot` variance question under amended G5.
It is not a variance question: the file wrote
`type AnyOp = Parameters<typeof _storyOrchestratorDeps.callOp>[1]`, which is the full
`Operation` union with complete-kind included, while `runPhase` takes an `AnySlot` whose `op`
is `RunOperation | DeterministicOperation` — narrower on purpose, since a phase slot cannot be
a one-shot complete. The fixture's own `makeOp` already returns a `kind: "run"` shape, so
aliasing `AnySlot["op"]` types it as what it always was. **Two lines, all 15 errors, no `src/`
change.**

**`unit/config/merge` (17) — three phantom keys the fixtures never followed.** The plan called
it "six codes, uninspected, adjacent to the merge surface". The six codes were one cause seen
from several angles:

- `review.pluginMode: "per-story"` (8 sites) is a value US-005c **removed**; the live union is
  `"observational" | "gating"` and `compat-shims.ts:254` strips the old one with a warning. The
  override test paired it with `"deferred"` — never a member at all — so the assertion proved
  nothing about a real config. Now `observational → gating`, an override the merger must
  actually get right.
- `review.semantic.modelTier` was renamed `model` (migrated by `migrateLegacyReviewModelKey`).
  **The same defect Batch 3 found in `runner.test.ts`** — third sighting of this rename.
- The `regressionGate` `test.each` widened its tuple, making `getField` a union of function
  types. Pinned with an explicit type argument, the §30 `semantic-categories` recipe.

Trap 4 fired on schedule: clearing the wholesale rejections unmasked field-level gaps
underneath. `ReviewConfig` also requires `parseRetryMaxAttempts` + `conflictDetection`;
`SemanticReviewConfig` requires `diffMode` + `resetRefOnRerun` + `timeoutMs`. Two file-local
factories supply them. **`makeReview` spreads `DEFAULT_CONFIG.review`; `makeSemantic` cannot** —
`review.semantic` is `.optional()` with no `.default()`, so `DEFAULT_CONFIG.review.semantic` is
`undefined` and there is nothing to spread. Its required fields are written out to the schema's
own declared defaults, which is faithful transcription, not invention.

**`integration/config/merger` (19) — the per-call-site decision, made.** `deepMergeConfig<T>`
defaults `T` to `NaxConfig`, so every untyped call in the file claimed its probe fixture was a
parsed config. It is not: **the merger runs on raw layered JSON, before Zod.** That single fact
explains both error clusters — the four `result.constitution.content` TS2339s (the merger
concatenates that key at `merger.ts:113-131` while `ConstitutionConfigSchema` has no such
field, because the parse strips it) and the nine TS2769s (`toEqual({ a: 1 })` has no overload
against a `NaxConfig`).

This is why §4's blanket `deepMergeConfig<Record<string, unknown>>` backfired (19→15 while
adding 6 `TS2339` + 6 `TS18046`): it erased the shape the later tests read fields off. The fix
is what the exclusion asked for — a **per-call-site type stating the shape each call actually
merges**, including the null-removal cases, where the removed key is genuinely absent from the
result type and so absent from the annotation. Two named raw types (`RawConstitution`,
`RawHooksConfig`) carry the repeated shapes; typing the three-level hook merge also retired the
file's `(merged2 as any)`, narrowing through `Array.isArray` instead.

### What this says about the exclusion list

Three files were held back for an owner because a delegate could not decide them. Read, all
three turned out to be stale test-side references — a wrong alias, removed config keys, and a
default type argument nobody had questioned. The exclusions were still correct *as exclusions*:
each needed someone willing to check whether a `src/` type was wrong before concluding the test
was. But the prior on "this needs a `src/` change" should be lower than these notes assumed —
**one src/ line changed across 59 errors.**

Verify: src tsc **0** incl. contracts. 474 → 415, files 202 → 197, per-file `worse: 0`. 25/25
gates green; full suite green across all three phases; `test:coverage` 102/103 below floor,
exit 0, on every commit. Counters: `asAny=1386, tsSuppress=40, ratchetAllow=106,
absentValue=17, anyType=1877, looseCast=1925`.

### Still open after this

- **The tail** — ~415 errors across 197 files, none above 8. **"No cluster larger than one
  file" is wrong** — grouping by error message rather than by file finds cross-file clusters
  sharing one recipe. See §32.
- **`test/unit/cli/plan.test.ts`** stays grandfathered in `file-sizes-baseline.json` at 1202
  lines; a fix there must be line-neutral or shrinking.

## 32. Guard before delegation — the tail is recipe-shaped, and two hatches were open

Branch `chore/1514-guard-before-delegation`, three commits, **no typecheck change** (415
throughout). This is groundwork for handing the tail to a cheaper model, not drain work.

### The tail is not file-shaped

§31 closed with *"none above 8, no cluster larger than one file."* True by file; false by cause.
Grouping the 415 by normalized error message finds cross-file clusters that share one recipe —
`Mock<() => X>` into a typed dep slot is ~35 errors across ~30 files, and three of its
sub-clusters have an existing helper or a proven annotation. **Group by message as well as by
file before declaring a tail heterogeneous.**

### Two escape hatches were uncounted, and they were the ones that mattered

- **`as never` — 619 in test/, invisible.** `looseCast` is `/\bas\s+[A-Z]\w*/`; `never` is
  lowercase. §13 noticed this in passing ("`as never` is matched by none of the six patterns")
  and moved on. `never` is assignable to every type, so it silences any assignment error in one
  word — including the entire `Mock<() => X>` family that is now the largest thing left.
- **Postfix `!` — 827 in test/, invisible to the ratchets *and* to Biome.** §12 named it "the
  uncounted hole" and deliberately did not delegate the `TS18046/47/48` cluster because of it.
  What nobody checked: `biome.json:20` sets `noNonNullAssertion: "off"` for `test/**`, so the
  lint pass did not catch it either. §16 then drained that cluster by hand and the hole stayed.

Both now counted (`asNever`, `nonNullAssert`). Negative control before baselining: one `as never`
and one `x!.y` added to a test file trip the gate at 619→620 and 827→828.

The `!` pattern is anchored to postfix position and **undercounts on purpose** — `x! + 1` and an
end-of-line `!` are missed. One false positive survives (prose punctuation mid-string, e.g.
`"wow!, really"`; zero such strings exist in test/ today) and is pinned by a test so it stays a
documented property. A ratchet that false-positives on an honest comment invites gaming, which
is the same reasoning `anyType`'s docstring already records.

### The baseline had 69 points of slack

`check:test-escape-hatches` fails on growth *against the committed baseline*, and §30/§31 drained
counters without ever running `--update-baseline`:

```
committed: asAny=1388  anyType=1880  looseCast=1994
live:      asAny=1386  anyType=1877  looseCast=1925
```

69 unmarked `as T` casts could have been added with all 25 gates green. Re-baselined.
**A drain commit that lowers a counter must also lower its baseline, or it hands the next
worker free headroom.** (`as unknown as` was unaffected — it sits at its floor, 102/102.)

### A cluster that looked mechanical and was not — fourth time

`_planDeps.createRuntime` (10 errors, 5 files) reads as a stale fixture: `Mock<() => IAgentManager>`
in a slot declared `(cfg, wd, featureName) => NaxRuntime`. It was written into the first draft of
the handoff as the *safest* cluster. Reading `src/cli/plan-runtime.ts:34-41` removed it:
`createPlanRuntime` casts the dep result to `unknown`, duck-types it with
`isRuntimeWithAgentManager`, and wraps a bare `IAgentManager` when that is what it gets. The
production seam **deliberately accepts both shapes**; only its declared type says otherwise. The
tests exercise the documented second path, so every test-side fix is either a fabricated runtime
or a cast. Escalated — the fix is widening the dep's type in `src/`.

**The rule:** before delegating a cluster, read the `src/` side of the seam. An error message
describes the type mismatch, never which side is wrong.

### Handoff

`docs/plans/HANDOFF-1514-tail-recipes.md` — clusters B (8) and C (14) with both recipes
prototyped on the live tree and reverted, cluster A escalated with evidence, G1, and an explicit
bail rule ("a reverted file is a good outcome; a silenced file is a failed batch"). Expected
landing 415 → ~393.

---

## 33. Cluster A — §4 of the tail handoff was wrong, and the fix was test-side (393 → 383)

`HANDOFF-1514-tail-recipes.md` §4 marked cluster A (`_planDeps.createRuntime`, 10 errors,
4 files under `test/unit/cli/plan-decompose-*`) **NOT DELEGABLE**, on the reasoning that
`src/cli/plan-runtime.ts:34-41` duck-types `NaxRuntime | IAgentManager` on purpose, so the
only honest fix was a `src/` type widening — an owner call, and therefore outside G5.

That verdict came from reading the `src/` side and stopping there. Reading the **sibling
tests** reverses it: `plan-decompose-ac-repair`, `ac13-14`, `regression` and `plan-debate`
already wrap their manager in `makeMockRuntime({ agentManager })` and typecheck clean. The
four erroring files were plain stale stragglers — the same "held back for an owner, actually
just stale" case §31 found three times.

```ts
_planDeps.createRuntime = mock(() =>
  makeMockRuntime({ agentManager: makeMockDecomposeManager(...) }),
);
```

Not a fabrication: `makeMockRuntime` is built on the real `createRuntime` — the same call the
production fallback path makes — plus `trackRuntime` leak tracking. One commit per file,
**393 → 383**, all eight escape-hatch counters and `as unknown as` flat.

### The rule §4 stated but did not finish applying

§4's own sentence is right: *"an error message tells you two types disagree, never which side
is wrong."* It applied that to `src/` and not to the neighbouring fixtures. Reading the `src/`
side is **necessary, not sufficient**.

**Before escalating a test-typecheck cluster as an owner call, grep sibling test files for the
same dep override. If any sibling already typechecks, the recipe exists and the cluster is
delegable.** This is now G6 in the batch-2 handoff.

That makes it *three* directions the cause column has been wrong in: §29 recorded it wrong
twice out of six batches, §31 found three files wrongly held back for an owner, and §4 held
back a fourth. The prior on any "not delegable" verdict is weak — including the ones in the
batch-2 handoff.

### Follow-up: the duck-typed fallback was dead, and is gone (`cd5ee7b52`)

Having established the tests do not need the second shape, the second shape had no callers
left. Confirmed before deleting, rather than argued:

- Patched the branch to append which path it takes to `$PROBE_FILE`, then ran
  `FULL=1 NAX_PRECHECK=1 bun test test/` — 15381 tests produced **164 calls, all path 1, zero
  fallback**. `test:e2e` never calls it at all.
- `NaxRuntime.agentManager` is non-optional and always assigned.
- The package ships `bin`-only (no `exports`/`main`), so `_planDeps` is not importable public
  API and there is no external caller to preserve it for.

**Technique worth reusing:** to prove a branch is dead, make it *say so at runtime* under the
full suite. Static reading could not have settled this one — the guard is a duck-type, so no
type or grep tells you which shape actually arrives.

Pre-existing `FULL=1` failures are **4** (one Logger, three precheck). Compare a full-mode run
against those, not against zero.

## 34. The tail-recipes batch-2 handoff, applied — A–F done, 383 → 356 (2026-08-24)

`HANDOFF-1514-tail-recipes-batch2.md` measured each cluster on the live tree and reverted; this
section is the application, on `chore/1514-tail-recipes-batch2` (head `e72ff2835`). The §3
landing is reproduced exactly: **383 → 356**, 17 commits, one file each (G4). The §1 loop ran
per commit, unmodified.

| cluster | files | edits | measured | landed |
|:--|:--|--:|--:|--:|
| A `durationMs`→`runElapsedMs` (`story:completed`) | event-bus, events-writer, hooks, reporters | 7 | −7 | **−7** |
| B dead `models: {}` (debate selectors) | judge, majority, synthesis, verifier-pick | 4 | −3 (one masked) | **−3** |
| C otel `logs` fixture field | 4 otel files | 4 | −4 | **−4** |
| D `untrackedBefore` on `InspectionOptions` | scratch-per-role, verdict-cleanup, post-run-isolation | 4 | −4 | **−4** |
| E `failedTestFiles` on `DeferredRegressionResult` | lifecycle-completion | 5 | −5 | **−5** |
| F `featureName` on `TriggerContext` | triggers | 4 | −4 | **−4** |

Guards, all held across all 17 commits:

- **G1** — the syntax guard printed exactly one line: the pre-existing `TS1355` in
  `smart-runner.test.ts:516`, nothing else, every commit.
- **G2** — all eight escape-hatch counters and `as unknown as` sat flat at baseline 1386 / 40 /
  106 / 17 / 1877 / 1925 / 619 / 827 and 102 throughout; `src` tsc stayed 0.
- **G4** — one file per commit, explicitly staged; the working tree is clean.
- The §§2A/2C/2F traps were followed deliberately: the `durationMs` renames hit only the
  `story:completed` literals (reporters kept its 9 legitimate uses, including the `:235`
  assertion); the logs fixtures got the **disabled** default even in the logs-lifecycle file;
  and each `substituteTemplate` template was verified to avoid `{{featureName}}` before
  `featureName: "f"` was added.

Two findings worth recording, both in hand:

- **The mask bait was taken and not chased.** `verifier-pick.test.ts`'s `models` line yields 0
  because a sibling excess-property error masks it; the edit is correct, the total is flat, and
  the §2B instruction is to *not* go hunting for a second fix to make the arithmetic come out.
  The loop's step-4 rail therefore reads "the total moved by the §3 amount **for this file**",
  and for that one file the amount is 0.
- **Cluster G is genuinely owner-shaped, confirmed not just asserted (§5 of the handoff).**
  Applying it means rewriting each fixture to `makeNaxConfig(...)`, changing what the file
  exercises, with an unknown number of masked keys behind the visible TS2353s, and the loop's
  "total must drop by exactly N" rail inverts on the way there. The worked example on
  `tier1-blockers` (whose visible baseline was 2 errors) needed the whole fixture converted to
  `makeNaxConfig`, which unmasked **8** errors total — three partial attempts in between
  (`resetMode`, then `defaultAgent`/`requireExplicitContextFiles`, then
  `makeConfigSlice("execution"/"autoMode", …)`) each only revealed more, and only an owner can
  sign off per file on what the fixture then exercises. **Remaining for the owner:** the five
  precheck files plus, to reach the stretch, `triggers.test.ts:75`'s TS2322 (not part of
  cluster F).

Coverage gate (`bun run test:coverage`) is green on the landed tree: **lines 87.67% (64411/73471),
functions 87.36% (6041/6915), floor 80%**, and the per-file ratchet holds — 102 files below
floor against a baseline of 103, no new violation, no grandfathered drop.

## Next

The residue is **356 across 177 files**. What remains is no longer recipe-shaped in the batch
sense — the six regex-recipes of the last handoff are drained (or, in G's case, owner-signed).

- **Cluster G — precheck config fixtures (§5), owner only.** Five files
  (`test/unit/precheck/precheck-checks-tier1-blockers`, `precheck-checks-tier2-warnings`, and
  the two `test/integration/cli/` files) with 5 visible TS2353s that are a floor, not a census.
  The conversion is `createMockConfig` → `makeNaxConfig({...})`, verified on `tier1-blockers`,
  plus three documented dead ends. Its true size is unmeasured until applied.
- **`triggers.test.ts:75`** — one TS2322, left behind when cluster F landed (which is why the
  file's drop is −4 in a cluster that touched it 4 times).
- **Still deferred, from `HANDOFF-1514-tail-recipes.md` §5:** `TS2769` (23, scattered, no shared
  cause found), `TS7024` (9, needs a real return type worked out per function — cheap to get
  wrong, invisible when wrong), and `TS2352` → `Record<string, unknown>` (7 errors, 7 files,
  unmeasured — do not treat the resemblance to §22 as a recipe).

As §30 cut it: every drain commit that lowers a counter must also lower its baseline. The 383
baseline carries into this landing correctly because each of the 17 commits re-ran
`check:test-typecheck:update` after its gates — no slack was handed onward.

## 35. Cluster G — precheck config fixtures, done (356 → 347, 2026-08-24)

`HANDOFF-1514-tail-recipes-batch2.md` §5 marked cluster G owner-only, off `origin/main` @
`f2519a395` (test typecheck 356), branch `chore/1514-tail-cluster-g`, 4 commits — one file
each, per G4:

| file | baseline errors | fix | landed |
|:--|--:|:--|--:|
| `precheck-checks-tier1-blockers.test.ts` | 2 | `createMockConfig` deleted — **never called**, confirmed by grep and by identical 30 pass/3 skip before and after | **−2** |
| `precheck-checks-tier2-warnings.test.ts` | 5 | `createMockConfig` → `makeNaxConfig({execution: {...}})`; `checkOptionalCommands` gained a `workdir` param since the handoff was written, wired to an isolated `makeTempDir()` | **−5** |
| `test/integration/cli/cli-precheck-checks.test.ts` | 1 | same conversion + dropped dead `execution.cwd` (nothing in `src/` reads it — `runPrecheck` takes `workdir` separately) | **−1** |
| `test/integration/cli/cli-precheck-integration.test.ts` | 1 | identical fixture, same fix | **−1** |

**§5's own worked example was wrong about tier1-blockers being a conversion case** — the
handoff measured the `makeNaxConfig` swap landing 383 → 375 on `createMockConfig`, but never
checked whether anything called it. It didn't. `test-debt-ratchets-uncounted-escape-hatches`
memory: check fixture usage before applying a documented conversion recipe, every time — a
dead fixture typechecks the same whether deleted or converted, and deleting is strictly
cheaper. The other three files' fixtures *were* live (17, 16, and 14 tests respectively) and
needed the real conversion; §5's recipe was correct for those.

`anyType` dropped 2 as a side effect (`overrides: any` on the two `cli-precheck-*` fixtures
narrowed to `Partial<ExecutionConfig>` during the conversion) — a bonus, not a violation, all
other counters flat at baseline throughout. Full suite green after every commit (1137
pass/37 skip unit+integration, 38 UI pass); the two `cli-precheck-*` files stayed at their
pre-edit 0 pass/16 skip and 0 pass/14 skip (`FULL=1`-gated, needs a real `claude` binary — not
run here).

**Cluster G is fully drained.** 356 → **347**, 173 files.

## Next

Residue: **347 across 173 files.** What's left is the tail the batch-2 handoff §4 explicitly
deferred, unmeasured beyond a baseline count:

- **`TS2769`** — 23, scattered, no shared cause found across two prior passes (batch 1 §5,
  batch 2 §4).
- **`TS7024`** implicit-`any` recursive return — 9, needs a real return type worked out per
  function; cheap to get wrong and invisible when wrong.
- **`DispatchContext`** (3) and the rest of the long tail: per-site, no recipe.

## 36. `triggers.test.ts` + the `TS2352` → `Record<string, unknown>` cluster, measured (346 → 340)

Still on `chore/1514-tail-cluster-g`, 6 more commits, one file each per G4.

`triggers.test.ts:75` (347 → 346): `makeConfig(triggers: Record<string, unknown>)` was looser
than what `makeNaxConfig({interaction: {triggers}}` actually needs.
`InteractionConfig["triggers"]` (imported from `@/config/runtime-types` — not re-exported
through the `@/config` barrel) is the real type; every call site already passed values
matching it.

§35's finding generalises: **measure the `TS2352` → `Record<string, unknown>` cluster before
assuming it matches §22.** It didn't, on both counts. §22 was `NaxConfigSchema.safeParse`'s
input side (a cast on the source of a spread feeding something typed `unknown` — almost none
of those casts did anything). This round's 7 sites, re-grepped fresh (6 files, not 7 — one
file had 2), were read/write sites instead — a value with a real, narrower type being
force-cast to `Record<string, unknown>` so a property read or reassignment would compile:

| file | what the cast was hiding | fix | landed |
|:--|:--|:--|--:|
| `agents/acp/adapter.test.ts` | none — `client.createSession = mock(...)` already matched `MockAcpClient`'s declared signature | cast deleted outright (§22-shaped: did nothing) | −1 |
| `cli/plan.test.ts` | `(s as Record<string, unknown>).complexity` read a property `UserStory` doesn't have (`routing.complexity` is the real path) — **but the field's presence in the fixture is load-bearing**, `validatePlanOutput` accepts a legacy top-level `complexity` too (`routing.complexity ?? complexity`, `src/prd/schema.ts:187`). Deleting it outright breaks 5 tests; the read was dead, the write wasn't | literal `complexity: "simple"` (line-neutral — file is grandfathered at 1202 lines) | −1 |
| `execution/lifecycle/acceptance-fix.test.ts` | `capturedInput` declared `Record<string, unknown>` for no reason — the real type (`AcceptanceDiagnoseInput`, the actual param type of `_diagnosisDeps.callOp`) was one import away | typed directly, cast dropped | −1 |
| `execution/lifecycle/mutation-summary-completion.test.ts` | `mock(() => {})` with no declared params makes every `.mock.calls[n]` element `undefined` — cast was compensating for an untyped mock, not a real narrowing | typed the mock against `Logger.warn(stage, message, data?)`; cleared a second latent error alongside the targeted one | −2 |
| `operations/setup-generate.test.ts` | double-cast (`Record<string, unknown>` then a hand-rolled shape) around `result.config`, which is already `NaxConfig` (non-null) on `setupGenerateOp`'s Output type | direct `.quality.commands.test` access | −1 |
| `bakeoff/coordinator.test.ts` (2 sites) | **genuinely load-bearing — left alone.** `withCoordinatorDeps` saves/restores `_coordinatorDeps` by dynamic key (`Object.keys(overrides) as Array<keyof BakeoffCoordinatorDeps>`, `saved[key] = _coordinatorDeps[key]`). Tried and reverted: this hits TypeScript's correlated-union-key problem — assigning `T[K]` to `Partial<T>[K]` for a `K` that's a *union* of several unrelated function-signature types doesn't type-check, because TS can't prove `saved[key]` and `_coordinatorDeps[key]` pick the same union member at the same iteration. The `Record<string, unknown>` cast is the least-bad way to do this generic save/restore pattern | reverted, unchanged | 0 |

Every commit: syntax guard, per-file typecheck diff, `check:test-escape-hatches` /
`check:test-as-unknown-as` flat or better (both `anyType` and `looseCast` dropped as a
bonus — untyped `mock()` calls and single-`as` casts were removed alongside the targeted
`TS2352`s, never added), matching test pass/fail counts before and after (`git stash` /
`git stash pop` around each file), `check:all` 25/25 green, full suite green after the final
commit (1137/37/0 unit+integration, 38/0 UI). `346 → 340`, 170 files.

**The `TS2352` → `Record<string, unknown>` cluster is drained** except `bakeoff/coordinator.test.ts`'s
2 sites, which are a correct, documented exception — not deferred debt.

## Next

Residue: **340 across 170 files.**

- **`TS2769`** — 23, scattered, no shared cause found across three prior passes now (batch 1
  §5, batch 2 §4, this round did not re-check it).
- **`TS7024`** implicit-`any` recursive return — 9, needs a real return type worked out per
  function; cheap to get wrong and invisible when wrong.
- **`DispatchContext`** (3) and the rest of the long tail: per-site, no recipe.

## 37. `TS2769` (23 → 0), `TS7024` (9 → 0), and the 3 "`DispatchContext`" sites — all three drained (340 → 303, 2026-08-24)

Still `chore/1514-tail-cluster-g`, 12 more commits (one file each, per G4). All three prior
"no shared cause" verdicts were half right — no single fix, but **two repeatable families**
covered nearly everything.

### `TS2769` (23 sites, 15 files → 0)

Once actually read case by case (not just counted), two shapes covered ~19 of the 23:

1. **`test.each` array-literal widening** — the classic culprit again, but for `toBe`/
   `toEqual`/`toContain` overload resolution instead of `TS2352`. A `test.each` table's
   "expected" column loses its literal type without `as const`; the received side (a real
   function's return type, often a narrow union or literal) then rejects the widened
   `string`/plain-object argument. Fix: `as const` on the whole table (`calculate.test.ts`,
   `plan-inputs.test.ts`, `session-role-plan-critic.test.ts`, `cli-precheck-command.test.ts`'s
   sibling array, `plan.test.ts` ×2). Where columns are non-uniform (a getter function AND
   its expected value both vary per row — `debate/resolvers.test.ts`), `as const` alone hits
   TypeScript's correlated-union problem; an explicit `Array<[string, T[], boolean,
   "passed"|"failed"]>` annotation gave every column its real type directly, with no cast at
   all and two pre-existing casts removed as a bonus. `findings/cycle.test.ts` needed
   `satisfies ClassifyCase[]` instead of a separate typed `const` + `test.each(name)` — the
   two-statement form grew the file 1 line past its grandfathered cap; `satisfies` uses the
   target type as a literal-inference hint without a second statement.
2. **`expect()`/`toContain()` narrowing a possibly-undefined or wrongly-typed value** —
   `process.env.X` (`config/paths.test.ts`), an optional fixture field
   (`features-resolve.test.ts`), a hand-typed `Record<string, unknown> | undefined` capture
   var (already-covered ground from §36) all hit the same shape: `assertDefined()` narrows
   the sanctioned way. `tui-controls.test.ts`'s `PanelFocus` enum comparison needed the
   opposite move — swap which side of `.toBe()` is the raw literal, since a plain string
   isn't assignable to a nominal enum type but an enum member widens to string covariantly.
   `acceptance-diagnose.test.ts`'s `"weird" as FixTarget` is the one legitimate new cast in
   this batch — the test exists specifically to prove an off-domain string passes through
   unvalidated (`src/findings/adapters/acceptance-diagnose.ts:17` does the identical cast on
   the LLM's raw output, by design), so casting the expected value states that intent instead
   of failing the overload.

Two were real bugs, not widening: `pipeline.test.ts` assigned a raw string to
`ctx.constitution` where the type is `ConstitutionResult` — genuinely wrong, fixed with a
real object and `.content` reads. `bakeoff/coordinator.test.ts` needed a plain
`as ContestantResult[]` matching a cast three lines above it (`Mock.results[n].value` is
`unknown`).

**One near-miss, caught by running the suite, not by typecheck** — `plan.test.ts`'s
`buildPlanComposition()` tests. The first fix attempt (add the missing required
`sessionMode` field to the shared `baseConfig` fixture) typechecked clean but silently
flipped a real assertion: one test specifically checks that `buildPlanComposition` *injects*
a `sessionMode` default when the field is absent, and giving `baseConfig` a default meant it
was never absent. `git stash`/`bun test`/`git stash pop` before every commit is what caught
this — 46 pass dropped to 45 pass 1 fail, invisible to `bun x tsc`. Correct fix: the function's
declared parameter type (`DebateStageConfig`, `sessionMode` required) is stricter than its
actual runtime contract (partial input, fills defaults) — two sibling `test.each` blocks in
the same file already knew this and cast their call site; cast the third the same way, as
`DebateStageConfig` (a real, single cast) rather than `as any` (which would have added a new
`asAny` occurrence past baseline — unlike the sibling blocks' pre-existing casts, this would
have been new debt).

### `TS7024` implicit-any-via-self-reference (9 sites, 2 files → 0)

Both files: an inline `async (arg) => value` (or `() => value`) function inside a
`test.each` table, with no declared return type. `test.each`'s generic inference is
self-referential enough that TS gives up and falls back to `any` for the whole function
instead of resolving it structurally — spelling out the return type
(`Promise<string | null>`, `Promise<boolean>`, `(): string`) breaks the cycle.
`plan-interactive.test.ts` (7, two tables) and `tdd-verdict.test.ts` (2). No cast, no
counter movement — purely additive type annotations.

### "`DispatchContext`" (3 sites, 2 files → 0)

None were actually about `DispatchContext`. All three were `_routingDeps.X = mock(...)`
assignments to properties `_routingDeps` (`src/pipeline/stages/routing.ts:178`) doesn't
have — `computeStoryContentHash` and `routeBatch` (the latter's own inline comment said
`/* routeBatch deleted ROUTE-001 */`), and `routeStory` (never existed on this deps object;
`resolveRouting` is the real member). All three were provably inert at runtime — same
before/after test counts on deletion. `routing-idempotence.test.ts` also dropped the
now-unused `FRESH_ROUTING_RESULT` fixture the dead mock referenced.

### Verification, every commit

Syntax guard, per-file typecheck diff, `check:test-escape-hatches`/`check:test-as-unknown-as`
flat or better throughout (net: `anyType` −2, `looseCast` −2 over this whole round — casts
removed outnumbered the one added), matching `bun test` pass/fail counts before and after via
`git stash`/`git stash pop`, `check:all` 25/25 green, full suite green after the final commit
(1137/37/0 unit+integration, 38/0 UI). **340 → 303**, 157 files.

## Next

Residue: **303 across 157 files.** All three previously-flagged clusters (`TS2769`,
`TS7024`, `DispatchContext`) are fully drained — this branch's remaining errors are the
undifferentiated long tail: 87 `TS2322`, 35 `TS2353`, 30 `TS2352`, 28 `TS2339`, 22 `TS2739`,
19 `TS2741`, 19 `TS2345`, 14 `TS2349`, 12 `TS2554`, 7 each of `TS2783`/`TS2740`/`TS2305`, and
smaller tails below that — no cluster has been measured or read yet. Re-run the error-code
histogram fresh before picking the next one; per this round's lesson, "no shared cause"
verdicts from earlier passes did not hold up under actual per-site reading.

## 38. Batch-3 prep — the slack re-opened, cluster A1 drained, B and C handed off (303 → 299)

Branch `chore/1514-tail-batch3-prep`. Two drain-relevant commits plus a handoff.

### The baseline slack re-opened, four days after §32 closed it

§37's round removed 2 `anyType` and 2 `looseCast` and did not re-baseline, so the tree arrived
at this round with 4 points of free headroom under all 25 green gates — the exact defect §32
diagnosed and fixed once already. `4723c7a7a` reclaims it.

**This is not a one-time cleanup, it is a recurring leak.** §32's rule ("a drain commit that
lowers a counter must also lower its baseline") is stated but nothing enforces it: the gate
fails on *growth*, so a counter sitting below baseline is silently tolerated. **Measure the
gap before every hand-off**, or consider making `check:test-escape-hatches` fail on slack the
way `check:test-typecheck`'s per-file gate reports `worse: 0`.

### The tail, re-clustered by cause (§32's method, re-run on 303)

By file it is flat — the largest file has 8 errors, and 157 files hold 303. By cause:

| Cluster | Errors | Files | Shape |
|:--|--:|--:|:--|
| A — `Mock` into a typed function slot | 46 | ~30 | TS2322/TS2352 whose target type starts with `(` |
| D — TS2353 dead fixture keys | 35 | many | top key appears 3× — genuinely scattered now |
| B — flat `models:` fixtures | 9 | 3 | one recipe |
| C — imports of symbols the barrel does not re-export | 12 | 8 | per-site, 30-second lookups |
| unread tail | ~200 | — | 87 TS2322, 30 TS2352, 25 TS2339, 22 TS2739, … |

Cluster A is what §32 measured at "~35 errors across ~30 files" and it has grown, not shrunk.

### A is three sub-families, not one recipe — and only the first is safe

- **A1 — literal widening. Drained, `60cdf5ba2`, 303 → 299.** Three sites in
  `run-regression-attribution.test.ts` assigned a mock whose inferred `status` was the widened
  `string` into a slot typed `Promise<VerificationResult>`. Annotating the mock's return type
  gives the literals their union-member type with **no cast**. One site also read
  `.mock.calls` off the dep slot (a *consequent* TS2339, not a separate defect) — hoisting the
  mock to a typed local and assigning the local clears both together. `8 pass / 15 expect()`
  identical before and after.
- **A2 — fixture missing required fields.** Looks mechanical, unverified.
- **A3 — the fixture is wrong and the wrongness is load-bearing.** Two mutation-check tests
  return `status: "FAILURE"`, which is not a `VerificationStatus` member.
  "Correcting" it to `"TEST_FAILURE"` is **not inert**: `classifyMutant`
  (`src/verification/mutation/classify.ts:14`) switches on `status`; `"FAILURE"` falls to the
  `default:` arm and throws `MUTATION_UNHANDLED_STATUS`, while `"TEST_FAILURE"` returns
  `killed` or `errored` depending on the counts. The test asserts the op continued and stopped
  after one mutant — the throw may be the thing under test.

**The lesson, and it is §32's rule in a new costume:** an invalid *value* in a fixture is not
the same defect as a widened *type*, even though tsc reports both as "not assignable to
`VerificationStatus`". Before "fixing" a wrong literal, find the `switch` that consumes it. A
union-member error tells you the value is unreachable in the type; it never tells you the code
ignores it.

### What was handed off, and what was deliberately not

`HANDOFF-1514-tail-recipes-batch3.md` — clusters **B (9) and C (10)**, expected 299 → 280. Both
recipes were prototyped on the live tree and reverted, per batch-1 practice:

- **B**: `models: { fast, balanced, powerful }` predates the per-agent
  `Record<agentName, Record<tier, entry>>` shape. Nesting under `claude` (the convention in
  `validate.test.ts`) measured 299 → 296 on one file with identical pass/expect counts. The
  handoff carries the one non-mechanical check: these fixtures are **inert today**
  (`resolveModelForAgent` finds nothing and throws), so nesting makes them *reachable for the
  first time* — grep for the model strings in assertions before editing.
- **C**: every symbol exists in `src/`; only the barrel lacks the re-export. Type-only imports
  from an internal path are explicitly exempt from `check:alias-internals` (its header,
  exemption 1), so the fix is legal. The handoff names the declaring module for all 10 and
  flags `PlanResult` as ambiguous between two unrelated interfaces.

**Not delegated:** A (all three sub-families), D, the unread tail, and
`pb-004-migration.test.ts`'s 2 × TS2307 — that test imports two deleted modules *in order to
assert they are gone*, so the error is intrinsic and `@ts-expect-error` would breach
`tsSuppress`. It is an accepted exception awaiting the §8 treatment, not debt.

## 39. Reviewing the batch-3 handoff before delegating — verifying cluster C drained it (299 → 289)

§25 recorded that reviewing a handoff before delegating "paid for itself". This round it paid
differently: the review **consumed** the cluster it was reviewing.

### What the review found

The draft handed off cluster C — 10 errors, 8 files, "imports naming symbols the barrel does not
re-export", described as 30-second lookups. Checking the table line by line instead of trusting
it found:

- **`mutation-check-diff-scope.test.ts:236` is not an import.** It is a namespace-qualified type
  reference, `mutationModule.GenerateMutantsInput[]`, on an `import * as` used for `spyOn`. The
  fix is a separate type import plus a bare name — a different edit from every other row.
- **`status-file-integration.test.ts` was not importing from a barrel.** It imports from
  `@/agents/types` directly; `PlanOptions`/`PlanResult` simply live in
  `@/agents/shared/types-extended`. The row's conclusion held, its reasoning did not.
- **Five of the eight needed a mixed import split** (`{ NaxRuntime, PipelineContext }` →
  two lines). The draft said "import from the declaring module" and never mentioned it.
- **The draft never addressed unmasking at all** — the risk that resolving a type turns a
  silently-`any` file into a newly-typechecked one. It doesn't happen here (the total fell by
  exactly 10), but that was luck, not analysis.

### Why the cluster is now done rather than handed off

There was no way to check those four things without doing the edits. Once done and verified —
289, `check:all` 25/25, identical pass/fail/`expect()` across all 8 files — reverting proven,
zero-risk work to preserve a delegation would have been waste. Committed as `d5016b4e6`.

**The general rule this suggests:** *verifying* a mechanical cluster costs about as much as
*executing* it. A cluster small enough to hand off cheaply is usually small enough that the
owner's verification pass finishes it. **The delegable unit is not "a small cluster" — it is a
recipe already proven on one site, with enough sites left that repetition dominates
verification.** Cluster B (9 errors, 3 files, one proven recipe) barely clears that bar;
cluster C never did.

### What replaced it in the handoff

**Cluster E — fixtures missing required properties, 29 errors, ~25 files.** Same family as
`HANDOFF-1514-mechanical-fixture-fields.md`, which drained 91 errors successfully, and this repo
has ~50 `makeX` factories in `test/helpers/` that exist precisely to answer it. The handoff
carries three things the draft of C lacked: the priority order (use a factory → add inert fields
→ escalate), the hard bar that **shared helpers are off-limits to edit** (§4a's 69-consumer
`FakeProcSpec` incident), and an explicit warning that the three `Logger` sites are *not* a
drop-in swap because they assert against local capture arrays and `makeLogger` exposes `.calls`.

E's number is also marked **soft** in the handoff: 29 errors across 9 small groups plus a tail of
singletons is not one recipe applied 29 times, and a handoff that quotes a hard number invites
the executor to reach it.

## 40. Batch 3 landed (289 → 246) and its two escalations — one fixed, one refused

PR #1700 drained clusters B and E: **289 → 248**, 22 commits, one file per commit. Verified
independently on the branch, not taken from the report: test typecheck 248, `src` tsc 0, every
escape-hatch counter flat (`asAny=1386 … nonNullAssert=827`), `as unknown as` 102, per-file gate
**no file worse and no new file with errors**, `check:all` 25/25, full suite green
(14132 + 1137 + 38 pass, 0 fail). −41 against a −38 forecast; the surplus is masked collateral
the commits name individually.

Both escalations were the same shape — **an error whose wrong side is `src/`** — and they
resolve in opposite directions. That is the point of this section.

### Escalation 1 — `ModelsConfig` was stricter than its own runtime contract. Fixed.

`schema-types.test.ts` had to keep an incomplete `codex` tier map to exercise
`resolveModelForAgent`'s fallback, and ate a `TS2739` for it. The type said every agent defines
all three tiers; **nothing else in the system agreed**: `resolveModelForAgent` reads
`models[agent]?.[tier]`, falls back to the default agent, and throws `MODEL_NOT_FOUND` only when
neither has it, while `PerAgentModelMapSchema` is a plain `z.record` with no tier requirement.
The type made its own fallback branch unexpressible.

`ModelsConfig = Record<string, Partial<ModelMap>>` — **0 src errors, 248 → 246**, clearing the
escalated site *and a second, unflagged instance at line 184*. No ADR governs this type.
`fix/1514-escalations-src-types` @ `873277a76`.

### Escalation 2 — `DispatchContext.sessionManager`. Type kept; the dead guards retired instead.

`run-completion-session-close.test.ts:69` asserted `closeAllRunSessions` is *not* called when
`sessionManager` is omitted, and could not construct that input without a forbidden cast.

Making the field optional measures beautifully — **0 src errors** — and is still the wrong fix.
**ADR-020 §D3 deliberately dropped the `?` from `sessionManager` and fixed every resulting `??`
fallback site in the same PR**, so that "the compiler surfaces every consumer that must thread
them". Re-adding it reverses a shipped decision to buy one test-typecheck error.

What the measurement actually found is two **ADR-020 misses**: `run-completion.ts:403`
(`if (options.sessionManager)`) and the `options.agentManager ? … : undefined` beside it are
pre-ADR-020 residue that every typed caller makes unreachable. Both retired, along with the test
that pinned the false branch. **246 → 245**, `6caf7196c`.

#### The correction: "unreachable" was true of the type, false of the suite

This section first claimed the false branch "can no longer be false". Removing the guard
**broke four tests** — `mutation-summary-completion.test.ts` reaches `closeAllRunSessions` with
`sessionManager` undefined at runtime, because its fixture omits all four dispatch fields under
an `as unknown as RunnerCompletionOptions` cast.

That is not a counter-example to the ruling; it is the contract violation ADR-020 exists to
prevent, and one of the 102 grandfathered casts is what let it through. The fixtures now spread
`makeDispatchContext({ runtime })` from the runtime they already build. But the sequence is the
lesson: **a guard proven unreachable by the type system is still reachable by any fixture that
casts its way past the type.** Deleting defensive code in a repo with 102 sanctioned casts and
615 `as never` is a runtime change, not a refactor — the full suite, not the compiler, is what
tells you.

(Deleting that test also dropped `asNever` 619 → 615; re-baselined immediately, per §38's
recurring-leak note.)

### The control that made the difference

`agentManager` looks identical to `sessionManager` at the call site — `context.ts:74` even
optional-chains it. Measuring it the same way gives **9 src errors**: it is genuinely required
and the optional-chain is noise. One field of the same interface is a lie and its neighbour is
not, and only the compiler could tell them apart.

**The rule:** "0 src errors when I loosen it" proves the *code* tolerates the change. It says
nothing about whether the constraint was **intended** — grep `docs/adr/` for the type before
concluding the type is wrong. Escalation 1 had no ADR and the schema on its side; escalation 2
had an ADR that had explicitly considered and rejected the change.

## 41. Batch-4 prep — the A2 recipe prototyped, and A is smaller than §38 measured (2026-08-24)

Nothing landed. Four sites were edited on `main` @ `aba3f9b84`, measured, and reverted; the
tree is back at 245 with every counter at baseline. `HANDOFF-1514-tail-recipes-batch4.md`
carries the result.

### The recipe needs a discovery step, and that is the finding

§38 left cluster A's A2 sub-family as "looks mechanical, unverified". It is mechanical — but
**the error message does not say what is wrong**, because `mock()` wraps the callback and tsc
reports the whole `Mock<…>` as unassignable. Dropping the `mock()` wrapper and annotating the
local with `typeof _deps.<slot>` makes tsc name the missing properties exactly. That also
solves the "the result type is not exported" problem for free: `RunTestsResult` is private to
`full-suite-gate.ts`, but `FullSuiteGateDeps` is exported and the indexed slot type reaches
through it.

The same discovery step separates A2 from A1 in one compile: "missing the following
properties" → add the fields; "`string` is not assignable to `"typescript" | …`" → keep the
annotation, that *was* the fix.

| Prototype | Fix | Errors | Tests |
|:--|:--|--:|:--|
| `orchestrator-totals.test.ts:40` | add `parsedSummary`, `timedOut` | 245 → 244 | 3 pass / 7 expect, identical |
| `story-orchestrator-failureCategory.test.ts:154` | add `timedOut` | 245 → 244 | 6 pass / 6 expect, identical |
| `semantic-agent-session.test.ts:60,73` | `CompleteResult` re-shape | 245 → **243** | 20 pass / 37 expect, identical |
| `plan.test.ts:578` | annotate `Promise<SourceRoot[]>` | 245 → 244 | 46 pass / 99 expect, identical |

### Cluster A is 11 errors, not 42 — and that is why batch 4 is not "cluster A"

§38 sized A at 46 by pattern-matching the target type against `^\(`. Reading all 42 surviving
rows one at a time reclassifies most of them: 12 are `TS2352` sites that **already carry an
`as` cast** (touching them risks `looseCast`/`asNever`, and there is no slack), 5 are the
`AgentResult`-vs-anonymous-clone family whose wrong side is `src/`, 7 are parameter-type or
return-type mismatches that share nothing with the recipe, 2 are §38's load-bearing A3, 2 are
the `CallOpFn` tier-3 exception, 2 the known config-slice annotation residue, and 1 a retired
`PromptOptimizerResult` contract. What is left that the recipe actually fits is **11**
(11 + 12 + 5 + 7 + 2 + 2 + 2 + 1 = 42, checked against the row list, not estimated).

Eleven is below §39's delegable bar. The batch clears it only because the same recipe covers
the **16 surviving `TS2741` rows** — cluster E's residue, where tsc names the missing property
outright and no discovery step is needed. F1 + F2 = ~27 errors, ~20 files, one family.

**The lesson is §39's, one level up:** a cluster sized by pattern-matching the *error text* is
an upper bound, not a count. §38 sized A from the target type's shape and got 46; reading the
rows got 11 in scope. The re-read cost an hour and it moved five rows into "escalate, the
wrong side is `src/`" that a delegate would otherwise have fixed the fast way.

### Two hazards worth carrying forward

- **A dead fixture key can be carrying a live value.** The `CompleteResult` mocks pass
  `costUsd: cost` — a key the type does not have — while `estimatedCostUsd` (which the type
  requires) is absent. The fix is only correct because the `cost` parameter is plainly meant to
  reach the consumer. Deleting a dead key that holds a non-default value is a behaviour change.
- **`bun run lint:fix` after every edit.** An added return-type annotation pushes lines past
  biome's width and reorders imports; all four prototypes failed `biome check` until formatted.

## 42. Batch 4 landed — the fixture-shape family (245 → 219, 2026-08-24)

On `chore/1514-tail-batch4-handoff`. §41's estimate was ~218; the tree landed at **219** — the
handoff's declared "soft" number (27 errors across ~20 files, some files carrying a second
masked error). 26 errors cleared across **21 files**, one commit per file, all per-file gates
green, no file's count rose, no new file with errors.

### All rolls in the in-scope table landed

- **F1 (function-slot `TS2322`, 11 rows):** the four proven recipes reproduced exactly
  (`orchestrator-totals`, `failureCategory`, `semantic-agent-session` 245→243 second error was
  a dead key left alone, `plan.test.ts`), plus `adversarial-threshold`, `acceptance-loop-routing`,
  `manager-phase-b-session`, `replay.test.ts`, `unified-executor-session-close`.
- **F2 (`TS2741`, 16 rows):** all named properties added inert, including `report.test.ts`'s
  `toJSON` handled per §41's caveat via `new TokenUsage(...)` (`TokenUsage` is a value import
  from `@/metrics/types`, not the type-only `@/metrics` re-export).

### Two unmasks the handoff's hazard section predicted

- **`acceptance-loop-routing`** — dropping the `complete` mock's wrong shape unmasked
  `run`/`plan`/`decompose`, which do not exist on `AgentAdapter` (ACP has no `run`). Nothing in
  the test reads any of the three; the keys were dead. Removed them and the unpassed `result`
  param (2 → 1, the surviving `analyze` TS2339 was pre-existing).
- **`runner-retry.test.ts`** — fixing the `hooks` key unmasked a `PipelineContext` missing
  `rootConfig`/`projectDir`/dispatch fields; the hand-rolled `makeCtx` simply predates
  `makeDispatchContext()`. Completed it with `makeDispatchContext()` (1 → 0). The extra fields
  were never read, so this is the §6 danger ("check:file-sizes rejects line-adding fixes")
  avoided, not a behaviour change.

### Three things worth recording

- **`check:file-sizes` rejects a line-adding annotation in a grandfathered file.** The F1b
  fix at `plan.test.ts:578` grew the file 1202 → 1204 and the pre-commit gate failed. The
  annotation moved onto `mock`'s type parameter
  (`mock<typeof _planDeps.scanSourceRoots>`) which is line-neutral. This is §6's
  `check:file-sizes` trap, hit *by* the annotation recipe §41 prescribed; the recipe's "keep
  the annotation" and the file-size ratchet do not always agree.
- **`manager-*` fixtures needed sibling fields.** `manager-credentials` wanted `info` next to
  `warn` on `LoggerLike`; `manager-narrowed`'s `AgentManagerConfig` pick grew `profile`. Both
  are the ordinary "add the named property and its sibling" shape — the sibling was only
  visible because tsc names one property at a time.
- **All eight escape hatches and `as unknown as` stayed flat** (102; `asAny=1386 …
  nonNullAssert=827`). The only counter that moved was the typecheck ratchet, re-baselined
  245 → 219 in the same PR. The §40 slack-leak instruction applied; it has now recurred four
  times and each was closed the same way.

Verify: `bun run check:all` 25/25 green, full suite green across all three phases
(1174 tests / 116 files), per-file typecheck diff against the 245 baseline showed zero risen
files.
