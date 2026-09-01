# Native LLM Adapter (Phase A) — Design

**Date:** 2026-09-01
**Status:** Approved (ADR-027 merged, `1d700b4d3`)
**Decision record:** [`docs/adr/ADR-027-adapter-protocol-split.md`](../../adr/ADR-027-adapter-protocol-split.md) — the *why*, the alternatives, and the rulings. This spec is the *what*: concrete shapes an implementer builds against.
**Why at all:** [Nax Native LLM Harness](https://claude.ai/code/artifact/3f52e26b-9614-411f-ba38-31dd6393f804)

---

## 1. Goal

Route nax's one-shot completion ops through `@nathapp/nax-ai` instead of an acpx
subprocess, behind an explicit opt-in, without changing any existing config's
behaviour.

**In scope (Phase A):** a `native` agent that implements `AgentAdapter.complete()`
over nax-ai; the `agent.protocol` capability gate; the registry discrimination;
credential resolution; the two ADR-025/012 amendments the above requires.

**Out of scope:** sessions and multi-turn (ADR-027 §10 — Phase B is a *storage*
feature, not a mapping over `complete()`); tools; permission enforcement
(#374, Phase C); changing any op's default agent.

## 2. Global constraints

Copied verbatim; every task inherits these.

- Runtime **Bun 1.4.0**, Bun-native APIs only. Tests are `bun:test`.
- `SRC_LIMIT = 600` lines, `TEST_LIMIT = 800` (`scripts/check-file-sizes.ts`).
  The gate refuses growth in already-oversized files.
- **`src/agents/acp/adapter.ts` is at 593/600 — do not touch it.**
- `@nathapp/nax-ai` is importable **only** from `src/agents/native/`, enforced by
  a new gate mirroring `scripts/check-adapter-no-config-import.sh`.
- Every new check script must be reachable from CI (`check:gate-reachability`).
- Permission decisions go through `resolvePermissions(config, stage)` — never
  hardcoded (`check:permission-mode-ssot`).
- Errors use `NaxError` with a code and `{ cause }`.
- Docs land in **`.nax/context.md`**, never `CLAUDE.md` (generated;
  `check:rules-drift` fails if `.claude/rules/` is stale).
- Dependency pin: `@nathapp/nax-ai` at an **exact** version, no range.

## 3. Config surface

### 3.1 `agent.protocol` — a capability gate, not a router

```ts
protocol: z.enum(["acp", "native", "hybrid"]).default("acp")
```

| value | permitted |
|---|---|
| `acp` (default) | acpx agents only. A `models.native` entry is a **config error**. |
| `hybrid` | both. |
| `native` | native only. An acpx agent entry in `models` is a **config error**, and `agent.default` **must** be `"native"`. |

Validation lands in `NaxConfigSchema.superRefine`, beside the existing
`tierOrder` cross-check. Each error names the remedy.

Rationale (ADR-027 §2): the agent name already routes, so a second router would
be redundant; native calls hit a **different billing path**, so reaching it must
be an explicit opt-in rather than the consequence of a typo in `models`.

### 3.2 `models.native`

```json
"models": {
  "claude": { "fast": "haiku" },
  "native": {
    "cheap":  "opencode-go/deepseek-v4-flash",
    "strong": "anthropic/claude-sonnet-5"
  }
}
```

Under `native`, a model entry's string is `"<provider>/<model>"`, split on the
**first** `/`. `huggingface/MiniMaxAI/MiniMax-M2.7` → provider `huggingface`,
model `MiniMaxAI/MiniMax-M2.7`.

**A string with no `/` is a config error.** There is no default provider.

Tier keys are already arbitrary strings — `PerAgentModelMapSchema` is
`z.record(z.string().min(1), z.record(z.string().min(1), ModelEntrySchema))`.
Five tiers or fifty need **no schema change** (ADR-027 §5). `tierOrder` rungs are
already agent-qualified, so a `native cheap → native strong → claude balanced`
ladder works today.

**The model string is the only source of the provider — `ModelDef.provider` is
ignored under `native`.** `resolveModel` (`src/config/schema-types.ts:149`)
*infers* a provider for string entries by prefix-matching the model name
(`claude…` → anthropic, `gpt…` → openai, else `"unknown"`), so
`"openai/gpt-5.4-mini"` arrives as `{provider: "unknown", model: "openai/gpt-5.4-mini"}`.
That field is a guess, not configuration, and routing a billed call on a guess
is exactly the failure the gate in §3.1 exists to prevent.

The object form still works and is how `pricing` is overridden (§6.3) — its
`model` must also carry the `provider/model` string:

```json
"native": {
  "strong": { "provider": "ignored", "model": "anthropic/claude-sonnet-5",
              "pricing": { "inputPer1M": 3, "outputPer1M": 15 } }
}
```

## 4. Module layout

All under `src/agents/native/`. Nothing else in `src/` may import
`@nathapp/nax-ai`.

| File | Responsibility | Exports |
|---|---|---|
| `models.ts` | model reference parsing, usage mapping, cost | `NATIVE_AGENT`, `parseNativeModel`, `toNaxTokenUsage`, `estimateCostUsd` |
| `errors.ts` | nax-ai error kinds → nax failure taxonomy | `toAdapterFailure`, `NativeSessionUnsupportedError` |
| `client.ts` | construct and hold the nax-ai `Client` | `getNativeClient`, `_clientDeps`, `_resetNativeClient` |
| `credentials.ts` | the `~/.nax/credentials` store (plan 2) | `createNativeCredentialStore` |
| `adapter.ts` | `AgentAdapter` implementation | `NativeAgentAdapter` |
| `index.ts` | the only surface `registry.ts` imports | re-exports `NATIVE_AGENT`, `NativeAgentAdapter` |

`registry.ts` changes to:

```ts
function adapterFor(name: string): AgentAdapter {
  return name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
}
```

**Known wrinkle (ADR-027 §3):** `createAgentRegistry(config)` sees config, but
`buildAdapterList` / `getAllAgents` / `getInstalledAgents` are config-less by
design and cannot consult the gate. `native` therefore appears in those listings
whatever `protocol` says, and its `isInstalled()` answers about credentials, not
permission. The gate bites at config validation and `createAgentRegistry`.
`registry.ts:100`'s hard-coded `"Agent protocol: acp"` log becomes the resolved
value.

## 5. Type contracts

```ts
// models.ts
export const NATIVE_AGENT = "native";

export interface NativeModelRef {
  readonly provider: string;
  readonly model: string;
}

/** Throws NaxError("NATIVE_MODEL_MALFORMED") when raw has no "/". */
export function parseNativeModel(raw: string): NativeModelRef;

/** nax-ai TokenUsage -> nax TokenUsage. The field names differ; see §6.1. */
export function toNaxTokenUsage(usage: NaxAiTokenUsage): TokenUsage;

/** Cost in USD from rates per 1M tokens. Throws when no rate is available. */
export function estimateCostUsd(usage: TokenUsage, rates: TokenPricing): number;

// errors.ts
export function toAdapterFailure(err: ProtocolStreamError): AdapterFailure;
export class NativeSessionUnsupportedError extends NaxError {}

// client.ts
/** Memoised. Async because piProviders() loads the bundled catalog. A REJECTED
 *  build is not memoised — a transient failure must not poison the process. */
export function getNativeClient(): Promise<Client>;
export const _clientDeps: { build: () => Promise<Client> };
export function _resetNativeClient(): void;

// adapter.ts
export class NativeAgentAdapter implements AgentAdapter {
  readonly name = NATIVE_AGENT;
  readonly displayName = "Native (nax-ai)";
  readonly binary = "";
  readonly capabilities: AgentCapabilities;
  isInstalled(): Promise<boolean>;
  hasCredentials(): Promise<boolean>;
  buildCommand(): string[];
  complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult>;
  openSession(): Promise<never>;
  sendTurn(): Promise<never>;
  closeSession(): Promise<never>;
}
```

## 6. Mappings

### 6.1 Token usage — the field names differ

| nax-ai `TokenUsage` | nax `TokenUsage` |
|---|---|
| `inputTokens` | `inputTokens` |
| `outputTokens` | `outputTokens` |
| `cacheReadTokens` | `cacheReadInputTokens` |
| `cacheWriteTokens` | `cacheCreationInputTokens` |

Absent optional fields stay absent — not zero — so "no cache data" and "zero
cache tokens" remain distinguishable.

### 6.2 Errors — typed, never parsed

nax-ai throws `ProtocolStreamError` carrying `protocolError: { kind, message,
status?, retryAfter?, cause? }`. `complete()` **catches** it and returns an
`adapterFailure` rather than rethrowing, because rethrowing would route through
`classifyCompleteException` → `parseAgentError`, which parses *ACP* strings.

| `ProtocolError.kind` | `AdapterFailure` |
|---|---|
| `rate-limit` | `{ category: "availability", outcome: "fail-rate-limit", retriable: true }` |
| `auth` | `{ category: "availability", outcome: "fail-auth", retriable: false }` |
| `overloaded` | `{ category: "availability", outcome: "fail-service-down", retriable: true }` |
| `transport` | `{ category: "availability", outcome: "fail-service-down", retriable: true }` |
| `bad-request` | `{ category: "quality", outcome: "fail-adapter-error", retriable: false }` |
| `unknown` | `{ category: "quality", outcome: "fail-unknown", retriable: false }` |

Four of six are `availability`, which is what keeps `shouldSwap`'s fallback
branch reachable. A blanket `quality / fail-unknown` once made every transient
failure terminal for exactly these ops — that regression must not return.

A caller-initiated abort is **not** a native failure: it propagates as
`fail-aborted` through the existing path, unchanged.

### 6.3 Cost

`estimatedCostUsd = estimateCostUsd(usage, rates)` where

```
rates = modelDef.pricing ?? client.pricing(resolvedModel)
```

Both sides express **rates per 1M tokens**, so no unit conversion is needed —
nax-ai's `PricingRates` is documented "Rates per 1M tokens", matching nax's
`inputPer1M`.

**A model with no rate throws** (`NaxError("NATIVE_PRICING_MISSING")`) at model
resolution rather than reporting `$0`. A zero cost that is really "unknown"
corrupts every aggregate that sums it.

`exactCostUsd` is **not** set: nax-ai supplies rates and deliberately computes no
cost, so nothing here is exact.

Tiered pricing (`Pricing.tiers`, 22 upstream models) is **not** honoured in
Phase A; base rates are used and a long-context request under-reports. Recorded
as a known limitation rather than silently ignored.

## 7. Adapter semantics

- **`isInstalled()`** — true when credentials resolve for at least one provider.
  "Installed" has no other meaning with no binary. Phase A: ambient env only.
- **`hasCredentials()`** — same probe; declared because `AgentManager.validateCredentials()`
  reads it at run start.
- **`buildCommand()`** — `[]`. Dry-run display shows no process because there is none.
- **`binary`** — `""`.
- **`capabilities`** — `supportedTiers` is the three builtin names, **not** the
  configured ones. `agentManagerConfigSelector` (`selectors.ts:78`) excludes
  `models` by design: ADR-019 puts model resolution at the `callOp` seam, so
  widening the slice to populate a capability field would breach that boundary.
  **It must never be empty**: `validateAgentForTier` clamps an unsupported tier
  to `supportedTiers[0]`, so `[]` would log a tier mismatch on every story. The
  gap is bounded — `validateAgentForTier` lives in the execution stage, which
  serves `kind: "run"` ops, and Phase A's seven take `callOp`'s complete branch.
  Phase B decides whether capabilities become model-derived (ADR-027 Open
  Question 3).
  `maxContextTokens` is a conservative constant in Phase A (ADR-027 Open
  Question 3). `features` is `["review"]` — narrower than acpx's
  `["tdd","review","refactor"]`, because Phase A runs no sessions. Nothing in
  `src/` reads it today (`validateAgentFeature` is exported but unwired), so it
  is a declaration rather than a gate.
- **`timeoutMs`** — becomes an `AbortSignal` passed as `req.signal`, which the
  option's own doc comment already promises adapters do.
- **`onPidSpawned` / `onPidExited`** — never called. There is no process.
- **Session methods** — throw `NativeSessionUnsupportedError`, naming Phase B.

## 8. Test strategy

- **Unit, no network.** `client.ts` exposes `_clientDeps` so tests inject a fake
  `Client`; this is nax's established `_deps` pattern.
- **Every `ProtocolError.kind` gets a case.** Six kinds, six assertions — the
  table in §6.2 is the contract, and a missing row is how the availability
  regression returns.
- **Config validation is tested per gate value**: `acp` + `models.native` fails,
  `native` + `agent.default: "claude"` fails, `hybrid` + both passes.
- **The wire-isolation gate is tested by violating it** — a fixture importing
  `@nathapp/nax-ai` from outside `src/agents/native/` must make the script exit
  non-zero. A gate never proven to fail is not a gate.
- **The existing 86 test files under `test/**/agents/**` stay green.** Nothing in
  Phase A changes acpx behaviour.

## 9. Amendments this requires

Both are in ADR-027; both are separable plans (§10).

- **Fallback targets may name a tier** (ADR-012/013's `AgentFallbackConfigSchema`).
  `map` values additionally accept `{ agent, tier }`, the shape `tierOrder` rungs
  already use, so one native provider can fall back to another. Plain strings
  keep working unchanged.
- **`resolveConfiguredModel` must stop dropping `modelTier`** for non-builtin
  tiers in the **object** form. The string form already carries it; only the
  profile path (`target: { agent, model }`) is broken.

## 10. Delivery: four plans, not one

Phase A is split so each plan produces working, testable software on its own.

| Plan | Delivers | Depends on |
|---|---|---|
| **1 — native completion path** | `protocol` gate, registry discrimination, `src/agents/native/`, wire gate. A working native `complete()` with ambient-env credentials. | — |
| **2 — credentials and `nax auth`** | `~/.nax/credentials` store, `nax auth login/import/list/rm`. | 1 |
| **3 — routing amendments** | §9's two changes. | — (independent) |
| **4 — op cutover** | `classify-route` migrated and A/B'd, then the remaining six. | 1, 3 |

Plan 1 is `docs/superpowers/plans/2026-09-01-native-completion-path.md`.
Plans 2–4 are written when their predecessor lands, so each is written against
code that exists rather than code that is planned.
