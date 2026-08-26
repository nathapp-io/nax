# `noExplicitAny` drain — closed log

Archived from `../STATUS-test-debt-drain.md` §8.14–§8.25 on 2026-08-26, when the drain
finished and the rule was promoted. Sections keep their original numbers; cross-references
to §0–§7 point back at the live doc, and references to §8.1–§8.13 point at the
`as unknown as` drain that still lives in it.

**Outcome.** Two hundred thirty-five files drained across twelve batches. Biome's
authoritative `test/` count fell **1529 → 0**; the regex ratchet's `asAny` fell 1179 → 1
and `anyType` 1538 → 10 (the residue is prose and the ratchet parser's own string
fixtures, which biome does not see). `biome.json`'s `test/**` override now says
`"noExplicitAny": "error"`, closing the first half of endgame item 4. No counter rose in
any commit; `nonNullAssert` (819 → 792), `looseCast` (1875 → 1800), `ratchetAllow`
(105 → 103) and `asNever` (608 → 603) fell as side effects. Shipped as #1719.

**The rulings worth carrying** are lifted into the live doc's §6; this file holds the
per-batch detail, the escalations, and the reasoning behind each.

---

### 8.14 Batch 1 of the `noExplicitAny` drain — nine files, biome 1529 → 1288 (2026-08-25)

The top ten files by biome count were drained in owner work (nine of the ten before the
batch paused; `story-orchestrator-logs.test.ts`, 24 sites, is untouched and still heads the
queue). ~241 sites across nine files; `asAny` ↓186 and `anyType` ↓241 on the ratchet,
**every other counter flat** — including `looseCast`, which two early edits briefly traded
and was reclaimed (see below). Gates: typecheck 0 (all three), full suite green
(unit / integration / e2e / ui, 0 fail), ratchet `[OK]`.

**The recurring shape, and the recipe that retired most sites.** Most files hand-built an
`as any` context/runtime bag (`configLoader: {…} as any, packages: {…} as any } as any`) or
assigned `(async () => X) as any` to a dep slot. The recipes:

| Shape | Recipe |
|:--|:--|
| fake runtime bag | `makeMockRuntime({ agentManager, sessionManager, config })` — real `NaxRuntime`, zero casts |
| generic dep slot (`callOp`) | shared `makeCallOp({ fallback })` from `@test/helpers` — already generic over `<I, O, C>` |
| fabricated op literal for `AnySlot` | complete the fixture: `kind/name/stage/config/session/build/parse` with a real two-section `ComposeInput` return, checked via `satisfies RunOperation<…>` |
| `redactSecrets(x) as any` at every read | **source fix**: `redactSecrets<T>(input: T): T` — shape-preserving generic like its sibling `redactEntry`; retires all 22 call-site casts at once |
| OTLP payload builders returning `object` | **source fix**: precise `OtlpTracesPayload` / `OtlpMetricsPayload` return types; also retires the two structural `as { resourceMetrics: … }` casts in `otel-reporter/index.ts` |
| partial-config ctx | `makeNaxConfig(overrides)` + a literal `PackageView` with `select: <C>(sel) => sel.select(config)` |
| registry-keyed kind not in a closed union (`{ kind: "test-synthesis" }`) | `Object.assign(stageConfig, { selector: { kind } })` — returns `T & U`, whose `.selector` type is the intersection, assignable back to the union field |

Two source changes carried the heaviest files. Both follow the `redactSecrets` precedent:
the source return type was vaguer than the value it produces, so every consumer paid a cast.
Precision there is not weakening anything — it is what let the fixtures hold a `T` without
asserting.

**The two counter trades the first draft made, and how they were caught.** The escape-hatch
ratchet failed the verification run: acceptance.test.ts `looseCast` 1 → 3. One was a genuine
trade — `hooks: {} as any` had become `hooks: {} as HooksConfig`, moving debt from one
counter to another instead of paying it. The honest fixture is `{ hooks: {} }`, which
typechecks against `HooksConfig` directly with no assertion. The other was a **ratchet false
positive worth knowing**: the line

```
})) as unknown as typeof _executorDeps.spawn; // test-ratchet-allow: as-unknown-as
Object.assign(Bun, { file: fileStub });
```

matches `\bas\s+[A-Z]\w*` because `\s+` spans the newline — the comment's trailing `-as`
plus the next line's capitalised `Object.assign` reads as a single cast. Reordering so the
`Object.assign` precedes the cast line clears it without touching the counters. **A
comment's last word can pair with the next line's first word inside a raw-text regex;
when a looseCast appears that you did not write, read the seam between lines before
hunting for a cast you forgot.**

**Other notes.** `(Bun as any).file = stub` became `Object.assign(Bun, { file: stub })` —
same mechanism-A route as §8.13's class stubs, no assertion, restore by assigning the saved
original back through `Object.assign`. Two dead helpers (`capturingDeps`,
`resourceAttributes`) and a never-called heartbeat tracker were already unused at HEAD and
were removed while editing. Inert write-only counters (`prePhaseCallCount`,
`verifierCallCount` in runner-plug-point-dispatch) were dropped rather than asserted: a
probe confirmed the verifier dispatch does not fire in that test's config path, so an
assertion would have pinned a falsehood.

**Remaining queue** (biome count per file): `story-orchestrator-logs` 24, `debate/runner`
23, `pipeline/subscribers/interaction` 23, `verify-op` 22, `build-plan-triage-predicates` 21,
`test-presence-gate` 21 — 225 files hold the remaining 1288. After the queue reaches zero as
biome counts it, endgame item 4 promotes the `test/**` override to `"error"` (§0.1), and the
regex `asAny`/`anyType` rows retire into the rule.

### 8.15 Batch 2 of the `noExplicitAny` drain — top 2 files, biome 1288 → 1241 (2026-08-25)

The two highest-count files by biome were drained in owner work, picking up the queue §8.14
left at `story-orchestrator-logs` (24) and `debate/runner` (23). 47 sites total across the
two files; `asAny` ↓45 (993 → 948) and `anyType` ↓47 (1297 → 1250) on the ratchet, every
other counter flat except `nonNullAssert` which fell 819 → 812 as a benign side effect of
removing `logger!.info = … as any` patterns in `story-orchestrator-logs` (the new pattern is
`logger.info = … as typeof logger.info` after binding `const logger = getSafeLogger()!`
once at the top of each test). Gates: typecheck 0 (all three), full suite green (unit /
integration / ui, 0 fail), ratchet `[OK]`.

**`story-orchestrator-logs.test.ts` (24 → 0).** Two recipe families.

| Shape | Recipe |
|:--|:--|
| `{ story: { id: "US-001" } as any }` on `addTestWriter` / `addImplementer` / `addSemanticReview` (13 sites) | `makeStory({ id: "US-001" })` from `@test/helpers` — already exports a typed `UserStory` factory and `SemanticStory` is a structural subset |
| `(async () => ({ success, filesChanged, … })) as any` for run-op callOp stubs (4 sites) | `makeCallOp({ fallback: { … } })` from `@test/helpers` — already generic `<I, O, C>`, zero casts at call site |
| `logger!.info = ((stage, msg, data?) => { … }) as any` (4 sites) and `data?: any` array type (2 sites) | `const logger = getSafeLogger()!` once, then `logger.info = … as typeof logger.info` — the same recipe `test-coverage.test.ts:409` and `runs.test.ts:87` already use, retried here |
| `logger!.warn = …` (1 site) | same pattern via `typeof logger.warn` |

The `logger!.info` → `logger.info` swap also retired the four `!` non-null assertions that
came with it — that is the source of the `nonNullAssert` ↓7 outside the target rows. **No
counter traded for the drain**; the assertion swap is a strict improvement (one `!` per test
instead of one per `logger!.X` line).

**`debate/runner.test.ts` (23 → 0).** Three recipe families.

| Shape | Recipe |
|:--|:--|
| hand-rolled `runtime: { agentManager, sessionManager, configLoader, packages, signal, costAggregator } as any` (18 sites across 6 tests) | `makeMockRuntime({ agentManager, sessionManager, costAggregator: createNoOpCostAggregator() })` — real `NaxRuntime`, zero casts |
| hand-rolled `packageView: { config: DEFAULT_CONFIG, select: … } as any` (2 sites) | `runtime.packages.repo()` — the helper pattern every other debate test uses (`runner-plan.test.ts:24`, `runner-stateful.test.ts:52`, etc.) |
| `spyOn(callModule, "callOp").mockImplementation(async (…) => { …; return '{"passed":true}' as any })` (2 sites) | `spyOn(callModule, "callOp").mockImplementation(makeCallOp({ fallback: '{"passed":true}', onDispatch: (op, ctx) => { if (op.name === "debate-propose") capturedIds.push(ctx.scopeId); } }))` |

