# SPEC: Cost-Row Rate Provenance

## Summary

Every nax cost row records what a call cost, but not the per-1M rates it was
priced at. Those rates are resolved, used once inside `estimateCostUsd`, and
discarded. This feature carries them onto the row: the four effective per-1M
rates actually multiplied against the token counts, plus the version of the
catalog package they came from. A cost row becomes self-describing — its
arithmetic independently checkable, and its rate vintage nameable — which makes
both catalog rate drift (#2020) and time-varying provider rates (#2021)
answerable after the fact by anyone reading a ledger, without nax owning a rate
table, a network fetch, or a model of time.

## Motivation

Two filed gaps share one root cause: a cost row states a conclusion and discards
its inputs.

**#2020 — catalog rate drift is undetectable.** A row stamped
`pricingSource: "catalog-rates"` carries no signal that the catalog rate
disagrees with the provider's published rate. The rates originate in a transitive
dependency's bundled data file, and measured drift on one provider ran 2.33x on
one model's `cacheRead` and 0.50x on another's — in opposite directions, on the
term that dominates the bill (the harness telemetry baselines measured ~99.5% of
billed input tokens as cache-read). The ledger presents a drifted rate with
exactly the same confidence as a correct one, and the same stale value survived a
memory snapshot and a week of runs unnoticed.

**#2021 — time-varying rates are unrepresentable.** One provider bills its
DeepSeek models at exactly 2x during published peak hours. Neither pricing-override
inlet has a temporal dimension, so any single configured value is wrong for part
of every weekday. The issue notes the mitigation that already works — rows carry
`ts`, so peak/off-peak can be reconstructed post-hoc — but that reconstruction
requires the analyst to already know the rate card by heart.

Both issues independently propose the same remedy: record the rate card on the
row. Doing it once serves both. It does not detect drift and does not correct a
budget gate mid-run — those active halves stay open, narrowed to exactly that.

## Design

A cost row gains two optional fields: `rates` (the four effective per-1M numbers
that were multiplied) and `catalogVersion` (the version of the catalog package
those rates came from). `COST_ROW_SCHEMA_VERSION` goes 4 -> 5. Both fields are
optional, so existing v4 rows stay readable and no consumer breaks on absence.

**Why effective rates rather than the resolved card.** `estimateCostUsd` selects
one rate row for the whole request via its internal tier selection, then
substitutes `inputPer1M` for any absent cache rate. Recording the post-selection,
post-substitution numbers is what makes a row's arithmetic verifiable: token
counts multiplied by the recorded rates must reproduce the recorded
`estimatedCostUsd`. Recording the whole card instead would force every reader to
re-run tier selection to learn what was actually billed.

**Data flow.** The rates are known in the producer (the adapter, where pricing
happens) and the row is written in the cost subscriber. That producer-to-row
handoff already exists for `pricingSource`, which the subscriber copies through
rather than re-deriving. The rates travel the same path — result object ->
dispatch event -> cost row — so this feature adds a passenger to an existing
seam rather than a new channel.

**Three deliberate decisions.**

1. `rates` describes `estimatedCostUsd`, not `costUsd`. When a wire-exact cost is
   present the row's `pricingSource` becomes `"wire"`, discarding the producer's
   branch. `rates` survives that branch: the row still carries an
   `estimatedCostUsd` computed from them, and a row where estimate and exact cost
   diverge is the interesting one. `pricingSource: "wire"` together with `rates`
   present is valid and intended.
2. The cache-rate fallback is resolved before recording. Pricing substitutes
   `inputPer1M` for an absent `cacheReadPer1M` or `cacheCreationPer1M`. Recording
   the substituted number is what makes the arithmetic check out; recording
   absence would leave the row unverifiable exactly where cache-read dominates.
3. `catalogVersion` is stamped only when the producer's own reported source was
   the catalog. It keys off the producer-supplied value on the dispatch event, not
   off the row's final `pricingSource` — which the wire branch may have already
   overwritten. A `config-override` row's rates came from the operator's config,
   so stamping a catalog version there would assert a false origin.

**How `catalogVersion` is obtained.** nax pins its catalog dependency exactly
(no range), so the declared pin is an exact version string. It is read the same
way the existing version module already reads nax's own version — a static
import of `package.json`, which the bundler inlines as a constant. A runtime read
of the dependency's own manifest is not available: its `exports` map declares
only the package root, with no `./package.json` subpath.

Known limitation, accepted: this is the *declared* pin, not the *installed*
version. The two diverge only under a local link or override during development.
The pin is what CI and every release ship, so it is a sound answer to "which rate
vintage billed this row".

### Integration

This feature changes three call signatures and adds fields to four types. The
baselines below exist only to locate the code; they are never the interface to
implement.

**`estimateCostUsd`** — `src/agents/cost/estimate.ts:79` (US-001)
- Baseline: `estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number`
- Target: unchanged signature and unchanged contract. It becomes a thin wrapper
  that returns the cost component of `priceCall`.

**`priceCall`** — new export from `src/agents/cost/estimate.ts`, re-exported
through `src/agents/cost/index.ts` (US-001)
- Target: `priceCall(usage: TokenUsage, rates: TokenPricing): { costUsd: number; resolvedRates: ResolvedRates }`

**`ResolvedRates`** — new exported interface, `src/agents/cost/estimate.ts` (US-001)
- Target: four required numbers — `inputPer1M`, `outputPer1M`, `cacheReadPer1M`,
  `cacheCreationPer1M`. All four required, distinguishing it from the module's
  existing internal tier-selection shape whose cache fields are optional.

**`deriveTokenUsage`** — `src/agents/acp/adapter.ts:121` (US-002)
- Baseline: `private deriveTokenUsage(wire, rateCard): { tokenUsage: TokenUsage; estimatedCostUsd: number }`
- Target: the same, plus `rates?: ResolvedRates` on the returned object, absent when the
  nonzero-usage guard skipped pricing.

**`buildTurnResult` / `BuildTurnResultInput`** — `src/agents/acp/adapter-output.ts:234` (US-002)
- Baseline: `buildTurnResult(input: BuildTurnResultInput): TurnResult`, pricing behind a
  `hasUsage` guard at `:241`.
- Target: the same signature; the returned `TurnResult` additionally carries
  `rates` when the guard let pricing run.

**`CompleteResult` / `TurnResult`** — `src/agents/session-types.ts` (US-002)
- Baseline: both carry `pricingSource?: "catalog-rates" | "config-override" | "fallback-rates"`
  (`:192`) alongside `estimatedCostUsd` / `exactCostUsd`.
- Target: the same, plus `rates?: ResolvedRates`.

**`DispatchEvent`** — `src/runtime/dispatch-events.ts:68` (US-002)
- Baseline: carries `pricingSource?` as a producer-supplied passenger.
- Target: the same, plus `rates?: ResolvedRates`.

**`CostEvent`** — `src/runtime/cost-aggregator.ts:3` (US-003)
- Baseline: carries `schemaVersion?`, `estimatedCostUsd`, `pricingSource?`.
- Target: the same, plus `rates?: ResolvedRates` and `catalogVersion?: string`.

**`COST_ROW_SCHEMA_VERSION`** — `src/runtime/middleware/cost.ts:56` (US-003)
- Baseline: `4`
- Target: `5`.

Symbols this feature reads but does **not** change:

- `TokenPricing` with optional `tiers` — `src/config/schema-types.ts`
- `TokenUsage` — `src/agents/cost/types.ts`
- `buildRateCard(catalog, override) -> { rates, source }` — `src/agents/native/models.ts:191`
- `resolveRateCard(modelId, lookupPricing) -> Promise<RateCard>` — `src/agents/cost/rate-card.ts`
- `NAX_VERSION` and its `import pkg from "../package.json"` pattern — `src/version.ts:8,13`
- `resolvePricingSource(model)` — `src/agents/cost/calculate.ts`

Patterns to follow:

- The producer-supplied passenger pattern established for `pricingSource`: the
  adapter stamps it on its result, the dispatch event forwards it, the cost
  subscriber copies it through without re-deriving.
- The conditional-spread idiom used throughout the cost subscriber's row
  construction, which omits absent fields rather than writing `undefined`.
- The static-manifest-import pattern in `src/version.ts` for build-time constants.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Producer supplied no rates (pre-existing path, or an adapter that resolved no card) | Row omits `rates` entirely. Fail-open: the row is written exactly as it is today. |
| Producer's reported source was not the catalog | Row omits `catalogVersion`. No false origin is asserted. |
| Dispatch failed (error row) | Row carries neither field. See Out of Scope. |
| Session turn carried no token usage (`usageMissing`) | Row omits `rates`; nothing was multiplied. |
| Call had zero input and zero output tokens | Adapter-dependent, deliberately: the ACP path's nonzero-usage guard skips pricing, so no rates are produced; the native path prices unconditionally and produces rates for a zero-cost call. Both are recorded as they occur rather than normalised. |
| Catalog pin string unreadable at build time | `catalogVersion` is omitted rather than recorded as an empty or placeholder string; the row stays valid. |

## Out of Scope

- Detecting catalog rate drift at runtime or in CI, including any command that fetches or scrapes a provider's published rate card. Issue #2020's active half stays open.
- Any network request, HTTP fetch, HTML scraping, or provider API credential handling in the pricing path.
- A rate table, bundled rate data, or any rate source owned by nax itself.
- Expressing time-varying (peak/off-peak) rates in configuration, including any time predicate, UTC hour range, or weekday mask on a pricing tier. Issue #2021's active half stays open.
- Changes to the pricing-override config schemas, their validation, or the wholesale-override precedence rule.
- Changes to how `costUsd`, `exactCostUsd`, or `confidence` are computed, and to any budget gate or spend cap that reads them.
- Changes to tier-selection semantics, including which tier wins and the strictly-greater-than threshold comparison.
- Recording the full resolved rate card, including the `tiers` array, on a cost row. Only the post-selection effective rates are recorded.
- Recording rates or catalog version on error rows, which carry a partial-spend estimate attributed from a failed dispatch. Deferred because the error carrier is a positional constructor and extending it is disproportionate to the partial-spend case.
- Detecting that the installed catalog package differs from the declared pin, such as under a local development link or a package-manager override.
- Backfilling, migrating, or re-pricing existing schemaVersion 4 cost rows.
- Any reader-side feature that consumes the new fields: reporting, drift dashboards, re-pricing tooling, or telemetry rollups.

## Stories

### US-001 — Pricing returns the rates it used

Introduce `priceCall`, which computes a call's cost and returns the effective
per-1M rates it multiplied by, with tier selection applied and the cache-rate
fallback resolved. `estimateCostUsd` is retained unchanged as a wrapper over it,
so every existing caller and every existing test keeps its current contract.

Depends on: nothing.

#### Context Files
- `src/agents/cost/estimate.ts` — the tier-selection and pricing logic to extend
- `src/agents/cost/index.ts` — barrel to re-export the new symbol from
- `src/config/schema-types.ts` — `TokenPricing` and its optional `tiers` shape
- `test/unit/agents/cost/estimate.test.ts` — existing test patterns for this module

### US-002 — Producers carry the rates to the dispatch event

Both adapters stamp the effective rates on the result they return, and the
dispatch event forwards them, mirroring how `pricingSource` already travels this
path. Adapters price via `priceCall` so the rates they report are the rates they
billed, rather than a second independent resolution.

Depends on: US-001.

#### Context Files
- `src/agents/session-types.ts` — `CompleteResult` / `TurnResult`, `pricingSource` at `:192`
- `src/runtime/dispatch-events.ts` — `DispatchEvent`, `pricingSource` at `:68`
- `src/agents/native/adapter.ts` — native pricing call site at `:199`
- `src/agents/acp/adapter.ts` — ACP pricing inside `deriveTokenUsage` at `:127`, reached from `complete()` at `:131`; the `:570` site prices a thrown `SessionTurnError` and is out of scope
- `src/agents/acp/adapter-output.ts` — ACP result construction at `:241`

### US-003 — The cost row records rates and catalog version

The cost subscriber stamps both new fields on the row and the schema version goes
to 5. The catalog version is exposed as a build-time constant beside the existing
nax version constant. The pricing-override field documentation gains a note that
configured rates are treated as time-invariant, so operators know a
time-varying provider rate must be reconstructed post-hoc.

Depends on: US-002.

#### Context Files
- `src/runtime/middleware/cost.ts` — row construction and `COST_ROW_SCHEMA_VERSION` at `:56`
- `src/runtime/cost-aggregator.ts` — `CostEvent` interface at `:3`
- `src/version.ts` — the static manifest-import pattern at `:8`
- `src/config/schemas-model.ts` — pricing-override field docs to annotate
- `test/unit/runtime/middleware/cost.test.ts` — existing row-construction test patterns

### Seams

The project forbids `mock.module()`, and neither the pricing module nor the native
adapter exposes a `_deps` injection seam, so these seams are proven by observable
propagation through the real production path rather than by a spy. The discriminating
fixture is a **tiered** rate card whose usage crosses the tier threshold: the effective
rates then differ from the card's base rates, so a result carrying the base rates proves
the adapter bypassed `priceCall`, and a result carrying the tier's rates proves it did not.

- [unit] invoke the native adapter's `complete()` with a tiered rate card and usage crossing the tier threshold; assert the returned `CompleteResult.rates` equals the tier's rates, not the card's base rates
- [unit] invoke the ACP adapter's `complete()` with a tiered rate card and nonzero usage crossing the tier threshold; assert the returned `CompleteResult.rates` equals the tier's rates, not the card's base rates
- [integration] emit a dispatch event carrying `rates`; assert the recorded cost row carries the same four rate values

## Acceptance Criteria

### US-001

- [unit] `priceCall` is importable from `@/agents/cost` and, called with usage of 1,000,000 input and 1,000,000 output tokens against rates `{ inputPer1M: 3, outputPer1M: 15 }`, returns `costUsd` equal to 18.
- [unit] `priceCall` called with rates whose `cacheReadPer1M` is undefined returns `resolvedRates.cacheReadPer1M` equal to the card's `inputPer1M`.
- [unit] `priceCall` called with rates whose `cacheCreationPer1M` is undefined returns `resolvedRates.cacheCreationPer1M` equal to the card's `inputPer1M`.
- [unit] `priceCall` called with rates whose `cacheReadPer1M` is defined returns `resolvedRates.cacheReadPer1M` equal to that defined value, not to `inputPer1M`.
- [unit] `priceCall` called with a card carrying a tier at `inputTokensAbove` 100,000 and usage of 150,000 input tokens returns `resolvedRates.inputPer1M` equal to that tier's `inputPer1M`.
- [unit] `priceCall` called with a card carrying a tier at `inputTokensAbove` 100,000 and usage of exactly 100,000 input tokens returns `resolvedRates.inputPer1M` equal to the card's base `inputPer1M`.
- [unit] `priceCall` called with a card carrying two tiers whose thresholds are both crossed returns `resolvedRates` equal to the tier with the higher `inputTokensAbove`.
- [unit] For any usage and card, the sum over the four token classes of (tokens divided by 1,000,000, multiplied by the matching field of `resolvedRates`) equals the returned `costUsd`.
- [unit] `estimateCostUsd` called with the same usage and rates returns a number equal to `priceCall`'s `costUsd` for those inputs.
- [unit] `priceCall` called with usage whose `cacheReadInputTokens` is undefined returns a `costUsd` that charges nothing for cache reads.

### US-002

- [unit] The `CompleteResult` returned by the native adapter's `complete()` carries a `rates` object whose four fields equal the effective rates used to price that call.
- [unit] The `CompleteResult` returned by the ACP adapter's `complete()` carries a `rates` object whose four fields equal the effective rates used to price that call.
- [unit] The `TurnResult` returned by the ACP adapter's `sendTurn()` carries a `rates` object whose four fields equal the effective rates used to price that turn.
- [unit] The native adapter's `complete()`, called with a tiered rate card and usage crossing the tier threshold, returns a `CompleteResult` whose `rates` equal the winning tier's rates and not the card's base rates.
- [unit] The ACP adapter's `complete()`, called with a tiered rate card and nonzero usage crossing the tier threshold, returns a `CompleteResult` whose `rates` equal the winning tier's rates and not the card's base rates.
- [unit] The native adapter's `complete()`, called with token usage of zero input and zero output tokens, returns a `CompleteResult` that carries `rates`, because the native path prices unconditionally.
- [unit] The ACP adapter's `complete()`, called with token usage of zero input and zero output tokens, returns a `CompleteResult` that carries no `rates` field, because its nonzero-usage guard skips pricing entirely.
- [unit] The `TurnResult` returned by the ACP adapter's `sendTurn()` for a turn with zero accumulated token usage carries no `rates` field.
- [integration] A `DispatchEvent` built from a result carrying `rates` exposes the same four rate values on its own `rates` field.
- [integration] A `DispatchEvent` built from a result carrying no `rates` omits the field rather than exposing it as undefined.

### US-003

- [integration] A cost row recorded from a dispatch event carries `schemaVersion` equal to 5.
- [integration] A cost row recorded from a dispatch event carrying `rates` exposes the same four rate values on the row's `rates` field.
- [integration] A cost row recorded from a dispatch event that carries both `rates` and a wire-exact cost carries `pricingSource` equal to `"wire"` and still carries the four rate values.
- [integration] A cost row recorded from a dispatch event carrying no `rates` omits the `rates` field.
- [integration] A cost row recorded from a dispatch event whose `pricingSource` is `"catalog-rates"` carries `catalogVersion` equal to `NAX_AI_VERSION`.
- [integration] A cost row recorded from a dispatch event whose `pricingSource` is `"config-override"` carries no `catalogVersion` field.
- [integration] A cost row recorded from a dispatch event whose `pricingSource` is `"fallback-rates"` carries no `catalogVersion` field.
- [integration] A cost row recorded from a dispatch event whose `pricingSource` is `"catalog-rates"` and which also carries a wire-exact cost carries `catalogVersion` equal to `NAX_AI_VERSION`, even though the row's `pricingSource` reads `"wire"`.
- [unit] `NAX_AI_VERSION` is importable from the version module and is a non-empty string matching the dotted numeric form `<major>.<minor>.<patch>`.
- [integration] An error row recorded from a failed dispatch carries neither a `rates` field nor a `catalogVersion` field.
- [integration] A session-turn cost row whose dispatch event carried no token usage carries `usageMissing` true and no `rates` field.

**Out of scope:**
- US-003 only: rates and catalog version on error rows, deferred per the feature-level Out of Scope entry.

<!-- spec-writing: completed-through-phase-6 -->
