# Test-debt drain — status

The live doc for draining `test/`'s type-escape hatches. Successor to
`archive/STATUS-1514-typecheck-drain.md`, which ran the typecheck half of the same effort to
completion and is closed.

**§0 is the live state and is re-measured, not carried forward. §8 is a chronological log —
each entry records what was true when written and is not edited afterwards.** Closed drains
are lifted out to `archive/` once their ratchet is gated; see §7.

---

## 0. Current state — re-measured 2026-08-26 on `main` (after the `noNonNullAssertion` drain merged, #1726)

| Counter | Regex ratchet | Biome | Drain target? |
|:--|--:|--:|:--|
| `tsc --noEmit` (src) | **0** | — | hard gate |
| `tsc --noEmit -p tsconfig.test.json` | **0** | — | hard gate |
| `as unknown as` | **0** | — | done — closed invariant (`archive/LOG-as-unknown-as-drain.md`) |
| `asAny` | 1 | **0** | done — rule at `"error"` (`archive/LOG-no-explicit-any-drain.md`) |
| `anyType` | 10 | **0** | done — rule at `"error"` (`archive/LOG-no-explicit-any-drain.md`) |
| `nonNullAssert` | 2 | **0** | done — rule at `"error"` (`archive/LOG-non-null-assertion-drain.md`) |
| `asNever` | **323** | — | **yes — current target (§1)** |
| `ratchetAllow` | 103 | — | yes — next |
| `tsSuppress` | 25 | — | yes — next |
| `absentValue` | 17 | — | yes — next |
| `looseCast` | 1799 | — | **no** — guard only, see below |

Four ratchets are closed and gated, and the phase-3c endgame is complete. `as unknown as`
went 101 → 0 and is now a pure invariant: any nonzero reading is a regression to reject, not
a number to work down. `noExplicitAny` went biome 1529 → 0 across twelve batches and 235
files. `noNonNullAssertion` went biome 1064 → 0 across nine commits. Both biome rules now sit
at `"error"` in `biome.json`'s `test/**` override, explicitly. The residual regex readings
(`asAny` 1, `anyType` 10, `nonNullAssert` 2) are comments and string fixtures which biome does
not see, and are baselined as such.