The `onDispatch` callback here is a small forward-only extension of the helper: its second
argument is now the call context, so tests that need `ctx.scopeId` (or any other ctx field)
can capture it without re-mocking `callOp`. The existing helper had only `(op)`; the new
signature is `(op, ctx)`. Source change is additive — no caller was broken — and the helper
file's own `as unknown as O` is the only `as` left in the helper (it carries the
`test-ratchet-allow: as-unknown-as` marker).

**`makeMockRuntime` gained a `costAggregator` option.** The four-file debate queue mix was
caught by the second test ("AC3: debater callOp receives scopeId from debaterScope"), which
needed to override `costAggregator.openScope` while keeping everything else from
`makeMockRuntime`. Adding `costAggregator?: ICostAggregator` to `MockRuntimeOptions` and
threading it into `createRuntime` retires the remaining `as any` cleanly. Cost tests across
the suite that previously passed `createNoOpCostAggregator()` in hand-rolled runtimes
(`runner.test.ts:makeCtxWithCostAgg`) now spread it onto `makeMockRuntime` directly; the
pattern is `{ ...createNoOpCostAggregator(), openScope: costAgg.openScope }` — `openScope`
overrides cleanly because the rest of the surface is filled from the no-op baseline, and the
test asserts on `costAgg.openScope` and `costAgg.closed` (separate fields) which the spread
preserves.

**Carry forward: the second-rung `as O` escape.** The first attempt at the callOp mocks used
`as O` inside a generic `<I, O, C>` arrow — TS-clean, but the escape-hatch script flags
every `as [A-Z]` as `looseCast`, and §3 forbids any counter trade. Switching to
`makeCallOp` moves the single `as unknown as O` into the helper (where the marker comment
lives), so the test file pays zero `as`. The recipe is now: when a generic-return callOp
mock would otherwise need an `as`, use `makeCallOp({ fallback, onDispatch })` and capture
per-op state through `onDispatch`. The helper's marker is the only escape hatch any test
needs to write itself.

Gates: typecheck 0 (all three), `check:all` 24/24, suite green (14149 / 1136 / 38, 0 fail),
coverage OK (87.83% lines / 87.49% functions, 101 files below floor against baseline 103).
Casts `asAny` ↓45 (993 → 948) and `anyType` ↓47 (1297 → 1250); `nonNullAssert` ↓7 as a
side effect; every other counter flat.

**New top of queue** (biome count per file): `pipeline/subscribers/interaction` 23,
`verify-op` 22, `build-plan-triage-predicates` 21, `test-presence-gate` 21, `plugins/registry`
19, `operations/greenfield-gate` 18 — 223 files hold the remaining 1241.

### 8.16 Batch 3 of the `noExplicitAny` drain — the top 20 files, four parallel delegates, biome 1241 → 897 (2026-08-25)

The entire §8.15 queue head drained: all twenty highest-count files (344 sites) taken to zero
by four parallel agents on disjoint file sets, working from a shared brief that carried the
§4 forbidden list, the per-file gate loop from §8.2's lesson (`tsc -p tsconfig.test.json`,
biome on the touched files, the file's own tests, both ratchets, `check:file-sizes`,
`check:deep-relatives` — everything cheap), and the standing recipe table. No delegate edited
outside its set; no helper-barrel conflicts. `asAny` ↓267 (948 → 681) and `anyType` ↓344
(1250 → 906) on the ratchet; `looseCast` ↓47 (1875 → 1828) as a benign side effect of deleting
real casts; every other counter flat, none rose. Gates: typecheck 0 (all three), `check:all`
green, full suite green (unit / integration / ui, 0 fail), coverage OK (101 below floor
against baseline 103, identical to main).

**Recipe families applied across the batch** (all proven in §8.14/§8.15 except the last):

| Shape | Where | Recipe |
|:--|:--|:--|
| config literal `{...DEFAULT_CONFIG, section} as any` | interaction subscriber, acceptance-setup-gate, plan-critic-llm, curator-collector, file-injection | `makeNaxConfig(overrides)`; `makeSparseNaxConfig` + `makeConfigSlice` where an *omission* was under test |
| ctx/runtime bag `as any` | test-presence-gate, greenfield-gate, execution-unified | `makeMockCallContext()` / `makeMockRuntime({...})` |
| op slot / callOp stubs | verify-op, quality-gate-packageview | `makeCallOp({ fallback })`; typed `_deps` objects |
| `{ story: { id } as any }` | verify-op ×9, execution-unified | `makeStory({ id })` |
| `(op as any).execute(...)` probe | test-presence-gate, greenfield-gate | direct call — the const was already typed; build/parse absence via `"build" in op === false` or an intersection-typed local |
| `<FixStrategy<Finding, any, any, any>>` restated generics ×21 | build-plan-triage-predicates | derive from the dep: `Parameters<typeof _storyOrchestratorDeps.runFixCycle>[0]["strategies"][number]` |
| `: any` payload annotations ×17 | otel-span-tree | real `OtlpMetricsPayload` + local user-defined type predicates narrowing `OtlpMetric`'s vague `sum?/histogram?: object` members |
| inline ctx literals failing to satisfy a type | adversarial-review-reground | `satisfies HopBodyContext<Input>` — contextual typing then let 14 inner single casts be deleted outright |
| `(Bun as any).file/.Glob = …` | smart-runner-discovery | `Object.assign(Bun, { … })`, restore likewise (§8.14 recipe) |

**One fixture-value correction worth recording:** the interaction-subscriber mock returned
`{ action: "escalate" }`, which is not an `InteractionAction` — `applyFallback` maps escalate→
approve and the subscriber only branches on `"abort"`, so replacing it with `"approve"`
preserves every assertion while making the fixture hold a real member. Same family as
quality-gate-packageview's bogus `"PASS"` status corrected to `"SUCCESS"`.

**A prose false positive, and the fix.** After the batch, the ratchet still counted
`anyType: 3` in build-plan-triage-predicates — a doc comment explaining the new
`Parameters<>` derivation quoted the old generic text verbatim, and `[:<|&,(]\s*any\b`
matches inside backticks. Reworded the comment; the counter is for code. This is §8.13-D's
observation from the other side: **the raw-text ratchet counts history as readily as it
counts debt — when a drain retires a shape, do not quote the shape in the surviving prose.**

**Escalation-shaped finding left open (source, not test):** `OtlpMetric.sum/histogram` are
typed bare `object` in `src/plugins/builtin/otel-reporter/otlp.ts`, so every consumer re-narrows.
Same vaguer-than-value shape §8.14 fixed at the payload level; the two predicate helpers in
otel-span-tree.test.ts are the local containment until a source follow-up exports precise point types.

**Promotion candidates noted by the delegates, not actioned:** `makePackageView(overrides)`
(two independent local copies this batch plus the §8.14 pattern), a complete-`RoutingResult`
factory, and a sanctioned stub route for *generic* dep slots (bun's `mock()` cannot satisfy
`<F extends Finding>(…) => …` without one retained `as typeof dep` assertion — same
containment model as `makeCallOp` would retire that recurring trailing cast).

**New top of queue** (biome count per file): `integration/plugins/validator` 13, `cli/plan` 13,
`acceptance-loop-cycle` 13, `adversarial-review-retry-flip` 13, `plan-draft` 13,
`acceptance-setup-criteria` 13, `retire-legacy-surfaces` 13, `tdd-verdict` 13 — 203 files hold
the remaining 897. The queue head has flattened: no file exceeds 13.

### 8.17 Batch 4 of the `noExplicitAny` drain — the next top 20 (+1 tie), four parallel delegates, biome 897 → 650 (2026-08-26)

