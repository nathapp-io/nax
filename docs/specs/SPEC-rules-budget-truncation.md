# SPEC: Soft rules budget and provider budget-pressure metric

<!-- spec-writing: completed-through-phase-6 -->

## Summary

The canonical-rules provider currently discards rules that do not fit a fixed
8,192-token ceiling, silently losing roughly half of this repository's rule
corpus before the packer ever runs. This feature makes that ceiling **soft by
default** — the provider reports how far over budget it is instead of throwing
content away — and adds a generic `budgetPressure` channel so any provider's
self-imposed loss becomes visible in story metrics. Hard truncation remains
available behind a new `context.v2.rules.enforceBudget` config flag.

## Motivation

`StaticRulesProvider` applies `applyCanonicalRulesBudget` before returning
chunks. Measured against this repository's real `.nax/rules/` store:

| | tokens | files |
|:--|--:|:--|
| Corpus | 16,425 | 11 |
| Ceiling (`DEFAULT_CANONICAL_RULES_BUDGET_TOKENS`) | 8,192 | — |
| Delivered | 8,080 | 6 |
| Discarded | 8,345 | 5 |

Every retry rule, every monorepo rule, and most testing rules never reach any
prompt of any stage.

Three properties make this worse than a tuning problem:

1. **It contradicts the floor contract.** `static` is a floor kind
   (`packing.ts:36`); `packChunks` deliberately packs floor chunks even when
   they overflow the stage budget. But the provider drops rules *before* packing,
   so the packer's "never drop rules" guarantee is applied to a set that has
   already lost half its members.
2. **The loss is unmetered.** `static-rules.ts:245-252` logs a warning carrying
   `droppedCount`, but nothing reaches `StoryMetrics`. A warning inside a long
   run is not an observability story.
3. **The provider has no channel to report it.** `ContextProviderResult`
   (`types.ts:543-552`) carries only `chunks` and `pullTools`.

The discard is a contiguous tail: `applyCanonicalRulesBudget` breaks at the
first rule that does not fit (`canonical-loader.ts:391`) and rules are sorted
ascending by `priority`, so higher `priority:` numbers are dropped first. That
behaviour is intended and documented (`schemas-context.ts:63`); this spec
revisits the design, not its implementation.

## Design

### Approach

Two implementations were considered. This spec chooses **soft-by-default**, not
**raise-the-constant**.

Raising `DEFAULT_CANONICAL_RULES_BUDGET_TOKENS` to a larger number only moves
the cliff, and the cliff returns silently as the corpus grows. Making the
ceiling advisory eliminates the cliff permanently and resolves the contradiction
in Motivation #1 — rules are floor-kind (`packing.ts:36`), so a hard pre-pack
drop contradicts the packer's own semantics one layer down.

`budgetTokens` is therefore reinterpreted as a **reporting threshold** rather
than a guillotine. Its numeric default is unchanged.

### Integration

Existing symbols to extend:

- `applyCanonicalRulesBudget(rules, budgetTokens)` — `src/context/rules/canonical-loader.ts:375`.
  Gains a third parameter `options?: { enforce?: boolean }`.
- `CanonicalRulesBudgetResult` — `canonical-loader.ts:358-363`. Currently
  `{ rules, totalTokens, usedTokens, droppedCount }`. Gains `overageTokens: number`.
- `ContextV2RulesConfigSchema` — `src/config/schemas-context.ts:54-68`. Gains
  `enforceBudget: z.boolean().default(false)`.
- `ContextV2RulesConfig` runtime type — `src/config/runtime-types-context.ts:48-56`.
  Gains `enforceBudget: boolean`.
- `ContextProviderResult` — `src/context/engine/types.ts:543-552`. Gains optional
  `budgetPressure`.
- `ContextManifest.providerResults[]` — `types.ts:225`. Gains optional
  `budgetPressure`.
- `ContextProviderMetrics` — `src/metrics/types.ts:72`. Gains optional
  `budgetPressure`.
- `StaticRulesProvider.fetch` — `src/context/engine/providers/static-rules.ts:235`
  is the existing `applyCanonicalRulesBudget` call site.
- `deriveContextMetrics` — `src/metrics/tracker.ts:45`, whose per-provider
  aggregation loop is at `tracker.ts:58-80`. It is **module-private**; the
  exported entry point that reaches it is
  `collectStoryMetrics(ctx, storyStartTime)` (`tracker.ts:138`), which returns
  `StoryMetrics` with the aggregate at `metrics.context.providers[providerId]`.
  All metrics ACs are written against `collectStoryMetrics`, matching the
  existing AC-18 tests in `test/unit/metrics/tracker-context-metrics.test.ts`.

