# SPEC: Context Engine v2 — Budget Truth and Rule Scope Restoration

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Context v2 reports a token budget it neither enforces nor accounts correctly, and the rules store it injects is roughly twice the size it needs to be. This spec makes the budget arithmetic true — a correct remaining-room estimate, digest tokens reserved before packing, truncation that drops the intended tail, and floor overage that is visible instead of silent — and restores the per-story rule scoping that already ships in the engine but is inert because no rule declares it.

## Motivation

Four accounting defects compound in the assemble path:

- **The remaining-room estimate inverts under pressure.** `estimateAvailableBudgetTokens` (`src/context/engine/available-budget.ts:18`) returns `undefined` when the computed remainder is non-positive. `undefined` is the caller's signal for *no ceiling* (`packing.ts:83-84`), so the ceiling is removed at exactly the moment the prompt is largest. The file has no test.
- **Digest tokens are never reserved.** `digest.ts:12-14` states the orchestrator reserves them before packing; `orchestrator.ts:436` packs first and builds the digest at `:448`. `manifest-builder.ts:69` then reports `usedTokens + digestTokens`, so a bundle can exceed its budget by up to 250 tokens. The accounting is also mismatched: the tokens actually carried in the emitted prompt are the packed chunks plus `priorStageDigest` (`render.ts:50-51`), while the manifest adds the digest this stage *produces*.
- **Rules truncation is best-fit, not tail-biased.** `applyCanonicalRulesBudget` (`canonical-loader.ts:381-386`) `continue`s past any rule that does not fit and keeps scanning. Rules arrive sorted ascending by priority (`canonical-loader.ts:480-483`), so a large `priority: 10` rule is dropped while small `priority: 900` rules survive — the inverse of the function's own docstring.
- **Floor overage is silent.** `static` is a floor kind (`packing.ts:36`) and the floor pass adds `chunk.tokens` even when the chunk overflows (`packing.ts:98-108`). This repo's `.nax/rules/` store is 66 277 bytes ≈ 16.6k tokens against stage budgets of 8k–12k, so overage is the steady state. Every non-floor chunk is then excluded with no log and no metric — the only trace is `reason: "budget-exceeded-by-floor"` inside the manifest.

Underneath the size problem is a data problem. The engine already filters rules per story: `static-rules.ts:234` runs every rule through `ruleMatchesTouchedFiles(rule.appliesTo, request.touchedFiles)`, and `touchedFiles` is populated by both request builders (`stages/context.ts:104`, `stage-assembler.ts:193`). It is inert because **no file in `.nax/rules/` declares `appliesTo:` or `paths:`** — all 11 carry `priority:` alone, and the matcher early-returns `true` for an unscoped rule.

**Five** of them carried file scoping before migration. All five lost it; the three below were restored by US-004 but with **incomplete glob lists**, and two were missed entirely. Corrected list (this is the authoritative table — an earlier revision transcribed a truncated read of the source and named only three files):

| File | `.claude/rules/` | `.nax/rules/` |
|:--|:--|:--|
| `.nax/rules/adapter-wiring.md` | `paths: ["src/agents/**/*.ts", "src/operations/**/*.ts", "src/pipeline/**/*.ts", "src/execution/**/*.ts", "src/tdd/**/*.ts", "src/acceptance/**/*.ts", "src/review/**/*.ts", "src/debate/**/*.ts", "src/routing/**/*.ts", "src/cli/**/*.ts", "src/runtime/**/*.ts", "src/session/**/*.ts", "src/verification/**/*.ts"]` |
| `.nax/rules/retry-strategy.md` | `paths: ["src/agents/**/*.ts", "src/operations/**/*.ts", "src/execution/**/*.ts", "src/tdd/**/*.ts", "src/review/**/*.ts"]` |
| `.nax/rules/test-architecture.md` | `paths: ["test/**/*.test.ts"]` |
| `.nax/rules/test-helpers.md` | `paths: ["test/**/*.test.ts"]` |
| `.nax/rules/test-writing.md` | `paths: ["test/**/*.test.ts"]` |

The migrator bug is already fixed — `withReviewNotice` (`cli/rules.ts:216-231`) documents it exactly: the review notice is an HTML comment, frontmatter is recognised only at byte 0, so emitting the notice first displaced the frontmatter and it parsed as body text, losing the scope key on every file that both needed neutralizing and carried one. `translateLegacyFrontmatter` (`:202-214`) correctly rewrites legacy file-glob `paths:` to nax's `appliesTo:`. The store on disk was produced by the pre-fix migrator and never regenerated, and nothing in `nax rules lint` would notice.

