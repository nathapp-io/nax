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

| Bucket | Casts | Who |
|:--|--:|:--|
| §3a Shape A — factory exists | **169** | you |
| §3b seam sweeps — helper exists, example committed | **157** | you |
| §3c-i typed dep stubs | **23** | you |
| §3c-ii dep members returning a class | 31 | escalate |
| §3d leave alone | 61 | nobody |
| §3e private-member reach-ins | 49 | escalate |
| tail — everything under 4 per cluster | **191** | you, with the resolution habit |

**349 casts are yours with no judgement required** (3a + 3b + 3c-i). Do those first
and in that order; the tail is where you will slow down.

### 3a. Shape A — a factory already returns this exact type

Replace `{ …literal… } as unknown as T` with `makeX({ …literal… })`, importing from
`@test/helpers`. Nothing else changes. **169 casts, no judgement required.**

| Cast target | Casts | Files | Replace with |
|:--|--:|--:|:--|
| `NaxConfig` | 48 | 25 | `makeNaxConfig(…)` |
| `PipelineContext` | 25 | 22 | `makeTestContext(…)` |
| `PRD` | 16 | 15 | `makePRD(…)` |
| `ReturnType<typeof import("@/logger").getSafeLogger>` | 11 | — | `makeLogger()` |
| `Partial<NaxConfig>` | 11 | 5 | `makeNaxConfig(…)` — takes `DeepPartial` |
| `UserStory` | 10 | 10 | `makeStory(…)` |
| `CallContext` | 9 | 4 | `makeMockCallContext(…)` |
| `PipelineContext["config"]` | 7 | 6 | `makeNaxConfig(…)` |
| `NaxRuntime` | 6 | 6 | `makeMockRuntime(…)` |
| `ReturnType<typeof origGetSafeLogger>` | 6 | — | `makeLogger()` |
| `ReturnType<typeof _rulesCLIDeps.getLogger>` | 5 | 3 | `makeLogger()` |
| `ReturnType<typeof _packagesDeps.getSafeLogger>` | 5 | 1 | `makeLogger()` |
| `import("@/agents").IAgentManager` | 5 | — | `makeMockAgentManager()` |
| `Parameters<typeof preIterationTierCheck>[0]` | 4 | 1 | `makeStory(…)` |
| `Parameters<typeof preIterationTierCheck>[2]` | 4 | 1 | `makeNaxConfig(…)` |
| `Parameters<typeof preIterationTierCheck>[3]` | 4 | 1 | `makePRD(…)` |
| `import("@/prd/types").PRD` | 2 | — | `makePRD(…)` |
| `import("@/runtime").NaxRuntime`, `import("@/config").NaxConfig`, `import("@/plugins/registry").PluginRegistry` | 3 | — | `makeMockRuntime()` / `makeNaxConfig()` / `makePluginRegistry()` |

The four `getSafeLogger` / `getLogger` spellings all resolve to `Logger`, which
`makeLogger()` returns since commit `ef0b154e0`. They look like four clusters and are
one.

Several `PipelineContext` sites are a *local* `makeCtx()` in the test file that casts
on the way out. Delete the local, use `makeTestContext`.

### 3b. Seam sweeps — helper exists, one file done as a worked example

Same edit as 3a. Read the worked example first: `git show <commit> -- <file>`.
**157 casts.**

| Cast target | Casts | Helper | Worked example |
|:--|--:|:--|:--|
| `typeof Bun.spawn` | 39 | `makeSpawn().spawn` | `577570f96` — `test/unit/quality/runner-env-strip.test.ts` |
| `typeof _gitDeps.spawn` | 36 | `makeSpawn().spawn` | `577570f96` — `test/unit/utils/auto-commit.test.ts` |
| `typeof _diffUtilsDeps.spawn` | 26 | `makeSpawn().spawn` | same |
| `ReturnType<typeof Bun.spawn>` | 25 | `makeSpawnResult(…)` | same |
| `typeof _deferredReviewDeps.spawn` | 10 | `makeSpawn().spawn` | same |
| `Parameters<typeof handleTierEscalation>[0]` | 8 | `makeEscalationContext(…)` | `f3aa6b248` |
| `typeof _completionDeps.spawn` | 4 | `makeSpawn().spawn` | `577570f96` |
| `typeof _executorDeps.spawn`, `_resultHandlerDeps.spawn`, `_isolationDeps.spawn`, `_reconcileDeps.spawn` | ~12 | `makeSpawn().spawn` | same |

Every `_xDeps.spawn` in `src/` is declared `spawn as typeof spawn` off
`src/utils/bun-deps`, so one `makeSpawn().spawn` is assignable to all of them. The
handler is `({ cmd, opts }) => stdoutString | FakeProcSpec`; `calls` and `lastEnv()`
cover recording and env assertions.

### 3c. `_xDeps.<member>` — two kinds, and only one is yours

I tested the obvious rule ("declare the stub with the slot's type so the compiler
forces it to conform") on a real site and **it does not work for half of these**, so
check which kind you have before touching anything.

**3c-i — plain function or value members. Yours. ~23 casts.**

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

### The tail — 191 casts, ~40 clusters of fewer than four

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