**Two default literals must both be updated.** Zod does not re-parse a
`.default()` value, so adding a key to the object schema without updating the
literals leaves it `undefined` at runtime:

- `src/config/schemas-context.ts:68` — `.default(() => ({ allowLegacyClaudeMd: false, budgetTokens: 8192 }))`
- `src/config/schemas.ts:321` — `rules: { allowLegacyClaudeMd: false, budgetTokens: 8192 }`

**File-size constraint — this is why US-001 exists.** `bun run lint` runs
`scripts/check-file-sizes.ts`, which fails when a source file exceeds 600 lines
(`SRC_LIMIT`). `src/context/engine/types.ts` is at **590 lines**, leaving 10
lines of headroom, and this feature adds an import plus two documented optional
fields there. Landing the feature without first relieving that file would fail
the lint gate on the last story. Precedent: PR #1460 split `src/operations/call.ts`
(628 lines) purely to unblock #1461. `orchestrator.ts` at 583 lines has enough
headroom for its ~8-line change and needs no split.

Patterns to follow:

- `FloorOverageMetrics` and `computeFloorOverage` (`src/metrics/tracker.ts:121`,
  `src/metrics/types.ts`) — the precedent for "budget was exceeded, report rather
  than prevent", including how legacy manifests missing the field contribute zero
  instead of falling back to a wrong answer.
- Config defaults live in the Zod schema first (`.nax/rules/config-patterns.md`).

### New shapes

```ts
/** A provider's own budget pressure — how far over, and what it discarded. */
interface ProviderBudgetPressure {
  /** max(0, produced - providerBudget). Non-zero whenever the provider is over. */
  overageTokens: number;
  /** Items discarded to satisfy the budget. Zero unless the budget is enforced. */
  droppedCount: number;
  droppedTokens: number;
  /** Stable ids of discarded items, for manifest-level debugging. */
  droppedIds: string[];
}
```

`ContextProviderResult.budgetPressure?: ProviderBudgetPressure` and
`ContextManifest.providerResults[].budgetPressure?: ProviderBudgetPressure`
carry the full shape. `ContextProviderMetrics.budgetPressure?` carries only
`{ overageTokens, droppedCount, droppedTokens }` — ids stay in the manifest
because aggregating them across stages grows unbounded.

The field is generic rather than rules-specific: it describes "provider
self-limited", and static-rules is merely the only provider with an internal
budget today.

**`overageTokens` is a deliberately reused name for a distinct measurement.**
`StoryMetrics.context` will carry two fields spelled the same way and they must
not be conflated:

| Field | Level | Meaning |
|:---|:---|:---|
| `context.floorOverage.overageTokens` | per stage, existing (`metrics/types.ts:66`) | floor-kind chunks packed beyond the stage's `effectiveBudget` |
| `context.providers[id].budgetPressure.overageTokens` | per provider, new | content a provider produced beyond its *own* internal budget, before packing |

A provider can report budget pressure while floor overage is zero, and the
reverse — they measure different ceilings at different layers.

Reporting overage **separately from** drops is what keeps the default path
observable. In soft mode nothing is discarded, so a drop-only metric would read
zero forever, while "your corpus is 8.2k over its threshold" is the signal worth
having.

### Data flow

```
applyCanonicalRulesBudget(rules, cap, {enforce})
  -> {rules, totalTokens, usedTokens, droppedCount, overageTokens}
       |
StaticRulesProvider.fetch()
  -> ContextProviderResult{chunks, budgetPressure?}
       |
orchestrator provider loop (orchestrator.ts:337-356)
  -> manifest.providerResults[i].budgetPressure
       |
collectStoryMetrics() -> deriveContextMetrics() (tracker.ts:58-80)
  -> StoryMetrics.context.providers[id].budgetPressure
```

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `budgetTokens` is zero, negative, or non-finite | Unchanged from today — no rules returned, every rule counted dropped |
| Soft mode (`enforceBudget` false) | Never throws; never returns fewer rules than it was given |
| Canonical loader raises `NeutralityLintError` | Propagates unchanged — fail-closed behaviour from PR #1449 must not regress |
| Manifest written before this change (no `budgetPressure`) | Treated as "no pressure"; contributes zero rather than being inferred |

## Out of Scope

