# SPEC: ACP catalog-backed pricing

## Summary

Replace nax's hand-maintained per-model token rate table (`src/agents/cost/pricing.ts`)
with lookups against nax-ai's model catalog, keyed through a small bundled alias
file. The ACP path then prices from the same source the native path already uses,
`MODEL_PRICING` is deleted, and unpriceable models become discoverable instead of
silently wrong.

## Motivation

`MODEL_PRICING` is stale, and stale in the direction that matters: `resolvePricingSource`
detects only an *absent* entry, so a wrong rate is stamped `"model-rates"` and reads as
authoritative in the cost ledger with no downstream signal. The file's own comment says
"a wrong row is worse than a missing one".

Measured against the catalog on 2026-09-08, seven of roughly eleven live rows are wrong:

| key | table | catalog | error |
|---|---|---|---|
| `opus` -> `claude-opus-5` | 15 / 75 | 5 / 25 | 3x over |
| `sonnet` -> `claude-sonnet-5` | 3 / 15 | 2 / 10 | 50% over |
| `claude-opus-4-6` | 15 / 75 | 5 / 25 | 3x over |
| `opencode-go/deepseek-v4-pro` | 1.32 / 3.96 | 0.66 / 1.98 | 2x over |
| `opencode-go/deepseek-v4-flash` | 0.44 / 1.32 | 0.22 / 0.66 | 2x over |
| `claude-haiku-4-5` | 0.8 / 4.0 | 1 / 5 | 20% under |
| `gpt-5.6-sol` | 5 / 30 | 4 / 20 | 25-33% over |

The estimator covers exactly the rows the wire does not price. Per the August cost
baseline that is 56% of rows / ~5% of dollars — the cheap-model rows, which are the
mispriced ones, and which feed the native-versus-acpx cost comparison the harness
roadmap turns on.

The native path is already correct: it resolves rates from nax-ai's catalog, which
normalises `@earendil-works/pi-ai`'s bundled data, generated upstream from models.dev.
A diff of pi-ai 0.84.4 against live `models.dev/api.json` found 38 drifting rows out of
791 priced pairs across 27 providers, all in floating aggregator entries
(`openrouter/*`, `google/gemini-flash-*`, `github-copilot/gpt-5.6-sol`,
`opencode-go/hy3`). No model nax runs drifts. The data nax needs is already correct,
already in the process, and already load-bearing on the other path.

## Design

### Approach

Swap the rate *source*, not the estimator. ACP's `exactCostUsd` is opportunistic rather
than contractual — `src/agents/acp/parser.ts` reads it from `update.cost.amount` and its own comment
notes the shape is agent-dependent ("Claude Code does; other adapters may omit it"), so
deleting the estimator outright would send 56% of rows to zero and drop those calls out of
`execution.costLimit` accounting.

Runtime fetching of models.dev is rejected: `models.dev/models.json` and
`models.dev/catalog.json` carry no `cost` field on any of their 370 entries, and the only
priced endpoint is the 4.3 MB provider-scoped `api.json`. Generating a table from it at
build time is rejected as a second pipeline to a source nax already consumes.

### Integration

Read-only symbols, verified present at their stated shapes:

- `defaultProviders(ids?: readonly string[]): Promise<RawProvider[]>` — `@nathapp/nax-ai`.
- `normaliseCatalog(raw, overrides?): Catalog` — `@nathapp/nax-ai`.
- `Catalog.model(provider: string, model: string): ResolvedModel | undefined`.
- `ResolvedModel.pricing: Pricing`, where `PricingRates` declares `input`, `output`,
  `cacheRead` and `cacheWrite` as **required** numbers; only `tiers?: readonly PricingTier[]`
  is optional, and `PricingTier` adds `inputTokensAbove`.
- `parseModelSpec(raw): { model: string; effort?: string }` — `src/agents/model-spec.ts`.
- `TokenPricing` / `TokenPricingTier` — `src/config/schema-types.ts`; the tier field is
  `inputTokensAbove`.
- `buildRateCard(catalog: Pricing, override: TokenPricing | undefined): { rates: TokenPricing; source: "config-override" | "catalog-rates" }`
  — `src/agents/native/models.ts:218`. The pattern US-002 mirrors: resolve once, reuse per turn.

Mutated symbols:

