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

### 3a. Shape A — a factory already returns this exact type

Replace `{ …literal… } as unknown as T` with `makeX({ …literal… })`. Import from
`@test/helpers`. Nothing else changes.

| Cast target | Casts | Files | Replace with |
|:--|--:|--:|:--|
| `NaxConfig` | 48 | 25 | `makeNaxConfig(…)` |
| `PipelineContext` | 25 | 22 | `makeTestContext(…)` |
| `PRD` | 16 | 15 | `makePRD(…)` |
| `Partial<NaxConfig>` | 11 | 5 | `makeNaxConfig(…)` — it takes `DeepPartial` |
| `UserStory` | 10 | 10 | `makeStory(…)` |
| `CallContext` | 9 | 4 | `makeMockCallContext(…)` |
| `PipelineContext["config"]` | 7 | 6 | `makeNaxConfig(…)` |
| `NaxRuntime` | 6 | 6 | `makeMockRuntime(…)` |

Several `PipelineContext` sites are a *local* `makeCtx()` in the test file that casts
on the way out. Delete the local and use `makeTestContext` instead.

### 3b. Seam sweeps — the helper exists, one file is done as a worked example

Same edit as 3a, but read the worked example first — `git show <commit> -- <file>`.

| Cast target | Casts | Files | Helper | Worked example |
|:--|--:|--:|:--|:--|
| `typeof _gitDeps.spawn` | 42 | — | `makeSpawn` | `577570f96` — `test/unit/utils/auto-commit.test.ts` |
| `typeof Bun.spawn` | 42 | — | `makeSpawn` | `577570f96` — `test/unit/quality/runner-env-strip.test.ts` |
| `ReturnType<typeof Bun.spawn>` | 27 | 8 | `makeSpawnResult` | same commit |
| `typeof _diffUtilsDeps.spawn` | 26 | — | `makeSpawn` | same commit |
| `typeof _executorDeps.spawn` | 11 | — | `makeSpawn` | same commit |
| `typeof _deferredReviewDeps.spawn` | 10 | — | `makeSpawn` | same commit |
| `typeof _completionDeps.spawn` | 8 | — | `makeSpawn` | same commit |
| `typeof _resultHandlerDeps.spawn` | 5 | — | `makeSpawn` | same commit |
| `typeof _isolationDeps.spawn` | 4 | — | `makeSpawn` | same commit |
| `Parameters<typeof handleTierEscalation>[0]` | 8 | 1 | `makeEscalationContext` | `f3aa6b248` |

Every `_xDeps.spawn` in `src/` is `spawn as typeof spawn` off `src/utils/bun-deps`, so
one `makeSpawn().spawn` is assignable to all of them. Handler signature is
`({ cmd, opts }) => stdoutString | FakeProcSpec`; `calls` and `lastEnv()` cover
recording and env assertions.

### 3c. Resolve the indirection first

A target spelled `T["field"]`, `Parameters<typeof f>[n]`, or `ReturnType<typeof f>`
**does not name a new type**. Look up what it resolves to, then check §3a. On this
branch that collapsed three whole clusters — `PipelineRunResult["context"]` was just
`PipelineContext`; `Parameters<typeof handleTierEscalation>[0]` was
`EscalationHandlerContext`, exported all along.

| Cast target | Casts | Files | Do this |
|:--|--:|--:|:--|
| `DeferredRegressionOptions` | 9 | 3 | resolve each field; one already resolved to `PRD` |
| `FixCycle<Finding>` / `Finding[]` | 17 | 5 | **not** a factory problem — these read back a captured value. Type the capture variable at its declaration instead of casting at the read |
| `ReturnType<typeof _xDeps.<member>>` | ~25 | ~10 | declare the stub as the dep's own type: `const stub: typeof _xDeps.createRuntime = …`. If the mock cannot conform, it is genuinely incomplete — complete it |
| `typeof _semanticDeps.createDebateRunner` etc. | ~50 | — | same rule as the row above |

### 3d. Leave these alone

| Cast target | Casts | Why |
|:--|--:|:--|
| `Record<string, unknown>` | 20 | Deliberate negative tests (`"not-an-object"`) and `DEFAULT_CONFIG` spread-widening. Legitimate |
| `BakeoffCoordinatorDeps[…]`, `BakeoffCliDeps[…]` | 24 | One file each. A typed builder local to that file is the right fix, not a shared helper — nothing else uses these deps bags. Low priority |
| anything already carrying `// test-ratchet-allow: as-unknown-as` | 116 | Reviewed and accepted. Do not touch |

---

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

---

## 6. Definition of done

`bun run check:all` green, `bun run test` green, all three baselines lower than when
you started, and no file worse than its per-file baseline. Report the before/after
numbers for casts and typecheck errors.
