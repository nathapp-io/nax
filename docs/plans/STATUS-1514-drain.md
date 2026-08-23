# #1514 test-debt drain — status

Written 2026-08-23 to resume later. Supersedes nothing; it points at the docs that hold detail.

---

## ✅ The dead-fixture-keys handoff is COMPLETE

`HANDOFF-1514-dead-fixture-keys.md` finished on 2026-08-23: all 10 keys, 38 errors, fully
gate-verified. Every commit below was run through the full six-step loop (src tsc, test
typecheck, per-file gate `worse: 0`, `check:all`, full suite, baseline update).

## ✅ The mechanical-fixture-fields handoff is COMPLETE

`HANDOFF-1514-mechanical-fixture-fields.md` finished on 2026-08-23 on
`chore/1514-implicit-any-params` (head `b5fb516`): all 3 clusters, **91 errors**
(1351 → 1260), fully gate-verified. Same six-step loop per commit. Details in §2b/§3b.

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
| `DispatchContext` fixtures (18) | not started — see §10 | — |
| ~~`makeObservation` (~90)~~ — **really 9** | not started | — |

**Branches:**
- `chore/1514-dead-fixture-keys` — **merged as #1686** (`e915b47e1` on `main`); branch gone.
- `chore/1514-implicit-any-params` — local only, never pushed. Contains `main` @ `e915b47e1`
  and is 14 commits ahead. **Ready for PR.**

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
