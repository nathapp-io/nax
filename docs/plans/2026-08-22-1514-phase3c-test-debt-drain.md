# Draining the test-debt baselines (issue #1514 phase 3c + 4)

> Drafted 2026-08-22. Target: `check:test-typecheck` and `check:test-as-unknown-as`
> baselines to **0**, then wire `tsconfig.test.json` into `bun run typecheck`.
>
> **Phase 0 is done** (commits `e8a55d6dc`, `4038a447d`, `20c059774`, `d95e605a0` on
> `chore/1514-test-debt-drain`). Phases 1–3 are the mechanical handover. Sections
> below are as-built; the §1 counts are the live post-phase-0 numbers.

## 0. Where these gates actually live

They are **not** in `bun run lint` (that is `biome check src/ bin/` plus the src-side
checks). They are in **`bun run check:all`**, which runs in `.githooks/pre-commit`
and in `.github/workflows/ci.yml:63`.

Consequence worth knowing before touching anything: **`test/` is never linted by
Biome.** `lint` only scans `src/` and `bin/`, so `noExplicitAny` and friends have
never applied to the test tree. The only things guarding `test/` are these two
ratchets.

### Is the Biome exclusion the *cause* of these two ratchets?

No — measured, not assumed.

The typecheck ratchet exists because **`tsconfig.json` excludes `"test"` and
`"scripts"`**, so `bun run typecheck` has never compiled the test tree. Biome is
*type-unaware*: a probe file containing a TS2739 (missing fixture properties — the
#3 cluster, 137 errors) and a TS2554 (wrong call arity — the #4 cluster, 132
errors) produced from Biome exactly one complaint, about formatting. **Biome cannot
catch a single one of the 2008 typecheck errors.** Only `tsc` can.

Biome also has **no rule for `as unknown as`** — the probe's double-cast drew
nothing. So the cast ratchet is not replaceable by Biome either.

Adding `test/` to `lint` is still worth doing, for a different reason: it is what
permanently retires the **`as any`** escape hatch (§2). See §3.

## 1. Current state (measured 2026-08-22)

| Ratchet | Baseline (start) | After phase 0 | Files |
|:--|--:|--:|--:|
| `check:test-typecheck` | 2009 | **1999** | 365 |
| `check:test-as-unknown-as` | 815 (per-line) | **819** (per-match) | 254 |
| `check:test-escape-hatches` — `asAny` | — | **1399** | |
| `check:test-escape-hatches` — `tsSuppress` | — | **54** | |
| `check:test-escape-hatches` — `ratchetAllow` | — | **128** | |

Union: **514 files**, ~2820 items. 104 files carry both kinds.

The cast number went *up* because phase 0 fixed the counter, not because casts were
added: it now counts per match rather than per line. Nine typecheck errors went away
with the eight shadowed-import fixes (TS2440) that Biome's `noRedeclare` surfaced.

Concentration is mild — top 10 files = 13%, top 50 = 41%, top 100 = 60%. There is
no small set of files that clears this; it is a long grind. What *is* concentrated
is the **cause**.

Typecheck errors by code:

| Code | N | Meaning |
|:--|--:|:--|
| TS2322 | 597 | fixture object not assignable to the declared type |
| TS2352 | 197 | single `as X` cast that no longer overlaps |
| TS2739/2741/2740 | 253 | fixture missing required properties |
| TS2554 | 132 | call-site arity drifted from the real signature |
| TS2345 | 132 | argument type mismatch |
| TS7006 | 125 | implicit `any` parameter in an inline mock |
| TS2353 | 112 | fixture sets a property the type dropped |
| TS2769 | 102 | no overload matches |
| TS2339 | 102 | property missing on the mocked type |
| TS2304 | 79 | **missing type import** (`PRD` ×32, `UserStory` ×31, `NaxConfig` ×8) |
| tail | ~180 | 20 further codes |

Casts by target type (top named types):