`looseCast` is not a target. It exists so the TS2352 population ("convert the
expression to `unknown` first") cannot escape into unmarked single casts. That job
matters **more** now, not less: with `as unknown as` baselined at 0, a single `as X`
is the cheapest way to reintroduce the debt under a name the closed ratchet does not
see. Driving it down is not progress; keeping it from rising is.

### What is already done

The typecheck half is finished and gated. `bun run typecheck` compiles all three projects:

```
bun x tsc --noEmit && bun x tsc --noEmit -p tsconfig.contracts.json && bun x tsc --noEmit -p tsconfig.test.json
```

`check:test-typecheck`, its baseline and its parser are deleted — a counting ratchet at zero
reports a number where `tsc` reports a file and a line. Issue #1514 is closed. Against the
original start: test typecheck **2009 → 0 (−100%)**, casts **815 → 0 (−100%)**.

All five endgame steps from `archive/2026-08-22-1514-phase3c-test-debt-drain.md` §6 are done:
`tsconfig.test.json` wired into `typecheck`; `check:test-typecheck` and its baseline deleted;
the two cast ratchets kept as the permanent invariant; the `test/**` biome exemptions retired
by promotion to `"error"`; `.nax/rules/test-ratchets.md` updated and #1514 closed. What
follows is the residue the endgame never covered — the counters with no biome rule behind
them.

---

### 0.1 Measure with a parser where one exists

**The regex counter is not a drain's finish line whenever a linter can see the same shape.**
`scripts/check-test-escape-hatches.ts` is raw text; its own doc comment concedes the ceiling.
On the last drain that gap was 272 uncounted sites — the regex read 792 where biome read 1064
(`archive/LOG-non-null-assertion-drain.md`). **Zero on the ratchet was not zero on the rule.**

Take the authoritative count from biome's JSON reporter. Test-scoped rules are configured in
the `test/**` override, so point `--config-path` at a copy with that override dropped — the
repo's own config and lockfile are never modified:

```bash
# build a probe config: same as biome.json, minus the test/** exemption
mkdir -p /tmp/biome-probe
python3 - <<'EOF'
import json
c = json.load(open("biome.json"))
c["assist"] = {"actions": {"source": {"organizeImports": "off"}}}   # drop assist noise
c["overrides"] = [o for o in c["overrides"] if "helpers" in o["includes"][0]]
json.dump(c, open("/tmp/biome-probe/biome.json", "w"), indent=2)
EOF

bun x @biomejs/biome@2.5.10 check --config-path=/tmp/biome-probe . \
  --reporter=json --max-diagnostics=50000 2>/dev/null \
| python3 -c "
import json, sys, collections
d = [x for x in json.load(sys.stdin)['diagnostics']
     if x['location'].get('path', '').startswith('test/')]
c = collections.Counter(x['category'] for x in d)
for k, v in c.most_common(): print(f'{k}: {v}')
"
```

Swap the final `Counter` for one keyed on `x['location']['path']` to get a per-file ranking.

Two notes on the invocation. **Scope with `.` plus the python path filter, not a bare `test/`
argument**: biome resolves a path argument against the directory holding `--config-path` unless
it is absolute, so `test/` from the repo root can silently check an empty directory and report
zero. The JSON reporter also returns diagnostics for `src/` / `bin/` and the `.nax` acceptance
tests, so filter to `test/` in python — otherwise the count includes scope biome already gates.
`--reporter=json` was **not** truncated in testing — it returned all ~2900 diagnostics with and
without `--max-diagnostics` — but pass the flag anyway: the human and summary reporters do stop
early (they cap at 20 by default and print "Diagnostics not shown: N"), so anyone adapting this
to a different reporter gets a silently short count. Keep `organizeImports` off in the probe, or
every unsorted import inflates the list.

**The four remaining counters have no biome rule behind them.** `as never`, `test-ratchet-allow`,
`@ts-expect-error`/`@ts-ignore` and `absentValue<T>()` are all shapes biome has no lint for, so
for these the regex ratchet *is* the measure and its per-file listing is the queue:

```bash
bun run scripts/check-test-escape-hatches.ts --list
```

There is no hidden-population risk here as there was for `!` — but there is the opposite one:
the regex is text, so a drain "finishes" the moment the text stops matching. Whether the site
was fixed or reworded is on review (§4), and there is no parser to catch the difference.

Use the regex ratchet for what it is good at — failing a PR that *adds* debt, on every commit,
in milliseconds.

---

## 1. Current target — `asNever` (603 sites, 117 files)

`as never` is assignable to **every** type, so it silences any assignment error outright — a
strictly stronger escape hatch than `as any`, and lowercase, so `looseCast` (which anchors on
an uppercase initial) never saw it. It is the largest counter left with a real drain behind it.

The queue, top of the per-file listing:

| Sites | File |
|--:|:--|
| 38 | `test/integration/execution/runner-parallel-metrics.test.ts` |
| 28 | `test/unit/cli/plan.test.ts` |
| 24 | `test/unit/execution/unified-executor-logging.test.ts` |
| 23 | `test/unit/operations/plan-refine.test.ts` |
| 21 | `test/unit/cli/plan-replan.test.ts` |
| 20 | `test/unit/execution/unified-executor-dispatch.test.ts` |
| 17 | `test/unit/execution/unified-executor-results.test.ts` |
| 17 | `test/unit/debate/runner-plan.test.ts` |
| 16 | `test/unit/execution/unified-executor-cost.test.ts` |
| 13 | `test/unit/cli/plan-interactive.test.ts` |
| 13 | `test/unit/cli/plan-decompose-debate.test.ts` |
| 12 | `test/unit/agents/manager-swap-loop.test.ts` |

Regenerate it any time with `bun run scripts/check-test-escape-hatches.ts --list`.

**The population is overwhelmingly argument position, not assignment.** Sampled across the
top files: `executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never)`,
`planCommand(tmpDir, DEFAULT_CONFIG as never, {…})`, `{ runOptions: { storyId: "s1" } as never }`.
Roughly 380 of the 603 sit directly before a `,` or `)`. That shape says the same thing every
time: **a local builder or shared fixture returns a partial, and the cast is re-applied at every
call site instead of once at the builder.**

So the route order inverts the last drain's. Start at the builder:

1. **Type the builder's return.** A `makeCtx` / `makePrd` / `DEFAULT_CONFIG` that returns an
   inferred partial forces the cast on all 38 of its callers. Give it the real type and every
   cast falls out at once — the same shape as the shared-helper finding the last drain closed
   (a trailing cast on a mock helper hides an interface defect from every consumer and from
   the ratchet). Fix the builder, not the call site.
2. **Complete the fixture** the builder returns, if typing it exposes missing required fields.
   If the compiler is right that the mock is incomplete, complete the mock.
3. **Narrow the parameter** when the function genuinely only reads a slice — interface
   segregation at the callee beats a cast at the caller, and it is the move that broke the last
   drain's held escalation open. This is a `src/` change: it must *loosen nothing*, and per §5
   it is an escalation candidate, not a free hand.
4. **`absentValue<T>()` / `nullValue<T>()`** only where the absence *is* the assertion. That
   trades `asNever` for `absentValue`, which §4 forbids as a counter trade — so it is legitimate
   only when the test is genuinely asserting on an absent value, and must be called out in the
   commit body, not slipped in under the delta.

Do **not** replace `as never` with `as any`, `as unknown as`, or a single `as T`. All three are
counter trades, and the last two are strictly weaker claims about the same site.

## 2. The loop — per unit of work

```bash
# 1. see this unit's sites. `as never` has no biome rule, so the ratchet is the
#    measure (§0.1); use the biome probe instead for any counter a rule does see.
grep -n 'as never' <path>

# 2. fix (see forbidden list)

# 3. this file still passes
bun test <path> --timeout=60000
```

## 3. The loop — per commit, in this order

```bash
bun run typecheck        # src + contracts + test, all three must be 0
bun run check:all        # 24 gates green BEFORE any --update-baseline
bun run test             # full suite green
bun run check:test-as-unknown-as:update
bun run check:test-escape-hatches:update
git diff scripts/baselines/   # the target count DOWN, every other counter FLAT
```

**Never run `--update-baseline` before `check:all` is green.** The update writes whatever it
finds, including a regression.

Run `bun run test:coverage` as well, not just the suite, whenever an edit changes a value that
a classifier or switch reads (a status string, an outcome, a story/PRD shape). A per-file
coverage floor catches what a typecheck cannot: correcting an impossible fixture value can
delete a default branch's only coverage.

Commit as `test: <what>` with a body line carrying the delta, e.g. `asNever: P → Q`.

## 4. Forbidden — these lower the number without doing the work

- Adding `as any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as never`, or
  `as unknown as`.
- Adding `// test-ratchet-allow: …` or any `// biome-ignore …` line.
- Replacing `x as never` with `x as any`, `x as unknown as T`, or a single `x as T` — all
  three trade `asNever` for another counter, and the last two assert strictly less about the
  same site.
- Moving a cast from a builder's call sites into the builder's own return (`return {…} as T`).
  That is one counter hit instead of thirty-eight, which reads as a win and is the exact
  shape §1 route 1 exists to fix: the trailing cast hides the interface defect from every
  consumer *and* from the ratchet.
- Replacing `x!.y` with `x?.y` in an assertion. It narrows, and it **passes vacuously** when
  the value is absent — a real failure turned green. (`test/helpers/assert-defined.ts`.)
- Deleting a comment that merely *mentions* the phrase.
- Joining two lines into one, or reflowing to lower a count.
- Deleting, skipping, or `.skip`-ing a test, or narrowing a `describe`.
- Excluding a file from `tsconfig.test.json`.
- Weakening a **source** type in `src/` so a fixture fits. The fixture is wrong, not the type.
- Trading one counter for another. The system is closed: no counter may rise so another can
  fall. `git diff scripts/baselines/` is the check.
- Running `--update-baseline` on a count that grew.

The escape-hatch ratchet enforces the first two mechanically. The rest are on review.

**The right fix, every time:** the test claims to hold a `T`. Make it actually hold a `T` —
complete the fixture, tighten the helper's return type, correct the arity, import the type.
If the compiler is right that the mock is incomplete, complete the mock.

## 5. Escalate instead of guessing when

- The error says a **source** type is wrong, not the fixture. (This has produced real issues
  twice — #1702 was two of them.)
- Removing the escape hatch changes what the test asserts.
- A fixture change makes a *different* test fail. That test was relying on the wrong shape;
  report it, do not paper over it.
- Removing the escape hatch reveals the mock cannot satisfy the interface at all.
- The same file fails twice in a row. Two attempts, then hand it back.

## 6. Rulings carried forward

These cost real time to learn and apply unchanged. Section numbers below name the archive
they were earned in: §4x = `archive/STATUS-1514-typecheck-drain.md`, §8.x of the cast drain =
`archive/LOG-as-unknown-as-drain.md`, and the `noExplicitAny` §8.2x =
`archive/LOG-no-explicit-any-drain.md`.

- **Re-check the ratchet slack before every hand-off** (§0). Every drain commit that lowers a
  counter without re-baselining re-opens headroom a delegate can spend without noticing. This
  re-opened and was reclaimed seven times on the last issue.
- **There is usually a third option** (§44, §47). Between "delete the test" and "widen `src/`
  to fit the fixture" sits "assert what is true now". Four inert `try {} catch {}` tests
  became one executable one that fails the day the feature is wired.
- **A defensive `?.` is not evidence of a tolerated absence** (§44). If the schema carries
  `.default()`, the key is always present after parse and the fixture was pinning an
  impossible state. It was load-bearing for `noNonNullAssertion` — most `!` sites were the
  same claim in the opposite direction — and it is load-bearing again here: a builder whose
  callers all write `as never` is usually pinning a shape the real type never permits.
- **You do not have to reach a value through the seam that broke** (§44). The error names the
  seam, not the fix. Exporting the op was additive and loosened nothing.
- **"No caller in this file" is not "no caller"** (§47a). Scope the grep to the repo before
  concluding a feature is missing. This produced a wrong entry in a status doc and a wrong
  claim in a commit message.
- **An accepted exception is a ruling, not a law** (§47). A tier-3 "undrainable" ruling turned
  out to be an argument against `mock()`, not against the assignment; a plain generic arrow
  satisfied the slot.
- **"Every route out trades a counter" is a survey, not a proof** (cast drain §8.13). Three passes
  inherited the same three-option frame (structural stub / cast / src change) and declared a
  17-site floor. The question that broke it was "what does this class's constructor actually
  require?", asked once. Before writing "undrainable", enumerate again.
- **A "src-blocked" ruling names a seam the author had in mind, not the seam the error
  demands** (`noExplicitAny` §8.25). Re-derive which property of the site rejects the test; the held
  escalation's own report is evidence, not a specification. This turned a proposed dependency
  injection into a one-line interface-segregation change.
- **Inert tests are the third population.** `try { … } catch {}` bodies outlive the refactors
  that invalidate them precisely because they cannot fail.
- **Verifying a cluster costs about as much as doing it.** Delegate a proven recipe with many
  sites left, not a small cluster — under roughly ten sites the review pass finishes the work.
- **Reproduce against the project's own script** (cast drain §8.13), not a hand-rolled invocation of the
  same test files. `bun test <dir>` misses `--timeout=60000` and turns a passing suite into a
  cascade of misleading failures. Run the gate, then read its exit code.

## 7. Where the archived detail lives

| Doc | Holds |
|:--|:--|
| `archive/LOG-as-unknown-as-drain.md` | the closed `as unknown as` drain, nine commits, 101 → 0 |
| `archive/LOG-no-explicit-any-drain.md` | the closed `noExplicitAny` drain, twelve batches, 235 files, biome 1529 → 0 |
| `archive/LOG-non-null-assertion-drain.md` | the closed `noNonNullAssertion` drain, nine commits, biome 1064 → 0 — including the `assertDefined` recipe record and the regex-vs-biome measurement gap |
| `archive/STATUS-1514-typecheck-drain.md` | the full 47-section log of the typecheck drain |
| `archive/2026-08-22-1514-phase3c-test-debt-drain.md` | the parent plan — gate inventory, biome interaction, phasing |
| `archive/PLAN-1514-callop-seam.md` | the `callOp` generic-in-return-position analysis |
| `archive/HANDOFF-explicit-any-batch*.md` | the four `noExplicitAny` delegation briefs (batches 8–11) |
| `archive/HANDOFF-cast-drain-batch1.md` | the `as unknown as` batch-1 brief |
| `archive/HANDOFF-1514-*.md` | eleven completed typecheck-drain briefs and their recipes |
| `.nax/rules/test-ratchets.md` | the live rule the gates enforce |

Every ruling from those logs that is still load-bearing has been lifted into §6. Read §6 before
opening an archive; open the archive when §6's one-line version is not enough to act on.

---

## 8. Log

Entries below cover the current drain (`asNever`). The three closed drains' logs are in
`archive/` per §7 — they were lifted out on 2026-08-26 when `noNonNullAssertion` closed.

### 8.1 Batch 1 — one typed builder, three files, 603 → 547 (2026-08-26)

First unit of the drain, and it validated §1's population claim exactly: the top file's 38
sites were not 38 problems but one — `_parallel-metrics-helpers.ts#makeCtx` returned an
inferred object-literal partial, so all three importer files
(`runner-parallel-metrics`, `-cost-duration`, `-rectification-events`) re-applied
`as never` at every `executeUnified` call site. 56 sites across the three files
(38 + 10 + 8), overwhelmingly argument position.

Fixed at the builder per route 1, using the recipe `unified-executor-fallback-seam.test.ts`
already proved: `makeCtx` now returns `SequentialExecutionContext` — `DEFAULT_CONFIG`
spread with the execution overrides it was pinning (`maxIterations`/`costLimit`/
`iterationDelayMs: 0`/`rectification.maxAttemptsTotal: 2`), `EMPTY_HOOKS`,
`makePluginRegistry()`/`makeStatusWriter()`, and `makeDispatchContext` over a
`makeTestRuntime` wired with `createNoOpCostAggregator()` so cost accounting stays
deterministic exactly as the old hand-rolled stub's always-zero snapshot was. Every call-site
cast then fell out with no other edit; `makePrd` already returned `PRD`.

Typing surfaced two latent fixture defects the cast had been hiding: `hooks: {}` was not a
`LoadedHooksConfig`, and the hand-rolled runtime carried no `projectKey` (read by
`wireReporters`). Both fixed by completing the fixture to the real types — nothing in `src/`
loosened, no counter traded.

typecheck 0/0/0, check:all 24/24, full suite green before `--update-baseline`; baseline diff
shows asNever −56, every other counter flat.

### 8.2 Batches 2a–2f — six commits, eight files, 547 → 393 (2026-08-26)

Six commits in one drain session, dropping 154 sites across eight files. Per §6's
"verifying a cluster costs about as much as doing it" ruling, batched closely-related
files together when the recipe matched, kept unrelated ones in their own commit.

**2a — `test/unit/cli/plan.test.ts` (−28).** Twenty-eight sites were pure cargo-copies
of `DEFAULT_CONFIG as never` — `DEFAULT_CONFIG` is already typed as `NaxConfig` and
`planCommand` takes `NaxConfig`, so the casts were always redundant. The one
substantive site was `{} as never` for "throws when nax directory not found":
substituted `DEFAULT_CONFIG` since `buildPlanModeContext` throws on `.nax` existence
before reading config.

**2b — `test/unit/execution/unified-executor-logging.test.ts` (−24).** Exact §1 recipe.
`makeCtx`/`makePrd` were inferred partials; typed as `SequentialExecutionContext`/`PRD`,
completed via the shared helpers (`makeDispatchContext`, `makePluginRegistry`,
`makeStatusWriter`, `makeMockRuntime`). Surfaced four latent defects: `hooks: {}` not
`LoadedHooksConfig`; `pluginRegistry` partial; hand-rolled runtime literal covering
the nax#1709 stores (which `createRuntime` already builds); `autoMode.defaultAgent`
removed in the agent config migration (spread `DEFAULT_CONFIG` instead).

**2c — `unified-executor-{dispatch,results,cost}.test.ts` (−53).** Same recipe across
three files. `results.test.ts` already imported the shared `makeNaxConfig`/`makePRD`/
`makeStory` helpers, so its local `makeCtx` collapsed to one call site. `cost.test.ts`
was the tricky one: two sites overrode `config.interaction.triggers` — the spread of
`NaxConfig.interaction` (typed optional even though `.default()` always fills it) widens
to `Partial`, and the compiler rejected the override. Fixed by extracting typed locals
(`costWarningInteraction: InteractionConfig`, `costExceededInteraction: InteractionConfig`)
that carry every required field. No counter traded.

**2d — `test/unit/cli/plan-replan.test.ts` (−21).** All `as never` were on
`_planDeps.X = mock(...)` assignments — `mock()` returns a generic mock type that's
structurally assignable to `_planDeps`'s concrete function fields (`Promise<string>`,
`Promise<PrecheckResultWithCode>`, etc.), so every cast was redundant.

**2e — `test/unit/operations/plan-refine.test.ts` (−23).** `makeValidPrd`/`prdWith`
were inferred objects; typed them as `PRD`, casts on `normalizeCreatedContextFiles`
callers fell out. Also completed the `verify()` call sites (typed `input` as
`PlanRefineInput`; the optional fields are genuinely optional, just need an explicit
type) and replaced `fileOutput?.({ outputPath } as never)` with a complete input.
`story0`'s `as { contextFiles?: unknown[]; expectedFiles?: string[] }` (already 1
looseCast at baseline) became `assertDefined(prd.userStories[0], …)` — kept the trade
flat, didn't add a new one.