- `estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number`
  - Baseline: defined in `src/agents/native/models.ts:185`, together with its private
    `selectRates` tier-selection helper. Baseline stated only to locate the code.
  - Target: same signature, relocated to `src/agents/cost/`, exported from `@/agents/cost`,
    with `src/agents/native/models.ts` importing it from there. `native/` already imports
    `@/agents/cost` (`models.ts:10`), so the direction adds no cycle.

- `BuildTurnResultInput` — `src/agents/acp/adapter-output.ts:205`.
  - Baseline: carries `modelDef: ModelDef`.
  - Target: carries `rateCard: RateCard` in place of `modelDef`; `buildTurnResult` prices
    from `rateCard.rates` and sets `pricingSource` from `rateCard.source`.

- `resolvePricingSource(model: string | undefined)` — `src/agents/cost/calculate.ts:200`.
  - Baseline: returns `"model-rates"` when `MODEL_PRICING` has the model.
  - Target: the `MODEL_PRICING` branch is gone; the function returns `"unknown-model"` for
    an absent/empty/`"unknown"` model and `"fallback-rates"` otherwise, for callers with no
    producer-supplied source. The return union is unchanged.

Existing consumers that must keep working unchanged: `middleware/cost.ts:154` still prefers
`exactCostUsd` and stamps `"wire"`; `CompleteResult.pricingSource` (`agents/types.ts:414`)
and `TurnResult.pricingSource` (`agents/session-types.ts:180`) already exist and are already
accepted by `CostAggregator` — US-003/US-004 widened the union for native but never wired
the ACP producers to emit it.

### Module boundary

`scripts/check-nax-ai-imports.ts` restricts `@nathapp/nax-ai` imports to
`src/agents/native/` and runs inside `bun run lint`. Placing the catalog lookup in
`src/agents/cost/` would fail that gate; importing it from `src/agents/native/` instead
would close a `cost <-> native` runtime cycle, because `native/models.ts:10` and
`native/session/turn-loop.ts:11` already import `@/agents/cost` — and
`bun run check:import-cycles` fails a newly cyclic module.

Resolution: a new `src/agents/catalog/` module owns the nax-ai boundary and is added as a
second allowed prefix in the gate. It imports nax-ai, maps `Pricing` onto nax's own
`TokenPricing`, and exports no nax-ai type. It depends on neither `cost/` nor `native/`, so
no cycle is created. The gate's stated rationale — "swappable only while its surface has one
consumer" — is what changes here, and the change is recorded in the gate rather than routed
around. The prose rule in `.nax/rules/adapter-wiring.md` states the same boundary and has
already been amended to match; see Out of Scope.

### File Format

`src/agents/cost/model-aliases.json`, bundled into `dist/nax.js` by `bun build`
(`resolveJsonModule` is already enabled; `files: ["dist/"]` ships only the bundle, so no
packaging change is needed).

```json
{
  "sonnet": { "provider": "anthropic", "model": "claude-sonnet-5" },
  "opus":   { "provider": "anthropic", "model": "claude-opus-5" },
  "haiku":  { "provider": "anthropic", "model": "claude-haiku-4-5" }
}
```

Every key is a bare model id as it appears in `models.<agent>.<tier>` config and on the
acpx wire. Every value carries both `provider` and `model`, both required, both non-empty
strings; there are no other supported fields. Provider qualification is required because
the same model has different ids per provider (`opencode-go` lists `minimax-m2.7`, `minimax`
lists `MiniMax-M2.7`).

Only bare ids need entries. A config value already containing `/`
(`minimax/MiniMax-M2.7`, `opencode-go/deepseek-v4-pro`) is split rather than looked up.

The file is a shipped default with no user-override path. It exists to cover the three
Anthropic shorthands `.nax/config.json` uses; any other model can be written as its real
provider-qualified id and bypass aliasing entirely.

### Failure Handling

| Condition | Behaviour |
|---|---|
| Model id has no alias entry and no `/` | Generic fallback card, `source: "fallback-rates"`, warn once for that id |
| Alias resolves but the catalog has no such provider/model | Generic fallback card, `source: "fallback-rates"`, warn once for that id |
| Catalog load rejects (dynamic import or `defaultProviders` throws) | Every lookup returns no pricing; callers fall back as above; warn once for the load failure |
| Repeated lookups of the same unresolved id | Exactly one warning per distinct id, not one per turn |

Pricing is fail-open throughout: no path throws, because a pricing failure must never end a
run. Zero-cost rows are explicitly rejected as the failure mode — they would drop the call
out of `execution.costLimit` accounting and make run totals a floor.

