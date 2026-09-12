# SPEC: Advisory and Budget Truth

## Summary

Two independent reporting-truth defects in the review and context layers. The non-blocking fix (nbf) lane seeds exclusively from `adversarial-review`'s advisory bucket, so `semantic-review`'s identical sub-threshold bucket has no fix path at all (#1957). Separately, `StaticRulesProvider` logs "Rule sections truncated by static rules budget" and reports a dropped-section count even when `context.v2.rules.enforceBudget` is `false` and nothing was dropped (#1992). This spec closes the seeding gap behind a per-reviewer `sources` switch, promotes the nbf config block to its own home under `review`, and makes the static-rules soft-mode log say what actually happened.

## Motivation

**#1957 — semantic advisories have no fix path.** Both reviewers build the same `advisoryFindings` bucket, deliberately so since #1865 / PR #1908; `semantic-review.ts:440-445` says as much in a comment. But the nbf seed reads one phase by name (`execution-plan.ts:397`), so the semantic bucket is reported at run end and then dropped.

Measured over the 5,416-record review-audit corpus in `~/.nax/*/review-audit/`, taking the final record per `(project, runId, storyId, reviewer)` and applying the real `actionableAdvisoryFindings` filter:

| | stories |
|:---|---:|
| adversarial advisories only | 472 |
| **semantic only — no fix path today** | **9** (20 findings) |
| both | 28 |
| neither | 1,217 |
| **total** | **1,726** |

So the union adds 9 nbf passes (500 → 509, +2%) plus 36 findings into passes that already run. Small, but the population is young: semantic's bucket was empty on default-config runs until `a1cc049aa` (2026-09-07) removed a `.filter(isBlockingSeverity)` that intersected the bucket with its own complement. This is the second half of that fix.

Two corpus facts shape the design. Semantic advisories are **100% actionable** (145/145 survive the filter, against 92% for adversarial) because advisory retirement only reached semantic on 2026-09-10 (`317456639`, #1986) and has not yet appeared in the data — so the brake exists but has never executed on this path. And 132 of 145 semantic findings carry no `category`, against adversarial's clean six-way spread.

**#1992 — soft mode reports drops it did not perform.** With `enforceBudget: false` the provider correctly delivers every rule section, but the `enforceBudget` guard is applied to the chunk output (`static-rules.ts:391`), the empty-branch notice chunk (`:414`) and the notice chunk (`:460`) — and omitted from the two warning logs at `:373` and `:382`. An operator reading the log is told rules were truncated when all of them shipped, and is pointed at a budget that is not binding.

## Design

### Approach

Two independent changes, no shared module. The nbf work is a config move plus one extracted seam; the static-rules work is a log-wording change with no behavioural effect.

**Per-reviewer seeding is a config `sources` list, not a widened boolean.** The four states operators need are adversarial-only, semantic-only, both, and neither. A `sources` array expresses all four in one place and keeps a single set of `scope` / `sourceDiffCap` knobs governing the one fix pass.

**The nbf block moves to `review.nonBlockingFix`.** It currently lives inside `AdversarialReviewConfigSchema` (`schemas-review.ts:167`), which is why the seed was adversarial-shaped in the first place. Configuring semantic's opt-in under `review.adversarial` would reproduce that drift. The legacy path keeps working through a migration shim, per the project's config conventions: a benign rename with no semantic change takes a shim that warns, copies to the new key and drops the old — not a pre-parse reject guard, which is reserved for removals that would silently drop behaviour.

**`sources` defaults to `["adversarial"]`.** Existing configs behave exactly as today and semantic seeding is opt-in, matching how nbf itself shipped ("Opt-in; ramp to true after validating signal quality").

The default is declared with Zod's `.default()`, per the project's config convention that defaults live in the schema. The consequence is deliberate and must not be "simplified" away: `.default()` makes `sources` **required on the inferred output type**, so every existing object literal passed where a `NonBlockingFixConfig` is expected stops typechecking until it names the field. US-001's `Modifies` list authorises exactly those files. Declaring `sources` as `.optional()` and resolving the fallback at the read site would avoid the cascade but would move a default out of the schema, which the convention forbids.

**No per-reviewer `blockingThreshold`.** There is one threshold, on `ReviewConfigSchema` (`schemas-review.ts:231`), and both reviewers read the identical value at `plan-inputs.ts:376` and `:428`; all 2,991 threshold-stamped records in the corpus carry `"error"`, with zero stories where the two reviewers stamped different values. Divergence is unreachable via config and out of scope here.

What makes a mixed-threshold union safe today is that nbf's strategy set passes `promptSeverityFloor: "info"` at all six call sites in `build-plan-for-strategy.ts:395-427`, so the rectifier prompt's render floor never reads `review.blockingThreshold`. That is load-bearing behaviour resting on a hardcoded literal, documented only as a comment about empty findings lists and pinned by no test. US-002 pins it.

### Integration

**Read-only — verified signatures:**

- `IMPLEMENTER_SOURCES` (`src/operations/autofix-implementer-strategy.ts:11`) is `new Set(["lint", "typecheck", "semantic-review", "tdd-verifier"])`. `"semantic-review"` is already a claimable implementer source, with no `includeAdversarialReview`-style opt-in — the fix lane has been ready all along. No change needed here.
- `nonBlockingExcludePhases()` (`src/execution/non-blocking-fix.ts:85`) returns `REVIEW_PHASE_KINDS` — all review phases, not just adversarial — so unioning the buckets creates no revalidation asymmetry. No change needed.
- `actionableAdvisoryFindings(findings: readonly Finding[]): readonly Finding[]` (`src/execution/non-blocking-fix.ts:65`) filters `actionRequired === false`, `acDropped === true`, and `isRecurrenceRetired(f)`. Applies unchanged to both sources.
- `shouldRunNonBlockingFix(cfg: NonBlockingFixConfig | undefined, advisoryCount: number): boolean` (`src/execution/non-blocking-fix.ts:80`) requires `cfg?.enabled === true && advisoryCount > 0`.
- `toReviewFindings` (`src/review/semantic-helpers.ts:241`) stamps `source: "semantic-review"` and sets `fixTarget` via `resolveFixTarget`; `toAdversarialReviewFindings` (`src/review/adversarial-helpers.ts:167`) does the adversarial equivalent. Both return `Finding[]`.
- `migrateLegacyReviewModelKey(raw, logger)` (`src/config/migrations.ts:100`) is the pattern to mirror for a review-block key migration, including its `migrateBlock` helper and its canonical-wins-without-throwing rule.
- `applyConfigCompatShims(conf, logger, dedupe)` (`src/config/compat-shims.ts:483`) runs the shim chain per config layer, before merge and before Zod.
- Phase-name → state-key map at `src/execution/story-orchestrator/types.ts:224-225`: `"semantic-review" → semanticReview`, `"adversarial-review" → adversarialReview`.

**Mutated — baseline exists only to locate the code; the target is the interface to implement:**

`src/config/schemas-review.ts`
- Baseline: `nonBlockingFix` is a field of `AdversarialReviewConfigSchema` (`:167`), with `enabled`, `scope`, `regressionAttempts`, `verifierGuard`, `sourceDiffCap`.
- Target: the same object schema is exported as its own named schema and becomes a field of `ReviewConfigSchema` at `review.nonBlockingFix`, gaining `sources: z.array(z.enum(["adversarial", "semantic"])).default(["adversarial"])`. `AdversarialReviewConfigSchema` no longer declares it.

`src/config/selectors.ts`
- Baseline: `export type NonBlockingFixConfig = NonNullable<z.infer<typeof AdversarialReviewConfigSchema>["nonBlockingFix"]>;` (`:182`).
- Target: the alias is derived from the new standalone nbf schema, so the type carries `sources` and no longer depends on `AdversarialReviewConfigSchema`.

`src/config/migrations.ts`
- Target: a new exported migration that moves `review.adversarial.nonBlockingFix` to `review.nonBlockingFix`, warning on migration, leaving the canonical key untouched when both are present, and returning the input unchanged when the legacy key is absent.

`src/config/compat-shims.ts`
- Baseline: the chain in `applyConfigCompatShims` runs nine shims (`:491-500`).
- Target: the new nbf migration joins the chain.

`src/execution/story-orchestrator/execution-plan.ts`
- Baseline: lines ~379-410 inline the green precondition, the `advCfg` gate keyed on `this.state.adversarialReview`, the single-phase read of `phaseOutputs["adversarial-review"]`, and the `actionableAdvisoryFindings` call.
- Target: that derivation moves to a new module and the call site consumes its result. **This extraction is mandatory, not stylistic:** the file is exactly 600 lines, the `SRC_LIMIT` in `scripts/check-file-sizes.ts`, and it is not in `scripts/baselines/file-sizes-baseline.json` — it has zero headroom and any added line fails the ratchet.

`src/context/engine/providers/static-rules.ts`
- Baseline: the warnings at `:373` ("Canonical rules are approaching/exceeding static rules budget") and `:382` ("Rule sections truncated by static rules budget") fire off `budgetResult` with no `enforceBudget` check, both carrying `droppedCount: budgetResult.droppedIds.length`.
- Target: under `enforceBudget: false` the messages state that sections *would* be truncated and name the flag; under `enforceBudget: true` message text and payloads are unchanged. The file is 597 of 600 lines, so the change must be net-neutral or shrink; the provider's returned `budgetPressure` is not touched.

`src/context/engine/manifest-types.ts`
- Baseline: `ProviderBudgetPressure.droppedCount` is documented as *"Items discarded to satisfy the budget. Zero unless the budget is enforced."* (`:33-34`), which is false — `static-rules.test.ts:667` pins it to 1 in soft mode.
- Target: the doc comment on `droppedCount` and `droppedTokens` states that under a non-enforcing budget these count sections that *would* be discarded, and that `overageTokens` is the enforcement-independent signal.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `sources` names a reviewer whose phase did not run or is disabled | That source contributes nothing; the pass still runs on the remaining sources. Not an error. |
| `sources` is empty, or no named source produced actionable findings | nbf does not run, exactly as when the adversarial bucket is empty today. |
| Both `review.nonBlockingFix` and `review.adversarial.nonBlockingFix` are set | Canonical wins, legacy is dropped with a warning naming both keys. No throw — mirrors `migrateLegacyReviewModelKey`. |
| The same defect appears in both reviewers' advisory buckets | Seeded once. |
| A semantic advisory carries `meta.recurrence.disposition === "retired"` | Not seeded, via the existing `actionableAdvisoryFindings` filter. |

## Out of Scope

- Per-reviewer `blockingThreshold` configuration (`review.semantic.blockingThreshold` / `review.adversarial.blockingThreshold`). One shared threshold stays the only threshold; if per-reviewer thresholds are wanted they are a separate change, landing after this one so the union's semantics are already pinned by tests.
- Changing what `budgetPressure.droppedCount` counts in soft mode. It remains a pressure signal — the count of sections that would be dropped — and the existing US-003 AC 3 assertion at `static-rules.test.ts:667` stays green. Only the log wording and the field documentation change.
- Changing nbf's `scope`, `sourceDiffCap`, `regressionAttempts` or `verifierGuard` semantics, or making any of them per-source. One fix pass, one set of knobs.
- Adding a `category` to semantic-review findings. 132 of 145 carry none today; that is a reviewer-prompt question, not a seeding question.
- Emitting a `stale` chunk-exclusion reason, persisting `ChunkKind`, or any curator heuristic change (#1931, #1930, #1445).
- Aggregating the plan-time Context Files drop telemetry (#1474).

## Stories

**US-001 — nbf config gets its own home and a per-reviewer `sources` list**
Move the nbf block out of `AdversarialReviewConfigSchema` to `review.nonBlockingFix`, add `sources` defaulting to `["adversarial"]`, re-point the `NonBlockingFixConfig` alias, and migrate the legacy path through the compat-shim chain.
Dependencies: none.

**US-002 — nbf seeds from every reviewer named in `sources`**
Extract the nbf seed derivation out of `execution-plan.ts` into its own module, and have it union the advisory buckets of the reviewers named in `sources`, deduplicated, through the existing actionable filter. Pin nbf's render floor as independent of `review.blockingThreshold`.
Dependencies: US-001.

**US-003 — static-rules soft mode stops reporting truncation it did not perform**
Make both budget warnings state what happened under a non-enforcing budget, and correct the `ProviderBudgetPressure` field documentation. No change to the returned pressure object or to enforced-mode output.
Dependencies: none.

### Context Files (per story)

**US-001**
- `src/config/schemas-review.ts`
- `src/config/selectors.ts`
- `src/config/migrations.ts`
- `src/config/compat-shims.ts`
- `.nax/rules/config-patterns.md`

**US-002**
- `src/execution/story-orchestrator/execution-plan.ts`
- `src/execution/non-blocking-fix.ts`
- `src/execution/story-orchestrator/types.ts`
- `src/execution/build-plan-for-strategy.ts`
- `src/review/semantic-helpers.ts`

**US-003**
- `src/context/engine/providers/static-rules.ts`
- `src/context/engine/manifest-types.ts`
- `src/context/engine/providers/static-rules-budget-notice.ts`

### Creates (per story)

**US-002**
- `src/execution/story-orchestrator/nbf-seed.ts`

### Modifies

**US-001**
- `test/unit/config/non-blocking-fix-config.test.ts` — every case parses through `AdversarialReviewConfigSchema` and the first asserts `cfg.nonBlockingFix` deep-equals the defaults literal. Once the block moves, that schema strips the key and the field is `undefined`, so a correct implementation fails these assertions. Replacement invariant: the same default-shape and validation assertions, made against the new standalone nbf schema and through `review.nonBlockingFix`, plus the legacy path asserted via the migration rather than via the adversarial schema.
- `test/unit/execution/non-blocking-fix-retirement.test.ts` — two `as const` nbf literals are passed to `shouldRunNonBlockingFix` and `runNonBlockingFix`, both of which take a `NonBlockingFixConfig`. Once `sources` is a defaulted field it is required on that type, so the literals stop typechecking. Replacement invariant: the same retired-only gate-closure assertions, with each literal naming `sources`.
- `test/unit/execution/nbf-readonly-flake-triage.test.ts` — the quarantine-transaction literal is passed to `runNonBlockingFix`, whose options declare `cfg: NonBlockingFixConfig`, so it stops typechecking for the same reason. Replacement invariant: the same quarantine-transaction assertions, with the literal naming `sources`.
- `test/unit/execution/rectification-overrides.test.ts` — the literal is passed to `StoryOrchestratorBuilder.addNonBlockingFix`, whose first parameter is a `NonBlockingFixConfig`, so it stops typechecking for the same reason. Replacement invariant: the same "builder does not throw" assertion, with the literal naming `sources`.
- `test/unit/execution/build-plan-for-strategy-triage-assembly.test.ts` — two fixtures declare a fully-enumerated `review.adversarial` block with `nonBlockingFix` nested inside it. That key is no longer part of the adversarial schema, so the fixtures no longer describe a reachable config shape. Replacement invariant: the same triage-assembly assertions, with nbf declared at `review.nonBlockingFix` and `sources` named.
- `test/unit/execution/non-blocking-fix-wiring.test.ts` — three fixtures nest `nonBlockingFix` under `review.adversarial` for the same reason. Replacement invariant: the same wiring and green-precondition assertions, with nbf declared canonically and `sources` named.

### Seams

- **US-001 -> US-002.** US-001 introduces the `sources` field on the nbf config slice; US-002 is its only consumer. US-002's AC-9 stubs the reviewer phase outputs and asserts that the seed honours `sources`, proving the field is read rather than merely declared.
- **US-002's extracted module.** `nbf-seed.ts` exports the seed derivation that `execution-plan.ts` calls. AC-10 enters at the story-orchestrator phase-completion path — the outermost production entry point that reaches the seed — rather than calling the module directly, so the wiring is proven and not just the function.

## Acceptance Criteria

### US-001

1. `[unit]` Parsing a config whose `review.nonBlockingFix` is an empty object yields `enabled: false`, `scope: "both"`, `regressionAttempts: 1`, `verifierGuard: true`, and `sourceDiffCap` equal to `{ maxFiles: 10, maxLines: 500 }`.
2. `[unit]` Parsing a config whose `review.nonBlockingFix` is an empty object yields `sources` equal to a single-element list containing `"adversarial"`.
3. `[unit]` Parsing a config that sets `review.nonBlockingFix.sources` to a list containing both `"adversarial"` and `"semantic"` yields both entries in declared order.
4. `[unit]` Parsing a config whose `review.nonBlockingFix.sources` contains an unrecognised reviewer name rejects with a validation error naming the field.
5. `[unit]` Parsing a config that omits `review.nonBlockingFix` entirely yields `undefined` for that slice, and no nbf defaults are synthesised elsewhere in the parsed config.
6. `[unit]` Parsing a config that declares `nonBlockingFix` under `review.adversarial` and nothing under `review.nonBlockingFix` yields the same resolved nbf slice as declaring it canonically, and emits one config warning naming both the legacy and the canonical key.
7. `[unit]` Parsing a config that declares `nonBlockingFix` under both `review.adversarial` and `review.nonBlockingFix` resolves to the canonical block's values, emits a warning naming both keys, and does not throw.
8. `[unit]` Parsing a config that declares `nonBlockingFix` under neither location leaves the config unchanged and emits no config warning about nbf.
9. `[unit]` A config supplying the legacy `review.adversarial.nonBlockingFix` in one layer and a canonical `review.nonBlockingFix` field in a later layer resolves with the later layer's value winning, demonstrating the migration runs before layer merge.
10. `[unit]` `AdversarialReviewConfigSchema` no longer accepts `nonBlockingFix` as a declared field: parsing an adversarial block that names it yields a parsed object with no `nonBlockingFix` property.

### US-002

1. `[unit]` Given a story whose semantic-review phase produced two actionable advisory findings, whose adversarial-review phase produced none, and whose nbf `sources` names both reviewers, the seed returns both semantic findings.
2. `[unit]` Given the same inputs but `sources` naming only `"adversarial"`, the seed returns an empty list and reports that nbf should not run.
3. `[unit]` Given a story whose adversarial-review phase produced one actionable advisory finding and whose semantic-review phase produced two, with `sources` naming both, the seed returns three findings.
4. `[unit]` Given advisory findings from both reviewers describing the same file, line and message, with `sources` naming both, the seed returns that finding once.
5. `[unit]` Given a semantic advisory finding whose `meta.recurrence.disposition` is `"retired"`, with `sources` naming both reviewers, the seed excludes it.
6. `[unit]` Given a semantic advisory finding whose `actionRequired` is `false`, with `sources` naming both reviewers, the seed excludes it.
7. `[unit]` Given a story where the semantic-review phase did not run at all and `sources` names both reviewers, the seed returns the adversarial findings and reports no error.
8. `[unit]` Given a story that is not currently green — a phase output that fails the phase-passed predicate — the seed reports that nbf should not run regardless of how many advisory findings either reviewer produced.
9. `[integration]` Stub the nbf runner; drive a story through the story-orchestrator phase-completion path with rectification enabled, a story id set, nbf `enabled` true, `sources` naming both reviewers, a passing semantic-review phase carrying one actionable advisory finding and a passing adversarial-review phase carrying none; assert the nbf runner was invoked once with that finding.
10. `[integration]` Repeat the previous scenario, changing only `sources` to name just `"adversarial"`; assert the nbf runner was not invoked.
11. `[unit]` The nbf strategy set builds its implementer strategy with a severity floor of `"info"` when `review.blockingThreshold` is `"error"`, and with the same `"info"` floor when `review.blockingThreshold` is `"warning"`, so an advisory finding at `warning` severity is rendered into the rectifier input under both settings.
12. `[unit]` A finding whose `source` is `"semantic-review"` and whose `fixTarget` is `"source"` is claimed by the autofix implementer strategy built by the nbf strategy set.

### US-003

1. `[unit]` When canonical rules exceed the budget and `enforceBudget` is `false`, the provider emits a truncation warning whose message states that sections would be truncated and names `enforceBudget`, and does not state that sections were truncated.
2. `[unit]` When canonical rules exceed the budget and `enforceBudget` is `true`, the provider emits a truncation warning whose message is unchanged from today's text.
3. `[unit]` When canonical rules exceed the budget and `enforceBudget` is `false`, the provider still returns one chunk per canonical rule — no section is withheld.
4. `[unit]` When canonical rules exceed the budget and `enforceBudget` is `false`, the returned `budgetPressure` reports a non-zero `overageTokens` and the same `droppedCount` the enforcing configuration would report for the same rule set, confirming the pressure object is unchanged by this story.
5. `[unit]` When canonical rules fit inside the budget and `enforceBudget` is `false`, the provider emits no truncation warning.
6. `[unit]` When the rule total reaches the approaching-budget threshold and `enforceBudget` is `false`, the approaching-budget warning's message names `enforceBudget` and does not assert that any section was dropped.

**Verification note (US-003):** the `ProviderBudgetPressure` documentation change is a comment edit with no runtime behaviour; it is covered by the repo's static gate, `bun run typecheck`, not by an acceptance criterion.

<!-- spec-writing: completed-through-phase-6 -->
