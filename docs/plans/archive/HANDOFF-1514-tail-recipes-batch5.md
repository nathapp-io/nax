# Handoff: #1514 tail batch 5 — draining the remaining 219

Branch `chore/1514-tail-batch5-drain`, forked from `main` @ `9908767a7` (batch 4, PR #1701).
Measured on that tree: test typecheck **219**, `as unknown as` **102**, and **every escape-hatch
counter exactly at baseline** (`asAny=1386 tsSuppress=40 ratchetAllow=106 absentValue=17
anyType=1875 looseCast=1923 asNever=615 nonNullAssert=827`).

**There is zero slack in any ratchet.** A fix that adds one `as any`, one `as never`, one `!`,
or one `@ts-expect-error` fails the gate outright. This is the constraint that shapes the whole
batch.

---

## 0. Scope and rules

**Allowed:** edits to `test/**`. Minimal, justified edits to `src/**` and `test/helpers/**` are
permitted **only** when the fixture is right and the type is wrong (the phase-2 "make the type
say what the code does" move) — never to widen a `src` type so a wrong fixture compiles.

**Forbidden without escalating:**
- Any new escape hatch (`as any`, `as never`, `as unknown as`, `!`, `@ts-expect-error`,
  `: any`, ratchet-allow markers). All eight counters are at baseline.
- Widening a `src/` type to fit a fixture.
- Deleting a dead key that carries a **non-default value** — that is a behaviour change, not a
  type fix (batch-4 hazard, `STATUS §41`: `costUsd: cost` looked dead but the value was live).
- Editing a shared `test/helpers/**` fixture factory with many consumers. Name the file, say how
  many consumers, escalate. (`STATUS §4a`: an executor extended `FakeProcSpec` — 69 consumers —
  without asking.)

**Per commit, all six steps, in order:**

1. `bun x tsc --noEmit` → must stay **0** (src).
2. `bun run check:test-typecheck` → count must not rise; **the gate reports per-file rises
   itself** — no file may go up, and no new file may appear.
3. `bun run check:test-escape-hatches` → all eight counters equal or lower.
4. `bun run check:test-as-unknown-as` → 102 or lower.
5. `bun run lint:fix` then `bun run lint` → green. **An added annotation reorders imports and
   pushes lines past biome's width; every batch-4 prototype failed `biome check` until
   formatted.**
6. Run the touched test file(s): `bun test <path> --timeout=30000` → same pass/expect counts as
   before the edit.

One commit per file. Conventional commit: `test: drain #1514 tail — <file> (<n> errors)`.

**Do not update any baseline.** Re-baselining happens once, by the owner, at the end of the
batch. If you re-baseline mid-batch you hide the slack and the next round has to reclaim it —
this has already recurred four times on this issue.

---

## 1. Group 1 — `TS2353` dead fixture keys (38 errors, 27 files) ← START HERE

The proven recipe from PR #1686 (`dead-fixture-keys`). A key is in the literal that the target
type does not have. Almost always the fix is **delete the key** — which is line-*reducing*, so
`check:file-sizes` is safe here (unlike batch 4's annotation recipe).

### The floor caveat — read this before measuring

**`TS2353` reports ONE excess-property error per object literal.** If a literal has three dead
keys, tsc names only the first; removing it reveals the second on the next compile. So:

> **The batch total will NOT drop by exactly 38.** A commit that removes a real dead key and
> leaves the file's count unchanged (because a second dead key surfaced) is a **correct commit**
> — commit it and keep going on that file. Do not treat "total didn't move" as a failed fix, and
> do not hunt for a different edit.

The gate's rule is only that no count **rises**.

### Before deleting any key, decide which of three cases it is

| Case | Signal | Fix |
|:--|:--|:--|
| **Dead key** | nothing in the test reads it; the value is a default/placeholder | delete it |
| **Renamed key** | the type has a near-identical sibling (`maxRetries` vs `maxAttempts`, `run` vs `complete`) | rename to the real key |
| **Live value on a dead key** | the value is a parameter or a computed value the assertion depends on | **escalate — do not delete** |

Check by grepping the test for the key name and for what the assertions read.

### The rows, grouped by sub-family

**1a — `DeepPartial<*Config>` legacy config keys (12).** These are the ADR-012 family: config
fields that were removed from the schema but survive in fixtures.

```
test/integration/routing/routing-stage-final-state.test.ts(125,5)      'analyze'   -> DeepPartial<NaxConfig>
test/integration/routing/routing-stage-greenfield.test.ts(142,5)       'analyze'   -> DeepPartial<NaxConfig>
test/unit/precheck/precheck-run-story-size-gate-routing.test.ts(104,5) 'analyze'   -> DeepPartial<NaxConfig>
test/unit/routing/llm-batch-route.test.ts(32,9)(53,9)(72,9)            'adaptive'  -> DeepPartial<RoutingConfig>
test/unit/precheck/checks-warnings.test.ts(203,23)(218,23)             'enabled'   -> DeepPartial<SemanticReviewConfig>
test/unit/operations/execution-gates.test.ts(17,28)                    'maxRetries'-> DeepPartial<RectificationConfig>
test/unit/cli/plan-callop.test.ts(283,43)                              'tier'      -> DeepPartial<Debater>
test/integration/pipeline/pipeline-events.test.ts(38,7)                'maxAttempts' -> DeepPartial<escalation tierOrder block>
```

Careful with `'enabled' -> DeepPartial<SemanticReviewConfig>` and `'maxRetries'`/`'maxAttempts'`
— these are the classic **renamed-key** shape, not dead. Read the schema in
`src/config/schemas.ts` first.

**1b — `PRD` / `UserStory` shape (7).**

```
test/integration/context/context-provider-injection.test.ts(37,5)  'version'     -> PRD
test/integration/context/context-provider-injection.test.ts(30,5)  'reasoning'   -> UserStory
test/unit/execution/crash-recovery.test.ts(129,9)(256,9)           'version'     -> PRD
test/unit/prompts/builders/critic-builder.test.ts(30,57)(198,60)   'stories'     -> Partial<PRD>
test/unit/prompts/builders/critic-builder.test.ts(47,9)            'specContent' -> Partial<PRD>
```

`'stories' -> Partial<PRD>` is suspicious — `PRD` certainly has stories. Read the actual
annotation at the site; it is probably a narrower local type, and the fix is the annotation, not
the key.

**1c — `AgentAdapter` ACP legacy (4).** ACP has no `run`/`plan`; batch 4 hit the same unmask in
`acceptance-loop-routing`. Verify nothing reads them, then delete.

```
test/integration/plugins/plugins-registry.test.ts(107,15)  'run'  -> AgentAdapter
test/integration/plugins/validator.test.ts(166,19)         'run'  -> AgentAdapter
test/unit/agents/manager-credentials.test.ts(19,5)         'run'  -> Partial<AgentAdapter>
test/integration/tdd/_tdd-test-helpers.ts(84,5)            'plan' -> AgentAdapter
```

> `_tdd-test-helpers.ts` is a **shared helper**. Count its consumers before editing; if more than
> a couple, escalate rather than reshaping it.

**1d — singletons (15).** One or two per file, each its own judgement call.

```
test/unit/runtime/middleware/cancellation.test.ts(14,5)(39,7)(55,7)          'prompt' -> MiddlewareContext
test/unit/operations/build-hop-callback-stale-retry.test.ts(119,51)(136,51)  'attempt' -> '{ kind: "primary" }'
test/unit/debate/runner-stateful.test.ts(27,5)                               'handle' -> SuccessfulProposal
test/unit/debate/selectors/verifier-pick.test.ts(23,5)                       'handle' -> SuccessfulProposal
test/unit/precheck/precheck-canonical-lint-orchestrator.test.ts(24,5)  'requireExplicitContextFiles' -> ExecutionConfig
test/unit/precheck/precheck-canonical-lint-orchestrator.test.ts(31,5)  'defaultAgent' -> AutoModeConfig
test/unit/agents/manager-iface-run.test.ts(242,7)                'model' -> CompleteOptions
test/unit/cli/setup-write.test.ts(25,53)                         'language' -> QualityConfig
test/unit/context/engine/stage-assembler.test.ts(404,50)         'providerTimeoutMs' -> '{ budgetTokens?, extraProviderIds? }'
test/unit/execution/lifecycle/acceptance-loop-skipped-packages.test.ts(260,15) 'failedACs' -> '{ missingTargets? }'
test/unit/pipeline/subscribers/hooks.test.ts(47,7)               '"on-story-complete"' -> LoadedHooksConfig
test/unit/tdd/orchestrator-totals.test.ts(125,51)  'rectificationEnabled' -> FullSuiteGateInput
test/integration/execution/prd-pause.test.ts(53,7)               'fallbackToKeywords' -> (routing literal)
```

`'defaultAgent' -> AutoModeConfig` is the ADR-012 Phase-6 removal (`config.autoMode.defaultAgent`
no longer exists). `verifier-pick.test.ts` is known to carry a second masked error (`STATUS §34`)
— expect a flat measurement there and commit anyway.

---

## 2. Groups 2–4 — not yet in scope

Dispatch order is one group at a time; each group's shape is re-measured after the previous one
lands, because `TS2353` deletions unmask errors in other codes.

| Group | Code | Count at 219 | Shape |
|:--|:--|--:|:--|
| 2 | `TS2339` | 24 | property-does-not-exist; fragmented, needs a read pass first |
| 3 | `TS2322` | 64 | ~40 distinct shapes, max 4 per shape — **owner work, not delegable as one recipe** |
| 4 | `TS2352` | 30 | sites that **already carry an `as` cast**; touching them risks `looseCast`/`asNever` and there is no slack. **Out of scope until slack exists.** |

The remainder (`TS2345` 17, `TS2349` 14, `TS2554` 12, `TS2783` 7, and 13 singletons) is a flat
tail with no recipe.

---

## 3. Escalate, don't improvise

Stop and report instead of guessing when:

- The only fix needs a new escape hatch.
- The wrong side is `src/` and correcting it changes runtime behaviour.
- The dead key holds a value the test's assertions depend on.
- The fix touches a shared `test/helpers/**` factory with more than a couple of consumers.
- A test's pass/expect counts change after the edit.

An escalation with the row, the two candidate fixes and why you stopped is a **success**, not a
failure. Batch 4's most valuable output was two such calls.

---

# Outcome — batch 5 complete: 219 → 21 (−198, −90%)

Ten groups, one delegated agent at a time, 59 commits on `chore/1514-tail-batch5-drain`.
Verified at each step, not taken from the agents' reports: `bun x tsc --noEmit` (src) **0**,
`bun run check:all` **green**, full suite **green (14138 tests, 0 fail)** after every group.

| Group | Family | Δ |
|:--|:--|--:|
| 1 | `TS2353` dead fixture keys | 219 → 191 |
| 2 | `TS2349` `op.model?.()` union + `TS2783` duplicate keys | 191 → 170 |
| 3 | callback-assignment `never` narrowing + `TS2554` arity | 170 → 149 |
| 4 | `TS2345` argument mismatches | 149 → 134 |
| 5 | fake-agent-manager contract + `TS2540`/`TS2532` + singletons | 134 → 120 |
| 6 | `ChunkKind` literals + `TS2339` tail | 120 → 101 |
| 7 | `TS2352` — fixture fixed, cast deleted | 101 → 78 |
| 8 | `TS2322` function-slot family | 78 → 55 |
| 9 | `TS2322` wrong-literal / partial-object | 55 → 31 |
| 10 | final singletons | 31 → 21 |

**No counter was ever traded.** Every escape hatch ended at or below its starting value:
`as unknown as` 102 → **101**, `looseCast` 1923 → **1910**, `asNever` 615 → **608**,
`anyType` 1875 → **1872**, `asAny` 1386 → **1385**; `tsSuppress`/`ratchetAllow`/
`absentValue`/`nonNullAssert` flat. Baselines re-tightened twice (after group 6 and at the
end) — the slack this drain re-opens has now recurred six times on this issue.

**`src/` was never edited.** One helper was added (`test/helpers/op-model.ts`) and one fixed
(`fake-agent-manager.ts`); nothing else under `test/helpers/` was touched.

## The 21 survivors — all accepted or deliberately held back

> **Superseded 2026-08-25 — ten of these twenty-one were drainable.** The rulings below were
> re-checked against the source one row at a time and three of the four buckets were wrong:
> the "115 consumers" blast radius did not apply to the edits in question, two "src typing
> gap" rows pinned a state the schema defaults make unreachable, and one "would change what
> the test asserts" row was two dead ACP keys. Typecheck is now **11**. Read
> `STATUS-1514-drain.md` §44 before acting on anything in this section — it carries the live
> ruling for each remaining row, and the three ways the reasoning here went wrong. The
> `callOp` tier-3 bucket is the only one that survived intact.

**Do not "fix" these without reading the reason.** None is a missed row.

### Genuine `src/` typing gaps — file these, do not patch the test (5 rows)

1. **`FixStrategy.fixOp` cannot accept deps** — `gating-preservation.test.ts(468)(484)` and
   `story-scoped-fix-budget.test.ts(568)`. `FixStrategy.fixOp` is typed `Operation<I,O,C>`
   (`src/findings/cycle-types.ts:168`), and that alias hard-fixes the deterministic variant's
   `D` to `never` (`src/operations/types.ts:317-320`). So no `fixOp` reached through a
   `FixStrategy` can take a real deps object — only `undefined`. The tests want to inject a
   spy dep and assert it is never called. **The tests are right and the type is wrong.**
   Third sighting adds `RunOperation.model`'s contravariance in `I` as the same shape.
2. **`TestPatternConfig` requires what the code defends against** — `resolver.test.ts(227)(229)`.
   `resolveTestFilePatterns` reads `config.execution?.smartTestRunner` with optional chaining
   *specifically* to tolerate an absent `execution`, but `TestPatternConfig =
   Pick<NaxConfig,"execution"|"project"|"quality">` types it required. The test exercises the
   absence the src code handles; the type forbids expressing it.

### Accepted by prior ruling (4 rows)

`non-blocking-fix-wiring.test.ts(127)(181)(261)(282)` — genuinely-polymorphic `callOp` /
`runFixCycle` seams. `PLAN-1514-callop-seam.md` §4 tier 3 ruled these correct as-is: the
caller picks `O`, so no concrete stub can satisfy the signature cast-free. `bun:test`'s
`Mock<T>` collapses to a single call signature, which can never satisfy a generic-in-return
position — verified empirically in group 8.

### Held back — blast radius (5 rows)

`test/helpers/mock-agent-manager.ts(162)(202)` plus the three dependent `runAsSessionFn` rows
in `test/integration/agents/*`. **115 consumers.** Same root cause as the fake-agent-manager
fix in group 5 (the manager *produces* fields the mock reads as if it received them), but too
wide to hand to a delegate on a mechanical brief. Owner work.

### Escalated with findings — each would change what the test asserts (7 rows)

- `context-provider-injection.test.ts(30)(37)` — using real `makePRD`/`makeStory` factories
  makes `buildStoryContextFullFromCtx` actually succeed instead of throwing-and-being-caught,
  flipping 2 tests from "preserves pre-set `contextMarkdown`" to "overwritten".
- `validator.test.ts(166)` — deleting the dead `run` key makes the fixture type-correct, but
  `src/plugins/validator.ts:205-215` still hard-requires `run`/`plan`/`decompose` at runtime,
  a stale pre-ACP check. Fixing the fixture makes `validatePlugin()` reject its own "valid
  plugin". **The runtime validator disagrees with the `AgentAdapter` type — worth an issue.**
- `_tdd-test-helpers.ts(84)` — shared helper, 7 consumers.
- `runner-stateful.test.ts(27)(29)`, `verifier-pick.test.ts(23)` — `handle` on
  `SuccessfulProposal`. The field exists nowhere in `src/debate/`, but the test is titled
  "carries optional handle field (compile-time check)" and cites an AC about session
  continuity. This reads as scaffolding for an unimplemented feature, not stale fixture:
  deleting it guts the contract the test exists to pin, and adding the field to `src/` to
  satisfy a fixture is the move this issue forbids.

## What this batch taught

- **Fix the type and the casts fall out.** Group 7 targeted 23 `TS2352` rows and removed
  10 `looseCast` + 4 `asNever` as a side effect. You do not drain casts by hunting casts.
- **One tsc message, two different bugs.** `"code-neighbor"` (a real *provider id*, not a
  `ChunkKind`) and a `string` that merely lost its literal type produce near-identical errors.
  Swapping the value on the second, or annotating the first, silences tsc and leaves the
  defect. Groups 6 and 9 both turned on making that call before editing.
- **The ratchets earn their keep mid-flight.** They rejected an `: any` parameter (group 3),
  an `as never` (group 6), and a line-adding annotation over `check:file-sizes` (group 8) —
  each caught inside the loop, before a commit.
- **Fixtures were asserting against impossible values.** `status: "FAILURE"`,
  `pluginMode: "per-story"`, `StoryStatus "running"`, `TestStrategy "greenfield"` — none was
  ever a member of its union. These tests passed while pinning states that cannot occur.
