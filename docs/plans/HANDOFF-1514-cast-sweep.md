# Handoff: sweeping the `as unknown as` casts out of `test/`

Self-contained. You do not need to read the plan doc, the issue, or any commit.

**Branch:** `chore/1514-test-debt-drain`. **Start:** 681 casts, 1969 typecheck errors.

Every design decision is already made. Your job is repetition: replace a cast with a
factory call that already exists, verify, commit. If you find yourself designing a
type, stop — see *Escalate*.

---

## 1. The loop

Work one **cluster** at a time (a cluster = one row of the queue in §3). Inside a
cluster, work one file at a time.

```bash
# what this cluster looks like
grep -rn "as unknown as <TARGET>" --include='*.ts' test

# after editing each file
bun x biome check --write test/
bun test <the file you changed> --timeout=60000
```

Per commit (a cluster, or 5–15 files of one), **all five, in this order**:

```bash
# 1. typecheck count must not rise. Record it before you start.
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c 'error TS'

# 2. no single file may be worse than its baseline
bun -e '
const b=require("./scripts/baselines/test-typecheck-baseline.json").byFile;
const out=require("child_process").execSync("bun x tsc --project tsconfig.test.json --noEmit 2>&1 || true",{encoding:"utf8",maxBuffer:1e8});
const cur={};for(const l of out.split("\n")){const m=l.match(/^([^(]+)\(\d+,\d+\): error TS/);if(m)cur[m[1]]=(cur[m[1]]||0)+1;}
const worse=Object.keys(cur).filter(f=>cur[f]>(b[f]??0));
console.log("total:",Object.values(cur).reduce((a,x)=>a+x,0),"| worse:",worse.length);
worse.forEach(f=>console.log("  ",f,(b[f]??0),"->",cur[f]));'

# 3. every gate green — BEFORE any baseline update
bun run check:all

# 4. full suite green (~40s)
bun run test

# 5. only now, lower the baselines
bun run check:test-as-unknown-as:update
bun run check:test-escape-hatches:update
bun run check:test-typecheck:update
git diff scripts/baselines/   # every number must have gone DOWN or stayed equal
```

Commit as `test(<area>): <what> (#1514 phase 1a)` with a body line
`casts: N -> M, typecheck: P -> Q`.

**Never run `--update-baseline` before `check:all` is green.** It writes whatever it
finds, a regression included.

---

## 2. Three traps that will bite you

**A typecheck count that drops implausibly far means the tree stopped compiling.**
tsc aborts on the first parse error and reports one error total. If step 1 above
prints something like `1` or `3`, you broke the syntax — do not celebrate, do not
update a baseline. Run `bun x tsc --noEmit -p tsconfig.test.json | head -3` and fix
it. This has already happened twice on this branch.

**Removing a cast usually exposes a fixture that is *wrong*, not merely incomplete.**
Expect it. Real examples from this branch: nine files set `packedChunks` on a
`ContextBundle` (it is a local variable inside `rebuild.ts`, never a field);
`tool-runtime` set a `meta` field that does not exist; a `PluginRegistry` stub passed
`{ getAll, get }`, neither of which the class declares. When the compiler rejects a
field, check whether the field exists at all before trying to make it fit — usually
you delete it.

**Do not hand-edit nested object literals with a regex.** Two attempts on this branch
produced `makeContextBundle()e` and unbalanced parens. Edit them by hand, or match
braces properly.

---

## 3. The work queue

Counts are from a scan that mirrors the ratchet exactly (per match, allow-marked lines
and their neighbours skipped) and sum to its 681. They drift as you work; the rulings
do not — regenerate them with:

```bash
bun scripts/report-cast-buckets.ts
```

| Bucket | Casts (start) | Casts (current) | Δ | Who |
|:--|--:|--:|--:|:--|
| §3a Shape A — factory exists | **169** | **9** | -160 | remaining are §3d-shaped / §3e-entangled |
| §3b seam sweeps — helper exists, example committed | **157** | **5** | -152 | survivors only |
| §3c-i typed dep stubs | **23** | **1** | -22 | survivor only |
| §3c-ii dep members returning a class | 31 | **0** | -31 | **CLOSED** (§9 Task B, session 6) |
| §3d holding bucket | 61 | 29 | -32 | load-bearing |
| §3e private-member reach-ins | 49 | 49 | 0 | escalate |
| tail — everything under 4 per cluster | **191** | **58** | -133 | **drained of tractable work** |
| **Total** | **681** | **151** | **-530** | |

**Last verified:** ratchet = 151, typecheck errors = 1946 (was 1969; **−23**), per-file
gate `worse: 0`, tree clean at `f3d7a4646`. 46 commits on the branch.

**§10 is DONE (session 7).** Every bucket with mechanical follow-through is now closed.
What remains needs a ruling from the repo owner — see §8.

**→ §9 and §10 are both DONE. There is no queued task.** Read §8 for the remaining
decisions, and §Patterns learned before touching anything.
**§9 is DONE (session 6) — do not start it.** It is kept only as the worked record of
how the seams were built.

**The unassisted mechanical work is finished.** Sessions 1–2 drained 3a/3b/3c-i;
session 3 drained the tail; session 4 drained the §3d bakeoff builders; sessions 5–6
built four seams and closed **§3c-ii entirely**. Remaining: tail remnant 63, §3e 49,
§3d 30, §3a remnant 17, §3b/§3c-i survivors 6.

**§10 is the one remaining bucket with mechanical follow-through.** Everything else needs
a ruling from the repo owner first.

**Do not dispatch another sweep agent against this doc.** There is no factory-swap
cluster left. The next step is one of the design decisions in §8, not more repetition.

### 3a. Shape A — a factory already returns this exact type

Replace `{ …literal… } as unknown as T` with `makeX({ …literal… })`, importing from
`@test/helpers`. Nothing else changes.

| Cast target | Casts (start) | Casts (now) | Files | Replace with | Status |
|:--|--:|--:|--:|:--|:--|
| `ReturnType<typeof …getSafeLogger/getLogger>` ×4 spellings | 27 | **0** | ~15 | `makeLogger()` | done (`8a42ec6f5`, `932896694`) |
| `NaxConfig` | 48 | **4** | 25 | `makeNaxConfig(…)` | done except design-call sites |
| `PipelineContext` | 25 | **4** | 22 | `makeTestContext(…)` + `Object.assign` for extras | done except design-call sites |
| `PRD` | 16 | **0** | 15 | `makePRD(…)` | done (incl. integration helpers) |
| `Partial<NaxConfig>` | 11 | **8** | 5 | `makeNaxConfig(…)` | remaining are allow-marked BUG-06 edge cases + deliberate `undefined` negative tests |
| `UserStory` | 10 | **0** | 10 | `makeStory(…)` | done (`3d05b2872`) |
| `CallContext` | 9 | **0** | 4 | `makeMockCallContext(…)` | done (`1046db345`) |
| `PipelineContext["config"]` | 7 | **2** | 6 | `makeNaxConfig(…)` | done except legacy-key fixtures (tracker-provider-cost, stage-assembler-scope-files) |
| `NaxRuntime` | 6 | **0** | 6 | `makeMockRuntime(…)` | done (`1046db345`) |
| `import("@/agents").IAgentManager` | 5 | **3** | — | `makeMockAgentManager()` | remaining 3 are deliberate `undefined as unknown as IAgentManager` negative tests |
| `Parameters<typeof preIterationTierCheck>[0]/[2]/[3]` | 12 | **0** | 1 | `makeStory` / `makeNaxConfig` / `makePRD` | done (`333882475`) |
| `import("@/prd/types").PRD`, `import("@/runtime").NaxRuntime`, `import("@/config").NaxConfig`, `PluginRegistry` | 5 | **1** | — | factories | remaining 2 PRD casts in deferred-review.test.ts need fixture tightening (design) |

The four `getSafeLogger` / `getLogger` spellings all resolve to `Logger`, which
`makeLogger()` returns since commit `ef0b154e0`. They looked like four clusters and
were one.

Several `PipelineContext` sites were a *local* `makeCtx()` casting on the way out;
those locals are gone.

**§3a skipped sites (escalate — design call needed):**