Consequence today: a story touching `src/config/loader.ts` is handed all four testing rules plus `.nax/rules/adapter-wiring.md` — roughly 17k bytes ≈ 4.3k tokens of inapplicable text, on every stage.

## Design

### Approach

Restore scope before trimming. Scoping removes rules that do **not** apply to a story; trimming removes rules that **do**. Both mechanisms already exist in the codebase — this spec fixes the arithmetic of one and supplies the missing data for the other. No new packing algorithm, no new provider, no change to `packChunks`' floor semantics.

Scope boundary, stated plainly so it is not overread: after this spec the budget is **truthfully accounted and visibly exceeded**, not enforced against the floor. Floor chunks are still always included (spec AC-6 of `docs/specs/SPEC-context-engine-v2.md`). Enforcing a ceiling on the floor is deferred (see Out of Scope).

### Integration

Verified against `main` @ `5cb48bd4`.

- **`estimateAvailableBudgetTokens(agentId: string, existingPrompt?: string)`** — `src/context/engine/available-budget.ts:12`. Currently `number | undefined`. Changes to always return a number `>= 0`; `undefined` is no longer produced. Callers are `src/pipeline/stages/context.ts:146` and `src/context/engine/stage-assembler.ts:206`, both assigning to `ContextRequest.availableBudgetTokens` — the narrowed return type is assignment-compatible and neither call site changes.
- **`packChunks(chunks, budgetTokens, availableBudgetTokens?)`** — `src/context/engine/packing.ts:82`. Unchanged. `availableBudgetTokens === undefined` must continue to mean "no caller ceiling"; the value `0` must mean a real ceiling of zero.
- **`PackResult.floorOverageIds`** — `packing.ts:68`, already populated and already threaded to `buildManifest` (`orchestrator.ts:466`). This spec consumes it; it does not change how it is computed.
- **`buildDigest` / `digestTokens`** — `src/context/engine/digest.ts`, imported at `orchestrator.ts:23`. A new exported `DIGEST_RESERVE_TOKENS` constant is derived from the existing `MAX_DIGEST_CHARS` (`digest.ts:25`), not written as a second literal.
- **Effective budget computation** — `orchestrator.ts:266-269`, currently `Math.min(request.budgetTokens, agentProfile.caps.preferredPromptTokens)`. The digest reserve is subtracted here, before the provider fetch loop and before `packChunks`.
- **`buildManifest`** — `src/context/engine/manifest-builder.ts:69`, currently `usedTokens: usedTokens + digestTokens`. Changes to account the digest actually carried in the rendered prompt (`request.priorStageDigest`), leaving the `digestTokens` field itself as the produced digest that is threaded forward.
- **`StoryMetrics.context`** — `src/metrics/types.ts:150-172`, an optional object currently holding `providers` and `pollution`. Gains a sibling `floorOverage` field following the same optional-object shape as `pollution`.
- **`applyCanonicalRulesBudget(rules, budgetTokens)`** — `src/context/rules/canonical-loader.ts:367`, returning `CanonicalRulesBudgetResult { rules, totalTokens, usedTokens, droppedCount }`. Only the loop-continuation behaviour at `:383` changes; the result shape and the zero/negative-budget early return (`:368-375`) are untouched. Its callers are `canonical-loader.ts:495` and `static-rules.ts:235`.
- **`loadCanonicalRules(workdir, options?)`** — `canonical-loader.ts:408`. Frontmatter parsing lives at `:265-347` and already throws `RulesFrontmatterError` (`:240`) for a non-numeric `priority`. Unknown-key and `appliesTo`-shape validation extend that existing path and reuse that error class.
- **`rulesLintCommand(options)`** — `src/cli/rules.ts:380`, returns `Promise<void>` and signals failure by propagating the loader's throw. Its `[OK]` line uses `console.log`, matching the surrounding CLI convention. New dead-glob reporting is a warning that does **not** throw.
- **`translateLegacyFrontmatter(content)` / `withReviewNotice(content, replacements)`** — `cli/rules.ts:202` and `:225`. Both already carry the fix; this spec adds the round-trip coverage that would have caught the original loss.
- **`StaticRulesProvider.fetch(request)`** — `src/context/engine/providers/static-rules.ts:180`. The scope filter at `:234` and the package filter at `:186-188` are unchanged; the restored frontmatter is what activates them.

