# ACP catalog-backed pricing

Date: 2026-09-08
Status: Design approved, not implemented

## Problem

`src/agents/cost/pricing.ts` hand-maintains a table of per-model token rates.
It is stale, and it is stale in the direction that matters: `resolvePricingSource`
detects only an *absent* entry, so a wrong rate is stamped `"model-rates"` and
reads as authoritative in the cost ledger with no downstream signal. The file's
own comment says as much — "a wrong row is worse than a missing one".

Measured against the catalog on 2026-09-08, seven of roughly eleven live rows
are wrong:

| key | table | catalog | error |
|---|---|---|---|
| `opus` → `claude-opus-5` | 15 / 75 | 5 / 25 | 3x over |
| `sonnet` → `claude-sonnet-5` | 3 / 15 | 2 / 10 | 50% over |
| `claude-opus-4-6` | 15 / 75 | 5 / 25 | 3x over |
| `opencode-go/deepseek-v4-pro` | 1.32 / 3.96 | 0.66 / 1.98 | 2x over |
| `opencode-go/deepseek-v4-flash` | 0.44 / 1.32 | 0.22 / 0.66 | 2x over |
| `claude-haiku-4-5` | 0.8 / 4.0 | 1 / 5 | 20% under |
| `gpt-5.6-sol` | 5 / 30 | 4 / 20 | 25-33% over |

The deepseek rows carry a comment claiming they hold DeepSeek's *peak* rate
deliberately, so `execution.costLimit` stays protective. That rationale no
longer holds — DeepSeek has since lowered its prices, and the catalog value is
the current one. The divergence is a stale-price artifact, not a live hedge, so
no override survives this change.

The rates are also wrong in the place that hurts most. The estimator covers the
rows the wire does not price, and per the August baseline (R15) that is
**56% of rows / ~5% of dollars** — the cheap-model rows, which are exactly the
mispriced ones. Those rows feed the native-versus-acpx cost comparison that the
harness roadmap turns on.

## Why not the obvious alternatives

**Fetch models.dev at runtime.** Rejected. `models.dev/models.json` and
`models.dev/catalog.json` carry **no pricing at all** (0 of 370 entries have a
`cost` field); only the 4.3 MB provider-scoped `models.dev/api.json` does.
Fetching that per run adds a network dependency to cost accounting and lets the
cost basis change silently between two runs.

**Generate a table from models.dev at build time.** Rejected as redundant. nax
already consumes models.dev transitively: the native path prices from nax-ai's
catalog, which normalises `@earendil-works/pi-ai`'s bundled data, which pi-ai
generates from the models.dev API. A second pipeline to the same source is
maintenance we would be adding, not removing.

**Just correct the five rows.** Rejected. It repairs today's numbers and leaves
the drift mechanism intact.

**Delete `MODEL_PRICING` outright and rely on wire-reported cost.** Rejected.
ACP's `exactCostUsd` is opportunistic, not contractual: `parser.ts:178-182`
reads it from `update.cost.amount`, and the parser's own comment flags the shape
as agent-dependent ("Claude Code does; other adapters may omit it"). Deleting
the estimator sends 56% of rows to `$0`, which is R15 finding #2 ("silent drop
— run totals are a floor") made materially worse, and drops those calls out of
`execution.costLimit` accounting.

## Freshness evidence

pi-ai 0.84.4's bundled catalog was diffed against live `models.dev/api.json`:
**791 priced pairs across 27 providers, 38 drift (4.8%)**. The drift is
concentrated in aggregator rows whose prices genuinely float — 28 of 38 are
`openrouter/*`, plus `google/gemini-flash-*`, `github-copilot/gpt-5.6-sol` and
`opencode-go/hy3`.

**No model nax runs drifts.** `anthropic/*`, `minimax/*`, `openai/gpt-5.6-*`,
`huggingface/MiniMaxAI/*` and `opencode-go/deepseek-v4-{pro,flash}` all match
live exactly. Catalog freshness is therefore bounded by pi-ai's release cadence,
and that bound is empirically adequate for nax's model set.

## Goals

1. No hand-maintained *per-model* token rates anywhere in nax. The single
   generic fallback card survives as a deliberate constant — it is a floor for
   models nothing can price, not a rate table, and it is never presented as a
   model's real rate (it always stamps `fallback-rates`).
2. One pricing source across the ACP and native paths.
3. Unpriceable models are **discoverable**, never silently wrong.
4. The change retires itself: when the ACP path goes away, so does all of this.

## Non-goals

- Changing what is dispatched on the wire. `"sonnet"` continues to reach acpx as
  `"sonnet"`.
