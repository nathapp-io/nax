# Handoff: #1514 Lane A — the delegable residue

Written 2026-08-24 against `main` @ `23d9e0e60` (clean tree). Test typecheck is **692 across
241 files**; `as unknown as` **102**; `asAny=1388, tsSuppress=40, ratchetAllow=106,
absentValue=17, anyType=1880, looseCast=1932`. Every number in this document was measured on
that commit, not recalled.

Read `HANDOFF-1514-delegable-clusters.md` §0 (G1–G6) and
`HANDOFF-1514-cast-and-fixture-residue.md` §3 (recipes R1–R6) first. Both bind you unchanged,
including **G5 as amended**: you may not edit `src/` or `test/helpers/`. Escalate instead.

---

## Evidence status — read this before trusting anything below

The previous handoff's headline claim ("every recipe below was prototyped") was false, and the
review caught it. Precise status here:

| Claim | Status |
|:--|:--|
| Recipes R1–R6 | **Proven** — each landed a commit; STATUS §17–§27 has the evidence |
| Helpers named in §3 exist with the signatures given | **Verified** — read from `test/helpers/` on this commit |
| Per-file counts and error codes in §2 | **Measured** on `23d9e0e60` |
| Per-file *cause* column | **Read from the file's actual first 1–4 tsc errors.** Not prototyped. A hypothesis to check, not a fact |
| Cause columns for `plan-monorepo` and `process-kill` | **Corrected after review** — the first draft read the error code and guessed the mechanism. Both guesses were wrong in the direction that would have sent a delegate hunting for the wrong thing. See §2 |
| The two traps in §5 marked "verified" | **Verified on this commit** — the grep is in the doc |
| Everything not in a table | **Uninspected** |

**No recipe in this document has been prototyped end-to-end.** Reading an error is not
executing a fix. Reviewing this document before handing it over already caught two wrong
cause columns out of ten — assume there are more. When a cause column is wrong, that is expected — record it in
`STATUS-1514-drain.md` and move on. Do not force a file to match a hypothesis here.

---

## 1. Scope

Lane A is **641 of the 692 errors**. Excluded — owner only, do not take, do not "just look":

| File | n | Why it is not yours |
|:--|--:|:--|
| `integration/config/merger` | 19 | The blanket `deepMergeConfig<Record<string, unknown>>` recipe was prototyped and **backfired** (19→15 while introducing 6 `TS2339` + 6 `TS18046`). Needs a per-call-site decision. `HANDOFF-1514-cast-and-fixture-residue.md` §4 |
| `unit/config/merge` | 17 | Six codes, uninspected, adjacent to the same merge surface |
| `unit/execution/story-orchestrator-run-phase-events` | 15 | `Operation<…>` includes `CompleteOperation`, `AnySlot` excludes it — a `src/` variance question under amended G5 |

Work unit: **one file per commit.** The big single-cause clusters are gone — 183 files hold
≤3 errors (317 total), 30 hold 4–5 (132), 28 hold ≥6 (243).

---

## 2. The batches, in order

Take Batch 1 top to bottom before touching Batch 2. Do not reorder to chase the biggest number.

### Batch 1 — proven recipe, single or twin cause (~82 errors)

**One ruling changed.** `HANDOFF-1514-cast-and-fixture-residue.md` marks
`session-manager-runtime` 🟡 ("needs a factory; keep it file-local"). That was written before
anyone checked: `makeAgentAdapter` and `makeSessionManager` both already exist in
`test/helpers/`, so no new factory is needed and no G5 escalation is involved. It is ✅ here.
Where the two documents disagree, this one is newer and was measured.

