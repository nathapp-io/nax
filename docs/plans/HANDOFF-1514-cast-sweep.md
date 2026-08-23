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
| §3a Shape A — factory exists | **169** | **24** | -145 | you |
| §3b seam sweeps — helper exists, example committed | **157** | **5** | -152 | you |
| §3c-i typed dep stubs | **23** | **10** | -13 | you |
| §3c-ii dep members returning a class | 31 | 31 | 0 | escalate |
| §3d leave alone | 61 | 61 | 0 | nobody |
| §3e private-member reach-ins | 49 | 49 | 0 | escalate |
| tail — everything under 4 per cluster | **191** | **172** | -19 | you, with the resolution habit |
| **Total** | **681** | **352** | **-329** | |

**Last verified:** ratchet = 352, typecheck errors = 1963 (was 1969; **−6**).

**349 casts were yours with no judgement required** (3a + 3b + 3c-i) — all drained
in sessions 1–2. What remains is the escalate/leave-alone set plus the tail.

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

### 3d. Leave alone

| Cast target | Casts | Why |
|:--|--:|:--|
| `Record<string, unknown>` | 20 | Deliberate negative tests (`"not-an-object"`) and `DEFAULT_CONFIG` spread-widening |
| `as unknown as string` / `string[]` | 9 | Deliberate negative tests — `42 as unknown as string`, `undefined as unknown as string`. Feeding a wrong type on purpose is the assertion |
| `BakeoffCoordinatorDeps[…]`, `BakeoffCliDeps[…]`, `ContestantRunnerDeps[…]` | 28 | One file each. A typed builder local to that file is the right fix, not a shared helper — nothing else uses these deps bags. Low priority; skip unless asked |
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

### The tail — ~172 casts, ~40 clusters of fewer than four

Not leftovers: this is 28% of the work and the second-biggest bucket. It has no table
because each cluster is 1–3 sites, but it is not unstructured — apply §3a's habit:

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

Two named callouts:

- **`FixCycle<Finding>` (12), `FixCycleContext` (4), `Finding` / `Finding[]` (9)** —
  **not** a factory problem. These read back a captured value
  (`capturedCycle as unknown as FixCycle<Finding>`). Type the capture variable at its
  declaration and the cast at the read disappears.
- **`DeferredRegressionOptions` (9)** — resolve field by field. One of its fields
  already resolved to `PRD` in commit `26da265d0`; the others may too.

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

---

## 6. Definition of done

`bun run check:all` green, `bun run test` green, all three baselines lower than when
you started, and no file worse than its per-file baseline. Report the before/after
numbers for casts and typecheck errors.

---

## 7. Progress log

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