- Touching `src/config/`, `resolveModel`, `isUnrecognizedLiteralModel`, or the
  protocol gate.
- Native-path pricing, which already resolves from the catalog.
- Per-model rate overrides in the alias file.

## Design

### 1. Alias file

`src/agents/cost/model-aliases.json`, bundled into `dist/nax.js` by
`bun build` (`resolveJsonModule` is already enabled; `files: ["dist/"]` ships
only the bundle, so the JSON needs no packaging change).

```json
{
  "sonnet": { "provider": "anthropic", "model": "claude-sonnet-5" },
  "opus":   { "provider": "anthropic", "model": "claude-opus-5" },
  "haiku":  { "provider": "anthropic", "model": "claude-haiku-4-5" }
}
```

Entries are provider-qualified, not flat strings: the same model carries
different ids per provider (`opencode-go` lists `minimax-m2.7`, `minimax` lists
`MiniMax-M2.7`).

Only bare ids need entries. Provider-qualified config values
(`minimax/MiniMax-M2.7`, `opencode-go/deepseek-v4-pro`) resolve by splitting.

This is a **shipped default with no user-override path**. The map covers the
three Anthropic shorthands `.nax/config.json` uses; a user wanting any other
model can already write its real id and bypass aliasing entirely. A merge layer
is deferred until a user actually needs one.

Aliases change when a vendor *renames* a model. Rates change every few weeks.
Trading the second maintenance surface for the first is the point of this
change.

### 2. Resolver

**Module boundary (amended after codebase grounding).**
`scripts/check-nax-ai-imports.ts` restricts `@nathapp/nax-ai` to
`src/agents/native/` and runs inside `bun run lint`, so the catalog lookup
cannot live in `src/agents/cost/`. Importing it from `src/agents/native/`
instead would close a `cost <-> native` runtime cycle (`native/models.ts:10`
already imports `@/agents/cost`), which `check:import-cycles` fails. A new
`src/agents/catalog/` module therefore owns the nax-ai boundary and is added as
a second allowed prefix in the gate; it depends on neither `cost/` nor
`native/`, so no cycle is created.

New `src/agents/cost/rate-card.ts`:

```ts
export interface RateCard {
  rates: TokenPricing;
  source: "catalog-rates" | "fallback-rates";
}

export function resolveRateCard(modelId: string): Promise<RateCard>;
```