| File | n | codes | cause (read from the error) | recipe |
|:--|--:|:--|:--|:--|
| `unit/execution/session-manager-runtime` | 15 | TS2345×15 | 13× `mock(() => ({ closePhysicalSession }))` passed as `AgentGetFn` — missing `name, displayName, binary, capabilities` +6. 2× a local `SessionManagerLike` whose `transition` is optional and drops the `options?` param | **R3** with `makeAgentAdapter` (exists); **R5** delete `SessionManagerLike`, use `makeSessionManager` (exists) |
| `unit/cli/status-cost` | 12 | TS2493×6 TS2352×4 TS2554×1 TS2769×1 | `loadRuns`/`stdout` are `mock(() => …)` = zero-arg, so `.mock.calls[0]?.[0]` is an index into `[]`. The four `as string` / `as {…}` casts exist **only** to bridge the resulting `undefined` | **R2**, then **R6** — deleting the casts drops `looseCast` too |
| `integration/cli/cli-plugins` | 8 | TS2322×4 TS2339×4 | The §26 optimizer fixture again: returns `{ optimizedPrompt, estimatedTokens, tokensSaved, appliedStrategies }`, reads `input.estimatedTokens` (never existed). `PromptOptimizerResult` wants `{ prompt, originalTokens, optimizedTokens, savings, appliedRules }` | `makeOptimizerResult` (exists). **See §5 trap 1 — there is a fifth copy tsc cannot see** |
| `unit/runtime/cost-aggregator` | 8 | TS2741×5 TS2322×3 | Fixtures omit the `kind` discriminant of `CostErrorEvent`. Separately one `resolve` typed `(value: number \| PromiseLike<number>) => void` in a `() => void` slot | mechanical field completion |
| `unit/execution/unified-executor-dispatch` | 8 | TS2741×6 TS2322×1 TS2352×1 | Story literals missing `escalations`; one `Mock<(event: Record<string, unknown>) => void>` cast into `(event: PipelineEvent) => void` | `makePendingStory` / `makeInProgressStory` (exist); **R4** for the event mock |
| `unit/cli/plan-decompose-ac13-14` | 7 | TS2322×6 TS2345×1 | `Mock<() => IAgentManager>` in a `(cfg, wd, featureName) => NaxRuntime` slot — identical to the §27 `plan-decompose-regression` fix. Plus one `(string \| ContextFileEntry)[]` into `string[]` | **R3** via `makeMockRuntime({ agentManager })` (exists) |
| `unit/review/orchestrator-wrapper-parity` | 6 | TS2741×3 TS2322×3 | Review-output fixtures missing `acDropped` | mechanical |
| `unit/cli/plan-monorepo` | 6 | TS2322×6 | **Literal widening, not missing fields.** The fixture already has all four `SourceRoot` fields; `mock(async () => [...])` infers `language: string` where `SourceRoot.language` is `"typescript" \| "javascript" \| "go" \| "rust" \| "python" \| undefined` | annotate the mock's return as `SourceRoot[]`. Not R2 — a zero-arg mock is assignable to a one-param slot, and nothing reads `.mock.calls` here |
| `unit/context/engine/tool-runtime` | 6 | TS2322×6 | `undefined` passed for required `ContextConfig` / `ExecutionConfig` | `makeConfigSlice` (exists) |
| `unit/utils/process-kill` | 6 | TS2322×6 | **The recorder array is too narrow, not too wide.** `killCalls: Array<{ signal?: NodeJS.Signals \| number }>` receives `signal` inferred as `string \| number \| undefined` from the `process.kill` overload | widen `killCalls` to the parameter's real type. Leave the existing `as typeof process.kill` alone — it is a counted `looseCast` doing real work |

### Batch 2 — two causes or a judgement call (~64 errors)

Do not start these until Batch 1 is landed and reported.

| File | n | codes | what makes it a judgement call |
|:--|--:|:--|:--|
| `unit/operations/autofix-implementer-strategy` + `unit/operations/full-suite-rectify` | 10 + 7 | TS2554, TS2339 | **One shared cause across two files**: the result is `Promise<X> \| X` and the test reads `.summary`/`.unresolved` without `await`; autofix additionally calls a 2-param function with 3 args. Decide whether the extra arg is dead or the signature moved — `PROPOSAL` §Actuals records these six `TS2554` as deliberately deferred in phase 1 |
| `integration/execution/runner-plugin-integration` | 10 | TS2559×8 +2 | Three causes: `hooks: []` where `hooks` is now `Partial<Record<HookEvent, HookDef>>` (a dead fixture shape — is `[]` meant to be `{}`?), a partial-`NaxConfig` `as` cast (`makeNaxConfig` exists), and a `spyOn(…, "getAgent")` naming an export that no longer exists |
| `unit/execution/nbf-readonly-flake-triage` | 9 | TS2345×7 TS2352×2 | The mock returns `T[]` where `TriageResult` is a 2-tuple. But the 7 `TS2345` are `CallContext.storyId?: string` vs `FixCycleContext.storyId: string` — **that may be a real `src` contradiction. Read it, then escalate rather than widening the fixture** |
| `unit/bakeoff/run-action` | 8 | TS2352×5 TS2493×3 | Dynamic dep-bag save/restore; a helper costs one cast at the `Object.keys` boundary. Already ruled 🟡 "measure first" in the previous handoff. **Measure, report the number, then ask** |
| `unit/plan/pipeline-strategy` | 7 | TS2352×5 TS2741×2 | Partial `PackageSummary` cast plus a dep bag missing `getLogger` |
| `unit/operations/debate-rebut` + `debate-propose` | 7 + 6 | TS2349, TS2345 | "This expression is not callable" — likely the `callOp` seam. Monomorphic annotation may apply (PROPOSAL §What phase 3 changed), but the 8 tier-3 sites are accepted exceptions. Check which side of that line these fall on |