- Two-tier rule delivery — an always-on tier carrying every rule's prohibitions plus full text fetched on demand via a `query_rules` pull tool — is deferred to a later arc; it requires authored per-rule summaries and should be designed against measurements this feature produces.
- Adding `appliesTo:` scoping to the six currently-unscoped rule files (`config-patterns.md`, `error-handling.md`, `forbidden-patterns.md`, `monorepo-awareness.md`, `project-conventions.md`, `testing-commands.md`) is deferred.
- Fixing `ruleMatchesTouchedFiles` returning true when `touchedFiles` is empty (`static-rules.ts:141`), which makes `appliesTo:` inert for stories declaring no context files, is deferred to the scoping arc.
- Changes to the effectiveness classifier, `pollutionRatio`, or the Context Engine v2 write path are deferred.
- Changes to `packChunks`, `FLOOR_KINDS` membership, floor-overflow semantics, or any per-stage `budgetTokens` value in `stage-config.ts` are deferred.
- Reducing the token size of any rule file's content is deferred.
- US-004 only: making context-manifest writes atomic against concurrent readers is deferred; this feature adds a field to an existing manifest write and does not change its concurrency behaviour.

## Stories

1. **US-001: Extract manifest types to create file-size headroom** — no dependencies
2. **US-002: Soft canonical-rules budget with opt-in enforcement** — no dependencies
3. **US-003: Static-rules provider reports budget pressure** — depends on US-001 and US-002
4. **US-004: Budget pressure reaches the manifest and story metrics** — depends on US-001 and US-003

US-001 is a **pure move** — no behaviour change, no new code. It relocates the
manifest/chunk type block (`ChunkEffectiveness`, `ContextChunk`,
`ContextManifest`, lines 123-320) out of `src/context/engine/types.ts` into a
new `src/context/engine/manifest-types.ts`, re-exported from `types.ts` so no
import site changes. This drops `types.ts` to roughly 395 lines, giving US-004
room to add its fields.

**US-001 verification note:** the move is verified by the build/static gate —
`bun run typecheck` (the compiler rejects any unresolved import) and
`bun run lint` (which runs `scripts/check-file-sizes.ts`). No runtime AC asserts
the file length; that would be a meta-AC.

### US-001 — Context Files

- `src/context/engine/types.ts` — the block to move and the re-export site
- `src/context/engine/manifest-store.ts` — the largest consumer of the moved types
- `src/context/engine/orchestrator.ts` — consumer of `ContextManifest`

### US-001 — Creates

- `src/context/engine/manifest-types.ts` — relocated manifest and chunk type declarations

### US-002 — Context Files

- `src/context/rules/canonical-loader.ts` — `applyCanonicalRulesBudget`, `CanonicalRulesBudgetResult`, `DEFAULT_CANONICAL_RULES_BUDGET_TOKENS`
- `src/config/schemas-context.ts` — `ContextV2RulesConfigSchema` and its default literal
- `src/config/schemas.ts` — the second default literal at line 321
- `src/config/runtime-types-context.ts` — runtime rules-config type
- `test/unit/context/rules/canonical-loader.test.ts` — existing budget test patterns

### US-003 — Context Files

- `src/context/engine/providers/static-rules.ts` — the `applyCanonicalRulesBudget` call site
- `src/context/engine/types.ts` — `ContextProviderResult`
- `src/context/engine/orchestrator-factory.ts` — where the rules budget is resolved and passed to the provider
- `test/unit/context/engine/providers/static-rules.test.ts` — existing provider test patterns and canonical-store fixtures

### US-004 — Context Files

- `src/context/engine/orchestrator.ts` — provider loop and `providerResults` construction
- `src/context/engine/types.ts` — `ContextManifest.providerResults`
- `src/metrics/types.ts` — `ContextProviderMetrics`, `FloorOverageMetrics` precedent
- `src/metrics/tracker.ts` — `collectStoryMetrics` entry, `deriveContextMetrics` aggregation loop, `computeFloorOverage` precedent
- `test/unit/metrics/tracker-context-metrics.test.ts` — existing aggregation test patterns

### Seams

- **S1 (US-002 → US-003):** `applyCanonicalRulesBudget` gains `overageTokens` and the `enforce` option in US-002; US-003 must pass the resolved config through and surface the result. Declared as a behavioural AC in US-003 (config value changes observable provider output).
- **S2 (US-003 → US-004):** `ContextProviderResult.budgetPressure` is produced in US-003 and consumed by the orchestrator in US-004. Declared as an integration seam AC in US-004 that stubs a provider and enters at `assemble()`.

## Acceptance Criteria

### US-001: Extract manifest types to create file-size headroom

**Verification note:** the move itself is verified by the build/static gate —
`bun run typecheck` (the compiler rejects any unresolved import of a moved type)
and `bun run lint` (which runs `scripts/check-file-sizes.ts`). No AC asserts a
file's line count; that would be a meta-AC.