Cache-class rate fallback is unified on the relocated `estimateCostUsd`'s existing
semantics: an absent `cacheReadPer1M` or `cacheCreationPer1M` falls back to `inputPer1M`.
This changes ACP's current behaviour, which uses 10% and 33% of input respectively. The
catalog always supplies both fields, so the fallback is reachable only through the generic
fallback card and through an explicit `modelDef.pricing` override.

## Out of Scope

- A user-editable or per-project override layer for `model-aliases.json`. The shipped file
  is the only source of aliases; a merge path is deferred until a user needs one.
- Per-model rate overrides inside the alias file. Aliases map ids to catalog coordinates and
  nothing else.
- Changing what nax dispatches on the wire. A configured `"sonnet"` continues to reach acpx
  as `"sonnet"`; aliases are consulted only to decide what to bill.
- Changes to `src/config/` — `resolveModel`, `isUnrecognizedLiteralModel`, `MODEL_SHORTHAND_TIERS`
  and the protocol gate are untouched, and `ModelDef.provider` keeps its current inferred value.
- Native-path pricing behaviour, which already resolves from the catalog via `buildRateCard`.
- Fetching models.dev at runtime or generating a rate table from it at build time.
- Migrating `native/` to consume `src/agents/catalog/`. Native keeps its own nax-ai import.
- Wire-exact cost reporting. `exactCostUsd` handling and the `"wire"` stamp are unchanged.
- Updating `.nax/rules/adapter-wiring.md`. Its "Native path" section **already names**
  `src/agents/catalog/` as a permitted `@nathapp/nax-ai` importer — amended manually on this
  branch as a precondition, before any story runs. No story edits it. This ordering is
  deliberate: the rule is path-scoped to `src/agents/**/*.ts` and loaded at the `execution` and
  `review-adversarial` stages, so it reaches the implementer and reviewer prompts for the very
  files US-001 creates. Had it still read "native is the only directory", the story and the
  rule would contradict, and rectification could not resolve it.