### Batch 3 — the tail

183 files at ≤3 errors (317 total) and 30 at 4–5 (132). No table; `grep` the file, read the
error, apply a recipe or move on. **Skip anything you cannot diagnose in ten minutes** — the
tail is not worth a deep dive per file.

### Escalate, do not fix

- `unit/debate/pre-phase/grounder` (6, TS2339×6) — `Property 'packageView' does not exist on
  type 'NaxRuntime'`. The test asserts against a field the runtime does not have. That is a
  `src`/test contradiction, not a fixture defect. Write it up; do not add the field, do not
  cast it away.

---

## 3. Helpers that already exist — check here before writing a factory

R3 says "check `test/helpers/` first". These are verified present on this commit and cover
most of Batch 1:

| Helper | File | Use for |
|:--|:--|:--|
| `makeAgentAdapter(overrides?)` | `mock-agent-adapter.ts` | full `AgentAdapter` — all 13 fields, `Partial` overrides |
| `makeSessionManager(overrides?)` | `mock-session-manager.ts` | full `ISessionManager` |
| `makeOptimizerResult(…)` | `optimizer-result.ts` | `PromptOptimizerResult` — written for exactly the cli-plugins defect |
| `makeMockRuntime({ agentManager })` | `runtime.ts` | `createRuntime` slots |
| `makeNaxConfig` / `makeSparseNaxConfig` | `mock-nax-config.ts` | config literals |
| `makeConfigSlice` / `makeStorySizeGateConfig` | `mock-nax-config.ts` | a typed view of one config sub-object |
| `makePendingStory` / `makeInProgressStory` | `mock-story.ts` | `UserStory` literals |
| `makeDispatchContext`, `makeCallOp`, `makeDebateRunner`, `makeFinding`, `makeMockCallContext` | — | see `test/helpers/index.ts` |

If none fits, write yours **file-local**. Adding to `test/helpers/` is G5 and needs an
escalation, not a judgement call.

---

## 4. The loop — every commit, in this order, no exceptions

```
bun run typecheck                                   # src + contracts — must print NOTHING
bun x tsc --project tsconfig.test.json --noEmit     # count before/after
bun run check:all                                   # 25 gates (lint's 11 + 14 more)
bun test <the files you touched> --timeout=30000    # must pass
bun run test                                        # full suite (unit + integration + ui)
bun run test:coverage                               # per-file coverage floor — see below
bun run check:test-typecheck:update                 # baseline LAST, only if all green
```

`check:test-typecheck` prints `worse: <n>` per file. **`worse` must be 0.** If a file you did
not touch got worse, you changed a shared type — stop and revert.

**`bun run test:coverage` must stay green — it is a gate, not a report, and `check:all` does
not run it.** At `23d9e0e60` it prints `103 files below floor (baseline 103)` and exits 0.
That is your starting state: **103, never 104.** The gate compares per-file coverage against
`scripts/baselines/coverage-per-file-baseline.json`, so a fix that changes which runtime
branch a test takes can breach it while every other gate stays green — see §5 trap 3, where
exactly that happened and only CI caught it.

**Never** run `check:test-escape-hatches:update`. If a counter rises, your fix is wrong.
**Never** run `test:coverage:update`. A typing fix has no business moving a coverage floor;
if it does, the fix changed behaviour and is wrong.