`CallOpFn` 65 · `NaxConfig` 53 · `PipelineContext` 38 · `PRD` 16 ·
`PipelineRunResult` 16 · `BakeoffCoordinatorDeps` 15 · `Partial<NaxConfig>` 14 ·
`ContextBundle` 14 · `RunCompletionOptions` 13 · `RunnerCompletionOptions` 12 ·
`Logger` 12 · `FixCycle<Finding>` 12 · `DeferredRegressionOptions` 12 ·
`BakeoffCliDeps` 12 · `Finding` 10 · `AgentRegistry` 10 — **≈284 casts across 16
types**. A further 364 are `as unknown as typeof …` / `ReturnType<typeof …>` /
`Parameters<typeof …>`, i.e. module- and spawn-mock shapes.

**The leverage:** these are not 284 independent problems. They collapse into ~16
clusters, in two shapes — and the fix differs, so the distinction matters:

**Shape A — a correctly-typed factory already exists and the call site bypasses
it.** This is the larger and easier group. `test/helpers/mock-nax-config.ts`
already exports `makeNaxConfig(overrides: DeepPartial<NaxConfig>): NaxConfig`, yet
53 sites write `{ ...BASE_CONFIG, debate: {…} } as unknown as NaxConfig`. Likewise
`_cycle-fixtures.ts` already exports `makeCallOpSpy()`, whose docstring reads
*"Prefer this over `makeCallOpMock()` in new tests: it satisfies `CallOpFn`
directly, so call sites need no type assertion at all"* — and 65 sites still call
the untyped `makeCallOpMock()` and cast. The fix is **migrate the call site to the
existing helper**, not touch the helper.

**Shape B — a *local* per-file helper returns a loose object and casts on the way
out.** e.g. `test/unit/metrics/tracker-full-suite-gate.test.ts` ends its private
`makeCtx` with `} as unknown as PipelineContext;` while
`test/helpers/pipeline-context.ts` already has a real `makeTestContext(): PipelineContext`.
The fix is either to delete the local helper in favour of the shared one, or to
give it a real return type and fill in what the compiler demands.

The shared helper files themselves are almost clean (13 files, 32 items). **The
debt is not in the helpers — it is in the call sites that route around them.**
Verify which shape a cluster is before editing; do not "fix" a helper that is
already correct.

Loop cost is not a constraint: TypeScript 7 (native) typechecks the whole test
tree in **0.9s**, and `bun run test` is **38s**.

## 2. The blocker — drain this and you will drain it into the ditch

Neither ratchet counts these, and all four are already in the tree:

| Escape hatch | Count in `test/` | Counted by a ratchet? |
|:--|--:|:--|
| `as any` | **1399** | no |
| `// test-ratchet-allow: as-unknown-as` | **128** | no — the marker makes the line invisible |
| `@ts-expect-error` / `@ts-ignore` | 38 / 15 | no |
| `as typeof X` | — | no, and `.nax/rules/test-ratchets.md` **recommends it** |

So the true cast debt is 815 + 128 = 943, and there are 1399 `as any` already
absorbing type errors that would otherwise show in the 2008.

### What Biome on `test/` would actually find

Measured with the repo's own Biome 1.9.4 and config against `test/`:

| | Errors |
|:--|--:|
| Today | **4400** across 1250 files |
| After a safe `biome check --write` | **3211** (1189 auto-fixed, 785 files touched) |
| of which `noExplicitAny` | **2830** (88%) |
| everything else remaining | ~380 (`useLiteralKeys` 162, `noDelete` 73, `useTemplate` 65, `noUnusedTemplateLiteral` 48, and a handful of singles) |

So enabling Biome on `test/` covers exactly one of the four hatches — `as any` —
and nothing else. `as unknown as`, `@ts-ignore`/`@ts-expect-error`, and the
`test-ratchet-allow` marker stay uncovered forever.

Every one of these converts a red ratchet to green in one keystroke without
improving a single test. A cheap model optimising for "make the number go down"
will find them within the first hour — the rules file literally points at one of
them. **Both baselines can reach 0 with the test tree no better typed than today.**

Phase 0 closes this before anyone is handed the grind.

## 3. Phase 0 — close the hatches (DONE)