- Regenerating `.claude/rules/` from `.nax/rules/`. Already done on this branch via
  `nax rules export --agent=claude`, so `bun run check:rules-drift` is green before the run
  starts. No story runs the export. `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `codex.md` are
  `nax generate` context files, not rule shims, and are not touched at all.
- Retiring `resolvePricingSource` itself. It keeps its signature and return union for callers
  with no producer-supplied source.

## Stories

### US-001 — Catalog-backed rate resolution

Introduces the catalog boundary, the alias file and the rate-card resolver, and relocates
the tier-aware cost function so both paths share one implementation.

Depends on: nothing.

#### Creates
- `src/agents/catalog/index.ts`, `src/agents/catalog/pricing-lookup.ts`
- `src/agents/cost/rate-card.ts`, `src/agents/cost/model-aliases.json`
- `test/unit/agents/catalog/pricing-lookup.test.ts`, `test/unit/agents/cost/rate-card.test.ts`

#### Context Files
- `src/agents/native/models.ts` — `buildRateCard` is the resolve-once pattern to mirror
- `src/agents/cost/pricing.ts` — the rates being replaced
- `src/agents/cost/calculate.ts` — current estimator semantics
- `src/config/schema-types.ts` — `TokenPricing`, `TokenPricingTier`

#### Modifies
- `src/agents/native/models.ts` — `estimateCostUsd` and its private `selectRates`
  helper move to `src/agents/cost/`; this file imports `estimateCostUsd` from `@/agents/cost`
  instead of defining it. Its existing callers keep the same signature.
- `scripts/check-nax-ai-imports.ts` — `ALLOWED_PREFIX` is a single hard-coded
  `src/agents/native/`; it becomes a list also admitting `src/agents/catalog/`, and its
  error message names both.
- `test/unit/agents/native/models.test.ts` — imports `estimateCostUsd` from
  `@/agents/native/models`, pinning its old location; it imports from `@/agents/cost` instead.
- `test/unit/agents/native/adapter-cost-rates.test.ts` — imports `estimateCostUsd`
  from `@/agents/native/models`, pinning its old location; it imports from `@/agents/cost`
  instead.

### US-002 — ACP adapter prices from the rate card

The ACP adapter resolves a rate card once per session or completion and prices every turn
from it, reporting which source it used.

Depends on: US-001.

#### Context Files
- `src/agents/cost/rate-card.ts` — created by US-001, consumed here
- `src/agents/native/adapter.ts` — how the native adapter stamps `pricingSource`
- `src/agents/session-types.ts` — `TurnResult.pricingSource`
- `src/agents/types.ts` — `CompleteResult.pricingSource`

#### Modifies
- `src/agents/acp/adapter.ts` — `deriveTokenUsage` takes a rate card rather than a
  model string; `complete()` and `createSession()` resolve the card once; the session handle
  carries it beside `_modelDef`.
- `src/agents/acp/adapter-output.ts` — `BuildTurnResultInput.modelDef` becomes
  `rateCard`, and `buildTurnResult` prices from it.
- `test/unit/agents/acp/adapter-output-timedout.test.ts` — builds
  `BuildTurnResultInput` with `modelDef` at seven call sites, a field this story replaces;
  each site constructs the input with `rateCard` instead.

### US-003 — Retire the hardcoded rate table

Deletion-only terminal cleanup. No new code.

Depends on: US-002.

#### Context Files
- `src/agents/index.ts` — the barrel exporting the retired symbols
- `src/agents/cost/index.ts` — the cost barrel

#### Modifies
- `src/agents/cost/pricing.ts` — deleted in full: `MODEL_PRICING`, `COST_RATES`,
  `RATE_CARD_REVIEWED`.
- `src/agents/cost/calculate.ts` — `estimateCost`, `estimateCostByDuration` and
  `estimateCostFromTokenUsage` are removed; `resolvePricingSource` loses its `MODEL_PRICING`
  branch and keeps its signature and return union.
- `src/agents/index.ts` — re-exports `COST_RATES`, `MODEL_PRICING`,
  `estimateCostFromTokenUsage`; these entries are removed.
- `test/unit/metrics/cost.test.ts` — its whole surface is `estimateCost`,
  `estimateCostByDuration` and `COST_RATES`, all removed by this story; the file is deleted,
  except any `formatCostWithConfidence` coverage, which moves to the calculate suite below.
- `test/unit/agents/acp/cost.test.ts` — its entire surface is
  `estimateCostFromTokenUsage` (four describe blocks, all of it); the function is removed by
  this story, so the file is deleted. Its per-model rate cases are superseded by the
  rate-card suite US-001 creates.
- `test/unit/runtime/middleware/cost.test.ts` — imports `estimateCostFromTokenUsage`
  and `MODEL_PRICING`, both removed by this story; those imports and the assertions resting on
  them are removed, and its `pricingSource` coverage is re-pinned to producer-supplied values.
- `test/unit/agents/cost/calculate.test.ts` — asserts against `MODEL_PRICING`
  lookups and `estimateCostFromTokenUsage`; those assertions are removed and the surviving
  `resolvePricingSource` behaviour is re-pinned to its `unknown-model` / `fallback-rates`
  contract.

**Verification note (US-003).** Removals are verified by the build/static gate, not by acceptance
criteria: `bun run typecheck` and `bun run lint` (which chains `check:file-sizes`,
`check:alias-internals`, `check:import-cycles`, `check:nax-ai-imports` and
`check:bundle-externals`). Before deleting, confirm the no-production-caller claim for
`estimateCost` and `estimateCostByDuration` rather than trusting a single search.

### Seams

- `lookupPricing` is exported from `@/agents/catalog` by US-001 and consumed by
  `rate-card.ts` in the same story. US-001 AC14 is its seam invariant.
- `resolveRateCard` is exported from `@/agents/cost` by US-001 and consumed by the ACP
  adapter in US-002. US-002 AC1 and AC2 are its seam invariants, entered at `complete()`
  and `sendTurn()` respectively.

## Acceptance Criteria

### US-001

1. `[unit]` `lookupPricing("anthropic", "claude-sonnet-5")` resolves to a defined value whose
   `inputPer1M` and `outputPer1M` are positive finite numbers.
2. `[unit]` `lookupPricing("no-such-provider", "no-such-model")` resolves to `undefined`.
3. `[unit]` Given a catalog whose `model()` returns pricing with `input` 3, `output` 15,
   `cacheRead` 0.3 and `cacheWrite` 3.75, `lookupPricing` resolves to a value with
   `inputPer1M` 3, `outputPer1M` 15, `cacheReadPer1M` 0.3 and `cacheCreationPer1M` 3.75.
4. `[unit]` Given a catalog whose `model()` returns pricing carrying one tier with
   `inputTokensAbove` 200000, `lookupPricing` resolves to a value whose `tiers` has one entry
   with `inputTokensAbove` 200000.
5. `[unit]` Two successive `lookupPricing` calls invoke the underlying provider loader exactly
   once.
6. `[unit]` When the provider loader rejects, `lookupPricing` resolves to `undefined` and does
   not reject.
7. `[unit]` `resolveRateCard("sonnet")` resolves to a card whose `source` is `"catalog-rates"`.
8. `[unit]` `resolveRateCard("minimax/MiniMax-M2.7")` resolves to a card whose `source` is
   `"catalog-rates"`, without consulting the alias file.
9. `[unit]` `resolveRateCard("huggingface/MiniMaxAI/MiniMax-M2.7")` splits on the first slash
   only, querying the catalog with provider `"huggingface"` and model
   `"MiniMaxAI/MiniMax-M2.7"`.
10. `[unit]` `resolveRateCard("gpt-5.6-luna[high]")` strips the effort suffix before lookup,
    querying the catalog with model `"gpt-5.6-luna"`.
11. `[unit]` `resolveRateCard("no-such-model-anywhere")` resolves to a card whose `source` is
    `"fallback-rates"` and whose `rates.inputPer1M` and `rates.outputPer1M` are positive
    finite numbers.
12. `[unit]` Calling `resolveRateCard("no-such-model-anywhere")` twice produces exactly one
    warning.
13. `[unit]` Calling `resolveRateCard` once for each of two distinct unresolved ids produces
    exactly two warnings.
14. `[unit]` With `lookupPricing` stubbed, `resolveRateCard("sonnet")` invokes it once with
    provider `"anthropic"` and model `"claude-sonnet-5"`.
15. `[unit]` Every alias entry in `model-aliases.json` resolves to a defined result when its
    `provider` and `model` are passed to `lookupPricing`.
16. `[unit]` `estimateCostUsd` is importable from `@/agents/cost` and, given usage of
    1,000,000 input and 1,000,000 output tokens against rates of `inputPer1M` 2 and
    `outputPer1M` 10, returns 12.
17. `[unit]` `estimateCostUsd` with `cacheReadPer1M` unset prices 1,000,000 cache-read tokens
    at `inputPer1M`.
18. `[unit]` `estimateCostUsd` given rates carrying a tier with `inputTokensAbove` 200000
    applies the tier's `inputPer1M` when input-class usage totals 250,000 tokens.
19. `[unit]` `estimateCostUsd` given rates carrying a tier with `inputTokensAbove` 200000
    applies the base `inputPer1M` when input-class usage totals 100,000 tokens.

### US-002

1. `[integration]` Invoking `complete()` with a stubbed `resolveRateCard` and a model whose
   card reports `"catalog-rates"` yields a `CompleteResult` whose `pricingSource` is
   `"catalog-rates"`.
2. `[integration]` Invoking `sendTurn()` on a session opened by `createSession()` with a
   stubbed `resolveRateCard` reporting `"catalog-rates"` yields a `TurnResult` whose
   `pricingSource` is `"catalog-rates"`.
3. `[integration]` Invoking `complete()` for a model whose card reports `"fallback-rates"`
   yields a `CompleteResult` whose `pricingSource` is `"fallback-rates"`.
4. `[integration]` Two successive `sendTurn()` calls on one session invoke `resolveRateCard`
   exactly once.
5. `[unit]` `buildTurnResult` given a `rateCard` with `inputPer1M` 2 and `outputPer1M` 10 and
   accumulated usage of 1,000,000 input and 1,000,000 output tokens returns a `TurnResult`
   whose `estimatedCostUsd` is 12.
6. `[unit]` `buildTurnResult` given `totalExactCostUsd` of 0.42 returns a `TurnResult` whose
   `exactCostUsd` is 0.42, unchanged by the rate card.
7. `[integration]` A dispatch carrying a wire-reported `exactCostUsd` records a cost row whose
   `pricingSource` is `"wire"`, taking precedence over the card's source.
8. `[unit]` `buildTurnResult` with `timedOut` true returns a `TurnResult` whose `output` is the
   empty string, unchanged by this story.

### US-003

Removal-only; verified by the build/static gate recorded on the story. No acceptance criteria.

<!-- spec-writing: completed-through-phase-6 -->