The §8.16 queue head drained: the twenty highest-count files (237 sites) plus
`operations/plan-interactive`, which tied at 10 and rode along as a 21st file, taken to zero by
four parallel agents on disjoint file sets under the same brief model as §8.16 (§4 forbidden
list, the cheap per-file gate loop, the standing recipe table). No delegate edited outside its
set; no escalations; no src/ or helper changes required. `asAny` ↓172 (681 → 509) and `anyType`
↓247 (906 → 659) on the ratchet; `looseCast` ↓12 (1828 → 1816) and `asNever` ↓1 (608 → 607) as
benign side effects of deleting real casts (pb-004's loop-site `as never` among them); every
other counter flat, none rose. Gates: typecheck 0 (all three), `check:all` green, full suite
green (14149 / 1136 / 38, 0 fail), coverage OK (101 below floor against baseline 103, identical
to main).

**Recipe families applied** (all proven in §8.14–§8.16 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| plugin-interface impls with untyped params (`async optimize(input: any)`) | validator | annotate at the real interface types (`PromptOptimizerInput`, `UserStory` + `RoutingContext`, `RunStartEvent`/`StoryCompleteEvent`/`RunEndEvent`); `satisfies NaxPlugin` contextual typing drops annotations where the object is checked |
| post-migration pokes on `Record<string, unknown>` returns (`result.execution as any?.field`) | migrations | local `hasKey` user-defined predicate + probe walker; missing keys still yield `undefined` and fail the same assertions |
| namespace probes (`(tddIndex as any).removedThing`) | retire-legacy-surfaces | absent symbols index a module-scope `Record<string, unknown>` spread of the barrel; present symbols switch to static typed access |
| op.config / op.retry unions | adversarial-review-retry-flip | `typeof === "function"` + `"prop" in` guards narrowing to the real member types |
| stage-module stubbing for dynamic-import seams | acceptance-loop-cycle ×2 files | `Object.assign({}, pipelineStages, { acceptanceStage: { …spread, execute } })` — assignable to the real `typeof import("@/pipeline/stages")` |
| required run-options fields fabricated loosely (`STUB_RUN_OPTIONS as any`) | stale-then-swap | `makeStubRunOptions(config)` constructing the required `modelTier`/`modelDef`; note `runOptions.config ?? this._config` made config-absence load-bearing — each caller now passes its own manager config |
| already-typed builder discovered mid-drain | pb-004-migration | every `(PromptBuilder.for(…) as any)` deleted outright once `withLoader` was found fully typed on the class |

**Fixture-value corrections, all assertion-preserving and reported per §4's rule-3 carve-out:**
the diagnosis callOp stub returned an `{ output: {…}, costUsd }` wrapper the dep never produces
(consumer reads `.verdict` off the resolved value directly) → corrected to a direct
`AcceptanceDiagnosisOutput`; stage-fail results gained the required `reason` string;
`SEMANTIC_CONFIG_DEFAULT` gained `resetRefOnRerun: false` (the documented default the old inner
cast silently omitted); AC-2's debate spread gained required `sessionMode: "one-shot"` — with
the companion lesson that adding it to the *shared* base broke "injects sessionMode stateful",
whose omission is intentional under test (**what the fixture omits can be the thing under
test; complete fixtures only at the call site that needs them**, §8.4's deepMerge trap from the
other side). Because these are values classifiers read, §3's coverage rule fired:
`bun run test:coverage` confirmed per-file floors unaffected.

**New top of queue** (biome count per file): `execution-phase-telemetry` 10,
`otel-reporter-lifecycle` 10, `adversarial-metadata-audit` 10, then six files at 9 — 182 files
hold the remaining 650. The head has flattened again: no file exceeds 10, so the next batch is
necessarily wider and shallower.

### 8.18 Batch 5 of the `noExplicitAny` drain — the top 10 (+1 tie), four parallel delegates, biome 650 → 548 (2026-08-26)

The §8.17 queue head drained: three files at 10 plus eight files tied at 9. A strict
top-10 cut lands mid-tie, so the tie rode along as an 11th file (§8.17's precedent) —
93 biome sites taken to zero by four parallel agents on disjoint file sets under the same
brief model as §8.16/§8.17 (§4 forbidden list, the cheap per-file gate loop, the standing
recipe table). No delegate edited outside its set; all escalations resolved test-side, with
zero src/ or helper changes required. `asAny` ↓74 (509 → 435) and `anyType` ↓102 (659 → 557)
on the ratchet; `ratchetAllow` ↓2 (105 → 103) and `looseCast` ↓1 (1816 → 1815) as benign side
effects of deleting real casts (acceptance-missing-target's two spawn-stub markers among
them); every other counter flat, none rose. Gates: typecheck 0 (all three), `check:all`
green, full suite green (unit / integration / ui, 0 fail).

**Recipe families applied** (all proven in §8.14–§8.17 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| dep-slot stub factories (`createWorktreeManager`/`createMergeEngine`) | parallel-batch-rectification | `makeWorktreeManager()` / `makeMergeEngine({ mergeAll })` from `@test/helpers` — both intersection types fit the slots directly |
| probe reads on captured audit calls ×8 | adversarial-metadata-audit | shared `captureAuditDecisions()` from `@test/helpers` (already used by a sibling) → typed `ReviewAuditDecision[]`, probes index without casts |
| union-member call `(op.retry as any)(…)` ×8 | adversarial-retry-truncation | local `resolveRetryStrategy()`: `typeof !== "function"` guard narrows to the resolver, `"shouldRetry" in` narrows the result — verbatim from `adversarial-review-retry-flip.test.ts` |
| whole-context hand-rolled bags | execution-phase-telemetry, plan-inputs | `makeTestContext()` / `makeDispatchContext()` supply real runtime/session/agent surfaces; the trailing `} as PipelineContext` fell with them |
| dep slot returning a fabricated object | execution-phase-telemetry | complete at the declared type — including a **real `ExecutionPlan`** for `buildPlanForStrategy` (private fields make it unsatisfiable structurally; `new ExecutionPlan(callCtx, {}, false)` + one typed `_deps` stub for its only I/O seam) |
| OTLP payload/spans typed loosely | otel-reporter-lifecycle | `OtlpTracesPayload \| OtlpMetricsPayload` union on the posts array; URL-filter predicates narrow to `MetricsPost`/`TracesPost`; local `SpanProbe` predicate over src's vague `object[]` spans (otel-span-tree precedent) |
| each()-tuple params + dynamic-key probes | plan-inputs | explicit `test.each<[…]>` generics: `Partial<UserStory>` overrides, `keyof UserStory` field → direct indexing, no annotations |
| `(op.execute as any)`-style calls ×14 across twins | lint/typecheck-check-tool-diagnostics | dead casts — `execute` exists on the declared op type; deleted outright. mechanical-lintfix's variant was NOT dead (broad `Operation` union): `"execute" in fixOp` guard + deterministically-typed local |
| spawn mocks, monkey-patches, gate-ctx stubs | _tdd-test-helpers, acceptance-missing-target | `makeSpawn(...)` for every `_xDeps.spawn` slot; `Object.assign(Bun, { file })` patch/restore; gate-ctx completed at real `FullSuiteGateContext` |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:** the
retry-truncation input literals lacked required `workdir` (masked by the old cast); the
metadata-audit config sat under a key path the review slice never had — moved to the real
`review.audit.enabled` schema path; the tdd gate-ctx stub gained the schema-required
`cmdWorkdir`; execution-phase-telemetry's routing gained required `reasoning: ""`; and two
plan-inputs fixtures dropped `inlineReview: true` — a legacy field already **deleted from
src/** that compat-shims strips with a warning, asserted by nothing. None is a value a
classifier branches on, so §3's coverage rule did not fire.

**One containment worth naming:** typing `_tdd-test-helpers`'s `mockAllSpawn(mockFn: any)`
strictly as `typeof Bun.spawn` broke an importer outside the delegate's set that passes a
partial-shape mock. The fix is a structural `PartialSubprocess` contract presented into the
dep slots through a contained overload (`presentAsSpawn`, the `makeSpawnResult` move) — the
helper keeps accepting what callers actually pass while every *dep slot* stays fully typed.
**When tightening a shared helper's parameter breaks a caller you cannot edit, contract the
input and widen only at the presentation seam — not by re-loosening the helper.**

**New top of queue** (biome count per file): eight files tied at 8 —
`integration/context/test-coverage-parity`, `agents/acp/activity-emission`, `cli/plan-debate`,
`debate/runner-mode-routing`, `debate/session-helpers`,
`interaction/plugins/cli`, `precheck/precheck-checks-tier2-warnings`,
`review/semantic-retry` — 171 files hold the remaining 548. The head has flattened again:
no file exceeds 8, and the next ten-file batch spans five of these ties exactly.

### 8.19 Batch 6 of the `noExplicitAny` drain — the top 20 (+ full 7-tie ride-along), four parallel delegates, biome 548 → 380 (2026-08-26)

The §8.18 queue head drained: eight files tied at 8, then a sixteen-file tier at 7 spanning
ranks 9–24. A strict top-20 cut lands mid-tie, so the whole tier rode along (§8.17/§8.18
precedent) — 24 files, ~168 biome sites taken by four parallel agents on disjoint file sets
under the same brief model as §8.16–§8.18 (§4 forbidden list, the cheap per-file gate loop,
the standing recipe table). No delegate edited outside its set; zero src/ or helper changes;
23 of 24 files reached zero.

**One escalation held: `interaction/plugins/cli.test.ts` (8 sites, untouched, gates green).**
The tests inject into `CLIInteractionPlugin`'s class-private `rl` and call private
`promptUser`. Two structural attempts failed: an upcast to a local view interface hits TS2342
(privacy modifiers break structural comparability in both directions), and generic keyed
accessors fail because `keyof CLIInteractionPlugin` excludes private members at external call
sites. A public-API-only redesign (`send` + `receive`) cannot faithfully preserve BUG-21's
assertions (`closeCalls === 1`, post-recreate identity of the private `rl`). **The site is
src-blocked, not test-hard**: it needs a sanctioned seam (`_deps.createReadline` injection,
or `rl` protected plus a tiny test subclass) before it can drain. Whoever takes it should
also correct the fixture then — it pokes `stage: "verify"` (not an `InteractionStage`
member) and `prompt`/`context` fields that do not exist on `InteractionRequest`, while the
required `fallback`/`createdAt` are missing.

Ratchet: `asAny` ↓124 (435 → 311) and `anyType` ↓168 (557 → 389); `looseCast` ↓4
(1815 → 1811), `asNever` ↓2 (607 → 605) and `nonNullAssert` ↓11 (812 → 801) as benign side
effects of deleting real casts and `!` assertions; `tsSuppress`/`ratchetAllow`/`absentValue`
flat; no counter rose anywhere, including per-file. Gates: typecheck 0 (all three),
`check:all` green, full suite green (14149 / 1136 / 38, 0 fail), coverage OK (101 below floor
against baseline 103 — run explicitly because two fixture corrections touch values feeding
source branches).

**Recipe families applied** (all proven in §8.14–§8.18 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| absent-key probes `(x as any)?.key` ×8 | acp/activity-emission | local predicate `activityLacksKey(a, key)` via `key in obj`, undefined-safe |
| `session!.x` after async load ×4 | acp/activity-emission | `assertDefined(session, …)` from `@test/helpers` immediately after `loadSession` — throws like the removed `expect(...).not.toBeNull()` |
| hand-typed ctx masked by a whole-arg cast / hop-body literals | adversarial-review-requote, review/semantic-retry | delete the cast — the literal is contextually typed against the real `HopBodyContext<Input>`; or close with `} satisfies HopBodyContext<SemanticReviewInput>)` (adversarial-review-reground verbatim) |
| restated generic unions `<FixStrategy<…, any, any>>` | fix-strategy-composition | `type ComposedStrategy = ReturnType<typeof makeXStrategy> \| …` over the four factories — self-maintaining, no widened holes |
| dead casts on union members and null slots | role-task ×7, pull-tools ×7, mutation-check, precheck-tier2 ×5, plan-debate | `"python"` is already in `ProjectProfile["language"]`; `null ∈ string \| null \| undefined`; src's role union already contains `"tdd-simple"`/`"standard"`/`"lite"`; `getLogger` slot returns a real `Logger` — deleted outright, no replacement construct |
| partial-`NaxConfig` hydrate literals | runtime/packages ×4 | **`Partial<NaxConfig>` is not deep** — nested sections must be complete, so build overrides through `makeNaxConfig({ quality: { commands: { lint } } })` (a full config) instead of nesting literals |
| normalize-row expected values typed loosely | prd/schema | explicit `test.each<[string, Complexity]>` generics; every expected literal is already a union member once the tuple is typed |
| each()-row illegal values `false` for `cmd` fields | precheck-tier2 ×3 | `false` is not a legal value of the field type; source skip branch is `!cmd \|\| cmd === null`, so falsy/null/undefined share one path — rows now use `undefined` |
| `(op as any).build/.parse` property-pokes | lint-check, typecheck-check, verify-scoped, mechanical-formatfix | `"build" in op` guards + deterministically-typed locals (mechanical-lintfix precedent); ctx bags rebuilt from the already-drained `-tool-diagnostics` twins |
| weak-alias deletes on stage config | debate/runner-mode-routing | §8.12's move: `const withoutMode: { mode?: DebateMode } = stageConfig; withoutMode.mode = undefined;` — the runner reads `.mode ?? default`, so explicit undefined ≡ absent key |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:** mock
send returns gained required `estimatedCostUsd: 0` (`TurnResult` requires it; nothing asserts
cost) in requote and semantic-retry; lint-check's dep stub returned `format: "text"`, which is
not an `LintParserFormat` member (`"text"` belongs to the *input* union) → `"text-block"`;
verify-scoped passed `{ kind: "test", id }` where a real `Finding` is required → replaced with
the in-file well-formed fixture, and its `resolvedTestPatterns` literal gained the cast-masked
required `resolution: "per-package"`; coverage-parity dropped a `patterns` key that is not on
`ResolvedTestPatterns` (the provider reads `resolved.patterns ?? resolved.globs`, so `globs`
supplies the identical value). The precheck correction touches a value feeding the skip
branch, so §3's coverage rule fired at integration: floors unaffected.

**Carry forward: even at flattened queue heads, half the population is still assertions doing
nothing.** Of ~168 sites this batch, the largest single family was *dead casts* — values or
shapes the declared types already admit (`role-task`'s seven, `pull-tools`' seven, precheck's
five `null as any`s, mutation-check's `"python"`) — retired by deleting, not by building.
The standing recipes keep paying, but the first question at each site remains §1's original:
is this cast doing anything at all? Second carry forward: **a private-member injection site
with no existing seam is src-blocked** — two failed structural routes plus an assertion-losing
public redesign is the evidence, and the honest outcome is a held count plus a written seam
proposal, not a third workaround.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then seven files tied at 6 — `integration/execution/fullsuite-rectify-declaration`,
`integration/execution/nbf-rectify-declaration`, `operations/build-hop-callback-stale-retry`,
`pipeline/stages/acceptance-setup-fingerprint`,
`pipeline/stages/completion-fragment-capture`, `prompts/builders/critic-builder`,
`prompts/sections/isolation` — 148 files hold the remaining 380.

### 8.20 Batch 7 of the `noExplicitAny` drain — the tiers at 6 and 5, four parallel delegates, biome 380 → 278 (2026-08-26)

The §8.19 queue head drained: the seven files tied at 6 plus the whole twelve-file tier at 5
(a strict top-10 cut lands mid-tie; ride-along per §8.17–§8.18 precedent) — 19 files, ~102
biome sites taken by four parallel agents on disjoint file sets under the same brief model as
§8.16–§8.18 (§4 forbidden list, the cheap per-file gate loop, the standing recipe table). The
two mutation-check files that share a helper (`helpers/mutation-check.ts` +
`operations/mutation-check-revert`) were assigned to one delegate deliberately. No delegate
edited outside its set; zero src/ changes; **zero escalations held — all 19 files reached
zero.**

Ratchet: `asAny` ↓86 (311 → 225) and `anyType` ↓100 (389 → 289); `looseCast` ↓5 (1811 → 1806)
as a benign side effect of deleting real casts; every other counter flat; no counter rose
anywhere, including per-file. Gates: typecheck 0 (all three), `check:all` green, full suite
green (**14149 / 1136 / 38, 0 fail** — after the incident below), coverage OK (101 below floor
against baseline 103, identical to main).

The largest single family was, again, dead casts — §8.19's carry-forward holding at the next
tier down:

| Shape | Where | Recipe |
|:--|:--|:--|
| dead casts on values the declared types already admit ×20+ | rectify-decl ×2 (`FixStrategy<Finding, any,…>[]` element params are already `any` in src), reporters-schema (`.default()` makes `otel.logs` non-optional), acceptance-setup ×2 (config/prd literals already satisfied `NaxConfig`/`PRD`), build-hop-callback (typed dep returns), isolation/builder (`"tdd-simple"` ∈ src unions), critic-builder (`require` scaffolding → static typed import) | deleted outright |
| hand-typed runtime/ctx bags | runner-agent-resolution, session-helpers-resolver-model, helpers/mutation-check | `makeMockRuntime({...})` / `makeMockCallContext()` / structural `PackageView` with generic `select<C>(s): C { return s.select(config) }` |
| partial-config literals | context-verification-integration, context-build ×5 sites each | `makeNaxConfig({ context: {...} })` |
| loosely typed each()-rows | rectifier-builder | explicit `test.each<[string, ReviewCheckResult[], boolean]>()` generic |
| story/PRD fragments | critic-builder, mutation-check-revert | `makeStory(...)` / `makePRD(...)` |
| incomplete fixture object | mutation-check-revert PATTERNS | existing `makeResolvedTestPatterns` (+ required `resolution: "detected"`) |
| generic dep slots (`<I, O, C>`) no wrapper satisfies by assignment | completion-fragment-capture, semantic-iteration-wiring, e2e/orchestrator-harness | mock derived via `Parameters<typeof origFn>`; slot replaced by `Object.assign(_deps, {...})` with finally-restore (§8.15 containment model) |

**Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:**
semantic-iteration-wiring's prior Iteration carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"resolved"` (value only round-trips through the store);
STUB_RUN_OPTIONS gained `AgentRunOptions`-required `modelTier`/`modelDef`/`config`;
mutation-check-revert's PATTERNS gained required `resolution: "detected"` (unread); reporters-schema
dropped optional chains on post-`.default()` keys. Because two of these feed comparisons,
§3's coverage rule fired at integration: floors unaffected.

**The incident — mutating a `makeNaxConfig()` result poisoned `DEFAULT_CONFIG` process-wide.
Every gate was green before it and the full suite caught it.** One helper rewrite ended

```ts
const config = makeNaxConfig();
applyQuality(config, quality);            // writes config.quality.commands
Object.assign(config.execution, execution);
```

`deepMerge` clones only the levels it descends into, so **each unmodified subtree is still
the same object as `DEFAULT_CONFIG`'s** — both writes landed on the global default. The
helper's historical contract set `quality.commands = { test: "bun test" }`; the schema default
is `{}`. Later files' `makeNaxConfig()` inherited the pollution, and
`precheck-checks-tier2-warnings`' "skips silently when test command is undefined" assertion
(reads `execution.testCommand || quality.commands.test`) flipped to "configured: bun test".
`mutation-check-wiring` failed the same way one hop removed. Both files passed **solo**, and
the four delegates had each run their own sets green: the failure only exists in the
full-suite runner's shared worker. Fixed by deep-cloning first:
`structuredClone(makeNaxConfig())` before either write.

Carry forward, two halves: **a factory return is safe to read and unsafe to write below its
top level** — `deepMerge`'s sharing is invisible until someone assigns through it, so any
mutation of a helper-built config must clone first (worth grepping for whenever a new
`makeXConfig()` caller appears); and **"passes solo" proves nothing about state leakage** —
the full suite is not a slower version of the per-file loop, it is the only gate that runs
every fixture against every other fixture's leftovers. Related: §8.10's nine hand-built
runtime stubs — shared-helper rewrites change what *other* files receive, which is why the
helper and its heaviest consumer shared a delegate this batch.

Two judgment calls resolved without counter trades, recorded for reuse: the harness's legacy
`parsedSummary` (deliberately missing `failures` to drive the validator-error crash path)
cannot satisfy `RunTestsResult` — merged onto the module dep via `Object.assign` instead of
asserted, preserving the crash byte-for-byte; and generic dep slots rejected concretely-typed
wrappers by assignment, replaced the same way with restore. Minor tooling note: verifying a
file hit zero needs biome's `--reporter=json` — the default reporter's diagnostics carry no
machine-readable category, so grep-based verification silently reports zero on anything.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a twenty-two-file tier tied at 4 (`integration/acceptance/red-green-cycle`,
`integration/execution/rectification-routing`, `agents/retry/tiered-parse-retry`,
`cli/init-context`, `config/regression-gate-schema`, `config/test-strategy`,
`debate/runner-events`, `debate/runner-one-shot-roles`, `debate/runner-rounds-and-cost`,
`execution/_revalidation-fixtures`, `execution/post-run-isolation`,
`metrics/tracker-escalation`, `operations/adversarial-review-verify`,
`operations/autofix-test-writer`, `operations/full-suite-rectify`,
`pipeline/stages/acceptance-setup-commit`, `plugins/builtin/curator-paths`,
`plugins/builtin/otel-resource-git`, `review/recurrence-demotion`,
`review/semantic-debate`, `session/session-keeper`, `verification/import-grep-fallback`) —
129 files hold the remaining 278. The head has flattened again: no drainable file exceeds 4.

### 8.21 Batch 8 of the `noExplicitAny` drain — the twenty-two-file tier tied at 4, four parallel delegates, biome 278 → 190 (2026-08-26)

The §8.20 queue head drained: the whole twenty-two-file tier tied at 4 (a strict top-20 cut
lands mid-tie; ride-along per §8.17–§8.19 precedent) — 88 sites taken by four parallel agents
on disjoint file sets under the same brief model as §8.16–§8.20 (`HANDOFF-explicit-any-batch8.md`
carried the §4 forbidden list, the cheap per-file gate loop, the standing recipe table). The
held escalation (`interaction/plugins/cli`, 8 sites, src-blocked per §8.19) was excluded by
name. No delegate edited outside its set; zero src/ or helper changes; **all 22 files reached
zero.**

Ratchet: `asAny` ↓73 (225 → 152) and `anyType` ↓91 (289 → 198); `nonNullAssert` ↓9 (801 →
792) as a benign side effect of tracker-escalation's `assertDefined` migration retiring that
file's ten pre-existing `!` assertions with its casts; every other counter flat; no counter
rose anywhere, including per-file. Gates: typecheck 0 (all three), `check:all` green (after a
lint fix, see carry-forward), full suite green (**14149 / 1136 / 38, 0 fail**), coverage OK
(101 below floor against baseline 103, identical to main).

Recipe families applied (all proven in §8.14–§8.20 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| hand-rolled runtime bag inside a local `makeCallCtx` factory ×3 files | debate runner-events / one-shot-roles / rounds-and-cost | `makeMockCallContext({ runtime: makeMockRuntime({ agentManager }), storyId })`; the hand-mocked `configLoader`/`packages`/`packageView` and other unread fields went with the bag after verifying nothing in `src/debate/` reads them |
| `(capture[0] as any).field` probes off an `unknown[]` audit capture | review/semantic-debate | type the array at declaration: `const auditCalls: ReviewAuditDecision[] = []` — probes become direct reads, nullable member via `?.` |
| illegal union values masked by `as any` | recurrence-demotion ×2, adversarial-review-verify priors | real `IterationOutcome` members (`"unchanged"` where findings persist, `"regressed"` matching `classifyOutcome([], [f])`) |
| generic op config slot `C` | rectification-routing ×4, `_revalidation-fixtures` | retype the fixture op's generic from `typeof DEFAULT_CONFIG` to `ReturnType<typeof testSel.select>`; params retyped at the real unions (`PipelineStage`, `SessionRole`) so inner casts fall out |
| `const ctx = {} as any` build contexts | post-run-isolation, full-suite-rectify, autofix-test-writer | `makeTestContext()` + an intersection *alias* for the structural key src writes (a declaration, not a cast); local `makeFixCycleContext() = { ...makeMockCallContext(...), storyId }` (spread + declared field); typed `BuildContext<AutofixConfig>` via `packages.repo().select(selector)` |
| dead casts on values/types already admitted | regression-gate-schema ×4 (`.default()` puts `mode` on the schema type), test-strategy ×6 (param already `string \| undefined`; row values ∈ language union), acceptance-setup-commit ×3 (literal satisfies `NaxConfig`; `{ hooks: {} }` fits `HooksConfig`; dep returns `AgentAdapter \| undefined`), session-keeper ×3 (fewer-params assignability holds) + 3 comments quoting the old cast rewritten (§8.13-D), curator-paths ×4 (`makeNaxConfig()`) | deleted outright |
| partial fake into a typed Bun dep slot | import-grep-fallback ×4 | `Object.assign(_bunDeps, { glob })` + finally-restore (§8.14/§8.20 containment model) |
| each()-row callbacks `(row: any)` | tracker-escalation ×4 | explicit `test.each<EscalatedStoryRow>` generic + `assertDefined(updatedStory)` at each callback head |
| loosely typed OTLP posts/predicates | otel-resource-git ×4 | `OtlpTracesPayload \| OtlpMetricsPayload` union + `"resourceSpans" in p.body` guards narrowing to `KeyValue[]` (§8.18 recipe) |
| hand-typed callOp impl params | red-green-cycle ×4 (one line) | declare the helper's return as `typeof _acceptanceSetupDeps.callOp` — contextual typing drops all four annotations |
| `(inspection as any)?.kind` probes on unknowns | tiered-parse-retry ×4 | local `kindOf(inspection: unknown): string \| undefined` predicate via `typeof`/`"in"` |
| manifest-table field readers `(m: any)` | init-context ×4 | explicit `test.each<[…]>` generic typing the reader at the real `ProjectScan["packageManifest"]` |
| incomplete descriptor literal | session-keeper:384 | complete the `SessionDescriptor` fields + `satisfies SessionDescriptor` (`mock()` loses contextual typing and widens literals; satisfies keeps them narrow) |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
recurrence-demotion's two prior iterations carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"unchanged"` (non-empty `findingsAfter` matches the documented
meaning; `classifyRecurrence` never reads `outcome`); adversarial-review-verify's priors same
illegal value → `"regressed"` (exactly what production computes for the shape); post-run-isolation's
routing carried `testStrategy: "direct"`, not a `TestStrategy` member → `"test-after"`
(unread by `applyPostRunInspection`; the non-TDD path is driven by `tddMode: null`) plus the
cast-masked required `complexity`/`reasoning` completed on its `RoutingResult` literals.
None feeds a classifier or switch branch (verified per-file by the delegates), but because
three corrections landed §3's coverage rule was run anyway at integration: floors unaffected.

**The one integration catch: the probe config cannot see what it disables.** Four files
landed with unsorted imports — delegates had added imports while editing, and their gate loop
verified biome through the probe config, which turns `assist.organizeImports` **off** by
design (§0.1). The repo config gates that rule as error for `test/`, so `check:all` caught
the four at integration and a scoped `biome check --write` cleared them. **When a verification
config deliberately disables rules to reduce noise, it also stops verifying them — anything
the probe silences still needs one repo-config pass over the touched files before hand-off.**

Carry forward: the dead-cast majority held for the third batch running — roughly half this
batch's 88 sites were deleted, not replaced (§8.19/§8.20 carry-forwards holding at the tie-at-4
tier). Second: the three debate files each carried a private copy of the same runtime-bag
factory; all three migrated to the shared helpers independently without conflict, which is
the quiet argument for §8.16's `makePackageView(overrides)` promotion note still open.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a twenty-one-file tier tied at 3 (`integration/agents/stale-retry-session-reuse`,
`integration/agents/timeout-retry-fresh-session`, `agents/retry/types`, `cli/plan-decompose-ac13-14`,
`cli/plan-decompose-mapper`, `context/context-core`, `context/engine/orchestrator-factory`,
`context/engine/providers/code-neighbor-cap`, `context/provider-timeout-abort`,
`debate/verifiers/review-grounding-filter`, `execution/lifecycle/run-cleanup`,
`execution/unified-executor-reconcile`, `operations/full-suite-rectify-op`,
`operations/semantic-review-verify`, `pipeline/stages/routing-idempotence`,
`pipeline/subscribers/hooks`, `pipeline/subscribers/reporters`,
`precheck/precheck-checks-tier1-blockers`, `review/orchestrator-wrapper-parity`,
`verification/flake-probe`, `verification/smart-runner-packageprefix`) — 107 files hold the
remaining 190.

### 8.22 Batch 9 of the `noExplicitAny` drain — the twenty-one-file tier tied at 3, four parallel delegates, biome 190 → 127 (2026-08-26)

The §8.21 queue head drained: the whole twenty-one-file tier tied at 3 — a clean tier boundary,
no ride-along forced (§8.17–§8.19 precedent applies only when a strict cut lands mid-tie) — 63
sites taken by four parallel agents on disjoint file sets under the same brief model as
§8.16–§8.20 (`HANDOFF-explicit-any-batch9.md`). The held escalation (`interaction/plugins/cli`)
was excluded by name. No delegate edited outside its set; zero src/ or helper changes;
**all 21 files reached zero.**

Ratchet: `asAny` ↓54 (152 → 98) and `anyType` ↓63 (198 → 135); `looseCast` ↓3 (1806 → 1803)
and `asNever` ↓1 (605 → 604) as benign side effects of deleting real casts (code-neighbor-cap's
read-side `as Record<string, unknown>`, orchestrator-factory's dead config-field cast, and one
of provider-timeout-abort's pre-existing `as never`s among them); every other counter flat; no
counter rose anywhere, including per-file (`git diff scripts/baselines/` shows removals and
reductions only). Gates: typecheck 0 (all three), `check:all` green, full suite green, coverage
OK (101 below floor against baseline 103 — run because multiple fixture corrections landed).

Recipe families applied (all proven in §8.14–§8.21 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| malformed-data pokes (`acceptanceCriteria: null as any`) | context-core ×2 | §8.12 weak alias extended to null: hoist to typed `UserStory`, plant via `const m: { acceptanceCriteria?: string[] \| null } = story; m.acceptanceCriteria = null` |
| illegal value in an otherwise-valid row (`priorErrors: "not an array"`) | context-core | row passes clean into the factory; poke the built object through a typed alias |
| dead casts on real fields / satisfied fixtures ×10+ | orchestrator-factory ×2, retry/types ×2 (`nextPrompt?` declared), review-grounding-filter (spread loses freshness), flake-probe (barrel re-export), semantic-review-verify, routing-idempotence `"medium"`/`"test-after"` ∈ unions, stale-retry deps returning declared optionals | deleted outright |
| incomplete fixture under its declared type | hooks/reporters (`StoryEventSummary` needs title/status/attempts), unified-executor-reconcile (`makeStory`), provider-timeout-abort (`kind: "static"` + full `ContextRequest`), orchestrator-factory (`makeResolvedTestPatterns`) | completed at the type; `satisfies`/factory contextual typing |
| class-typed dep bags / logger spies | code-neighbor-cap, run-cleanup | `makeLogger()` from helpers; spy typed `Mock<typeof module.getSafeLogger>`, real silent `Logger` overlaid via `Object.assign` (§8.13-A) |
| hand-rolled ctx/runtime bags | review-grounding-filter, semantic-review-verify, full-suite-rectify-op | `makeMockCallContext({...})`; local `makeCtx(): BuildContext<AutofixConfig>` copied verbatim from drained sibling autofix-test-writer |
| module-level run-options cast bag | stale-retry / timeout-retry twins | §8.17 recipe verbatim: local `makeStubRunOptions(config)` completing `modelTier`/`modelDef`/`config`, each test passing its own manager config |
| `(Bun as any).file` patches | smart-runner-packageprefix | `Object.assign(Bun, { … })` + restore (§8.14) |
| untyped mock/callback params | flake-probe `_env: any`, plan-decompose callbacks ×5 | annotate at the dep's real signature (`CompleteOptions`); defensive `opts ?? {}` → `assertDefined(opts)` — the real caller always passes them |
| deliberate illegal literal under test | routing-idempotence garbage persisted tier | supplied via `JSON.parse('"ultra-mega"')` — the corruption arrives as JSON in production (profile.test.ts precedent) |
| omission-under-test fixtures | precheck-tier1 tags/status/storyPoints | `createMockStory()` base + weak alias + `delete` for genuinely-absent keys — absent vs undefined share the single `??` branch |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
orchestrator-wrapper-parity's prior iteration carried `outcome: "fixes-applied"`, not an
`IterationOutcome` member → `"regressed"` (exactly what `classifyOutcome([], [f])` computes for
that shape; recurrence classifiers never read `outcome`); semantic-review-verify same illegal
value → `"unchanged"`; the retry twins' run-options gained the cast-masked required
`modelTier`/`modelDef`/`config` (dispatch mocked before the adapter reads them);
hooks/reporters' summaries gained required `title`/`status`/`attempts` (`wireHooks`/
`wireReporters` read only `ev.storyId`); ac13-14's debate section rebuilt through
`makeNaxConfig({ debate: { enabled: false } })` (`stages: {}` cannot exist post-parse; the
`enabled` branch value is preserved); run-cleanup dropped config keys `headless`/`autoCommit`
that do not exist on `NaxConfig`. None feeds a classifier or switch branch (verified per-file),
but because several corrections landed §3's coverage rule ran anyway at integration: floors
unaffected.

Two integration notes. **The probe-config blind spot fired again, identically to §8.21:** two
cli files landed with unsorted imports the delegates' gate loop could not see, and `check:all`
caught both — the scoped repo-config `biome check --write` is now understood as a mandatory
owner step, not a per-batch judgement call. **The suite-count bookkeeping was reconciled:**
this entry initially recorded "14156 / 1173 / 38" against earlier entries' "14149 / 1136 /
38", but bun prints both lines — `1136 pass` + `37 skip` = `Ran 1173 tests`, and `14149 pass`
+ `7 skip` = `Ran 14156` — so the suites are identical and the skips were always there.
Earlier entries quoted the pass line; future entries should quote pass counts explicitly
(`14149 / 1136 / 38 pass, 0 fail`) so a skip-count change cannot masquerade as a suite change.

Carry forward: the dead-cast majority held for the fourth batch running — ten-plus of this
batch's 63 sites were assertions doing nothing, retired by deleting. And the tie-at-3 tier
needed no new recipes at all: every site fell to a pattern already proven in §8.14–§8.21,
which is what a flattened queue head should look like. Remaining tail: 85 files hold 119 sites,
none above 2.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a tier tied at 2 led by `integration/cli/cli-precheck-run`,
`integration/config/merger`, `integration/plan/plan-prd-preservation`,
`integration/routing/plugin-routing-advanced`, five `cli/plan-decompose-*` files,
`context/engine/lint-config-factory`, `context/engine/providers/code-neighbor-size-cap`,
`debate/verifiers/plan-checklist`, `execution/parallel-worker-isolation`,
`execution/plan-inputs-review-wiring` — 86 files hold the remaining 127.

### 8.23 Batch 10 of the `noExplicitAny` drain — the thirty-four-file tier tied at 2, four parallel delegates, biome 127 → 59 (2026-08-26)

The §8.22 queue head drained: the whole thirty-four-file tier tied at 2 (a strict top-20 cut
lands mid-tie; ride-along per §8.17–§8.19 precedent) — 68 sites taken by four parallel agents
on disjoint file sets under the same brief model as §8.16–§8.21
(`HANDOFF-explicit-any-batch10.md`). The held escalation (`interaction/plugins/cli`) was
excluded by name. Files grouped by subsystem so shared helpers landed on one delegate each
(the five `plan-decompose-*` files together; the two otel files together). No delegate edited
outside its set; zero src/ or helper changes; **all 34 files reached zero, with zero
escalations held** — the first batch since §8.20 with nothing left behind.

Ratchet: `asAny` ↓47 (98 → 51) and `anyType` ↓68 (135 → 67); `looseCast` ↓1 (1803 → 1802,
plan-checklist's dead cast among them) as benign side effects of deleting real casts; every
other counter flat; no counter rose anywhere, including per-file. Gates: typecheck 0 (all
three), `check:all` green, full suite green (**14149 / 1136 / 38 pass, 0 fail** — identical
counts to batch 9), coverage OK (101 below floor against baseline 103 — run because multiple
fixture corrections landed).

Recipe families applied (all proven in §8.14–§8.22 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| untyped JSONL-log readers + null-slot reads | cli-precheck-run | local `PrecheckLogEntry` interface mirroring the producer's shape; return typed at the exported src type (`NaxStatusFile \| null`) + `assertDefined` after the existing null checks |
| dead casts on values/types already admitted ×8 | merger ×2 (`override` already `Record<string, unknown>`), acceptance-setup-agent-file (literal satisfies `NaxConfig`), storyid-events (`makeAgentAdapter` already returns `AgentAdapter`), hermetic ×2 (`"ruby"` ∈ language union), scratch-writer ×2 (typed `_deps` field assignment since #508-M8) | deleted outright |
| untyped mock-callback params | plan-decompose-ac-repair/adapter/debate/regression/writeback ×10 | annotate at the dep's real signature (`CompleteOptions`) + `assertDefined(opts)` replacing dead `opts ?? {}`; capture arrays retyped to match |
| hand-rolled logger literal / `mockLogger as any` | plugin-routing-advanced ×2, code-neighbor-size-cap | `Object.assign(makeLogger(), { warn })` real-Logger overlay (§8.13-A) |
| `{ story }` fragments / story-slot bags | duplicate-phase, runner-retry, autofix-prompts, mutation-check-telemetry, lint-config-factory, verify-op twins, parallel-worker-isolation | `makeStory(...)` / `makePRD(...)` |
| `(op.retry as any)(…)` union-member call ×2 | adversarial-review | §8.18 `resolveRetryStrategy()` recipe verbatim; gotcha recorded: op's `ReviewConfig` is the one in `@/config/selectors`, not `@/review/types` |
| hop-body options bag `as any` | adversarial-review-inspection-trail, semantic-review-inspection-trail | `} satisfies HopBodyContext<Input>)` (§8.19) |
| hand-typed ctx/runtime bags | plan-checklist, verify-op-parse-retry, verify-op-recover, debate-propose/rebut | `makeMockCallContext({ runtime })`; structural `PackageView` with generic `select<C>`; runId pinned via `Object.defineProperty(runtime, "runId", …)` preserving the path assertion |
| restated generics from a dep | revalidation-carveout ×2 | `NonNullable<Parameters<typeof runRectification>[1]["rectification"]>["strategies"][number]` (§8.16 derivation) |
| op-literal for `AnySlot` / callOp stubs | run-phase-telemetry | complete + `satisfies RunOperation<…>`; `makeCallOp({ fallback })` (§8.15) |
| absent-key poke on a typed dep | code-neighbor-size-cap | §8.12 weak alias over `_codeNeighborDeps.fileSize` |
| loosely typed OTLP accessors | otel-heartbeat ×2, otel-logs ×2 | drop `: any` where src already returns precise payloads; local payload interface + `"resourceLogs" in` predicate; typed gauge-point accessor that throws on missing metric |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
run-phase-telemetry's op carried `stage: "execution"`, not a `PipelineStage` member → `"run"`
(implementerOp itself declares `"run"`; feeds only a log line); runner-retry's prd literal used
key `stories`, which does not exist on `PRD` (correct key `userStories`), and missed five
required fields → rebuilt via `makePRD` (retry logic never reads it); semantic/adversarial
inspection-trails gained schema-required `resetRefOnRerun: false` and `estimatedCostUsd: 0`
(TurnResult requires it, nothing asserts cost — §8.17/§8.19 precedents); plan-inputs routing
gained required `complexity/modelTier/reasoning`; constitution `{content:""}` gained required
`tokens/truncated`; parallel-worker-isolation's inline story gained required `title`;
curator-seam's e2e config literal became a full `NaxConfig` (its `review.audit.enabled`
resolves to schema default `false` vs the old bare literal's absence-as-enabled — verified
behavior-neutral: `postRunAction.execute` never calls `shouldRun` and no collector reads
`ctx.config`); scratch-writer's appendFile stub returned `0` mimicking writeFile → now matches
the dep's real `Promise<void>`. None feeds a classifier or switch branch, but because several
landed, §3's coverage rule ran at integration anyway: floors unaffected.

Two integration notes. **The probe-config blind spot fired a third time (§8.21, §8.22):**
delegate C left four files with unsorted imports its gate loop could not see; the owner's
repo-config `biome check --write` pass over the touched files fixed all of them (five files,
import order only). **A delegate ran `git stash push/pop` mid-batch in the shared worktree**,
briefly cycling other delegates' in-flight edits through the stash — it popped cleanly here
and tree integrity was verified at integration, but **state-mutating git commands are off
limits for delegates on a shared worktree**: verifying a pre-existing failure should read HEAD
(`git show HEAD:<path>`) instead of stashing live work. Related: concurrent delegates'
in-flight edits made project-wide `tsc -p tsconfig.test.json` noisy mid-run (errors appearing
and vanishing as siblings committed fixes to their own files); per-file gates stayed reliable,
which is why the brief scopes the tsc gate to "my files contribute 0 errors" and defers the
whole-project certification to the owner's quiet-tree run.

Carry forward: the dead-cast family held for the fifth consecutive batch (~a third of this
batch's sites deleted outright, led by hermetic's `"ruby"` ∈ union and merger's
already-`Record<string, unknown>` params), and the tie-at-2 tier again needed no new recipes —
every site fell to a pattern already proven in §8.14–§8.22. The queue head is now the last
tier: after this batch only single-site files remain.

**New top of queue** (biome count per file): `interaction/plugins/cli` 8 (held escalation,
src-blocked), then a fifty-one-file tier tied at 1 spanning `test/integration/**`,
`test/unit/**` and one ui file (`usePipelineBusEvents.test.tsx`) — 52 files hold the remaining
59. The tier after this one is empty: draining it leaves only the held escalation, which ends
the drain pending its src-side seam.

### 8.24 Batch 11 of the `noExplicitAny` drain — the fifty-one-file tier tied at 1, four parallel delegates, biome 59 → 8 (2026-08-26)

The §8.23 queue head drained: the whole fifty-one-file tier tied at 1 — 51 sites taken by four
parallel agents on disjoint file sets grouped by subsystem under the same brief model as
§8.16–§8.22 (`HANDOFF-explicit-any-batch11.md`; recipes table extended with the batch-9/10
proven patterns: run-options stubs, logger overlays, capture-array typing). The held escalation
(`interaction/plugins/cli`) was excluded by name. No delegate edited outside its set; zero
src/ or helper changes; **all 51 files reached zero, with zero escalations held** — second
consecutive clean batch. **The drain queue is now empty**: every remaining site is the held
escalation, and the `noExplicitAny` half of endgame item 4 waits only on its src-side seam.

Ratchet: `asAny` ↓42 (51 → 9) and `anyType` ↓49 (67 → 18); `looseCast` ↓2 (1802 → 1800) and
`asNever` ↓1 (604 → 603, runner-plan-signal's callback-site `as never` among them) as benign
side effects of deleting real casts; every other counter flat; no counter rose anywhere,
including per-file (the two baseline lines that *look* added in the diff are pre-existing
entries re-serialized after a sibling key was removed — verified against HEAD). Gates:
typecheck 0 (all three), `check:all` green, full suite green (**14149 / 1136 / 38 pass,
0 fail** — identical counts to batches 9 and 10), coverage OK (101 below floor against
baseline 103 — run because fixture corrections landed).

Recipe families applied (all proven in §8.14–§8.23 except where noted):

| Shape | Where | Recipe |
|:--|:--|:--|
| dead casts on values/types already admitted ×14 | build-plan-for-strategy (`checks` literals ∈ schema enum), story-orchestrator-check-ops (literal satisfies `CallContext`), rectification-exhaustion (`config: testSel`, sibling ops never needed it), acp/registry (`{ agent: undefined }` assignable to `DeepPartial<NaxConfig>`), plan-mode + query-scratch (`makeLogger()` already returns the dep's declared type), routing-profile-tier (see below), pipeline-acceptance (statuses ∈ `StoryStatus`), tdd-conventions (`"go"` ∈ language union), verdict/scratch ctx bags → `makeTestContext(...)` | deleted outright |
| **open-union discovery** — `"custom-tier" as any` | routing-profile-tier | `ModelTier = "fast" \| "balanced" \| "powerful" \| (string & {})` already admits any string — the "illegal literal" premise was false; cast deleted, test intent unchanged |
| required run-options stubs ×3 | manager-lifetime, manager-stale-retry-hop-kind, timeout-retry-hop | §8.17 recipe verbatim, third application: local `makeStubRunOptions(config)` completing `modelTier`/`modelDef`/`timeoutSeconds`/`config` |
| hand-rolled runtime/ctx bags | merge (`makeWorktreeManager()`), tier-escalation-source-tier + curator-scoping (`config: makeNaxConfig()`), autofix trio (`BuildContext<AutofixConfig>` from the drained sibling), debate-judge/synthesis (real `PackageView` via `makeTestRuntime().packages.repo().select(selector)`), review/runner (`makeMockAgentManager()`), adversarial-advisory-findings (`VerifyContext` via `opSelector`) | shared helpers / real objects |
| story fragments | resume-integration, event-bus (`StoryEventSummary` completed with required `attempts`), mutation-check ×2, rectifier-builder-review-labels, usePipelineBusEvents (.tsx) | `makeStory(...)` |
| loosely typed mock params/capture arrays | compose (`[AdapterFailure \| Error, number, RetryContext][]` from the dep signature), completion-review-gate (mock annotated at dep signature so `.mock.calls[0]` infers), lifecycle-completion (`Mock<typeof getSafeLogger>`), webhook-reporter (precise post envelope type), report-dead-tests (`Parameters<typeof generateDeadTestsReport>[0]` reaching an unexported type), plan-builder (`Partial<Parameters<…>[0]>` derivation) | typed at declaration; casts fall out |
| null / corruption delivered as data | prior-failures (`formatPriorFailures(JSON.parse("null"))` — arrives deserialized from prd.json in production) | profile.test.ts precedent |
| omission-under-test | cli-precheck-integration | `createMockStory` base + weak alias + `delete` (precheck-tier1 precedent) |
| class-overlay mocks | plan-callop-migration (`makeInteractionChain({ destroy })` — MockInteractionChain ⊆ InteractionChain), map-source-to-tests-parallel (`Object.assign(Bun.file(p), { exists, text })` — intersection genuinely satisfies `BunFile`) | §8.13-A |
| generic dep slot | runner-plan-signal | §8.13-C overload seam: strict generic signature for callers, loose concrete implementation; retired both `input: any` and the trailing `as never` |

Fixture-value corrections, all assertion-preserving and reported per §4's carve-out:
adversarial-pass-fail's priors carried `outcome: "fixes-applied"` → `"regressed"` (not an
`IterationOutcome` member; exactly what production computes for that shape; classifier reads
only fingerprints); event-bus summary gained required `attempts` and dropped non-member
`acceptanceCriteria`; revalidation-repo-scope's phase list built real `InternalPhase` fixtures
(the cast hid a missing required `slot`); the three retry files' run-options gained the
cast-masked required tier/model/config fields; cli-precheck's story rebuilt on `createMockStory`
(gained unread auto-defaults). None feeds a classifier or switch branch beyond what coverage
already pins.

Two integration notes. **The probe-config blind spot fired a fourth time but cost nothing:**
two files landed with unsorted imports, and the owner's mandatory repo-config
`biome check --write` pass over touched files fixed them before any gate ran — §8.22's
promotion of the pass to "mandatory owner step" held. **The dead-cast majority held for the
sixth consecutive batch** — fourteen of fifty-one sites were assertions doing nothing, and one
of those exposed a new twist: an "illegal value" cast whose target union was secretly open
(`ModelTier`'s `(string & {})` arm). Before treating a literal as deliberately-illegal, read
the union's own arms — §1's first question ("is this cast doing anything at all?") applies to
the *premise*, not just the assertion.

**Remaining:** biome `noExplicitAny` = **8**, all in `interaction/plugins/cli.test.ts`
(held, src-blocked per §8.19 — needs `_deps.createReadline` injection or `rl` protected plus a
test subclass, plus that file's fixture corrections). With it drained or exempted, the
`noExplicitAny` half of endgame item 4 is ready to promote to `"error"`. The other half —
`nonNullAssertion`, biome 1064 against regex 792 — is untouched and is roughly ten times the
size of the entire `noExplicitAny` drain just completed.

### 8.25 The held escalation drained via a src-side seam — biome 8 → 0, rule promoted to `"error"` (2026-08-26)

The last file, `interaction/plugins/cli.test.ts` (8 sites, held since §8.19 as src-blocked).
The seam §8.19 asked for turned out to be one line of `src/`, and neither of the two shapes it
proposed:

**The blocker was the field's *type*, not the member's privacy.** §8.19's failed routes both
attacked privacy — an upcast to a local view interface (TS2342) and a generic keyed accessor
(`keyof` excludes private members). But §1's ruling already settled privacy: literal element
access (`p["rl"]`) reaches a `private` member, is more checked than a cast, and is the
containment pattern `test/helpers/*-internals.ts` was built for (`biome.json` already turns
`useLiteralKeys` off there for exactly this). What actually rejected the mock was that `rl`
was declared `readline.Interface | null`, and the test's stub is a two-method object.

So the src change is interface segregation, not injection and not a visibility downgrade:

```ts
export interface CLIReadline {
  question(prompt: string, callback: (answer: string) => void): void;
  close(): void;
}
// private rl: readline.Interface | null  →  private rl: CLIReadline | null
```

A real `readline.Interface` satisfies it structurally, so `init()` and `recreateReadline()` are
untouched and no caller changes. **This is not §4's "weakening a source type so a fixture
fits"**: the plugin genuinely calls only `question` and `close`, and naming the contract it
depends on narrows what the class may do, where `_deps.createReadline` injection (§8.19's first
proposal) would have added a constructor parameter and a second environment seam to buy the
same thing. The test side is then a `cliInternals(plugin)` live view in the existing
`interaction-internals.ts` helper — one more accessor beside `telegramInternals` /
`webhookInternals`, with a `set rl` for the injection and a bound `promptUser`.

All three BUG-21 assertions survive verbatim, including `closeCalls === 1` and the
post-recreate identity check (`internals.rl` is the live field, so `not.toBe(staleRl)` still
reads the real slot) — the public-API redesign §8.19 rejected was never needed.

The fixture corrections §8.19 flagged, applied: `stage: "verify"` → `"execution"` (`"verify"`
is not an `InteractionStage` member; the value is only read by `send()`, which this test never
calls), the non-member `prompt`/`context` keys dropped, and the required `fallback`/`createdAt`
added — `makeRequest` now returns a real `InteractionRequest` with the annotation to prove it.

Ratchet: `asAny` ↓8 (9 → 1) and `anyType` ↓8 (18 → 10); every other counter flat, no counter
rose. Gates: typecheck 0 (all three), `check:all` green, full suite green (**14149 / 1136 / 38
pass, 0 fail** — unchanged for the fourth consecutive batch). Coverage not re-run: the only
changed values are a private-path fixture's `stage`/`fallback`, which no classifier or switch
in `src/interaction/` reads.

**Then the promotion.** With biome's `test/` count at 0, `biome.json`'s `test/**` override was
changed from `"noExplicitAny": "off"` to `"error"` (`"noNonNullAssertion"` and `"noDelete"`
left as-is). `bun x biome check src/ bin/ test/` reports zero `noExplicitAny` diagnostics at
any severity, and `bun run lint` is green — so the ~2900 drained sites are now held by a hard
gate rather than by a counting ratchet with slack in it. Half of endgame item 4 is closed.

**Carry forward: a "src-blocked" ruling names a seam the author had in mind, not the seam the
error demands.** §8.19's write-up was rigorous about what it tried and still framed the fix as
injection-or-visibility, because both failed attempts were about privacy. Reading the actual
rejection — the *declared type* of the slot — gave a fix an order of magnitude smaller. Before
building a proposed seam, re-derive which property of the site rejects the test; the held
escalation's own report is evidence, not a specification.

**Remaining:** biome `noExplicitAny` in `test/` = **0**, gated at `"error"`. The drain queue is
empty. The next target is `noNonNullAssertion` — biome 1064 against regex 792 (§0.1), roughly
ten times the `noExplicitAny` drain, and not started.