1. Strip the `[effort]` suffix with `parseModelSpec` — nax profiles pin
   `gpt-5.6-luna[high]`, and a suffixed id matches nothing (#1464).
2. If the remainder contains `/`, split on the **first** slash into
   `(provider, model)`; a provider id never contains a slash but a model id
   often does (`huggingface/MiniMaxAI/MiniMax-M2.7`). Otherwise consult the
   alias file.
3. Look up `catalog.model(provider, model)` and map nax-ai's `Pricing` to nax's
   `TokenPricing`, carrying `cacheRead`, `cacheWrite` and **`tiers`** through.
4. On any miss, return the generic fallback card with
   `source: "fallback-rates"`.

Step 3 picks up context-threshold pricing that the current table explicitly
cannot express — `pricing.ts` says "this table has no context dimension" for
`gemini-2.5-pro`, and the same limitation silently applies to every `gpt-5.6-*`
row and to `MiniMax-M3`. `TokenPricingSchema` already models it via
`inputTokensAbove`, and `estimateCostUsd` on the native path already applies it.

The catalog is loaded once and memoised inside this module. `defaultProviders()`
is async behind a dynamic import and costs ~50 ms.

### 3. Cost math

**Amended after grounding: this function already exists.**
`estimateCostUsd(usage, rates)` in `native/models.ts:185` is exactly it —
pure, synchronous, tier-aware, taking rates as an argument. It is *moved* to
`src/agents/cost/` rather than written, with `native/models.ts` importing it
back from `@/agents/cost` (a direction that already exists, so no cycle). No
`estimateCostFromRates` is introduced.

Sharing one implementation forces one cache-class fallback rule. The relocated
function's existing semantics win: an absent `cacheReadPer1M` or
`cacheCreationPer1M` falls back to `inputPer1M`. This **changes** ACP's current
behaviour, which uses 10% and 33% of input respectively. `PricingRates` declares
`cacheRead` and `cacheWrite` as required, so the catalog always supplies both and
the fallback is reachable only via the generic fallback card or an explicit
`modelDef.pricing` override.

### 4. Adapter wiring

The rate card is resolved **once**, then reused per turn — mirroring the native
path, where `buildRateCard` (`native/models.ts:218`) already does exactly this.

- `complete()`: resolve alongside `createSession` (`adapter.ts:158`), where
  `_options.modelDef` is in scope.
- Session path: resolve in `createSession` (`adapter.ts:308`) and store the card
  on the handle beside `_modelDef`.
- `BuildTurnResultInput.modelDef` becomes `rateCard`.
- The three estimator call sites — `adapter.ts:123` (`deriveTokenUsage`),
  `adapter.ts:576` (session-error path), `adapter-output.ts:237`
  (`buildTurnResult`) — take rates instead of a model string.

Both results set `pricingSource` from the card. `CompleteResult.pricingSource`
(`types.ts:414`) and `TurnResult.pricingSource` (`session-types.ts:180`) already
exist and are already accepted by `middleware/cost.ts` and the aggregator:
US-003/US-004 widened the union to admit `"catalog-rates"` but never wired the
ACP producers to emit it. This populates them, which also delivers R15's
"rate-provenance breakdown by `pricingSource`".

Wire-exact cost is unaffected. `middleware/cost.ts:154` still prefers
`exactCostUsd` and stamps `"wire"`; the rate card only governs the estimate.

### 5. Failure semantics

An unresolvable model returns the **generic fallback card** and logs a warning
**once per distinct model id**.

- Not zero cost: that is R15's silent-drop failure and would drop the call out
  of `execution.costLimit`.
- Not silent: `fallback-rates` keeps the ledger honest, and the one-time warning
  makes the gap discoverable so the alias file can be filled.
- Warn once, not per turn: a long session must not flood the log.

A catalog **load** failure (the dynamic import throwing) is treated as a
total miss — every lookup returns the fallback card, with one warning. Pricing
must never take down a run.

### 6. Deletions

- `src/agents/cost/pricing.ts` in full: `MODEL_PRICING`, `COST_RATES`,
  `RATE_CARD_REVIEWED`.
- `estimateCost` and `estimateCostByDuration` from `calculate.ts`. Neither has a
  production caller; both are exercised only by
  `test/unit/metrics/cost.test.ts`, which goes with them.
- `estimateCostFromTokenUsage`, superseded by the relocated `estimateCostUsd`.
- `resolvePricingSource` loses its `MODEL_PRICING` branch and reduces to an
  `unknown-model` guard for callers that have no producer-supplied source.
- Corresponding exports in `src/agents/index.ts`.

Re-verify the dead-code claim during implementation rather than trusting a
single grep — `docs/dead-tests-report.md` has produced false positives before.

## Testing

Unit:
- `resolveRateCard` — bare alias hit; provider-qualified split; multi-slash
  model id (`huggingface/MiniMaxAI/MiniMax-M2.7`); `[effort]` suffix stripped;
  alias miss; catalog miss; catalog load failure.
- Warn-once: two lookups of the same unresolved id produce one warning; two
  distinct unresolved ids produce two.
- `estimateCostFromRates` — cache-class fallbacks, tiered rates above and below
  `inputTokensAbove`.
- A regression test asserting every alias in `model-aliases.json` resolves in
  the catalog. This is the gate that keeps the alias file from rotting, and it
  is the one thing standing between this design and the failure it replaces.

Integration:
- ACP `complete()` and `sendTurn()` emit `pricingSource: "catalog-rates"` for a
  known model and `"fallback-rates"` for an unknown one.
- A wire-reported `exactCostUsd` still wins and still stamps `"wire"`.

Both sides of each assertion must be non-empty — a green test over an empty
fixture enforces nothing.

## Risks

**The alias map rots.** A vendor renames a model and the alias points at
nothing. Mitigated by the resolution test above, which fails at CI rather than
mispricing at runtime — a strictly better failure mode than today's, where a
stale rate produces a confident wrong number.

**Catalog lag.** pi-ai ships a snapshot, so a same-week repricing is not
reflected until pi-ai releases and nax bumps. Measured drift on nax's own model
set is currently zero, and the failure is bounded and shared with the native
path rather than being a new class of error.

**Async resolution at a previously-sync seam.** `createSession` and `complete()`
are already async, so no signature above the adapter changes. The residual risk
is an ordering mistake inside the adapter; covered by the integration tests.

## Verification

1. No per-model token rate remains in `src/` (`pricing.ts` is gone); the only
   surviving constant is the generic fallback card.
2. A run against `.nax/config.json`'s `claude` agent produces cost rows stamped
   `pricingSource: "catalog-rates"`, priced at 2/10 for `sonnet`.
3. An unknown model id produces exactly one warning and a `"fallback-rates"`
   row with non-zero cost.
4. `bun run test` and `bun run lint` pass.