Existing patterns to mirror: `test/unit/context/engine/packing.test.ts` and `test/unit/context/rules/canonical-loader.test.ts` for engine and loader tests; `test/unit/cli/rules.test.ts` for lint-command tests. Dependency injection follows the established `_deps` pattern (`_canonicalLoaderDeps`, `_staticRulesDeps`, `_rulesCLIDeps`).

### Rule frontmatter shape

The complete set of recognised keys after this spec. Any other top-level key is a hard error.

```yaml
---
priority: 60                        # optional, integer; lower sorts first
appliesTo:                          # optional, list of file globs
  - "src/agents/**/*.ts"            # rule loads when the story touches a matching file
  - "src/operations/**/*.ts"
paths:                              # optional, list of package globs
  - "packages/core/**"              # rule loads when the story's package matches
---
```

`appliesTo` is a **file** glob matched against `request.touchedFiles`. `paths` is a **package** glob matched against the story's package dir, and `ruleMatchesPackage` short-circuits to `true` whenever `packageDir === repoRoot` — so in a single-package repo `paths` has no effect. This distinction is the trap that produced the current state and is why the migrator translates legacy `paths` to `appliesTo`.

### Failure Handling

| Condition | Behaviour |
|:--|:--|
| Prompt exhausts the agent profile's context window | Fail-closed: `estimateAvailableBudgetTokens` returns `0`, yielding a floor-only bundle rather than an unbounded one |
| Floor-kind chunks exceed the effective budget | Fail-open: chunks are still packed (AC-6 preserved), a warn-level log is emitted and the overage is recorded on `StoryMetrics.context.floorOverage`; the run never blocks |
| Rule frontmatter declares an unrecognised top-level key | Fail-closed: `loadCanonicalRules` throws `RulesFrontmatterError` naming the file |
| Rule frontmatter declares `appliesTo` that is not a list of strings | Fail-closed: `loadCanonicalRules` throws `RulesFrontmatterError` naming the file |
| An `appliesTo` glob matches zero files in the repository being linted | Fail-open: `rulesLintCommand` warns through the project logger, naming the rule file and the pattern, and still completes — a glob may legitimately match nothing in a shallow clone or a newly-split package |

## Out of Scope

- Floor-share trimming — capping the rules floor at a configured fraction of the stage budget (e.g. `floorShareRatio: 0.7`) — is deferred until the effect of restored rule scoping can be measured.
- Budgeting the legacy fallback path in `StaticRulesProvider.fetchLegacy`, which loads CLAUDE.md, `.cursorrules`, AGENTS.md and every `.claude/rules/**` file without applying any token budget, is deferred; the unbudgeted path remains live for repositories that have not migrated to `.nax/rules/`.
- Correcting `fetchLegacy`'s log line, which claims it prefers the first candidate file while it in fact loads all of them, is deferred.
- Satisfying spec AC-7's "packing within 5% of brute-force optimal" bound — via a knapsack-repair step or the property test the spec calls for — is deferred; density-greedy remains the packing heuristic.
- Pull-based rule delivery, where the agent requests rule bodies on demand instead of receiving them in every prompt, is deferred and requires its own design.
- The general per-provider soft budget — the spec'd `fetch(request, softBudgetTokens)` provider signature and its proportional-allocation policy — is deferred; only the rules provider's own budget is addressed here.
- Scoring-axis drift from the context-engine gap analysis — role weights, the absent `freshness` axis, per-stage kind weights, and the semantic kind taxonomy — is deferred.
- Auditing the eight rule files that never declared scope, to decide whether any of them should gain an `appliesTo` glob, is deferred to a human judgement pass; only the three files with a provable pre-migration scope are restored here.
- Regenerating the whole `.nax/rules` store with `nax rules migrate --force` is deferred; it would emit `appliesTo` correctly but discard the hand-added `priority` values, which the `.claude/rules` sources do not carry.
- Enforcing `nax rules lint` in CI or in `bun run lint` is deferred; this spec only makes the command validate more.

## Stories