Landed as four commits. What actually happened, including the parts the plan got
wrong, is in the commit bodies; the short version:

| Step | Commit | Outcome |
|:--|:--|:--|
| 0a-bis | `e8a55d6dc` | cast ratchet counts per match; re-baselined 815 → 820 |
| 0a | `4038a447d` | biome override + safe autofix, 785 files |
| 0a | `20c059774` | `lint` extended to `test/`; 4432 findings → 0 |
| 0b/0c | `d95e605a0` | escape-hatch ratchet + rules rewrite |

Four surprises worth carrying forward, all of the same kind — **line-based scanners
drift when the formatter reflows code**:

1. Biome 1.9.4 splits `as unknown as import("x").T` into a trailing-comma
   `import(
 "x",
)` that TypeScript will not parse. tsc aborts on the parse
   error, so `check:test-typecheck` read **1** instead of 2008 — a passing number
   that meant the tree no longer compiled. Any drain commit that makes the
   typecheck count fall implausibly far should be treated as a broken parse until
   proven otherwise.
2. The formatter detaches a trailing `test-ratchet-allow` comment from its cast.
   The marker is now honoured on either neighbouring line.
3. Joining a split `await import(
 "../../../../src/x"
)` exposed 43 real
   deep-relative imports that `check:deep-relatives` (baseline pinned at 0) had
   never matched. Converted to aliases.
4. Reflowing grew `test/` by ~5.5k lines, breaching `check:file-sizes` on 8 files.
   Baseline bumped — the growth is formatting, not code.

Two findings were suppressed with a note rather than fixed, and belong to the
per-file drain in §5:

- `test/unit/agents/acp/adapter.test.ts` exports helpers that three sibling tests
  import. Moving them to `_test-helpers.ts` changes which module first initialises
  `@/agents/acp` and breaks 22 tests — a real module-init-order problem, not a
  mechanical move.
- `test/integration/review/adversarial-reprompt-telemetry.test.ts` registers
  `afterEach` hooks from inside three test bodies. They belong at describe level.

Three Biome rules are off for `test/**` (`biome.json`): `noExplicitAny` (deferred,
counted by the escape-hatch ratchet, turns on in phase 3), `noNonNullAssertion`
(off for good — `!` is idiomatic in tests), and `noDelete` (off for good; its
autofix turns `delete process.env.X` into `process.env.X = undefined`, which leaves
the key present and so does not unset it).

<details>
<summary>Original phase-0 plan, as written before execution</summary>

### Phase 0 — close the hatches (do NOT delegate)

Biome has no baseline mechanism, so `test/` cannot simply be added to `lint` at
3211 errors. Turn it on with the one unaffordable rule disabled, and ratchet that
rule separately.

**0a — enable Biome on `test/`, minus `noExplicitAny`.** One standalone commit,
before any drain work, so its 785-file diff never tangles with the burn-down.

```jsonc
// biome.json
"overrides": [
  { "include": ["test/**"],
    "linter": { "rules": { "suspicious": { "noExplicitAny": "off" } } } }
]
```

Then `bun x biome check --write test/` (1189 auto-fixed), hand-fix the ~380
remainder, extend `lint` to `biome check src/ bin/ test/`, and confirm
`bun run test` is still green — the autofix is formatting, `organizeImports`, and
`useImportType`, so it should be, but 785 files deserves the check.

**0a-bis — fix the cast ratchet's counting before the reformat lands.**
`check-test-as-unknown-as.ts` increments **once per line**, not once per match:

```ts
if (!PATTERN.test(line)) continue;
byFile[rel] = (byFile[rel] ?? 0) + 1;   // ← one, even if the line has three
```

Two consequences, both measured:

- Six lines carry more than one cast, so the ratchet reads **814** where the truth
  is **820**. Joining two cast lines into one lowers the count by 1 while removing
  nothing — a fifth escape hatch, and the easiest of the lot to hit by accident.
- Biome's formatter splits those long lines. Running 0a's `--write` moves the count
  **940 → 942** on raw grep (all of it in `test/unit/findings/cycle.test.ts`,
  51 → 53), which would **fail `check:all` on the reformat commit** — and the rules
  file correctly forbids `--update-baseline` on a count that grew.