`bun run test` excludes `test/e2e/` by design (`scripts/run-tests.ts` PHASES). CI runs
`bun run test:e2e` separately. You are not expected to run it per commit — but if you touch
anything under `test/e2e/`, run it before you push.

**Pre-existing failures are not yours.** If the full suite is already red on an untouched
file before your edit, record it and continue; do not fix unrelated tests inside a typing
commit. If you cannot tell whether it pre-existed, stash your change and re-run.

---

## 5. Traps — the first two were verified on this commit

**1. `cli-plugins.test.ts` has FIVE optimizer stubs and only FOUR are typechecked.** The fifth
lives at lines 39–44 inside the `extensionsCode` template string that `writePluginFile` writes
to disk as a real plugin. `grep -n 'estimatedTokens' test/integration/cli/cli-plugins.test.ts`
returns 5 hits; tsc reports 4 blocks. Fixing only the typed ones leaves the written plugin
silently diverged, and the file's own tests exercise it. This is the same trap that
`config-resolution.test.ts` sprang in §26 — **count constructs, not diagnostics.**

**2. `test/unit/cli/plan.test.ts` (5 errors) is grandfathered in
`scripts/baselines/file-sizes-baseline.json` at 1202 lines.** A fix there must be
line-neutral or shrinking. It is the only Lane A file in that baseline.

**3. The coverage gate is `bun run test:coverage` and it is NOT in `check:all`.** In §27, changing a bogus
`lintOutputFormat: "eslint"` to `"text"` typechecked, passed the suite, passed all 25 gates —
and dropped a grandfathered `src` file below its coverage baseline, caught only by CI. If your
fix changes which runtime branch a test takes, you have changed coverage. `src/cli/status-cost.ts`
sits at 0.1765 in that baseline and **`unit/cli/status-cost` is Batch 1 item 2** — the safest
fix there is one that changes types only, never a fixture value.

**4. Removing a wholesale rejection reveals field-level errors underneath.** A file can get
worse for one step. Judge on the final number with `worse: 0`.

**5. Never regex over a nested object literal**, and **print the region you just edited** — a
scripted replacement once dropped a `return base;` and left unreachable code that no gate
catches.

**6. A grep-based negative is not proof.** `\b` fails on a quoted key; substrings over-match
(`getAll` hits `getAllAgents`); "no fixture supplies X" does not mean X is untested.

---

## 6. When to stop and escalate

Stop and write it up in `STATUS-1514-drain.md` the moment you find yourself:

- inventing a value to satisfy a required field,
- widening a `src/` type to fit a fixture,
- adding a cast to make an error go away,
- editing `test/helpers/` or `src/`,
- or arguing that a test is wrong.

**Every escalation on this branch turned out to be a real defect worth more than the errors it
was blocking.** Escalating is the high-value move here, not the fallback.

---

## 7. Definition of done, and what to report

Per commit, all of these, no exceptions:

- `bun run typecheck` prints nothing (src **and** contracts),
- `bun run check:all` green,
- `bun run test` green,
- **`bun run test:coverage` green — still `103 files below floor`, exit 0**,
- per-file typecheck gate `worse: 0`,
- `check:test-typecheck` baseline **lower**,
- `check:test-as-unknown-as` **equal or lower**,
- all six escape-hatch counters (`asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`,
  `anyType`, `looseCast`) **equal or lower**.

No commit may trade one counter against another. A typecheck drop paired with an `anyType`
rise is a failed commit, not a partial success. Only one baseline may ever be updated:
`check:test-typecheck:update`, in the same commit as the fix.

Report per file, in `STATUS-1514-drain.md`, in this shape:

- the count before → after, and the file count,
- **whether the cause column in §2 was right** — say so plainly when it was not,
- what the fix unmasked,
- any construct you found that tsc could not see.

Commit convention: conventional commits, `test:` type, one file per commit, and a
**descriptive** tag rather than a numbered phase — `#1514 phase 3a` already means two
different things in this repo's history (`PROPOSAL-1514-phase2-typecheck-drain.md`). Example:

```
test: drain session-manager-runtime adapter stubs (#1514 lane-a) — 692→677
```

Realistic landing point if all of Batch 1 goes: **692 → ~610**. Batch 1 + Batch 2: **~546**.

Branch: **`chore/1514-lane-a-drain`**, created from `main` @ `23d9e0e60`.