1. **US-001: Budget ceiling arithmetic** — no dependencies. Correct `estimateAvailableBudgetTokens` so an exhausted window yields a real zero ceiling rather than no ceiling, reserve digest tokens from the effective budget before packing, and account the digest the prompt actually carries.
2. **US-002: Tail-biased rules truncation** — no dependencies. Make `applyCanonicalRulesBudget` drop a contiguous low-priority tail instead of skipping past oversized high-priority rules.
3. **US-003: Floor overage observability** — depends on US-001. Emit a warn log and record a `StoryMetrics.context.floorOverage` measurement whenever floor-kind chunks push a bundle past its budget, without changing which chunks are packed.
4. **US-004: Rule scope validation and restoration** — no dependencies. Validate rule frontmatter keys and `appliesTo` globs in `nax rules lint`, add the migrate-then-lint round-trip coverage that would have caught the original scope loss, and restore `appliesTo` on the three rule files that lost it.

### Context Files

**US-001**
- `src/context/engine/available-budget.ts` — the ceiling estimator being corrected
- `src/context/engine/orchestrator.ts` — effective-budget computation and pack call site
- `src/context/engine/digest.ts` — `MAX_DIGEST_CHARS`, the source of the reserve constant
- `src/context/engine/manifest-builder.ts` — `usedTokens` accounting
- `test/unit/context/engine/packing.test.ts` — existing packing-test patterns to mirror

**US-002**
- `src/context/rules/canonical-loader.ts` — `applyCanonicalRulesBudget` and the priority sort
- `src/context/engine/providers/static-rules.ts` — the provider call site and its warn logs
- `test/unit/context/rules/canonical-loader.test.ts` — existing loader-test patterns, including the current `applyCanonicalRulesBudget` test

**US-003**
- `src/context/engine/packing.ts` — `floorOverageIds` production
- `src/context/engine/orchestrator.ts` — where overage becomes observable
- `src/metrics/types.ts` — `StoryMetrics.context` shape to extend
- `test/unit/context/engine/orchestrator.test.ts` — existing orchestrator-test patterns

**US-004**
- `src/cli/rules.ts` — lint command, `translateLegacyFrontmatter`, `withReviewNotice`
- `src/context/rules/canonical-loader.ts` — frontmatter parsing and `RulesFrontmatterError`
- `src/context/engine/providers/static-rules.ts` — `ruleMatchesTouchedFiles` scope filter
- `.claude/rules/test-writing.md` — the pre-migration source carrying the lost `paths` scope
- `test/unit/cli/rules.test.ts` — existing lint-command test patterns

### Creates

**US-001**
- `test/unit/context/engine/available-budget.test.ts` — first tests for a currently untested module

### Modifies

**US-001**
- `test/unit/context/engine/orchestrator.test.ts` — the test named "chunkTokens covers exactly the included chunks and sums to usedTokens minus the digest" (`:99-110`) asserts `summed === manifest.usedTokens - manifest.digestTokens`. Its `BASE_REQUEST` carries no `priorStageDigest`, so under the corrected accounting in US-001 AC 6 the identity no longer holds and the assertion fails against a correct implementation. US-001 owns updating it to the new invariant: `summed` equals `usedTokens` minus the tokens of the *prior-stage* digest carried in the rendered prompt (zero when no prior digest is supplied).

### Seams

- **US-001** `DIGEST_RESERVE_TOKENS` is newly exported from `src/context/engine/digest.ts` and consumed by the orchestrator's budget computation. Seam anchor: AC US-001.5 asserts that assembling with a stage budget packs non-floor chunks totalling at most that budget minus the reserve — proving the constant is wired into the effective-budget path, not merely defined.
- **US-003** `StoryMetrics.context.floorOverage` is newly produced by the assemble path and consumed by metrics reporting. Seam anchor: AC US-003.2 asserts a real assemble populates the field, and AC US-003.3 asserts the non-overage case leaves it at zero.

## Acceptance Criteria

### US-001: Budget ceiling arithmetic