So fix the counter first: switch to `line.matchAll(PATTERN)` and add the match
count, then re-baseline **814 → 820** as a deliberate correction (a same-tree
recount, not a regression). Order matters — counter fix, then re-baseline, then the
Biome reformat, which is then count-neutral.

**0b — new script `scripts/check-test-escape-hatches.ts`** for the three hatches
Biome will never see. Same shape as `check-test-as-unknown-as.ts`
(`{count, updatedAt, byFile}` baseline, `--update-baseline`, `--list`,
fail-on-growth), three counters in one baseline file
`scripts/baselines/test-escape-hatches-baseline.json`:

Seeds below are exact, counted per-occurrence with the same `EXEMPT_FILES` and
`.d.ts` exclusions the existing ratchets use — count per match, not per line, or
0b inherits the bug 0a-bis just fixed:

- `asAny` — `/\bas\s+any\b/` → seed **1399**
  (the ratchet standing in for `noExplicitAny` until Phase 3 turns the real rule
  on; Biome's 2830 counts every explicit `any`, this counts only the casts)
- `tsSuppress` — `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` → seed **54**
- `ratchetAllow` — `test-ratchet-allow: as-unknown-as` → seed **128**

Note on `ratchetAllow`: 128 markers exist but only **117** sit on a line that
actually contains a cast. The other **11 are orphaned** — stale markers suppressing
nothing. Deleting them is a free first commit and drops the seed to 117.

One script, so `check:all` stays short and `check:gate-reachability` stays
satisfied. Apply the same `EXEMPT_FILES` treatment for the ratchets' own test
files. Wire `check:test-escape-hatches` + `:update` into `package.json` and
`check:all`, with `test/unit/scripts/check-test-escape-hatches.test.ts` mirroring
the two existing ratchet tests (parser + report logic, no real scan).

**0c — amend `.nax/rules/test-ratchets.md`.** Delete the "`as typeof X` — passes
the regex, prefer when the shape is right" recommendation; it is a documented
bypass. Replace the "Avoid these patterns" section with the escape-hatch table
from §2 and the rule: *no drain commit may raise any escape-hatch count.*

Commits: `chore(test): lint test/ with biome (noExplicitAny deferred) (#1514)`,
then `ci(test): ratchet test/ escape hatches (#1514 phase 3c prep)`.

Only after these land is the drain safe to hand over.

</details>

## 4. Phase 1 — fixture type tightening (highest leverage, ~280 casts + ~600 tc errors)

One type-cluster per unit of work. For each of the 16 types listed in §1:

1. `grep -rn "as unknown as <Type>" --include='*.ts' test` → list the sites.
2. **Establish the shape first** (§1): does `test/helpers/` already export a factory
   returning that exact type? `grep -rn "): <Type>" test/helpers/`.
   - **Shape A** — yes: rewrite each site as a call to that factory, passing the
     ad-hoc literal as the overrides argument. Delete the cast. Touch nothing in
     `test/helpers/`.
   - **Shape B** — no, or the site's producer is a local per-file helper: give that
     local helper the real return type, fill in what the compiler demands once, and
     delete the cast at each of its call sites. Prefer replacing it with the shared
     factory outright if one fits.
3. Verify (§7).

Suggested order — biggest single-fixture wins first:

Existing shared factories were verified to exist and to return the right type —
these are confirmed Shape A targets:

| # | Type | Casts | Shape | Migrate to |
|--:|:--|--:|:--|:--|
| 1 | `CallOpFn` | 65 | A | `makeCallOpSpy()` — `test/unit/findings/_cycle-fixtures.ts:92` |
| 2 | `NaxConfig` + `Partial<NaxConfig>` | 67 | A | `makeNaxConfig()` / `makeSparseNaxConfig()` — `test/helpers/mock-nax-config.ts:24` |
| 3 | `PipelineContext` | 38 | B → A | `makeTestContext()` — `test/helpers/pipeline-context.ts:61` |
| 4 | `PRD` | 16 | A | `makePRD()` — `test/helpers/mock-story.ts:27` |
| 5 | `UserStory` | 9 | A | `makeStory()` — `test/helpers/mock-story.ts:3` |
| 6 | `Logger` | 12 | A | `makeLogger()` — `test/helpers/mock-logger.ts:18` |
| 7 | `AgentRegistry` | 10 | A | `makeMockAgentManager()` — `test/helpers/mock-agent-manager.ts:78` (confirm the type first) |
| 8 | `PipelineRunResult` | 16 | locate | — |
| 9 | `BakeoffCoordinatorDeps` + `BakeoffCliDeps` | 27 | locate | `test/unit/bakeoff/` |
| 10 | `RunCompletionOptions` + `RunnerCompletionOptions` | 25 | locate | `test/helpers/runtime.ts` has `makeTestRuntime`/`makeMockRuntime`, not these |
| 11 | `ContextBundle` | 14 | locate | — |
| 12 | `FixCycle<Finding>` + `Finding` | 22 | locate | `_cycle-fixtures.ts` has `makeCycle`/`makeFinding` — check their return types |
| 13 | `DeferredRegressionOptions` | 12 | locate | — |

Expect the typecheck count to move too — TS2322/TS2739/TS2741 (850 errors) are the
same fixture drift seen from the other side.

**Also in phase 1, because it is free:** the 79 TS2304 errors are missing type
imports (`PRD` ×32, `UserStory` ×31, `NaxConfig` ×8, `IAgentManager` ×4). Add the
`import type` line. One commit, ~79 errors.

## 4b. Phase 1b — the decision register

Every cast cluster, with its ruling. **Shape A** = execute now, it is a mechanical
call-site sweep. **Seam** = a typed helper had to be designed first; where the ruling
says *done*, the seam is committed and the sweep is now Shape A.

### The resolution rule — apply this before reading the table

A cast target spelled `T["field"]`, `Parameters<typeof f>[n]`, or
`ReturnType<typeof f>` **does not name a new type**. Resolve it first. 261 of the
casts (~30%) are spelled this way, and about a third of those land on a type that
already has a factory. Two worked examples, both committed:

- `Parameters<typeof preIterationTierCheck>[0] | [2] | [3]` → `UserStory`,
  `NaxConfig`, `PRD` — all three already have factories.
- `DeferredRegressionOptions["prd"]` → `PRD`. `makePRD()` was a drop-in.

Never write a new factory before resolving the indirection.

### Rulings

| Cluster | Casts | Ruling |
|:--|--:|:--|
| `typeof _xDeps.spawn` ×9 names, `ReturnType<typeof Bun.spawn>` | 186 | **Seam — done.** `makeSpawn` / `makeSpawnResult` |
| `CallOpFn` | 65 | **Seam — done.** `makeCallOpMock` returns `CallOpFn & Mock`, takes a handler |
| `…["statusWriter"]` (2 owning types) | 17 | **Seam — done.** `makeStatusWriter` |
| `PipelineRunResult["context"]` | 16 | **Done.** Resolves to `PipelineContext`; also needed a new `makeAgentResult` |
| `Parameters<typeof handleTierEscalation>[0]` | 16 | **Seam — done.** `makeEscalationContext`; resolves to the exported `EscalationHandlerContext` |
| `ContextBundle` | 14 | **Seam — done.** `makeContextBundle` / `makeContextManifest`, no cast needed |
| `Logger` | 12 + 15 tc | **Seam — done.** `MockLogger = Logger & {…}` |
| `…["pluginRegistry"]` (4 owning types) | 9 | **Seam — done.** `makePluginRegistry` |
| `AgentRegistry` | 10 | **Seam — done.** `makeAgentRegistry`, no cast needed |
| `NaxConfig`, `Partial<NaxConfig>` | 67 | **Shape A** → `makeNaxConfig()` / `makeSparseNaxConfig()` |
| `PipelineContext` | 38 | **Shape A** → `makeTestContext()`; several sites are a local `makeCtx` to delete |
| `Parameters<typeof preIterationTierCheck>[n]` | 25 | **Shape A** → `UserStory` / `NaxConfig` / `PRD` |
| `PRD` | 16 | **Shape A** → `makePRD()` |
| `UserStory` | 10 | **Shape A** → `makeStory()` |
| `CallContext` | 9 | **Shape A** → `makeMockCallContext()` |
| `NaxRuntime` | 6 | **Shape A** → `makeMockRuntime()` |
| `BakeoffCoordinatorDeps` + `BakeoffCliDeps` | 27 | **Local, not shared.** One file each — a typed builder in the test file. No shared helper: nothing else uses these deps bags |
| `SequentialExecutionContext` | ~5 | **Local.** Small; the `statusWriter` / `pluginRegistry` fields are already covered by their seams |
| `FixCycle<Finding>`, `FixCycleContext` | 19 | **Not a factory problem.** These read back a captured value; type the capture variable at its declaration |
| `Record<string, unknown>` | 20 | **Leave — case by case.** Deliberate negative tests and `DEFAULT_CONFIG` spread-widening |
| `Finding` | 10 | **Resolve first.** `makeFinding` exists in `_cycle-fixtures.ts`; check its return type |
| remaining `typeof _xDeps.<member>` | ~46 | **Uniform rule, per dep.** Declare the stub as the dep's own type — `const stub: typeof _xDeps.createRuntime = …`. If the mock cannot conform, it is genuinely incomplete: complete it |

### Phase 1b is complete

Nine seams committed and proven; every remaining cluster has a ruling that needs no
further design. What is left is execution:

- **Shape A: ~171 casts** across the six factory-backed clusters — pure call-site sweep.
- **Seam sweeps: ~120 casts** — the seams exist and one file of each is done as a
  worked example; the rest is the same edit repeated.
- **Local/leave: ~90 casts** — Bakeoff, SequentialExecutionContext, the capture-variable
  group, and the `Record<string, unknown>` ones that should stay.

### What the seams kept finding

Worth telling whoever runs the sweep: **removing a cast usually exposes a fixture that
was wrong, not merely incomplete.** Nine of twelve `ContextBundle` files carried a
`packedChunks` field that is a local variable inside `rebuild.ts` and has never been
part of the type; `tool-runtime` set a `meta` field that does not exist;
`acceptance-loop-skipped-packages` passed `{ getAll, get }` to a `PluginRegistry` that
declares neither; every `PipelineRunResult` site wrote one of `AgentResult`'s six
required fields; `tier-escalation-retry-cap`'s story was missing `StoryRouting`'s
`complexity` and `reasoning`. None of it was read by anything.

The casts were not protecting a shape. They were hiding that there was no shape.

## 5. Phase 2 — per-file burn-down (the grind, ~500 files)

Work descending by combined count. Regenerate the worklist any time:

```bash
bun -e '
const a=require("./scripts/baselines/test-typecheck-baseline.json").byFile;
const b=require("./scripts/baselines/test-as-unknown-as-baseline.json").byFile;
const rows=[...new Set([...Object.keys(a),...Object.keys(b)])]
  .map(f=>({f,tc:a[f]||0,ca:b[f]||0})).sort((x,y)=>(y.tc+y.ca)-(x.tc+x.ca));
rows.forEach(r=>console.log(String(r.tc).padStart(4),String(r.ca).padStart(4),r.f));'
```

One file per unit of work; batch 5–15 files per commit. Files are independent, so
this parallelises cleanly across agents if wanted — but each agent must hold the
whole-tree count check in §7, not just its own file.

Head of the queue today:

```
  4  49  test/unit/findings/cycle.test.ts            (dissolves in phase 1 #1)
 36   3  test/unit/execution/parallel-batch.test.ts
 38   0  test/unit/plugins/builtin/curator-heuristics.test.ts
 36   0  test/integration/cli/cli-plugins.test.ts
 36   0  test/unit/debate/runner-stateful.test.ts
 35   0  test/integration/config/merger.test.ts
 33   1  test/unit/execution/story-orchestrator-resume-integration.test.ts
 10  21  test/unit/execution/pipeline-result-handler.test.ts
 30   1  test/unit/execution/story-orchestrator.test.ts
 30   0  test/unit/operations/run-operation-retry.test.ts
```

## 6. Phase 3 — close the gates (not delegable)

Once both counts are 0:

1. Add `bun x tsc --noEmit -p tsconfig.test.json` to the `typecheck` script.
2. Delete `check:test-typecheck` and its baseline — the real gate replaces it.
3. **Keep** `check:test-as-unknown-as` and `check:test-escape-hatches`, baselined at
   0/0/0/0. They are the permanent invariant.
4. Drop the `noExplicitAny: off` override added in phase 0a — with the tree clean
   the real rule is finally affordable, and it retires the `asAny` counter
   properly. Keep the `tsSuppress` and `ratchetAllow` counters.
5. Update `.nax/rules/test-ratchets.md` and close #1514.

## 7. Handover contract — the loop, verbatim

**Per unit of work** (one fixture in phase 1, one file in phase 2):

```bash
# 1. see this unit's errors
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep '^<path>('
grep -n 'as unknown as' <path>

# 2. fix (see forbidden list below)

# 3. the file's tests still pass
bun test <path> --timeout=60000
```

**Per commit** — all four must hold, in this order:

```bash
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c 'error TS'   # must be < the number before this batch
bun run check:all        # all ratchets green BEFORE any --update-baseline
bun run test             # ~38s, full suite green
bun run check:test-typecheck:update
bun run check:test-as-unknown-as:update
git diff scripts/baselines/   # both counts must have gone DOWN, never up
```

Commit as `fix(tests): <what> (#1514 phase 3c)` with a body line
`typecheck: N → M, casts: P → Q`.

**Never run `--update-baseline` before `check:all` is green.** The update writes
whatever it finds, including a regression.

### Forbidden — these make the number go down without doing the work

- Adding `as any`, `@ts-ignore`, `@ts-expect-error`, or `@ts-nocheck`.
- Adding `// test-ratchet-allow: as-unknown-as`.
- Joining two cast-bearing lines into one, or otherwise reflowing code to lower a
  count. (Fixed by 0a-bis, but reviewers should still watch for it.)
- Replacing `as unknown as X` with `as typeof X` or any other single cast.
- Deleting, skipping, or `.skip`-ing a test, or narrowing a `describe`.
- Excluding a file from `tsconfig.test.json`.
- Weakening a **source** type in `src/` so a test fixture fits. The fixture is
  wrong, not the type.
- Running `--update-baseline` on a count that grew.

The phase-0 escape-hatch ratchet enforces the first three mechanically. The rest
are on review.

### The right fix, every time

The test claims to hold a `T`. Make it actually hold a `T`: add the missing
properties to the fixture, tighten the helper's return type, correct the call
arity, import the type. If the compiler is right that the mock is incomplete,
complete the mock.

### Escalate instead of guessing when

- The error says a **source** type is wrong, not the fixture.
- Fixing the type requires changing what the test asserts.
- A fixture change makes a *different* test fail — that test was relying on the
  wrong shape; stop and report it rather than papering over it.
- Removing a cast reveals that the mock cannot satisfy the interface at all
  (e.g. a `Bun.spawn` shape). These are the ~364 `typeof`-family casts and may
  legitimately need a typed helper built first.
- The same file fails twice in a row. Two attempts, then hand it back.

## 8. Sizing

| Phase | Unit | Est. items cleared |
|:--|:--|--:|
| 0 | ~~done~~ | 4432 biome findings cleared; typecheck 2009 → 1999 |
| 1 | ~16 fixtures + 1 import commit | ~280 casts, ~700 tc errors |
| 2 | ~500 files, 5–15 per commit | remainder |
| 3 | gate flip | 0 |

Phase 2 is the bulk and is genuinely mechanical; phase 1 needs a little judgement
about where each fixture lives but pays for itself several times over. Do phase 1
first — it shrinks phase 2's queue substantially.
