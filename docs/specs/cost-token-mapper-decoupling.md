# Cost / Token Mapper Decoupling Refactor

**Status:** Draft (rev 2)
**Date:** 2026-04-25
**Owner:** Nax Dev
**Related:** [ADR-018](../adr/ADR-018-runtime-layering-with-session-runners.md), [cost-ssot.md](./cost-ssot.md)

## Revision history

| Rev | Date | Change |
|:--|:--|:--|
| 1 | 2026-04-25 | Initial draft — wire-format decoupling via `ITokenUsageMapper`. Treated `exactCostUsd` split as out of scope. |
| 2 | 2026-04-25 | **Store both exact and estimated cost.** `AgentResult.estimatedCost` → `estimatedCostUsd` (always present) + new `exactCostUsd?` (when wire reports it). `CostEvent` carries both. Cost-calc ownership decision recorded explicitly: cost module owns the function; adapter owns the call; middleware observes; aggregator stores. Drift detection enabled. |

---

## 1. Problem

The cost SSOT (`estimateCostFromTokenUsage`) **operates on the ACP wire shape** (`SessionTokenUsage`, snake_case). This is a leak: a shared, adapter-agnostic cost utility carries protocol-specific naming. Concrete symptoms today:

| # | Site | Issue |
|:--|:--|:--|
| 1 | [src/agents/cost/calculate.ts:128](../../src/agents/cost/calculate.ts#L128) | `estimateCostFromTokenUsage(usage: SessionTokenUsage, model)` — wire format inside the shared cost SSOT |
| 2 | [src/agents/cost/types.ts:40](../../src/agents/cost/types.ts#L40) | `SessionTokenUsage` (an ACP wire contract) lives in the shared `cost/` module |
| 3 | [src/agents/acp/cost.ts](../../src/agents/acp/cost.ts) | Vestigial 9-line re-export "kept for zero-breakage backward compatibility" |
| 4 | [src/agents/acp/adapter.ts:86-91](../../src/agents/acp/adapter.ts#L86-L91) | Inline duplicate of `cumulative_token_usage` shape — drift hazard against `SessionTokenUsage` |
| 5 | [src/agents/acp/adapter.ts:657-662](../../src/agents/acp/adapter.ts#L657-L662) | Working accumulator (`totalTokenUsage`) holds wire snake_case |
| 6 | [src/agents/acp/adapter.ts:774](../../src/agents/acp/adapter.ts#L774), [:913](../../src/agents/acp/adapter.ts#L913) | Two separate call sites pass wire shape to cost calc |
| 7 | [src/agents/acp/adapter.ts:777-789](../../src/agents/acp/adapter.ts#L777-L789) | Inline anonymous wire→internal mapping when constructing `AgentResult.tokenUsage` |

If/when a second adapter (Codex, Aider) lands with its own wire shape, every fix above gets duplicated. The cost module would need to grow per-adapter overloads. That's the dependency direction inverted.

## 2. Principle — single boundary, owned contract

**One mapper boundary.** Wire format is converted to internal `TokenUsage` exactly once, at the seam between the external library and our adapter wrapper. Above that boundary, only internal types exist.

**Consumer owns the abstraction.** The cost module (consumer) defines the mapper contract. Adapters (producers) implement it. This is Dependency Inversion: high-level modules don't depend on low-level modules; both depend on abstractions owned by the high-level module.

**Single Responsibility on each piece.** The mapper converts wire → internal. The accumulator (`addTokenUsage`) does arithmetic. The cost calc does pricing. The middleware records. The aggregator stores. None of these overlap.

**Both exact and estimated cost are first-class.** When acpx reports an exact cost (`usage_update.cost.amount`), we store it alongside our token-based estimate. Storing both enables drift detection (pricing-rate staleness signal), forward-compat (graceful degradation if exact stops being reported), and unambiguous confidence semantics (`confidence` is derived from "is `exactCostUsd` present?" instead of being a label that can lie).

**Cost-calc ownership: cost module owns the function; adapter owns the call.** `estimateCostFromTokenUsage` is a pure function in `src/agents/cost/calculate.ts`. The adapter calls it once per run and writes the result to `AgentResult.estimatedCostUsd`. Middleware observes; it never computes. Rationale: cost numbers have non-observability consumers (fallback-hop accounting in [metrics/types.ts:92](../../src/metrics/types.ts#L92), budget gates, tests-driving-adapters-directly) that read `AgentResult` without a middleware chain in scope. Producer-side computation is the only correct location.

## 3. Architecture — layered relationships

### 3.1 Top-down layer responsibilities

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1 — CostAggregator        src/runtime/cost-aggregator.ts          │
│   Sink. Stores CostEvent / CostErrorEvent.                              │
│   Provides snapshot(), byAgent(), byStage(), byStory(), drain().        │
│   Owns: aggregation, query, flush-to-StoryMetrics on runtime close.     │
│   Stores both estimatedCostUsd and exactCostUsd from each event so      │
│   reports / audits can show drift, totals, or either number alone.      │
│   Knows: nothing about wire formats. Operates on CostEvent only.        │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 2 — Cost Middleware       src/runtime/middleware/cost.ts          │
│   Observer in AgentManager.runAs() chain. Stateless. Never computes.    │
│   Reads:  AgentResult.tokenUsage, .estimatedCostUsd, .exactCostUsd?     │
│   Emits:  CostEvent {                                                   │
│             tokens, runId, agentName, stage, storyId, model,            │
│             estimatedCostUsd,                                           │
│             exactCostUsd?,                                              │
│             costUsd:    exactCostUsd ?? estimatedCostUsd,  // canonical │
│             confidence: exactCostUsd != null ? "exact" : "estimated",   │
│             durationMs,                                                 │
│           } → ICostAggregator.record()                                  │
│   Owns: record-on-success / record-error-on-throw.                      │
│   Knows: TokenUsage (camelCase) only. Never sees wire format.           │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 3 — AgentManager          src/agents/manager.ts                   │
│   Wraps adapter call with permission pre-resolve + middleware chain.    │
│   Pass-through for tokens/cost. Defined by ADR-018.                     │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 4 — Agent Adapter         src/agents/acp/adapter.ts (our code)    │
│   Implements the AgentAdapter contract.                                 │
│   Owns: protocol orchestration (start, session, prompt, close) +        │
│         the call to the cost SSOT.                                      │
│   Returns: AgentResult {                                                │
│              tokenUsage:        TokenUsage,                             │
│              estimatedCostUsd:  number,        // always — from tokens  │
│              exactCostUsd?:     number,        // when wire reports it  │
│            }                                                            │
│   ─────────────────────────────────────────────────                     │
│   Internally uses:                                                      │
│     - ITokenUsageMapper<SessionTokenUsage> (Layer 6)                    │
│     - addTokenUsage() (Layer 5)                                         │
│     - estimateCostFromTokenUsage(TokenUsage, model) (Layer 5)           │
│   Wire format crosses the boundary exactly once: mapper.toInternal()    │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 5 — Cost Module           src/agents/cost/                        │
│   Owns abstractions and pure functions over internal TokenUsage:        │
│     - ITokenUsageMapper<Wire>      (token-mapper.ts)  ← contract        │
│     - addTokenUsage(a, b)          (calculate.ts)     ← arithmetic      │
│     - estimateCostFromTokenUsage   (calculate.ts)     ← pricing         │
│   Knows: nothing about any specific wire format.                        │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 6 — Mapper Implementation  src/agents/acp/token-mapper.ts         │
│   Concrete adapter per protocol.                                        │
│     class AcpTokenUsageMapper implements ITokenUsageMapper<…>           │
│   The ONLY place SessionTokenUsage flows into TokenUsage.               │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 7 — Wire Types            src/agents/acp/wire-types.ts            │
│   SessionTokenUsage (snake_case). Mirrors acpx contract.                │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 8 — External (acpx)                                               │
│   We do not edit. Emits cumulative_token_usage (snake_case) and         │
│   usage_update.cost.amount.                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Data flow on a single run

```
acpx                                          ← external; wire format
   │  emits cumulative_token_usage : SessionTokenUsage
   ▼
parser.ts                                     ← captures wire shape (Layer 7)
   │  state.tokenUsage : SessionTokenUsage
   ▼
adapter.run() loop:
   │
   │  for each session response:
   │    wire  = response.cumulative_token_usage         // Layer 7
   │    delta = mapper.toInternal(wire)                 // Layer 6 ── boundary crossed once
   │    totalTokens = addTokenUsage(totalTokens, delta) // Layer 5 ── internal arithmetic
   │    if (response.exactCostUsd != null)
   │      totalExactCostUsd = (totalExactCostUsd ?? 0) + response.exactCostUsd
   │
   │  on completion:
   │    estimatedCostUsd = estimateCostFromTokenUsage(totalTokens, model)  // Layer 5 ── always
   │    exactCostUsd     = totalExactCostUsd                                // undefined if wire never reported
   │
   │  return AgentResult {
   │    tokenUsage:       totalTokens,         // TokenUsage (camelCase)
   │    estimatedCostUsd,                      // always present
   │    exactCostUsd,                          // optional
   │  }
   ▼
AgentManager.runAs() → middleware chain         ← Layer 3
   │
   ▼
Cost Middleware                                 ← Layer 2
   │  reads result.tokenUsage, .estimatedCostUsd, .exactCostUsd
   │  emits CostEvent {
   │    tokens, runId, agentName, model, stage, storyId, packageDir,
   │    estimatedCostUsd,
   │    exactCostUsd?,
   │    costUsd:    exactCostUsd ?? estimatedCostUsd,   // canonical for budget/totals
   │    confidence: exactCostUsd != null ? "exact" : "estimated",
   │    durationMs,
   │  }
   ▼
CostAggregator.record()                         ← Layer 1
   │  retains both estimatedCostUsd and exactCostUsd
   │  on runtime.close() → drain() → StoryMetrics (both numbers preserved)
   ▼
.nax/metrics.json
```

### 3.3 Boundary inventory after refactor

| Boundary | Direction | Type | Where |
|:--|:--|:--|:--|
| External → Adapter | acpx → parser | `SessionTokenUsage` (wire) | `parser.ts`, `spawn-client.ts` |
| Adapter → Mapper | wire → internal | `SessionTokenUsage → TokenUsage` | `AcpTokenUsageMapper.toInternal()` |
| Mapper → Adapter accumulator | internal | `TokenUsage` | `addTokenUsage(a, b)` |
| Adapter → Cost calc | internal | `TokenUsage` | `estimateCostFromTokenUsage(TokenUsage, model)` |
| Adapter → Manager | internal | `AgentResult.tokenUsage : TokenUsage` | `AgentResult` |
| Manager → Middleware | internal | `AgentResult` | middleware chain |
| Middleware → Aggregator | event | `CostEvent` | `CostAggregator.record()` |
| Aggregator → Metrics | aggregate | `RunMetrics.totalTokens / StoryMetrics.tokens` | `runtime.close() → drain()` |

The wire format appears in exactly two layers: external (Layer 8) and the wire-types file + parser (Layer 7). Above Layer 6 (mapper) it never appears.

## 4. Code shape

### 4.1 Cost module — owns the contract

```ts
// src/agents/cost/token-mapper.ts (new)
import type { TokenUsage } from "./types";

/**
 * Generic mapper from an external wire format to internal canonical TokenUsage.
 * Each adapter package provides a concrete implementation parameterised by its
 * own wire type. The cost module never imports any specific Wire.
 */
export interface ITokenUsageMapper<Wire> {
  toInternal(wire: Wire): TokenUsage;
}
```

```ts
// src/agents/cost/calculate.ts (modified)
import type { TokenUsage } from "./types";
import { MODEL_PRICING } from "./pricing";

/** Sum two internal TokenUsage values. Pure. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  };
}

/** Pricing function — takes internal TokenUsage; no wire-format awareness. */
export function estimateCostFromTokenUsage(usage: TokenUsage, model: string): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    const fallbackInputRate = 3 / 1_000_000;
    const fallbackOutputRate = 15 / 1_000_000;
    return (
      usage.inputTokens * fallbackInputRate +
      usage.outputTokens * fallbackOutputRate +
      (usage.cacheReadInputTokens ?? 0) * (0.5 / 1_000_000) +
      (usage.cacheCreationInputTokens ?? 0) * (2 / 1_000_000)
    );
  }
  const inputRate = pricing.input / 1_000_000;
  const outputRate = pricing.output / 1_000_000;
  const cacheReadRate = (pricing.cacheRead ?? pricing.input * 0.1) / 1_000_000;
  const cacheCreationRate = (pricing.cacheCreation ?? pricing.input * 0.33) / 1_000_000;
  return (
    usage.inputTokens * inputRate +
    usage.outputTokens * outputRate +
    (usage.cacheReadInputTokens ?? 0) * cacheReadRate +
    (usage.cacheCreationInputTokens ?? 0) * cacheCreationRate
  );
}
```

### 4.2 ACP adapter — owns its wire types and concrete mapper

```ts
// src/agents/acp/wire-types.ts (new — moved from cost/types.ts)
/**
 * Token usage from an ACP session's cumulative_token_usage field.
 * Snake_case: matches the acpx wire format. Never escapes the acp/ folder
 * except through AcpTokenUsageMapper.toInternal().
 */
export interface SessionTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
```

```ts
// src/agents/acp/token-mapper.ts (new)
import type { ITokenUsageMapper, TokenUsage } from "../cost";
import type { SessionTokenUsage } from "./wire-types";

export class AcpTokenUsageMapper implements ITokenUsageMapper<SessionTokenUsage> {
  toInternal(wire: SessionTokenUsage): TokenUsage {
    return {
      inputTokens: wire.input_tokens ?? 0,
      outputTokens: wire.output_tokens ?? 0,
      cacheReadInputTokens: wire.cache_read_input_tokens,
      cacheCreationInputTokens: wire.cache_creation_input_tokens,
    };
  }
}

export const defaultAcpTokenUsageMapper = new AcpTokenUsageMapper();
```

### 4.3 Adapter usage — wire crosses the boundary exactly once

```ts
// src/agents/acp/adapter.ts (simplified)
import { addTokenUsage, estimateCostFromTokenUsage } from "../cost";
import type { TokenUsage } from "../cost";
import type { SessionTokenUsage } from "./wire-types";
import { defaultAcpTokenUsageMapper } from "./token-mapper";

export class AcpAgentAdapter implements AgentAdapter {
  constructor(
    name: string,
    naxConfig: NaxConfig,
    private readonly mapper: ITokenUsageMapper<SessionTokenUsage> = defaultAcpTokenUsageMapper,
  ) { /* ... */ }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    let totalTokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let totalExactCostUsd: number | undefined;

    // Per response loop:
    if (lastResponse.cumulative_token_usage) {
      totalTokens = addTokenUsage(
        totalTokens,
        this.mapper.toInternal(lastResponse.cumulative_token_usage),  // ← only boundary crossing
      );
    }
    if (lastResponse.exactCostUsd) {
      totalExactCostUsd = (totalExactCostUsd ?? 0) + lastResponse.exactCostUsd;
    }

    // On completion — compute both numbers, never collapse them:
    const estimatedCostUsd = estimateCostFromTokenUsage(
      totalTokens,
      options.modelDef.model,
    );
    const exactCostUsd = totalExactCostUsd; // undefined if wire never reported

    return {
      /* ...result, */
      tokenUsage: totalTokens,
      estimatedCostUsd,   // always present
      exactCostUsd,       // optional
    };
  }
}
```

After this, no wire-format identifier (`input_tokens`, `cache_read_input_tokens`, etc.) appears anywhere in the adapter file outside the `cumulative_token_usage` field shape (which is required to match acpx). The accumulator, cost call, and `AgentResult` mapping all operate on `TokenUsage`. Both cost numbers are independent — neither is computed from the other; both are stored.

### 4.4 Cost middleware — observes both, never computes

```ts
// src/runtime/middleware/cost.ts (revised)
async after(ctx, result, durationMs) {
  if (!result?.tokenUsage && result?.estimatedCostUsd === 0 && result?.exactCostUsd == null) {
    return; // nothing to record
  }
  const estimatedCostUsd = result.estimatedCostUsd ?? 0;
  const exactCostUsd     = result.exactCostUsd;
  const costUsd          = exactCostUsd ?? estimatedCostUsd;
  const confidence: "exact" | "estimated" = exactCostUsd != null ? "exact" : "estimated";

  aggregator.record({
    ts: Date.now(),
    runId, agentName: ctx.agentName, model: result.model ?? "unknown",
    stage: ctx.stage, storyId: ctx.storyId, packageDir: ctx.packageDir,
    tokens: { /* ...mapped from result.tokenUsage */ },
    estimatedCostUsd,
    exactCostUsd,
    costUsd,
    confidence,
    durationMs,
  });
}
```

The middleware never calls `estimateCostFromTokenUsage`. It reads two scalars off `AgentResult` and forwards them. Pure observation.

## 5. Refactor steps (low-risk first)

### Phase A — wire-format decoupling (mapper)

| # | Step | Type | Touches |
|:--|:--|:--|:--|
| A1 | Create `src/agents/acp/wire-types.ts`; move `SessionTokenUsage` from `cost/types.ts` to here | Move | new file + `cost/types.ts` + `cost/index.ts` |
| A2a | Create `src/agents/cost/token-mapper.ts` with `ITokenUsageMapper<Wire>`; export from `cost/index.ts` | Add | new file + `cost/index.ts` |
| A2b | Add `addTokenUsage(a, b)` to `cost/calculate.ts`; export from `cost/index.ts` | Add | `cost/calculate.ts` + `cost/index.ts` |
| A2c | Create `src/agents/acp/token-mapper.ts` with `AcpTokenUsageMapper` + `defaultAcpTokenUsageMapper`; export from `acp/index.ts`. Add unit tests. | Add | new file + `acp/index.ts` + new test |
| A3 | Refactor `estimateCostFromTokenUsage(usage: TokenUsage, model)`. Update all call sites. Update [test/unit/agents/acp/cost.test.ts](../../test/unit/agents/acp/cost.test.ts) (currently uses wire shape). | Breaking | `cost/calculate.ts` + tests |
| A4 | Refactor [src/agents/acp/adapter.ts](../../src/agents/acp/adapter.ts): inject mapper, accumulate via `addTokenUsage`, drop inline duplicate `cumulative_token_usage` interface (replace with `SessionTokenUsage` import), remove inline wire→internal mapping at result-construction site. Update tests if needed. | Breaking | `acp/adapter.ts` + adapter tests |
| A5 | Delete [src/agents/acp/cost.ts](../../src/agents/acp/cost.ts) (vestigial re-export). Update any consumers. | Delete | `acp/cost.ts` + grep-found consumers |

A1, A2a–A2c are pure additions and independently mergeable. A3 + A4 are breaking and ship together (one commit) so tests stay green. A5 ships after.

### Phase B — split exact + estimated cost (preserve both)

| # | Step | Type | Touches |
|:--|:--|:--|:--|
| B1 | Rename `AgentResult.estimatedCost` → `estimatedCostUsd`; add `exactCostUsd?: number`. Update [src/agents/types.ts](../../src/agents/types.ts) and every `AgentResult` consumer (grep). | Breaking rename | `agents/types.ts` + ~20 call sites |
| B2 | Refactor [src/agents/acp/adapter.ts](../../src/agents/acp/adapter.ts) to populate both: `estimatedCostUsd` always, `exactCostUsd` from accumulated `totalExactCostUsd`. Remove the today's `?? estimateCost(...)` collapse. | Breaking | `acp/adapter.ts` |
| B3 | Update `CostEvent` interface ([src/runtime/cost-aggregator.ts](../../src/runtime/cost-aggregator.ts)): add `estimatedCostUsd`, `exactCostUsd?`, `confidence`. Keep `costUsd` as canonical (= `exactCostUsd ?? estimatedCostUsd`). | Breaking | `cost-aggregator.ts` |
| B4 | Update [src/runtime/middleware/cost.ts](../../src/runtime/middleware/cost.ts): read both numbers off `AgentResult`, emit both into `CostEvent`. No calculation. | Breaking | `middleware/cost.ts` + tests |
| B5 | Update fallback-hop accounting ([src/agents/manager.ts](../../src/agents/manager.ts), `AgentFallbackHop.costUsd` source) to read `result.estimatedCostUsd` (the canonical comparable number across hops). | Mechanical | `manager.ts` + `metrics/types.ts` reader |
| B6 | Update `StoryMetrics` / `RunMetrics` if they should carry both numbers (decision: yes, add `tokenCostUsd` mirror of `estimatedCostUsd` and `exactCostUsd?`). Optional in this phase; the aggregator already retains both for query. | Additive | `metrics/types.ts` |
| B7 | Update tests: replace `expect(result.estimatedCost).toBe(...)` with `expect(result.estimatedCostUsd)` / add coverage for `exactCostUsd` populated when wire reports it; one test asserting both are present and independent. | Test | wide |

### Phase C — verification

| # | Step | Type |
|:--|:--|:--|
| C1 | `bun run typecheck` clean. `bun run lint` clean. | Verify |
| C2 | `bun run test` all green. | Verify |
| C3 | Grep audit: `grep -rn 'input_tokens\|output_tokens\|cache_read_input_tokens\|cache_creation_input_tokens' src/` returns only `acp/wire-types.ts`, `acp/parser.ts`, `acp/spawn-client.ts`, and inside `AcpTokenUsageMapper.toInternal()`. | Verify |
| C4 | Grep audit: `grep -rn 'estimatedCost[^U]' src/` returns zero hits (the field is fully renamed to `estimatedCostUsd`). | Verify |
| C5 | Drift smoke test: with mocked acpx that reports both wire tokens AND `usage_update`, assert `AgentResult.exactCostUsd != null && estimatedCostUsd != null && |exactCostUsd - estimatedCostUsd| / estimatedCostUsd < 0.5` (i.e. they're in the same order of magnitude — pricing rates are not catastrophically wrong). | Verify |

**Recommended PR layout:** Phase A as one PR (mapper decoupling, no behaviour change to cost numbers). Phase B as a second PR (cost field split, behaviour change: both numbers stored). Phase C runs against the merged result.

## 6. Risk & mitigation

| Risk | Likelihood | Mitigation |
|:--|:--|:--|
| `estimateCostFromTokenUsage` signature change breaks downstream callers | High (it has callers) | Find all call sites with grep; convert each via the mapper or directly to camelCase; tests catch missed sites |
| Existing tests pass `SessionTokenUsage`-shaped literals to the cost function | Certain | [test/unit/agents/acp/cost.test.ts](../../test/unit/agents/acp/cost.test.ts) is the main hit; rewrite to camelCase. Add new tests for `AcpTokenUsageMapper` |
| `acp/cost.ts` removal breaks an external consumer (e.g. test imports it) | Medium | Grep before deletion; keep a single-line deprecation if needed and remove in a follow-up; current users redirect to `../cost` directly |
| Mapper DI added to `AcpAgentAdapter` constructor breaks existing instantiations | Low — default param | Default to `defaultAcpTokenUsageMapper`; only tests that want a custom mapper opt in |
| Future Codex adapter needs a different `Wire` type but the same mapper interface | None — that's the goal | `class CodexTokenUsageMapper implements ITokenUsageMapper<CodexWire>` lands as a sibling; no changes to `cost/` |
| `estimatedCost` → `estimatedCostUsd` rename misses a call site, silently uses `undefined` | Medium | TS strict null checks catch it at typecheck; phase-B PR forces every consumer through the type system |
| Fallback-hop cost accounting changes meaning (was the `?? estimate` collapsed value, now strictly estimated) | Low | Document in B5: `AgentFallbackHop.costUsd` becomes "estimated cost of the failed attempt"; this is more precise (exact varies per call type and isn't always reported), not less |
| Drift between `exact` and `estimated` is large (signals pricing-table staleness) | Possible | C5 smoke test catches catastrophic drift; periodic alerting can be added later by reading aggregator snapshot |

## 7. What this deliberately does NOT change

- **Producer-side cost ownership.** Cost is computed in the adapter and lands on `AgentResult`. Non-middleware consumers (fallback-hop cost accounting in `AgentManager.runWithFallback`, [src/metrics/types.ts:92](../../src/metrics/types.ts#L92), and tests driving adapters directly) continue to read it without a middleware chain in scope. Only the *field shape* changes (split into `estimatedCostUsd` + `exactCostUsd?`) and the cost function's *input type* changes (wire → internal).
- **`CostEvent.tokens` shape (`{ input, output, cacheRead?, cacheWrite? }`).** Aggregator's own contract, intentionally distinct from `TokenUsage` (the field names are shorter / more event-friendly). Different layer, different contract — fine.
- **`metrics/types.ts` `TokenUsage` class with `toJSON()`.** It's a duplicate shape of `cost/TokenUsage` but exists for `metrics.json` zero-omit serialization. Out of scope for this refactor; tracked separately.
- **External `acpx` library.** Out of our control. Wire format is what it is.

## 8. Acceptance criteria

### Phase A — wire-format decoupling

| AC | Verifies |
|:--|:--|
| AC-A1 | `src/agents/cost/` contains zero references to `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (grep) |
| AC-A2 | `src/agents/cost/token-mapper.ts` exists; exports `ITokenUsageMapper<Wire>` |
| AC-A3 | `src/agents/cost/calculate.ts` exports `addTokenUsage(a, b): TokenUsage` and `estimateCostFromTokenUsage(usage: TokenUsage, model): number` |
| AC-A4 | `src/agents/acp/wire-types.ts` exists; declares `SessionTokenUsage` |
| AC-A5 | `src/agents/acp/token-mapper.ts` exports `AcpTokenUsageMapper implements ITokenUsageMapper<SessionTokenUsage>` and `defaultAcpTokenUsageMapper` |
| AC-A6 | `src/agents/acp/cost.ts` deleted |
| AC-A7 | `src/agents/acp/adapter.ts` references no inline duplicate of `cumulative_token_usage` shape (uses `SessionTokenUsage` from `./wire-types`) |
| AC-A8 | `src/agents/acp/adapter.ts` accumulates `TokenUsage` (not `SessionTokenUsage`) and calls `estimateCostFromTokenUsage(TokenUsage, model)` exactly via internal type |
| AC-A9 | Unit tests for `AcpTokenUsageMapper` cover: full snake_case → camelCase mapping, undefined cache fields → undefined, zero values preserved |
| AC-A10 | Snake_case identifiers `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` appear in `src/` only in: `acp/wire-types.ts`, `acp/parser.ts`, `acp/spawn-client.ts`, and inside `AcpTokenUsageMapper.toInternal()` |

### Phase B — split exact + estimated cost

| AC | Verifies |
|:--|:--|
| AC-B1 | `AgentResult.estimatedCost` no longer exists; replaced by `estimatedCostUsd: number` (always present) and `exactCostUsd?: number` (optional). Grep for the old name returns zero hits. |
| AC-B2 | `AcpAgentAdapter.run()` populates **both** numbers when wire reports `usage_update.cost.amount`: `estimatedCostUsd` from `estimateCostFromTokenUsage(tokens, model)` and `exactCostUsd` from accumulated wire-reported exact cost. Neither is computed from the other. |
| AC-B3 | When wire does NOT report exact cost, `AgentResult.exactCostUsd === undefined` and `estimatedCostUsd > 0`. The adapter never collapses the absence into a fallback estimate at the field level. |
| AC-B4 | `CostEvent` interface includes: `estimatedCostUsd: number`, `exactCostUsd?: number`, `costUsd: number` (= `exactCostUsd ?? estimatedCostUsd`), `confidence: "exact" \| "estimated"` (= `exactCostUsd != null ? "exact" : "estimated"`). |
| AC-B5 | `costMiddleware.after()` performs no cost calculation — it reads the two scalars from `AgentResult` and forwards them into `CostEvent`. Inspecting the source: no call to `estimateCostFromTokenUsage`. |
| AC-B6 | `AgentFallbackHop.costUsd` is sourced from `AgentResult.estimatedCostUsd` (documented as "estimated cost of the failed attempt"). |
| AC-B7 | Integration test: with mock adapter populating both fields, `CostAggregator.snapshot()` retains both `totalEstimatedCostUsd` and `totalExactCostUsd` as separate, queryable totals. |
| AC-B8 | Drift smoke test (Phase C, AC-C5): same-run estimated and exact differ by less than 50% (catches order-of-magnitude pricing errors). |

### Phase C — verification

| AC | Verifies |
|:--|:--|
| AC-C1 | `bun run typecheck` passes; full `bun run test` suite green. |
| AC-C2 | Grep audit confirms wire-format identifiers are quarantined (AC-A10 above). |
| AC-C3 | Grep audit: zero hits for `\.estimatedCost[^U]` in `src/` (rename complete). |
| AC-C4 | Drift smoke test passes (AC-B8 above). |

## 9. Future extensions enabled

- **Codex adapter** — adds `CodexTokenUsageMapper implements ITokenUsageMapper<CodexWire>`. Cost module untouched.
- **Pricing strategy injection** — `estimateCostFromTokenUsage` could accept a pricing-strategy parameter (e.g. negotiated rates, dry-run discounts) without any awareness of wire formats.
- **Drift alerting** — periodic check on aggregator snapshot: if `Σ exactCostUsd / Σ estimatedCostUsd` strays past a threshold, surface a warning. Trivially implementable once both numbers land.
- **Confidence-aware budget gates** — budget enforcement could be stricter on `exact` (hard cap) and softer on `estimated` (warning). Requires both numbers separately, which this refactor guarantees.
- **Test-only mappers** — DI lets unit tests inject deterministic mappers (e.g. echo-back for property tests).