1. `[unit]` `estimateAvailableBudgetTokens` returns `0` when called with a prompt long enough that the agent profile's remaining room is non-positive.
2. `[unit]` `estimateAvailableBudgetTokens` returns a positive number smaller than the agent profile's `maxContextTokens` when called with a short prompt.
3. `[unit]` `packChunks` called with `availableBudgetTokens` of `0` packs no non-floor chunk and still packs every floor-kind chunk.
4. `[unit]` `packChunks` called with `availableBudgetTokens` omitted uses `budgetTokens` as the ceiling and packs the same chunks as before this change.
5. `[unit]` assembling a bundle with a stage budget packs non-floor chunks whose total tokens do not exceed that budget minus `DIGEST_RESERVE_TOKENS`.
6. `[integration]` a bundle assembled with a `priorStageDigest` present reports a manifest `usedTokens` equal to the packed chunk tokens plus the token count of that prior-stage digest.
7. `[unit]` a bundle assembled with no floor chunk overflowing renders markdown whose estimated token count does not exceed the requested `budgetTokens`.

**Out of scope:** the case where an agent profile reports a `maxContextTokens` smaller than the reserved non-context allowance — the resulting negative remainder is covered by AC 1's zero return, and no separate error path is specified.

### US-002: Tail-biased rules truncation

1. `[unit]` `applyCanonicalRulesBudget` given priority-ordered rules whose first rule alone exceeds `budgetTokens` returns an empty `rules` array rather than skipping ahead to a smaller lower-priority rule.
2. `[unit]` `applyCanonicalRulesBudget` returns the longest leading run of priority-ordered rules that fits within `budgetTokens`, with `droppedCount` equal to the number of rules following that run.
3. `[unit]` `applyCanonicalRulesBudget` given a budget large enough for every rule returns all rules with `droppedCount` of `0` and `usedTokens` equal to `totalTokens`.
4. `[unit]` `applyCanonicalRulesBudget` given `budgetTokens` of `0` returns an empty `rules` array, `usedTokens` of `0`, and `totalTokens` equal to the summed token estimate of all input rules.
5. `[unit]` `StaticRulesProvider.fetch` against a store larger than the provider's budget emits chunks only for the surviving leading run of rules and none for the dropped tail.

### US-003: Floor overage observability

1. `[unit]` `packChunks` given floor-kind chunks whose total exceeds the budget returns those chunk ids in `floorOverageIds` and still includes every one of them in `packed`.
2. `[integration]` assembling a bundle whose floor chunks exceed the effective budget records the overage token count on `StoryMetrics.context.floorOverage`.
3. `[integration]` assembling a bundle whose floor chunks fit within the effective budget leaves the recorded `floorOverage` token count at `0`.
4. `[integration]` assembling a bundle with floor overage emits a warn-level log whose data object begins with `storyId` and carries the stage, the effective budget, and the number of non-floor chunks excluded as a result.

### US-004: Rule scope validation and restoration

1. `[unit]` `loadCanonicalRules` rejects with `RulesFrontmatterError` naming the offending file when a rule's frontmatter declares a top-level key other than `priority`, `paths`, or `appliesTo`.
2. `[unit]` `loadCanonicalRules` rejects with `RulesFrontmatterError` naming the offending file when `appliesTo` is present but is not a list of strings.
3. `[unit]` `loadCanonicalRules` resolves normally for a rule declaring `priority`, `paths`, and `appliesTo` together.
4. `[unit]` `rulesLintCommand` emits a warn-level record through the project logger naming the rule file and the unmatched pattern when an `appliesTo` glob matches zero files in the linted repository, and completes without throwing.
5. `[unit]` applying `withReviewNotice` to the output of `translateLegacyFrontmatter` for a legacy rule declaring `paths` yields content from which `loadCanonicalRules` reads back the translated `appliesTo` value.
6. `[unit]` `StaticRulesProvider.fetch` reading the repository's own `.nax/rules` store with `touchedFiles` containing only non-test source paths emits no chunk whose id begins with `static-rules:test-writing:`.
7. `[unit]` `StaticRulesProvider.fetch` reading the repository's own `.nax/rules` store with `touchedFiles` containing a path under `test/` emits a chunk whose id begins with `static-rules:test-writing:`.
8. `[unit]` `StaticRulesProvider.fetch` reading the repository's own `.nax/rules` store with `touchedFiles` containing a path outside **every** glob `adapter-wiring.md` declares (e.g. `src/config/loader.ts`) emits no chunk whose id begins with `static-rules:adapter-wiring:`; a path under `src/pipeline/**`, which the rule declares, DOES emit one.

**Out of scope:** validating that an `appliesTo` glob is syntactically well-formed beyond being a string — a malformed pattern that compiles to a regex matching nothing is reported by AC 4's dead-glob warning rather than a distinct error.