- [unit] `ContextManifest` remains importable from `src/context/engine/types.ts` after the move, and a manifest value constructed against it is accepted by `writeContextManifest` without error.
- [integration] Writing a manifest through `writeContextManifest` and reading it back through `loadContextManifests` returns a manifest whose `includedChunks` and `providerResults` equal what was written.

### US-002: Soft canonical-rules budget with opt-in enforcement

- [unit] `applyCanonicalRulesBudget` returns every rule it was given when the rules total exceeds `budgetTokens` and `enforce` is false.
- [unit] `applyCanonicalRulesBudget` returns `droppedCount` of 0 when the rules total exceeds `budgetTokens` and `enforce` is false.
- [unit] `applyCanonicalRulesBudget` returns `overageTokens` equal to the rules total minus `budgetTokens` when the total exceeds `budgetTokens` and `enforce` is false.
- [unit] `applyCanonicalRulesBudget` returns `usedTokens` equal to `totalTokens` when `enforce` is false and the total exceeds `budgetTokens`.
- [unit] `applyCanonicalRulesBudget` with `enforce` true returns only the leading rules whose cumulative tokens fit within `budgetTokens`, and `droppedCount` equal to the number of remaining rules.
- [unit] `applyCanonicalRulesBudget` returns `overageTokens` of 0 when the rules total is less than or equal to `budgetTokens`.
- [unit] `applyCanonicalRulesBudget` with `budgetTokens` of 0 returns no rules and `droppedCount` equal to the number of rules supplied.
- [unit] Resolving the nax config with `context.v2.rules.enforceBudget` unset yields `enforceBudget` equal to false.
- [unit] Resolving the nax config with `context.v2.rules.enforceBudget` set to true yields `enforceBudget` equal to true.

### US-003: Static-rules provider reports budget pressure

- [unit] `StaticRulesProvider.fetch` returns one chunk per canonical rule, including rules beyond the budget, when the store exceeds the provider's `budgetTokens` and `enforceBudget` is false.
- [unit] `StaticRulesProvider.fetch` returns `budgetPressure.overageTokens` equal to the store total minus the provider's `budgetTokens` when the store exceeds it and `enforceBudget` is false.
- [unit] `StaticRulesProvider.fetch` returns `budgetPressure.droppedCount` of 0 when the store exceeds the provider's `budgetTokens` and `enforceBudget` is false.
- [unit] `StaticRulesProvider.fetch` with `enforceBudget` true returns `budgetPressure.droppedCount` and `budgetPressure.droppedTokens` matching the rules omitted from its chunks.
- [unit] `StaticRulesProvider.fetch` with `enforceBudget` true returns `budgetPressure.droppedIds` containing the canonical rule id of each omitted rule.
- [unit] `StaticRulesProvider.fetch` omits `budgetPressure` entirely when the canonical rules total is within the provider's `budgetTokens`.
- [unit] `StaticRulesProvider.fetch` propagates `NeutralityLintError` to its caller when the canonical loader raises it, rather than returning an empty chunk list.
- [integration] `StaticRulesProvider.fetch` reading this repository's own `.nax/rules/` store under default configuration returns one chunk per rule file present in that store and reports `budgetPressure.droppedCount` of 0.

### US-004: Budget pressure reaches the manifest and story metrics

- [integration] Given a registered context provider whose `fetch` returns `budgetPressure`, calling `assemble()` writes a `providerResults` entry for that provider whose `budgetPressure` equals the value the provider returned.
- [integration] Given a registered context provider whose `fetch` returns no `budgetPressure`, calling `assemble()` writes a `providerResults` entry for that provider with `budgetPressure` absent.
- [unit] `collectStoryMetrics` returns `context.providers` for a provider whose `budgetPressure.overageTokens` equals the sum of that provider's `overageTokens` across every stored stage manifest for the story.
- [unit] `collectStoryMetrics` returns `context.providers` for a provider whose `budgetPressure.droppedCount` equals the sum of that provider's `droppedCount` across every stored stage manifest for the story.
- [unit] `collectStoryMetrics` returns `context.providers` for a provider whose `budgetPressure.droppedTokens` equals the sum of that provider's `droppedTokens` across every stored stage manifest for the story.
- [unit] `collectStoryMetrics` omits `budgetPressure` from a provider's entry in `context.providers` when that provider's stored manifest entries carry no `budgetPressure` field.
- [unit] `collectStoryMetrics` returns a provider entry whose `budgetPressure` has no `droppedIds` property even when the stored manifest entries carry `droppedIds`.