**2f — `test/unit/debate/runner-plan.test.ts` (−5).** Five sites on `stages: { plan: {}
as never, review: {} as never, ... }` — the file already exported `makePlanStageConfig()`
that returns a complete `DebateStageConfig`. Substituted the helper, all five drops.

**Held back: 12 mockImplementation `as never` in runner-plan.test.ts.** Those guard the
generic `<I, O, C>` signature of `mockImplementation` against the
`{ success: true, rebut: ... }` literal returns — `O` is generic so the literal can't
be widened without a counter trade (`as DebateHybridOutput` / `as DebatePlanOutput`).
Per §5 this is a "two attempts then hand back" rule; not pursued this session.
Next batch should revisit with a typed mock factory helper if the per-counter trade
is acceptable, or leave them as the cost of generic mock signatures.

typecheck 0/0/0, check:all 24/24, full suite green before each `--update-baseline`;
baseline diff per commit shows asNever strictly decreasing, every other counter flat.

### 8.3 Batches 3a–3f — six commits, eight files, 393 → 323 (2026-08-26)

Six commits in one drain session, dropping 70 sites across eight files. Per §6's
"verifying a cluster costs about as much as doing it" ruling, batched closely-related
files together when the recipe matched, kept unrelated ones in their own commit.

**3a — `test/unit/cli/plan-interactive.test.ts` (−13).** Same recipe as 2a — `DEFAULT_CONFIG`
is `NaxConfig`, `planCommand`'s `config` parameter is `NaxConfig`, the cargo `as never` was
redundant on all thirteen invocations. Single edit; per the §6 ruling on the file pattern
this is the "third option" the 2a log mentioned: complete the fixture by recognising the
cast was always cargo.