- `test/unit/config/selector.test.ts` (4 `NaxConfig` casts) — same file has §3e
  private-member reach-ins that read `c.execution.parallel` after the cast was masking
  an obsolete `parallel` field. Removing the NaxConfig cast breaks the §3e assertion.
  The test is exercising `makeSparseNaxConfig({...parallel})` and reading parallel via
  `as unknown as { execution: { parallel: boolean } }`. Removing parallel changes test
  semantics (toEqual would need toEqual-like → toMatchObject, against "Nothing else
  changes"). Leave both NaxConfig and §3e casts together; needs design.
- `test/unit/acceptance/hardening.test.ts` line 517 — has `// test-ratchet-allow`.
- `test/unit/cli/config-display.test.ts` line 39 — has `// test-ratchet-allow`.
- `test/unit/context/engine/stage-assembler*.test.ts` (3 files) — fixtures use legacy
  `autoMode.defaultAgent` + partial PRD/story that the cast was hiding. Removing
  cast surfaces many required fields. Either delete `defaultAgent` and fill PRD/story
  properly, or refactor the test to read via the public API. Design call.
- `test/unit/metrics/tracker-provider-cost.test.ts` — fixture has `autoMode.defaultAgent`
  and partial PRD. Same shape.
- `test/unit/execution/deferred-review.test.ts` (2 inline `import("@/prd/types").PRD`)
  — partial PRD `{ feature, userStories: [] }`. Switching to `makePRD({...})` would
  surface missing fields. Tighten fixture or design.
- `test/integration/execution/deferred-review-integration.test.ts` — fixture uses
  `pluginMode: "deferred"` which was REMOVED from the schema in ADR-012 Phase 6.
  Removing the cast surfaces the obsolete key. Needs a redesign of the test (or
  restoring the option). Cannot be a mechanical edit.
- `test/integration/acceptance/red-green-cycle.test.ts` — has `as PipelineContext["hooks"]`
  and `as PipelineContext["config"]` (different cluster, see PipelineContext["config"]
  table). §3a PRD casts at lines 191, 233 use `makePrd(completedStories) as unknown as PRD`
  — local `makePrd` could be replaced with `makePRD`.
- `test/integration/execution/_parallel-metrics-helpers.ts`, `parallel-batch-results.test.ts`,
  `parallel-batch-rectification.test.ts` — PRD casts, all use `{ userStories: [...] }` as
  unknown pattern. Switching to `makePRD({ userStories: [...] })` straightforward.
- `test/unit/config/merge-agent-models-routing.test.ts` — 3 of 5 `Partial<NaxConfig>`
  casts remain (lines 89, 140, 185), all with `// test-ratchet-allow: as-unknown-as`
  comments because they test `agent: null` / `routing: null` edge cases (BUG-06).
  Leave alone — these are reviewed exceptions.

### 3b. Seam sweeps — helper exists, one file done as a worked example

Swept: **157 → 5** (session 2, commits `151b23d2f`, `9460a487e`, `0d58e943e`). The
survivors are wedged-stream / hang-path sites whose hand-built streams cannot be
expressed by `FakeProcSpec` (never-closing stdout + custom `kill()`), or sit next to
a `// test-ratchet-allow` line. Leave them.

| Cast target | Casts (start) | Casts (now) | Helper | Status |
|:--|--:|--:|:--|:--|
| `typeof Bun.spawn` | 39 | **0** | `makeSpawn().spawn` | done |
| `typeof _gitDeps.spawn` | 36 | **1** | `makeSpawn().spawn` | survivor allow-marked (`git-capture-diff-summary`) |
| `typeof _diffUtilsDeps.spawn` | 26 | **1** | `makeSpawn().spawn` | survivor needs never-closing streams (`adversarial-audit-shape`) |
| `ReturnType<typeof Bun.spawn>` | 25 | **2** | `makeSpawnResult(…)` | survivors: allow-marked PERF-3 wedge tests (`pid-registry`) + `_spawnClientDeps.spawn` |
| `typeof _deferredReviewDeps.spawn` | 10 | **0** | `makeSpawn().spawn` | done |
| `Parameters<typeof handleTierEscalation>[0]` | 8 | **0** | typed `EscalationHandlerContext` literals | done (`0d58e943e`) |
| `_completionDeps/_executorDeps/_resultHandlerDeps/_isolationDeps/_reconcileDeps.spawn` | ~12 | **1** | `makeSpawn().spawn` | survivor allow-marked BUG-13 site |

Seam notes (current behaviour of `test/helpers/spawn.ts`):

- `makeSpawn().spawn` is a bun `mock()`, so `toHaveBeenCalledWith` /
  `toHaveBeenCalled` work directly on it; `stub.calls` and `lastEnv()` remain the
  structured way to assert.
- Wedged-stream fixtures that still need custom streams use
  `Object.defineProperty(proc, "stdout"|"stderr"|"exited"|"kill", …)` on a
  `makeSpawnResult()` proc returned from the handler — see
  `quality/runner.test.ts` (timeout flow), `review/runner.test.ts` (BUG-1),
  `completion-skip-persistence.test.ts` (pull-based stderr).

### 3c. `_xDeps.<member>` — two kinds, and only one is yours

I tested the obvious rule ("declare the stub with the slot's type so the compiler
forces it to conform") on a real site and **it does not work for half of these**, so
check which kind you have before touching anything.

**3c-i — plain function or value members. Yours. Done: 23 → 4.**

`_planDeps.createRuntime` (11) and `_regressionDeps.parseTestOutput` (2) were
converted in `1a7f807a5`; logger members went with the makeLogger sweep. The 4 the
classifier still counts as 3c-i are `worktreeManager` ×2 (actually a class return —
reclassify as 3c-ii) plus 2 allow-neighbours.

Declare the stub with the dep's own type instead of casting into the slot:

```ts
// before
_queueLockDeps.readdir = mock(async () => []) as unknown as typeof _queueLockDeps.readdir;

// after
const readdir: typeof _queueLockDeps.readdir = async () => [];
_queueLockDeps.readdir = readdir;
```

| Cast target | Casts | Files | Note |
|:--|--:|--:|:--|
| `typeof _planDeps.createRuntime` | 11 | 2 | returns `NaxRuntime` — build it with `makeMockRuntime()` inside the typed stub |
| `typeof _queueLockDeps.readdir` and other one-off `_xDeps` members | ~12 | — | |

**3c-ii — members that return a class. NOT yours. Escalate. 31 casts.**

| Cast target | Casts | Returns | Why it is blocked |
|:--|--:|:--|:--|
| `typeof _semanticDeps.createDebateRunner` | 13 | `DebateRunner` | class with private fields |
| `typeof _resultHandlerDeps.mergeEngine` | 7 | `MergeEngine` | class |
| `ReturnType<typeof _contextStageDeps.createOrchestrator>` | 6 | `ContextOrchestrator` | class |
| `ReturnType<typeof _acpAdapterDeps.createClient>` | 6 | ACP client | class-shaped |

A class with private fields cannot be satisfied by an object literal, so declaring the
stub does not fix the cast — it converts one cast into several type errors and, in the
case I tried, a failing test. These need a `makeX` seam with the cast contained inside
it, the same shape as `makeLogger` / `makeStatusWriter` / `makePluginRegistry`.
Building those is a design call. **Leave them and report.**

Rule of thumb: `grep -rn "export class <ReturnedType>" src/`. If it is a class, it is
3c-ii.

### 3d. Holding bucket — bakeoff builders done, 30 load-bearing left

The bakeoff deps bags were drained in session 4 (`ffc423b4e`, `64d1c823e`, `5be8fb7a3`).
What remains is load-bearing: negative tests, `DEFAULT_CONFIG` spread-widening, and
allow-marked lines.

| Cast target | Casts | Why |
|:--|--:|:--|
| `Record<string, unknown>` | 20 | Deliberate negative tests (`"not-an-object"`) and `DEFAULT_CONFIG` spread-widening |
| `as unknown as string` / `string[]` | 9 | Deliberate negative tests — `42 as unknown as string`, `undefined as unknown as string`. Feeding a wrong type on purpose is the assertion |
| ~~`BakeoffCoordinatorDeps[…]`, `BakeoffCliDeps[…]`, `ContestantRunnerDeps[…]`~~ | ~~31~~ **0** | **DONE (session 4).** No builder was needed in the end — see §Patterns learned item 12. The casts were pure noise: the mocks and the `FakeWorktreeManager` were already structurally assignable to their dep slots |
| anything carrying `// test-ratchet-allow: as-unknown-as` | 116 | Reviewed and accepted. Do not touch |

### 3e. Not classified — do not start here

49 casts target an **inline object literal type** to reach a non-public member:

```ts
const backoffMs = (plugin as unknown as { backoffMs: number }).backoffMs;
```

Concentrated in `test/unit/interaction/interaction-network-failures.test.ts` and
`test/integration/operations/complete-empty-output-retry.test.ts`. Fixing these means
deciding whether the member should be public, or whether the test should go through
the public API — a design call. Escalate rather than guess.

### The tail — DRAINED (191 → 63, session 3)

**Nothing here is actionable without a design call any more.** All 63 survivors are
listed in §8. The method below is kept because it is how the 128 were resolved, and it
is the right habit if a new cast ever lands in `test/`.

Apply §3a's habit:

1. What type is this really? Resolve `T["field"]`, `Parameters<typeof f>[n]`,
   `ReturnType<typeof f>` first.
2. `grep -rn "): <Type>" test/helpers/` — does a factory already return it?
3. If yes, it is Shape A. If the type is a **class**, it is 3c-ii — escalate.
4. If it is a plain interface with no factory and fewer than ~5 sites, write the
   literal out in full rather than adding a helper. A one-file fixture does not earn
   a shared factory.

Roughly 30 of the 191 are a measurement artifact — long or nested generics
(`RunOperation<…>`, `Pick<typeof DEFAULT_CONFIG, …>`) that the classifier could not
parse into a cluster. Treat them individually.

Two named callouts — **both resolved in session 3**, kept for the technique:

- **`FixCycle<Finding>` (12), `FixCycleContext` (4), `Finding` / `Finding[]` (9)** —
  done in `4f8252e2a`. Was **not** a factory problem: the capture variable was already
  declared `let capturedCycle: FixCycle<Finding> | null = null`. See the
  closure-narrowing trap in §Patterns learned item 7 — the obvious `if`-guard fix is
  wrong and the non-null assertion is the only correct one.
- **`DeferredRegressionOptions` (9)** — done in `aa764a4db`, resolved field by field.
  The cluster was **15 sites, not 9**: 6 more lived in `run-regression.test.ts` and
  `run-regression-attribution.test.ts`, which this doc did not name. See §Patterns
  learned item 9.

## 4. Forbidden

These lower a number without doing the work. The ratchets block most of them; the
rest are on review.

- Adding `as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- Adding `// test-ratchet-allow: as-unknown-as`.
- Replacing `as unknown as X` with `as typeof X` or any other single cast.
- Joining two cast-bearing lines into one, or reflowing code to move a count.
- Deleting, skipping, or `.skip`-ing a test; narrowing a `describe`.
- Excluding a file from `tsconfig.test.json` or adding it to any `EXEMPT_FILES`.
- Changing a type in `src/` so a test fixture fits. The fixture is wrong, not the type.
- Running `--update-baseline` on a count that grew.

---

## 5. Escalate — stop and report, do not guess

- The error says a **source** type is wrong, not the fixture.
- Fixing the type would change what the test asserts.
- A fixture change makes a *different* test fail. That test was relying on the wrong
  shape; report it rather than papering over it.
- Removing a cast reveals the mock cannot satisfy the interface at all and no factory
  covers it — that is a design call, which is not your job here.
- The same file fails twice in a row. Two attempts, then hand it back.
- Anything in **§3c-ii** (a dep member returning a class) or **§3e** (reaching a
  private member through an inline object type). Both need a design call. They are
  listed so you can recognise and skip them, not so you can attempt them.

**As of session 3 this whole document is the escalate set.** The mechanical work is
finished — see §8 for the 235 survivors grouped by the decision that unblocks each.
Class-typed blockers found in session 3 and *not* in the §3c-ii table above:
`InteractionChain` (3), `PlanModeContext` via `createDebateRunner` (2),
`createV1Provider` (1). Always confirm with `grep -rn "export class <T>" src/`.

---

## 6. Definition of done

`bun run check:all` green, `bun run test` green, all three baselines lower than when
you started, and no file worse than its per-file baseline. Report the before/after
numbers for casts and typecheck errors.

---

## 7. Progress log

### Phase 1a — session 7 (2026-08-23): §10 done, the masked-field catalogue

**163 → 151 (−12)**, typecheck **1949 → 1946**, per-file gate `worse: 0`, tree clean at
`f3d7a4646`.

- `41b9ee603` — `tracker-provider-cost.test.ts` (worked example, the ruling)
- `cc187b258` — `stage-assembler-scope-files.test.ts`, `execution-stage.test.ts`
- `236821bbf` — `context-digest.test.ts`, `context-rules-fallback.test.ts`
- `d52132410` — `deferred-review-integration.test.ts` rewrite (the product decision below)
- `f3d7a4646` — `red-green-cycle.test.ts`

**The `pluginMode` question was answered: rewrite the test, do not restore the value.**
Per-story plugin gating was removed in ADR-023 / #1146, so deferred **is** the plugin-review
timing and `review.pluginMode` selects only `gating` vs `observational`. The tests no longer
parameterise on a mode. One test — "reviewer failure does not fail the run" — now pins
`pluginMode: "observational"` **explicitly**, because it is the mode and not the deferred
timing that produces that behaviour; under `gating` the run would fail
(`run-completion.ts:76`). Left implicit, it would have silently ridden a schema default.

**What the casts were hiding — the real output of this session:**

| File | Masked defect |
|:--|:--|
| `tracker-provider-cost` | `routing: { tier }` — `RoutingResult` has **`modelTier`**; the fixture supplied `modelTier: undefined` for as long as the cast existed, and the tests passed |
| `deferred-review-integration` | the **entire `tdd` block was fictional** (`mode`, `testStrategy`, `testCommand` — none exist); `acceptance.testCommand` (it is `command`); and behind them, three **missing required** `DispatchContext` fields (`agentManager`, `sessionManager`, `abortSignal`) |
| `stage-assembler-scope-files` | `routing` missing required `complexity` / `modelTier` / `reasoning` |
| `execution-stage` | `packageView.select` had the wrong generic signature — `() => cfg` ignores the selector `PackageView.select` actually invokes; plus 4 missing `PackageView` fields |
| `context-digest` | `naxIgnoreIndex` stub had only `getMatchers()`; `NaxIgnoreIndex` also requires `repoRoot`, `filter`, `toPathspecExcludes` |
| `context-rules-fallback` | `makeCtx` hand-built the whole context with per-field casts (`rootConfig: {}`, `prd: {userStories:[]}`, `hooks: {}`, `routing: {}`) — **none satisfied its real type**; the casts bypassed the checker entirely |
| `red-green-cycle` | the `hooks` and `PRD` casts were pure noise (item 12); `ctx as Record<string, unknown>` was reaching `acceptanceSetup.redFailCount`, a real optional field |

Several of these tests were asserting against fixtures that did not resemble the types they
claimed to be, and passing. **That is the argument for this whole issue**, and it is worth
more than the −530 on the counter.

**Process failure worth not repeating:** this session ran an agent on §10 while editing
`deferred-review-integration.test.ts` itself, in the same working directory. See
§Patterns learned item 13. Use `isolation: "worktree"` or serialise.


### Phase 1a/1b — session 5 (2026-08-23): first seam built, `DeepPartial` bug found

**204 → 191 (−13)**, typecheck flat at 1961, per-file gate `worse: 0`, tree clean at
`42117eb0f`.

- `8a2e0c2f4` — `makeDebateRunner` seam + one worked example. **Net-zero on the count by
  design**: the helper adds the one contained cast while the converted site removes one.
- `42117eb0f` — the remaining 13 sites (12 in `semantic-debate.test.ts`, 1 in
  `fidelity-survives-recovery.test.ts`).

**The seam design that made it work.** The dep slot is
`(opts: DebateRunnerOptions) => DebateRunner`, and a zero-arg `mock()` is assignable to it
under function contravariance — so `mock(() => makeDebateRunner({ run }))` needs no cast
*and* keeps the outer bun mock assertable. A helper that returned the runner directly, or
one whose `const` was annotated with the dep-slot type, would have broken the existing
`toHaveBeenCalled()` assertions (§Patterns item 12).

**Two corrections to this doc, both found by verification rather than assumption:**
- `fidelity-survives-recovery.test.ts:104` was `createDebateRunner`-downstream as recorded,
  but needed **no seam call** — the inner fields were already typed and the outer cast was
  noise (§Patterns item 12 again).
- `:164` is **not** a debate-runner cast at all. It is a `DeepPartial` problem → §9 Task A.

**`makeNaxConfig`'s `DeepPartial` is buggy for optional nested config.** Root-caused,
fixed, measured, and then **reverted** — the one-line fix takes the total 1961 → 1958 but
leaves 8 files worse than baseline, which §6 forbids. The fix and the 8 fixture repairs
must land together. Fully specified as **§9 Task A**, including the exact patch and the
file list. This also upgrades §Patterns item 2 from a workaround to a known root cause.

**Also corrected:** `AcpClient` is an `interface`, not a class — this doc had it in the
§3c-ii "class-shaped" table. Its 6 casts may need no seam at all. See §9 Task B.


### Phase 1a — session 4 (2026-08-23): §3d bakeoff builders, 3 commits

The last cluster needing no design call. **235 → 204 (−31)**, typecheck flat at 1961,
per-file gate `worse: 0`, tree clean at `5be8fb7a3`.

- `ffc423b4e` — `ContestantRunnerDeps.worktreeManager` (4). `FakeWorktreeManager` was
  already structurally compatible — an interface, not a class. No fixture change needed.
- `64d1c823e` — `BakeoffCliDeps` spy stubs (12).
- `5be8fb7a3` — `BakeoffCoordinatorDeps` stubs (15).

**No escalations.** No dep member in the three files returns a class — confirmed with
`grep -rn "export class" src/bakeoff/`.

**The prescribed fix was wrong, in a useful way.** §8 Decision 5 specified "a typed
builder local to each file". No builder was needed: all 31 casts were unnecessary from
the start, because `mock()` spies and interface-shaped stubs are already structurally
assignable to plain-function dep slots. Recorded as §Patterns learned item 12, which also
covers the one place an annotation actively hurts (annotating the *variable* erases the
`Mock<T>` shape and breaks later `.mock.calls` assertions — annotate at the object-literal
property instead).

**One real defect surfaced**, not a masking artifact: in `coordinator.test.ts` the AC3
test's `runContestantSpy` declared its second parameter as an ad-hoc `{ feature: string }`
rather than the real `ContestantOptions`, whose `feature` is optional — a genuine
contravariance violation. Fixed by typing the parameter properly and reading
`opts.feature ?? ""`.

**Counting note:** the 28-vs-31 gap did not resolve as predicted. Raw grep and the
ratchet's `byFile` both said 31 with zero allow-markers in these files; this doc's 28 was
simply stale drift. See §Patterns learned item 10.


### Phase 1a — session 3 (2026-08-23): the tail drained, 18 commits

Two agents, dispatched in sequence (the first was wound down for context, not failure;
it committed its in-flight cluster and handed off).

**Agent 1 — the five pre-triaged clusters plus five more (346 → 265, −81, 7 commits):**
`4f8252e2a` FixCycle/Finding closure-narrowing · `413495737` LoadedHooksConfig /
DiagnosisResult / AgentGetFn · `aa764a4db` DeferredRegressionOptions field-by-field ·
`8b422e02c` InternalBuildState / RunOperation / PluginLogger · `c3ee52e2b` Logger and
UserStory `ReturnType` casts the session-2 sweep missed · `5ad991b89`
SequentialExecutionContext runtime via `makeTestRuntime` · `3e8cbfd67` ISessionManager /
RunOperation.

**Agent 2 — the unenumerated remainder (265 → 235, −30, 11 commits):**
`fddecf2fc` `mock<typeof console.log>()` · `5d58df1ba` PidRegistry real-instance
mutation · `77879e4ae` RunnerCompletionOptions.runtime · `5b077f75a`
RectificationOverrides typed directly · `31ff6f07b` `Omit<PipelineContext,…>` via
`makeTestContext` · `64b8dab0f` FixStrategy satisfied structurally · `cffd9ea30`
startHeartbeat / AbortSignal · `72efb9c48` logger / HopBodyContext params ·
`8afd3485d` PlanConfig via selector + full SessionDescriptor · `8c9ccee72` AgentGetFn /
require / hooks / AnyOp · `4bf6081da` `makeStatusWriter` class stub + full
DispatchContext.

**Totals (session 3):**
- casts: 346 → **235** (−111)
- typecheck errors in `test/`: 1963 → **1961** (−2)
- per-file baselines: **0 files rose**; baseline total 1963 → 1961
- tail bucket: 172 → **63**, and the 63 are all design calls (§8)

**Verification note.** New implicit-`any` (TS7006) diagnostics appeared in touched files
and were checked: not a regression. No file's typecheck baseline rose, the per-file gate
reports `worse: 0`, and the baseline total fell. They sit inside pre-existing per-file
allowances. The accompanying `Cannot find module '@/…'` diagnostics are IDE path-alias
noise, not `tsconfig.test.json` failures.

**Five new traps** were recorded as §Patterns learned items 7–11. Item 7 (the
closure-narrowing `never` trap) and item 8 (error-suppression masking a missing required
field) are the two that cost real time — read them before touching `test/` again.


### Phase 1a — session 2 (2026-08-23): §3a/§3b/§3c-i no-judgement queues drained

**Commits (this session, on top of session 1's 8):**
1. `3d05b2872` — `test(story-fixtures)`: use `makeStory` (12 UserStory sites; `"completed"` status → `"passed"`, never read by src)
2. `1046db345` — `test(plan,execution,pipeline)`: `makeMockCallContext` / `makeMockRuntime` / `makeNaxConfig`
3. `8a42ec6f5` — `test(logger)`: `makeLogger` for all 34 getLogger/getSafeLogger cast sites
4. `333882475` — `test(escalation,operations,cleanup)`: `makeMockAgentManager`, `makePluginRegistry`, typed tier-check params
5. `151b23d2f` — `test(spawn)`: `makeSpawn` seam for all non-allow-marked `typeof Bun.spawn` / `ReturnType<typeof Bun.spawn>` casts
6. `9460a487e` — `test(git-diff-spawn)`: `makeSpawn` for `_gitDeps.spawn` + `_diffUtilsDeps.spawn` (~60 sites)
7. `0d58e943e` — `test(escalation,completion,executor)`: remaining `_xDeps.spawn` seams + fully-typed `EscalationHandlerContext` fixtures
8. `1a7f807a5` — `test(plan-decompose,regression)`: typed `createRuntime` / `parseTestOutput` dep stubs
9. `932896694` — `test(logger)`: last logger-member casts (`_optimizerDeps`, `_debateSessionDeps`, `_gitDeps.getSafeLogger`)

**Totals (branch start → now):**
- `as unknown as` casts: 681 → **346** (−335; ratchet scan)
- typecheck errors in `test/`: 1969 → **1963** (−6)
- Buckets now: 3a=24 (all design-call), 3b=5 (allow-marked / wedged-stream), 3c-i=4
  (`worktreeManager` ×2 — actually class-typed, reclassify as 3c-ii; plus 2 allow-neighbours),
  3c-ii=31, 3d=61, 3e=49, tail=172.

**What remains is exactly the escalate/leave-alone set plus the tail.** No
factory-swap cluster is left untouched.

**Seam changes made this session (both in `test/helpers/spawn.ts`):**
- `makeSpawn().spawn` is now a bun `mock()` — `toHaveBeenCalledWith` /
  `toHaveBeenCalled` work directly on it, and `stub.calls` stays authoritative.
- Worked examples: `quality/runner.test.ts` (timeout flow via
  `Object.defineProperty(proc, "exited", …)`), `review/runner.test.ts` BUG-1 site,
  `completion-skip-persistence.test.ts` (pull-based stderr),
  `pid-registry.test.ts` (per-command routing).

**New blockers discovered (added to §5 list):**
- `test/unit/review/semantic-debate.test.ts` (12 `createDebateRunner` casts) and
  `pipeline-result-handler.test.ts` (7 `mergeEngine`) — confirmed 3c-ii: stubs
  return bare objects standing in for classes with private state.
- `iteration-runner-worktree.test.ts` spreads a real `WorktreeManager` then
  overrides 2 methods — needs a `makeWorktreeManager` seam or an interface; design.
- `tier-escalation.test.ts` cross-agent blocks put `agent` on `ctx.routing`;
  `EscalationHandlerContext.routing` has no `agent` field (handler reads
  `story.routing?.agent`). Fixed by dropping it from ctx.routing — safe because
  nothing reads `ctx.routing.agent`.

### Phase 1a — committed (7 commits, branch `chore/1514-test-debt-drain`)

**Commits:**
1. `195253fd5` — `test(bakeoff,interaction,precheck)`: use `makeNaxConfig`
2. `2067803f7` — `test(context,pipeline,cli)`: use `makeNaxConfig`
3. `bac6ae931` — `test(debate,integration)`: use `makeNaxConfig` + `makePlanDebateConfig` helper
4. `224197902` — `test(metrics,pipeline)`: use `makeTestContext` + `Object.assign` for extras
5. `fdd075f89` — `test(prd,plan,debate)`: use `makePRD`
6. `d0e600fe6` — `test(baselines)`: update ratchets
7. `c8a735cec` — `test(config)`: use `makeNaxConfig` for `Partial<NaxConfig>`
8. `fbd38fdf4` — `test(acceptance,review)`: use `makeNaxConfig` (hardening + semantic-debate)

**Totals so far (session 1):**
- `as unknown as` casts: 681 → 606 (−75)
- typecheck errors in `test/`: 1969 → 1967 (−2; net negative because removed bogus
  fields the cast was masking — `autoMode.defaultAgent` migration, `parallel` on
  `ExecutionConfig`, `enabled` on `InteractionConfig`, bogus `pluginMode: "deferred"`
  still deferred, etc.)
- Files touched: 49 test files + 4 baseline files

### Patterns learned (write these down so the next session doesn't relearn)

1. **`makeTestContext` + `Object.assign`** is the workhorse for PipelineContext:
   ```ts
   return Object.assign(
     makeTestContext({ config, prd, story, ...required fields }),
     { agentResult, runtime, verifyResult, ...test-only fields },
     overrides,
   );
   ```
   `as Partial<PipelineContext>` triggers TS2352 when extras are present; `Object.assign`
   avoids the cast entirely.

2. **DeepPartial inference breaks for nested objects** when you spread a typed value
   back into the override object. `makeTestContext({ ...TEST_CONFIG, debate: {...} })`
   fails because `debate: {enabled, agents, maxConcurrentDebaters}` is checked against
   `DebateConfig` (strict) instead of `DeepPartial<DebateConfig>`. Workaround: don't
   spread — either omit TEST_CONFIG entirely or use a local helper like
   `makePlanDebateConfig(agents)` that wraps the literal directly.

3. **`config: {} as unknown as NaxConfig`** at the bottom of a literal → use
   `makeNaxConfig()` (empty). Doesn't deep-merge anything weird, just returns
   `DEFAULT_CONFIG`.

4. **`{ …, …overrides } as unknown as T`** → `Object.assign(makeX(...), extras, overrides)`
   for cases where overrides and extras both exist.

5. **Pre-migration keys to delete on sight** (these were masked by the cast):
   - `autoMode.defaultAgent` → migrated to `agent.default`
   - `autoMode.fallbackOrder` → migrated to `agent.fallback.map` + `enabled`
   - `context.v2.fallback` → migrated to `agent.fallback`
   - `tierOrder: ["fast", ...]` → migrated to `tierOrder: [{tier: "fast", attempts: 1}, ...]`
   - `parallel` on `ExecutionConfig` — never existed, removed
   - `enabled` on `InteractionConfig` — never existed, removed (interaction is enabled
     via `defaults.fallback` etc.)
   - `pluginMode: "per-story" | "deferred"` — schema migrated to `"gating" | "observational"`
     in ADR-012 Phase 6; the old values are rejected with a migration pointer.
     Tests using them (deferred-review-integration.test.ts) need a redesign.

6. **Deep merge and reference equality**: `makeNaxConfig` returns a deep-merged object,
   not the same reference as `root`. Tests asserting `result.models === root.models`
   break when an override has no `models` field. Don't migrate those — keep the
   partial cast.

7. **The closure-narrowing `never` trap (session 3 — cost two attempts).**
   `let x: T | null = null` assigned only inside a callback passed to `mock(...)`:
   TS narrows `x` to the literal `null` for the rest of the enclosing function,
   *regardless of intervening `await`s*. An `if (x === null) throw` guard then yields
   **`never`, not `T`** — TS excludes `null` from the narrowed-to-`null` type, not from
   the declared union. It compiles silently while the value is only returned (`never`
   is assignable anywhere) and blows up the moment you call a method on it.
   ```ts
   let captured: FixCycle<Finding> | null = null;
   deps.run = mock(async (cycle) => { captured = cycle; });
   await subject();
   // ✅ correct — reads the DECLARED annotation
   const findings = captured!.findings;
   // ❌ wrong — `captured` is `never` here, fails on first member access
   if (captured === null) throw new Error("not captured");
   ```
   The non-null assertion is the fix. The `if`-guard looks more idiomatic and is wrong.
   Verified with an isolated `tsc --strict` repro.

8. **A type error on one field suppresses the missing-required-property check for the
   whole literal (session 3).** If an object literal already has one field erroring
   (e.g. an excess property like `PluginRegistry`'s `getAll`), TypeScript does *not*
   also report the literal's missing required fields. So a file can look clean after
   you remove one nested cast while a required field (`agentManager`, `sessionManager`,
   `abortSignal` on `DispatchContext`) stays silently missing, masked until the other
   error is separately fixed. **"No new error" is not evidence.** Only the per-file
   baseline diff is — always run §1 step 2.

9. **A named-file cluster usually spreads beyond the file named.** Always
   `grep -rn "as unknown as <Type>"` across all of `test/` before starting a cluster
   this doc names, not just the file it calls out. `DeferredRegressionOptions` was
   documented as one file and had 6 more sites in two siblings.

10. **Do not trust a "done" row in this doc; re-grep.** The session-2 logger sweep was
    recorded as 27 → 0 but had missed `_canonicalLoaderDeps.getLogger`,
    `_orchestratorDeps.getLogger`, `_tierEscalationDeps.getSafeLogger`, and
    `PlanModeContext["deps"]["getLogger"]` — all satisfied directly by `makeLogger()`,
    all swept in `c3ee52e2b`. Bucket counts also drift on their own (3a moved 24 → 22
    with no edit touching that bucket), so diff the actual grep output, never the
    bucket delta.

11. **Typed spread sources pin optional-field types even when the field is unset.**
    Spreading a `const x: RunOperation<I, O1, C> = {...}` into a literal typed
    `RunOperation<I, O2, C>` fails on any optional field (e.g. `verify`) that `x`'s
    declared generic parameterizes — even though it is `undefined` at runtime. Fix:
    don't spread the *typed* const. Spread an **untyped** object carrying only the
    fields you need copied, so it brings no conflicting optional-field type.

13. **NEVER run two agents against the same working directory (session 7 — near miss).**
    A session and a delegated agent both edited `test/` in the same non-worktree checkout.
    The agent ran `git stash` / `git stash pop` to isolate a diff at the moment the other
    process was committing, and separately read a transient "worse" typecheck result off a
    file the other process had mid-edit. Nothing was lost this time — that was luck, not
    design. `git stash` is repo-global: it would have swept the other process's uncommitted
    work. If work must overlap, give each agent its own git worktree (the Agent tool's
    `isolation: "worktree"`), or serialise. A narrowly-staged `git add <path>` commit is a
    partial mitigation, not a fix.

14. **A "wrong field" in a fixture is often a whole fictional section (session 7).**
    `deferred-review-integration.test.ts` carried a `tdd: { mode, testStrategy, testCommand }`
    block in which **not one of the three fields exists** on `TddConfig` (it has `strategy`,
    with entirely different values). Same file: `acceptance.testCommand` (it is `command`).
    Do not translate field-by-field on reflex — check whether the whole block was ever read,
    and delete it if not. And expect §Patterns item 8 to cascade: each deleted bogus field
    revealed the next, four rounds before that file went clean, ending in three **missing
    required** fields that had been invisible the whole time.

12. **Annotate at the point of use, never at the declaration — and check whether the
    cast was needed at all (session 4).** All 31 bakeoff casts turned out to be pure
    noise: a `mock()` spy assigned to a plain-function dep slot, and an interface-shaped
    stub object, are *already* structurally assignable. TypeScript's contravariant
    function-assignability accepts a fewer-parameter mock without help. Before designing
    a builder, try simply deleting the cast.

    Where a type IS needed, put it on the object-literal property, not the variable:
    ```ts
    // ❌ breaks later `.mock.calls` / `.mock.results` — erases the Mock<T> shape
    const runBakeoff: BakeoffCliDeps["runBakeoff"] = mock(async () => {});
    // ✅ leave the const inferred; the literal site does the checking
    const runBakeoff = mock(async () => {});
    const deps: BakeoffCliDeps = { runBakeoff, ... };
    ```
    This is why §8 Decision 5's prescribed "typed builder per file" was not what the work
    actually needed. **The doc specified a fix; the code needed a smaller one.**

### Open §3a sites (escalate, 24 casts — all design-call)

Everything "no judgement required" from this list is done. What remains is exactly
the design-call set:

- `test/unit/config/selector.test.ts` (4 `NaxConfig`) — entangled with §3e, see blockers below.
- `stage-assembler{,-extra-provider-ids,-scope-files}.test.ts` (3 `PipelineContext`
  + 1 `PipelineContext["config"]`) and `tracker-provider-cost.test.ts` (2) — legacy-key fixtures.
- `merge.test.ts` (4 `Partial<NaxConfig["context"]>` + 1 `undefined as unknown as …commands`)
  — deliberate negative tests / spread-widening; arguably §3d.
- `session-helpers-resolver-model.test.ts` (3 `undefined as unknown as IAgentManager`)
  — deliberate negative tests; leave.
- `deferred-review.test.ts` (2 inline PRD) + `context-rules-fallback.test.ts` (1 partial prd)
  + `context-digest.test.ts` (1 naxIgnoreIndex stub) — partial-field fixtures, tighten or design.

### Blockers requiring design (do not attempt mechanically)

- `test/integration/execution/deferred-review-integration.test.ts` — uses
  `pluginMode: "deferred"` (REMOVED from schema). Either restore the value or rewrite
  the test. **Not a cast sweep task.** (Its spawn casts were swept in session 2;
  only the ReviewConfig fixture remains.)
- `test/unit/config/selector.test.ts` — §3e cast and §3a NaxConfig cast in same file;
  removing the NaxConfig cast surfaces an obsolete `parallel` field that the §3e cast
  reads. Either delete the test or accept `toMatchObject` instead of `toEqual`.
- `test/unit/context/engine/stage-assembler{,-extra-provider-ids,-scope-files}.test.ts`
  — fixtures use `autoMode.defaultAgent` (legacy) + many partial fields. Migrating
  would require rewriting fixtures to use the new keys. Likely 3 hours.
- `test/unit/metrics/tracker-provider-cost.test.ts` — same legacy-key issue.
- `test/unit/execution/deferred-review.test.ts` (2 inline `import("@/prd/types").PRD`)
  — partial PRD; mechanical fix is `makePRD({...})` but needs an `as Partial<PRD>` cast
  on the overrides (TS2352).
- **New (session 2):** `semantic-debate.test.ts` (12 `createDebateRunner`) and
  `pipeline-result-handler.test.ts` (7 `mergeEngine`) are confirmed 3c-ii — stubs
  return bare objects for classes with private state. Need a `makeX` seam each.
- **New (session 2):** `iteration-runner-worktree.test.ts` (2) spreads a real
  `WorktreeManager` then overrides 2 methods — needs a seam or an interface; design.

### §3b seam sweeps — done (session 2)

All non-allow-marked spawn casts went through the `makeSpawn`/`makeSpawnResult`
seam. See the §3b table above for the 5 survivors and why they stay.

### §3c-i typed dep stubs — done (session 2)

`createRuntime` (11), `parseTestOutput` (2), and all logger members converted.
Pattern used:
```ts
// before
_queueLockDeps.readdir = mock(async () => []) as unknown as typeof _queueLockDeps.readdir;
// after
const readdir: typeof _queueLockDeps.readdir = async () => [];
_queueLockDeps.readdir = readdir;
```
For `createRuntime` specifically, build a real runtime inside the stub —
`makeMockRuntime({ agentManager: … })` — so the slot type is satisfied without a
cast (the src-side `isRuntimeWithAgentManager` check then takes the direct path).

---

## 8. What is left: 235 casts, five design decisions

The sweep is over. Everything below needs a judgement call, so it is organised by the
**decision** that unblocks it, not by cast shape. Each row is independent — they can be
taken in any order, or declined.

### Decision 1 — seams (§3c-ii) — **DECIDED, now §9 Task B**

`makeDebateRunner` is built and its 13 sites are swapped (session 5). The remaining 16
casts are specified as **§9 Task B**, including the correction that `AcpClient` is an
interface rather than a class. The table below is the original survey, kept for context;
**§9 Task B has the re-derived counts — use those.**

A class with private fields cannot be satisfied by an object literal, so the stub has to
live behind a seam that contains the cast once, the same shape as the existing
`makeLogger` / `makeStatusWriter` / `makePluginRegistry`.

| Seam to build | Class | Casts | Sites |
|:--|:--|--:|:--|
| ~~`makeDebateRunner`~~ | `DebateRunner` (`src/debate/runner.ts:41`) | ~~15~~ **DONE** | Built `8a2e0c2f4`, swapped `42117eb0f`. 13 sites went; `fidelity-survives-recovery.test.ts:104` needed no seam call (cast was noise); `:164` escalated — it is a `DeepPartial` problem, see §9 Task A |
| `makeMergeEngine` | `MergeEngine` (`src/worktree/merge.ts:35`) | 7 | `pipeline-result-handler.test.ts` |
| `makeContextOrchestrator` | `ContextOrchestrator` (`src/context/engine/orchestrator.ts:166`) | 6 | `_contextStageDeps` / `stageAssemblerDeps` |
| `makeAcpClient` | ACP client (class-shaped) | 6 | `_acpAdapterDeps.createClient` |
| `makeInteractionChain` | `InteractionChain` (`src/interaction/chain.ts:27`) | 3 | `triggers-narrowed.test.ts:28,113`, `paused-story-prompts.test.ts:50` — **found session 3, not in the original §3c-ii table** |
| `makeWorktreeManager` | `WorktreeManager` (`src/worktree/manager.ts:12`) | 2 | `iteration-runner-worktree.test.ts` spreads a real instance then overrides 2 methods |

Also class-typed, found session 3: `feature-context-fragments.test.ts:115` —
`_featureContextV2Deps.createV1Provider` returns `new FeatureContextProviderV1()`.

### Decision 2 — rule on §3e private-member reach-ins (49 casts)

`(plugin as unknown as { backoffMs: number }).backoffMs`. For each: should the member be
public, or should the test go through the public API? Concentrated in
`interaction-network-failures.test.ts` and `complete-empty-output-retry.test.ts`.
Entangled with `selector.test.ts`, where the §3a `NaxConfig` cast and the §3e cast must
move together (removing the former surfaces an obsolete `parallel` field the latter
reads; `toEqual` would have to become `toMatchObject`).

### Decision 3 — migrate the legacy-key fixtures (§3a remnant, ~10 casts)

`stage-assembler{,-extra-provider-ids,-scope-files}.test.ts` and
`tracker-provider-cost.test.ts` use `autoMode.defaultAgent` (migrated to `agent.default`)
plus partial PRD/story that the cast was hiding. Either rewrite the fixtures against the
new keys or route the test through the public API. Estimated ~3 hours.
`deferred-review-integration.test.ts` is the same family but worse: it uses
`pluginMode: "deferred"`, **removed from the schema in ADR-012 Phase 6**. Restore the
value or rewrite the test — it cannot be a mechanical edit.

### Decision 4 — accept or fix the tail remnant (63 casts)

All escalated in session 3. Each is a fixture deliberately built wrong, or a fake that
would need a real migration:

| Site | Type | Why it stayed |
|:--|:--|:--|
| `model-resolution.test.ts:27,43,53,83` | `Parameters<typeof resolveBalancedModelDef>[0]` | src param needs a full `ModelTier` record; fixtures pass sparse configs *on purpose* to test the fallback chain |
| `acceptance-fix.test.ts:34,40,52` | `AcceptanceLoopContext[…]` | the minimal fake runtime would need a full `NaxRuntime` migration plus `prd`/`hooks`/`pluginRegistry`/`statusWriter`/`sessionManager`/`abortSignal` |
| `curator.test.ts:60`, `curator-gc.test.ts:58` | `Observation` | factory takes a dynamic `kind`; producing the right discriminated-union `payload` needs a per-kind switch — new test infra |
| `fallback-aggregates.test.ts:146` | `AgentFallbackHop` | omits required `costUsd` on purpose, to simulate legacy on-disk data |
| `verify-recover.test.ts:11` | `BuildContext<unknown>` | `packageView: null` fakes a required non-nullable field; no `PackageView` factory exists |
| `cli-routing-calibrate.test.ts:576,600` | `NaxConfig["autoMode"]` | deliberate `undefined` negative test — really §3d |
| `post-run-inspection-exhaustion.test.ts:370` | `Finding` | omits required `severity` on purpose — really §3d |

The last two are §3d-shaped: the cleanest resolution may be to reclassify them as
reviewed exceptions rather than fix them.

### Decision 5 — §3d: bakeoff DONE, 30 load-bearing left

**Not closed as permanent.** §3d is a holding bucket, not a verdict, and it splits into
two halves that deserve different answers:

| Half | Casts | Standing |
|:--|--:|:--|
| ~~The three bakeoff deps bags~~ | ~~31~~ **0** | **Done, session 4.** Needed no builder — the casts were unnecessary from the start (§Patterns learned item 12) |
| Deliberate negative tests + `DEFAULT_CONFIG` spread-widening | 30 | Feeding a wrong type on purpose *is* the assertion. Removing these casts would delete the test's point. Revisit only if a better negative-test idiom appears |

§3d is now 30 load-bearing casts. The 116 allow-marked lines across the repo stay
untouched regardless; they are reviewed exceptions, separate from this decision.

**A counting note worth keeping.** This doc recorded the bakeoff cluster as 28; raw grep
and the ratchet's own `byFile` both said **31**, and there were zero `// test-ratchet-allow`
markers in the three files — so the "allow-marked neighbours" explanation for the gap was
wrong. The 28 was simply stale. Patterns item 10 again: re-derive, never trust a recorded
number in this doc, including the ones in §8.

### If nothing above is taken

235 is a defensible resting point — 681 → 235 is **−65%**, and every survivor is either
load-bearing or a documented design call with its blocker named — but it is **not a
floor**, and this issue should not be closed as done.

Ranked by effort-to-value for whoever picks it up next. **Every remaining item needs a
design call** — the no-judgement work ran out in session 4.

1. **§9 Task A — the `DeepPartial` fix** — infrastructure correctness; do it first, it
   is what the other fixtures depend on. Does not move the cast count.
2. **§9 Task B — remaining seams (16)** — `makeDebateRunner` proved the pattern.
3. **Legacy-key fixtures (~10)** — Decision 3. ~3 hours, plus a schema question for
   `deferred-review-integration.test.ts` that is a decision in its own right.
4. **§3e ruling (49)** — Decision 2. Largest single bucket and the most contentious;
   needs a member-visibility policy before a single edit is safe.
5. **Tail remnant (63)** — Decision 4. Mostly fixtures that are wrong on purpose; expect
   several to be reclassified as exceptions rather than fixed.
6. **§3d (30)** — Decision 5. Load-bearing; leave unless a better negative-test idiom appears.

Taking §9 Tasks A and B lands ~13 more casts (to roughly 178) plus a real correctness
fix. Before starting
any of them, read §Patterns learned item 12 — session 4 found that a cluster this doc had
specified a builder for actually needed nothing but the cast deleted. **Try deleting the
cast before designing anything.**

---

## 9. Seams and the `DeepPartial` fix — **DONE (session 6)**

Both are delegable. The design decision is made in each case; what is left is execution
against a worked example. **Do Task A first** — it fixes shared test infrastructure that
Task B and every future fixture depend on.

Everything in §1 (the five-step verify loop), §4 (forbidden), §5 (escalate) and
§Patterns learned applies to both. Read those first.

**BOTH TASKS ARE DONE (session 6).** Starting state when they were written was
ratchet = 191 / typecheck = 1961; they finished at **165 / 1949**. Kept as the worked
record — see §7 session 6 for what each one actually turned out to need.

---

### Task A — fix `DeepPartial`, then repair the 8 fixtures it unmasks

**Not a cast task.** The cast count will not move. This is a correctness fix to
`test/helpers/mock-nax-config.ts` plus the fallout it exposes.

**The bug.** `DeepPartial` is written:

```ts
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
```

For an **optional** nested config — `debate?: DebateConfig` on `NaxConfig` — `T[K]` is
`DebateConfig | undefined`, and a union with `undefined` does **not** extend `object`. So
it falls through to `: T[K]` and demands the *full* `DebateConfig` for a one-field
override. This is the root cause of §Patterns learned item 2, which until now was
recorded only as a workaround ("don't spread").

**The fix — already written and measured, apply it verbatim:**

```ts
/**
 * `NonNullable` before the `extends object` test: for an OPTIONAL nested config
 * (`debate?: DebateConfig`), `T[K]` is `DebateConfig | undefined`, and a union
 * with `undefined` does not extend `object` — so the old form fell through to
 * `: T[K]` and demanded the FULL `DebateConfig` for a one-field override.
 * See #1514 §Patterns learned item 2.
 */
type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> : T[K];
};
```

**Measured effect (session 5, verified then reverted — the tree does NOT contain it):**
total typecheck errors **1961 → 1958**. But it is *not* a clean win, and this is the
whole point of the task:

| | Files | Errors |
|:--|--:|--:|
| Improved | 9 | −11 |
| **Regressed** | **8** | **+8** |

The 8 regressions are **real fixture bugs the loose type was masking** — the fixture
passed a wrong shape and `DeepPartial` was too permissive to notice. They are not caused
by the fix; they are revealed by it.

**The 8 files to repair** (baseline → after the fix):

| File | Was | Becomes |
|:--|--:|--:|
| `test/helpers/e2e/orchestrator-harness.ts` | 0 | 1 |
| `test/integration/interaction/interaction-chain-pipeline.test.ts` | 20 | 21 |
| `test/unit/commands/curator-gc.test.ts` | 2 | 3 |
| `test/unit/commands/curator.test.ts` | 13 | 14 |
| `test/unit/context/engine/orchestrator-factory.test.ts` | 0 | 1 |
| `test/unit/execution/lifecycle-completion.test.ts` | 6 | 7 |
| `test/unit/precheck/checks-warnings.test.ts` | 2 | 3 |
| `test/unit/prompts/loader.test.ts` | 1 | 2 |

The 9 that improve on their own, no action needed: `plan-replan.test.ts`,
`runner-hybrid-{coordinator,cross-debater,rebuttal}.test.ts`, `runner-plan-signal.test.ts`,
`runner-stateful-coordinator.test.ts`, `selectors/verifier-pick-signal.test.ts`,
`story-orchestrator/phase-details.test.ts`, `plan/strategies.test.ts`.

**Definition of done for Task A:** the fix applied, all 8 files repaired, per-file gate
back to **`worse: 0`**, and the total at **1958 or lower**. §6 forbids landing with any
file worse than baseline, so **the fix and the 8 repairs must land together** — do not
commit the type change on its own.

**Method for each of the 8:** apply the fix, run the §1 step-2 per-file script, and read
the actual error. It will name a fixture field. Per §2 and §Patterns item 5, check whether
that field exists at all (`grep` the type in `src/`) before trying to make it fit —
usually the answer is to delete it. **Escalate rather than widen `DeepPartial` back** —
if a file cannot be repaired, that is a finding, not a reason to loosen the type.

**Watch for §Patterns item 8:** a file showing one error may be hiding others behind it.
Re-run the per-file script after each repair, not just at the end.

---

### Task B — the remaining seams (16 casts, and one may need no seam at all)

**The worked example is committed.** `makeDebateRunner` in `test/helpers/debate-runner.ts`
(seam, commit `8a2e0c2f4`) and its 13 site swaps (commit `42117eb0f`). Read both before
starting. The pattern:

1. The helper intersects the class type with mock-typed methods and keeps **one** cast
   inside itself — `return runner as unknown as MockDebateRunner`.
2. Call sites then need **no** cast, because a stub factory is assignable to the dep slot
   under function contravariance:
   ```ts
   _semanticDeps.createDebateRunner = mock(() => makeDebateRunner({ run: runMock }));
   ```
3. The outer `mock()` stays a bun mock, so existing
   `expect(dep).toHaveBeenCalled()` assertions keep working. **This is the part a naive
   helper breaks** — see §Patterns item 12.

Net effect per seam: `+1` cast in the helper, `−N` at the sites. A seam covering fewer
than ~3 sites is not worth building; write the stub out in that file instead.

**Counts re-derived by grep at `42117eb0f`** (§Patterns item 10 — do it again yourself,
these drift):

| Target | Casts | Files | Kind — **verify before building** |
|:--|--:|:--|:--|
| `_acpAdapterDeps.createClient` | 6 | `agents/acp/adapter.test.ts` | **`AcpClient` is an `interface`** (`src/agents/acp/adapter-session-types.ts:92`), NOT a class. This doc previously recorded it as "class-shaped" — wrong. **Try §Patterns item 12 first: just delete the cast.** These 6 may need no seam at all |
| `_resultHandlerDeps.mergeEngine` | 7 | `execution/pipeline-result-handler.test.ts` | `MergeEngine` IS a class (`src/worktree/merge.ts:35`), with a `private worktreeManager` parameter property. Needs `makeMergeEngine`. Public surface is `merge()` and `mergeAll()` |
| `createOrchestrator` | 7 | 5 files under `pipeline/stages/` (`context-digest` 2, `context-rules-fallback` 2, `context-scope-files` 1, `context-us004` 1, `prompt-scope-files` 1) | `ContextOrchestrator` IS a class (`src/context/engine/orchestrator.ts:166`), `constructor(private readonly providers)`. Needs `makeContextOrchestrator`. Spans 5 files — best seam-per-cast ratio after mergeEngine |
| `InteractionChain` | 3 | `interaction/triggers-narrowed.test.ts` 2, `execution/lifecycle/paused-story-prompts.test.ts` 1 | IS a class (`src/interaction/chain.ts:27`), `private plugins`, `private config`. Borderline at 3 sites — build the seam only if the stub is non-trivial |
| `worktreeManager` | 2 | `execution/iteration-runner-worktree.test.ts` | IS a class (`src/worktree/manager.ts:12`). The test **spreads a real instance then overrides 2 methods**. Below the seam threshold — try typing the override in place first |
| `createV1Provider` | 1 | `context/engine/providers/feature-context-fragments.test.ts` | Returns `new FeatureContextProvider()` (`src/context/providers/feature-context.ts:46`), aliased `V1`. One site — write it out, do not build a seam |

**Order:** `mergeEngine` (7, one file) → `createOrchestrator` (7, five files) → `createClient`
(6, and test the delete-the-cast hypothesis first) → the three small ones last, only if a
seam is genuinely warranted.

**Expected landing:** 191 → roughly **178** if every seam is built (each adds one contained
cast back), or lower if the `createClient` six need no seam.

**Commit shape:** seam and worked example in one commit
(`test(helpers): add makeX seam + worked example (#1514 phase 1b)`), site swaps in the
next (`test(<area>): swap X casts onto makeX seam (#1514 phase 1b)`). That is how
`8a2e0c2f4` / `42117eb0f` were split, and it keeps a broken seam from being buried in a
30-file diff.

**Escalate, do not improvise:** if a seam cannot express a site (a test needing real class
behaviour rather than a stub), leave that site cast and report it. Do not widen the seam
to cover one awkward caller.

---

## 10. Legacy-key fixture migration — **DONE (session 7)**

**COMPLETE.** 163 → 151. Kept as the record of the ruling and of what the casts were
hiding — that catalogue, not the count, is the value. Original brief follows. Everything in §1 (verify loop), §4 (forbidden), §5 (escalate)
and §Patterns learned applies.

**Starting state:** ratchet = 163, typecheck = 1949, per-file gate `worse: 0`, tree clean
at `41b9ee603`.

### The ruling

`autoMode.defaultAgent` was removed in **ADR-012 Phase 6**. It is dead in these fixtures —
**nothing reads it.** `AutoModeConfigSchema` (`src/config/schemas.ts:80`) has no such
field, and the canonical resolution is `resolveDefaultAgent()`
(`src/agents/utils.ts:5`), which reads **`config.agent.default`**. Pipeline code reaches
it via `ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config)`.

**So: delete `autoMode.defaultAgent` and set `agent: { default: "…" }` instead.**
Do not preserve the old key, and do not add it back to the schema.

### The worked example — `test/unit/metrics/tracker-provider-cost.test.ts`

```ts
// before — two casts, both masking dead or wrong fields
return {
  story: { id, title: "Test Story", description: "", acceptanceCriteria: [], status: "pending" },
  prd: { feature: featureId, userStories: [], project: "test", branchName: "main", createdAt: "", updatedAt: "" },
  config: { autoMode: { defaultAgent: "claude" } } as unknown as PipelineContext["config"],
  projectDir: "/repo",
  workdir: "/repo",
  routing: { tier: "balanced" },
  agentResult: { success: true, cost: 0 },
  runtime: makeMockRuntime(),
} as unknown as PipelineContext;

// after — zero casts
return Object.assign(
  makeTestContext({
    story: makeStory({ id, title: "Test Story" }),
    prd: makePRD({ feature: featureId, project: "test", branchName: "main" }),
    config: makeNaxConfig({ agent: { default: "claude" } }),
    projectDir: "/repo",
    workdir: "/repo",
    routing: { ...DEFAULT_TEST_ROUTING, modelTier: "balanced" },
  }),
  { agentResult: { success: true, cost: 0 }, runtime: makeMockRuntime() },
);
```

`makeTestContext` + `Object.assign` for the test-only extras is §Patterns learned item 1.
`DEFAULT_TEST_ROUTING` is exported from `@test/helpers`.

### What the cast was hiding — expect this

Removing the cast on this one file surfaced a **second** bogus field:
`routing: { tier: "balanced" }`. `RoutingResult` (`src/pipeline/types.ts:24`) has no
`tier` — the field is **`modelTier`**, and the tracker reads `routing.modelTier`. The
fixture had been silently supplying `modelTier: undefined` for as long as the cast existed,
and the tests passed either way.

**This is the norm, not the exception** (§2, §Patterns item 5). For every rejected field,
`grep` the type in `src/` and check whether the field exists at all before trying to make
it fit. Usually you delete it or rename it to the real one.

### The files

Re-derive with `grep -rn "as unknown as" --include='*.ts' test | grep -E "NaxConfig|PipelineContext"`
(§Patterns item 10 — these drift):

| File | Casts | Note |
|:--|--:|:--|
| ~~`metrics/tracker-provider-cost.test.ts`~~ | ~~2~~ **0** | **DONE** — the worked example |
| `context/engine/stage-assembler-scope-files.test.ts` | 2 | same `autoMode.defaultAgent` shape, plus a `rootConfig` sibling cast |
| `execution/execution-stage.test.ts` | 2 | verify the shape before assuming |
| `pipeline/stages/context-digest.test.ts` | 1 | |
| `pipeline/stages/context-rules-fallback.test.ts` | 1 | partial prd fixture |
| `integration/acceptance/red-green-cycle.test.ts` | 3 | local `makePrd` could become `makePRD`; also has `PipelineContext["hooks"]` |

### Do NOT touch in this task

- `config/selector.test.ts` (4) — entangled with §3e; removing the `NaxConfig` cast
  surfaces an obsolete `parallel` field that a §3e cast reads. Needs the §3e ruling first.
- `config/merge.test.ts` (5) and `debate/session-helpers-resolver-model.test.ts` (5) —
  deliberate negative tests / spread-widening. Really §3d.
- `integration/execution/deferred-review-integration.test.ts` (2) — uses
  `pluginMode: "deferred"`, **removed from the schema in ADR-012 Phase 6**. Restoring the
  value versus rewriting the test is a product decision for the repo owner. **Blocked.**
- `execution/deferred-review.test.ts` (2) — partial inline PRD; needs fixture tightening.

**Expected landing:** 163 → roughly **154**.
