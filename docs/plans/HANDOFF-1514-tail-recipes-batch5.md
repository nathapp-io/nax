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