**3b — `test/unit/cli/plan-decompose-debate.test.ts` (−12).** Twelve `mock(() => ({ run:
mock(...) })) as never` assignments to `_planDeps.createDebateRunner`. The plan-debate.test.ts
file already solved the same shape by returning `makeDebateRunner(...)` — the helper
constructs a real `DebateRunner` via `Object.assign` so its `run`/`runPlan` slots are bun
mocks satisfying `toHaveBeenCalledWith`. Reused verbatim. **Held back the one remaining
inner `} as never,` in `makeConfigWithDebate`**: it hides the `decompose` stage src/
already reads via `as unknown as Record<string, DebateStageConfig>` (`src/cli/plan-decompose.ts:86`)
— a `DebateConfig.stages.decompose?: DebateStageConfig` additive change. Per §5 that's a
src/ additive change, not a free hand; recorded as the next batch's candidate rather
than slipped in under this delta.

**3c — `test/unit/agents/manager-swap-loop.test.ts` (−12).** All twelve were bare `{ storyId:
"s1" } as never` / `{} as never` on the `runOptions` slot of `runWithFallback`. The fix
is a per-file `makeRunOptions` helper returning a complete `AgentRunOptions`:
`config: agentManagerConfigSelector.select(DEFAULT_CONFIG)` narrows to `AgentManagerConfig`
(`Pick<NaxConfig, agent|execution|profile>`) without a cast. Per-file because three nearby
files (manager.test.ts, manager-abort.test.ts, manager-types-phase5.test.ts) use a slightly
different `runOptions` slice; a shared helper would need an overrides signature broad
enough to swallow them all, which is the 3d batch's territory.

**3d — three more manager tests (−12).** Extended the 3c recipe to manager-abort.test.ts (3),
manager-types-phase5.test.ts (1), and manager.test.ts (8). Same `makeRunOptions` helper per
file. manager.test.ts also had two non-`runOptions` `as never` sites in the same file: the
`makeManager` helper (NaxConfig spread into AgentManagerConfig) and a `bundle: { files: []
} as never` that pinned an impossible shape (`ContextBundle` has `chunks`, not `files`).
Replaced with `agentManagerConfigSelector.select(...)` for the config helper and
`makeContextBundle()` for the bundle (already in `test/helpers`), completing the file.

**3e — `test/unit/operations/plan-refine-out-of-scope.test.ts` (−11).** Three structural
fixes for eleven sites: `const input: PlanRefineInput` (5), `function makeVerifyCtx():
VerifyContext<PlanConfig>` (5), drop the cargo `makePrd() as never` (1). The local
`makePrd` already returns `PRD` via `makePRD`; the cast was redundant. No src/ change.

**3f — `test/unit/execution/rectification-oscillation-circuit-breaker.test.ts` (−10).**
Three distinct fixes: the eight `ctx.config = { ...ctx.config, review: { ...,
conflictDetection: ... } } as typeof ctx.config` were all cargo — `NaxConfig.review.
conflictDetection` is in the schema and the spread produces a valid `NaxConfig`. `as
typeof ctx.config` is not looseCast (`typeof` starts lowercase) so dropping it loses
nothing. The two `config: testSel as never` on `RunOperation<...>` had a C-type mismatch
— `testSel` is a `ConfigSelector<Pick<NaxConfig, "execution">>` but C was `typeof
DEFAULT_CONFIG`. Fixing C to match the selector (a typed alias `ExecutionSlice`) drops
both casts. The eight `makeTestContext({ story: { id, title } as never })` — `Partial<UserStory>`
can't satisfy `UserStory`; the existing `makeTestStory(overrides)` helper in
`test/helpers/pipeline-context.ts` returns a complete `UserStory`.

typecheck 0/0/0, check:all 24/24, full suite green before each `--update-baseline`;
baseline diff per commit shows asNever strictly decreasing, every other counter flat.
Cumulative: asNever 603 → 323 (−280) across 18 files since the drain started.
