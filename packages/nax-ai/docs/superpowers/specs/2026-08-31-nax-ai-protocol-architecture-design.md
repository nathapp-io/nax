# nax-ai protocol architecture

**Date:** 2026-08-31
**Status:** Approved design, all questions resolved — not yet implemented
**Scope:** The internal structure of `@nathapp/nax-ai` — the `Protocol` interface, backend selection, and provider declarations.

## 1. Context

`nax-ai` is a provider-agnostic LLM client. Its first consumer is `nax`, which reaches it through a `NativeAgentAdapter` on nax's side of the boundary.

The package exists so that the boundary between nax and its provider layer is enforced by module resolution rather than by review. pi-ai is a transitive dependency: a stray `import … from "@earendil-works/pi-ai"` inside nax fails to resolve rather than passing code review.

The strategy is to wrap pi-ai now and replace pieces of it with hand-written code later, if ever. This document specifies the seam that makes "later" cheap.

### Established constraints

These are settled and this design assumes them:

- **Node ≥ 22.19, ESM-only.** Bun is the dev toolchain; Node is the compatibility target. No `Bun.*` APIs in `src/` — enforced by `scripts/check-no-bun-apis.ts`.
- **Vitest, not `bun test`.** Tests importing `bun:test` cannot run on Node, which would reduce the Node CI leg to an import check.
- **TypeScript 7.0.2, pinned exactly.** It emits the public `.d.ts`.
- **No bundling.** Bundling pi-ai would inline its tree and defeat its lazy `import()` of provider SDKs.
- **Codex OAuth is in scope. Anthropic subscription OAuth is prohibited** — server-blocked and a Consumer ToS violation. Anthropic *API-key* billing is in scope and unaffected.

### Non-goals

- **Tool execution.** nax-ai emits tool calls and accepts tool results. Executing a tool requires permission policy, which belongs to the consumer.
- **Cost computation.** nax-ai supplies pricing rates; the consumer computes cost. See §7.
- **Agent loop, session semantics, rate-limit policy.** The consumer owns orchestration. nax-ai retries transport faults only — see §10.1.
  - Amended 2026-09-03: an opaque `sessionId` on a request is in scope, because providers route and cache by it and the spelling is selected per model (see `src/protocols/session-id.ts`). What a session *consists of* remains the consumer's; only the id crosses the boundary.
- **Hand-rolling auth or the model catalog.** Explicitly out of scope permanently — see §8.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Unit of replacement | **Protocol** | Both pi-ai (`dist/api/*` + `dist/providers/*`) and opencode (`src/protocols/*` + `src/providers/*`) converged on this split. Wire format is the hard part; a provider is a thin declaration. |
| v1 surface | **complete + stream + tools** | pi-ai implements all three, so including them now is cheap. Unblocks nax Phase B's native tool calling, replacing the `<nax_tool_call>` regex protocol. |
| Cost boundary | **nax-ai supplies rates; consumer computes** | Rates are upstream-maintained provider facts. Attribution (confidence levels, per-story rollup) is consumer policy. |
| Backend selection | **Runtime registry, per-protocol** | Both backends must be able to exist at once so a native implementation can be compared against the pi-backed one on real traffic before becoming the default. |

### Why runtime selection rather than a build-time swap

A build-time module swap (`index.ts` re-exports one backend) is simpler and has no indirection. It was rejected because it makes A/B comparison impossible: there is no way to run pi-backed and hand-rolled implementations over the same prompts and compare output, token counts and cost. Behaviour drift is the main risk of hand-rolling a protocol, and the mitigation requires both implementations to coexist.

A per-model backend tag (opencode's `Provider.Native | Provider.AISDK` shape) was rejected as more granularity than the protocol-level unit needs, and because it pushes backend choice into provider data that then has to be maintained per model.

## 3. The `Protocol` interface

Three principles:

1. **Stream is the primitive; `complete` is derived.** Enforced by *omission* — `complete` is absent from this interface, so a backend has no way to implement it as a second, independently drifting request path.
2. **Provider semantics, never pi-ai's.** Every concept appears in more than one wire format or is a deliberate normalisation.
3. **Emit tool calls; never execute them.**

`Protocol` exposes **only** `stream`. `complete` is derived once, at the client layer (§6), by collecting a stream — not implemented per protocol. A backend author therefore cannot let the two paths diverge, because there is only one path.

```ts
interface Protocol {
  readonly name: string;                    // "anthropic-messages"
  stream(req: ProtocolRequest): AsyncIterable<ProtocolEvent>;
}

interface ProtocolRequest {
  readonly model: string;
  readonly system?: string;                 // separate from messages, deliberately
  readonly messages: readonly ConversationMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: "auto" | "none";
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly thinking?: ThinkingLevel;
  readonly cacheRetention?: CacheRetention;
  readonly signal?: AbortSignal;
}

type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCall[] }
  | { role: "tool-result"; toolCallId: string; content: string; isError?: boolean };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;                  // parsed, never a raw string
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type CacheRetention = "none" | "short" | "long";

/** JSON Schema draft 2020-12 object. Structural, not validated by nax-ai. */
type JsonSchema = Readonly<Record<string, unknown>>;

interface ProtocolError {
  readonly kind: "rate-limit" | "auth" | "overloaded" | "bad-request" | "transport" | "unknown";
  readonly message: string;
  readonly status?: number;
  /** Seconds, when the provider signals one. The consumer owns the retry loop. */
  readonly retryAfter?: number;
  readonly cause?: unknown;
}

type ProtocolEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-partial"; id: string; name: string; rawInput: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: ProtocolError }
  | { type: "done"; stopReason: StopReason };
```

### Neutrality check

No row uses one provider's field name:

| Concept | Anthropic Messages | OpenAI Chat/Responses |
|---|---|---|
| `system` | top-level `system` parameter | `system` message in the array |
| `tool-result` role | `user` message with `tool_result` block | `tool` role message |
| `inputSchema` | `input_schema` | `function.parameters` |
| tool args on the wire | `partial_json` deltas | `function.arguments` string deltas |
| `thinking` | thinking budget tokens | `reasoning_effort` |
| `cacheRetention` | explicit `cache_control` | automatic |

`cacheRetention` on OpenAI is accepted and ignored — a no-op rather than an error, because the caller's intent remains valid.

### Deliberate choices

- **`tool-call` carries parsed input and is emitted only once parseable.** Both wire formats stream tool arguments as incremental strings, so accumulation happens inside the protocol. `tool-call-partial` exposes the raw accumulated text for progress display; partial JSON is useless to a caller but useful to a UI.
- **Errors are events, not exceptions.** A mid-stream failure would otherwise discard text and usage already received, and usage is still billed. Setup failures (unknown model, missing credential, prohibited OAuth flow) still throw, because there is no partial result to preserve.
- **`toolChoice` is `auto | none` only.** Forcing a specific tool is inconsistently supported across providers and would need per-protocol fallbacks. pi-ai stopped at the same two values.
- **`ThinkingLevel` carries seven values, matching pi-ai's scale.** Resolved in §10.2 against nax's current pass-through behaviour: a narrower enum would remove expressiveness nax has today. Unsupported levels clamp to the nearest the model supports.

## 4. Registry and backend selection

```ts
type BackendId = "pi" | "native";

/** Lazy factories keyed by backend id. A protocol may offer only "pi". */
type ProtocolBackends = Readonly<Record<BackendId, () => Promise<Protocol>>>;

interface BackendSelection {
  readonly default?: BackendId;                              // "pi" if omitted
  readonly byProtocol?: Readonly<Record<string, BackendId>>;
}

interface ProtocolRegistry {
  available(): ReadonlyMap<string, readonly BackendId[]>;
  resolve(protocolName: string): Promise<Protocol>;
  /** Throws if any configured selection names a backend that is not registered. */
  validate(): void;
}
```

**Backends are lazy factories.** pi-ai's import cost is 33 ms warm precisely because its SDKs load on demand; eagerly importing every backend would discard that.

**Selection is an explicit parameter. nax-ai never reads the environment to decide behaviour.** Reading `process.env` would make nax-ai hold policy, and would make tests order-dependent. The consumer reads its own configuration and passes the result down.

**Requesting an unregistered backend throws; it never falls back.** Silent fallback to pi would make an A/B comparison lie — the operator would believe the native path had been exercised and ship on evidence never gathered.

**A/B is the consumer's, not a built-in mode.** A shadow mode inside nax-ai would double spend implicitly and put comparison policy in the wrong layer.

```ts
const piClient     = createClient({ backends: { default: "pi" } });
const nativeClient = createClient({ backends: { byProtocol: { "openai-completions": "native" } } });
```

**Consequence:** because `resolve()` is async and lazy, a typo'd `byProtocol` key would otherwise surface on first call rather than at construction. `validate()` exists so the consumer can check at startup; nax calls it once during config load.

### Migration path for one protocol

1. Write `backend-native.ts` implementing `Protocol`.
2. Register it alongside `backend-pi.ts`.
3. Run both over real prompts; compare text, tool calls, token counts, cost.
4. Flip the default for that protocol.
5. Delete `backend-pi.ts` and its registry entry once confidence holds.

Every provider on that protocol moves together. No step is a big-bang, and step 4 is reversible by configuration.

## 5. Provider declarations and catalog pass-through

Providers are **passed through from pi-ai's catalog, normalised into nax-ai types** — not redeclared. Redeclaring would recreate the maintenance burden the dependency was chosen to avoid. Normalising is what lets a future native backend obtain `baseUrl`, auth and headers without importing pi-ai.

```ts
interface ResolvedProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultProtocol: string;
}

interface ResolvedModel {
  readonly id: string;
  readonly provider: string;
  readonly protocol: string;              // may differ from the provider default
  readonly pricing: Pricing;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];  // empty = no thinking support
}

interface Pricing {                        // rates only; consumer computes cost
  readonly input: number;                  // per 1M tokens
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

type ProviderAuth =
  | { kind: "api-key"; env: string }
  | { kind: "oauth"; flow: string };
```

**Protocol is per-model with a provider-level default.** `opencode-go` alone serves models over three different protocols, so a provider-level protocol field would model it incorrectly. pi-ai's schema agrees: `model.api` is per-model.

### Verified provider inventory

Read from pi-ai 0.84.4's bundled catalog (`dist/providers/data/*.json`) on 2026-08-31:

| Provider | Models | Protocol | Auth |
|---|---|---|---|
| `openai` | 38 | `openai-responses` | `OPENAI_API_KEY` |
| `openai-codex` | 7 | `openai-codex-responses` | oauth `openai-codex` |
| `anthropic` | 13 | `anthropic-messages` | `ANTHROPIC_API_KEY` |
| `openrouter` | 333 | `openai-completions` | `OPENROUTER_API_KEY` |
| `deepseek` | 3 | `openai-completions` | `DEEPSEEK_API_KEY` |
| `minimax` | 3 | `anthropic-messages` | `MINIMAX_API_KEY` |
| `opencode-go` | 25 | per-model, all three of the above | `OPENCODE_API_KEY` |
| `google` | 22 | `google-generative-ai` | `GEMINI_API_KEY` |
| `groq` | 6 | `openai-completions` | `GROQ_API_KEY` |

`openai-codex-responses` is a distinct protocol from `openai-responses`: enabling Codex OAuth pulls in a wire format nothing else uses.

### Hand-roll leverage, if it is ever done

Line counts are from opencode's hand-written equivalents, as an order-of-magnitude guide:

| Protocol | Approx. cost | Unlocks |
|---|---|---|
| `openai-completions` | ~506 lines | openrouter, deepseek, groq — best value |
| `anthropic-messages` | ~855 lines | anthropic, minimax |
| `openai-responses` | ~1,022 lines | openai only — least leverage |

### Wiring the OAuth gate

`src/auth/oauth-policy.ts` currently ships **tested but not wired**: six passing tests prove the allowlist rejects `anthropic`, and no production code path calls it. A gate nothing calls is a decoration.

Provider resolution must call `assertOAuthFlowPermitted(flow)` when `auth.kind === "oauth"`, at registration time, so a provider carrying the Anthropic flow fails to resolve. A test must assert that behaviour through the real path — a synthetic provider declaring `{ kind: "oauth", flow: "anthropic" }` throws on registration — rather than only through a direct call to the policy function.

### Overrides

Two override needs exist, and they belong in different layers:

| Need | Layer | Form |
|---|---|---|
| baseUrl, headers, missing models | provider config | declaration data |
| rewriting the event stream | **protocol** | a decorating backend |

A stream-rewriting fix is a `Protocol` that wraps another and transforms its events. The registry supports this with no new concept, since a backend is a factory returning a `Protocol`. Provider overrides therefore stay narrow — declaration data only:

```ts
interface ProviderOverride {
  readonly provider: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Models absent from the upstream catalog, or replacing an entry by id. */
  readonly models?: readonly ResolvedModel[];
}
```

Anything about *behaviour* is a wrapping backend, not an override. Keeping that line sharp is what stops `ProviderOverride` growing into a second, weaker extension mechanism competing with the registry.

## 6. Client surface

The client is the only thing a consumer constructs. It ties the registry (§4) to the catalog (§5) and derives `complete` from `stream`.

```ts
interface ClientOptions {
  readonly backends?: BackendSelection;
  readonly credentials?: CredentialStore;      // injected; see src/types.ts
  readonly providerOverrides?: readonly ProviderOverride[];
  /** Transport-fault retries before the first event. Default 2; 0 disables. See §10.1. */
  readonly transportRetries?: number;
}

interface Client {
  /** Resolve a model reference through the catalog. Throws if unknown. */
  model(provider: string, model: string): Promise<ResolvedModel>;
  listModels(provider?: string): Promise<readonly ResolvedModel[]>;
  pricing(model: ResolvedModel): Pricing;

  stream(model: ResolvedModel, req: Omit<ProtocolRequest, "model">): AsyncIterable<ProtocolEvent>;
  complete(model: ResolvedModel, req: Omit<ProtocolRequest, "model">): Promise<CompleteResult>;

  /** Throws if any configured backend selection names an unregistered backend. */
  validate(): void;
}

function createClient(options?: ClientOptions): Client;
```

`complete` is implemented once, here, as `stream` collected:

- text deltas concatenated into `text`
- `tool-call` events collected into `toolCalls`
- the final `usage` event captured
- an `error` event rejects the promise, since a caller awaiting a single result has nowhere to put a partial one — this is the one place where the event-vs-exception rule inverts, and it inverts because the caller's shape demands it

Selecting the protocol is the client's job: it reads `ResolvedModel.protocol` and asks the registry to resolve it. A consumer never names a protocol, which is what keeps protocol-level migration invisible to nax.

`CompleteResult` is already defined in `src/types.ts` and gains a `toolCalls?: readonly ToolCall[]` field for the tools surface.

## 7. Cost boundary

nax-ai exposes `Pricing` rates from the bundled catalog and `TokenUsage` per call. It does not compute cost.

The consumer keeps attribution logic — confidence levels, per-story rollup, tier handling. On nax's side this means `src/agents/cost/calculate.ts` is retained and `src/agents/cost/pricing.ts` (93 hand-maintained lines, header reading "as of 2025-01", with a documented gap around Gemini's context-window tiering) is deleted in favour of the upstream table.

`toTokenUsage` already implements the mapping and drops two upstream fields deliberately: `reasoning` (documented upstream as a subset of `output`, so surfacing it invites double-counting) and `cacheWrite1h` (provider-specific; folded into `cacheWriteTokens`).

## 8. Folder structure

```
src/
  protocols/              SWAPPABLE — the migration surface
    types.ts              Protocol, ProtocolRequest, ProtocolEvent
    registry.ts           name -> backends, selection, validate()
    anthropic-messages/
      backend-pi.ts
      index.ts            registers available backends
    openai-completions/
    openai-responses/
    openai-codex-responses/
  providers/              thin declarations + catalog normalisation
    types.ts              ResolvedProvider, ResolvedModel, ProviderAuth
    catalog.ts            pass-through from pi-ai, normalised
    overrides.ts          baseUrl / headers / extra models
  auth/                   STAYS pi-ai-backed
    oauth-policy.ts       allowlist + gate (already implemented)
  usage.ts                mapping only (already implemented)
  types.ts                public vocabulary (already implemented)
  index.ts                public surface
```

`auth/` and `catalog.ts` each carry a header docblock recording that hand-rolling them is out of scope, with the reason: auth is roughly 864 lines per provider and security-sensitive, and the pricing table is the maintenance burden the dependency was chosen to avoid. Without that note, a reader seeing `backend-pi.ts` under `protocols/` reasonably concludes the pattern applies everywhere.

## 9. Testing strategy

| Area | Approach |
|---|---|
| `Protocol` conformance | One shared suite run against every registered backend, so `backend-native.ts` inherits the contract tests the day it is written. |
| Wire mapping | Recorded provider responses as fixtures; assert the event sequence. No live network in unit tests. |
| OAuth gate | Through the real registration path, not only via a direct policy call. |
| Registry | Unregistered backend throws rather than falling back; `validate()` catches a typo'd selection. |
| Usage mapping | Table-driven over each provider's reported shape, including absent cache fields. |
| Node compatibility | Full suite on Node 22 and 24; built artifact imported under Bun; tarball installed into a clean project and imported. |

The conformance suite is the load-bearing piece: it is what makes replacing a backend a bounded task rather than an open-ended one.

## 10. Resolved questions

### 10.1 Retry: split by fault class

**nax-ai retries transport faults. The consumer owns rate-limit and capacity policy.**

The split is principled rather than arbitrary: transport faults carry no policy content, and rate limits do.

| Fault | Owner | Behaviour |
|---|---|---|
| Connection reset, DNS failure, malformed SSE frame, 500 / 502 / 504 | **nax-ai** | Bounded retry with exponential backoff |
| 429 rate-limit, 503 / 529 overloaded | **consumer** | Surfaced as `ProtocolError` with `retryAfter`; never retried internally |
| 4xx bad request, auth failure | neither | Terminal — retrying cannot help |

`classifyHttpError` (`src/protocols/errors.ts`) classifies 503 as `"overloaded"`, alongside 529, not `"transport"` — both are capacity signals a provider emits under load, and capacity policy belongs to the consumer per the split above. An earlier draft of this table grouped 503 with the transport-retried statuses; the implementation and its test (`test/protocols/errors.test.ts`) settled it the other way, and this row now matches the code.

A rate limit interacts with the consumer's concurrency, its cost budget, and whether to fail over to a different model. nax runs stories in parallel, so retrying every one of them the instant a 429 arrives is worse than staggering — and that decision needs information nax-ai does not have. Upstream agrees: pi-ai's `retryAssistantCall` is documented as mirroring `settings.retry` in *coding-agent*, so pi-ai supplies the mechanism while its own consumer supplies the policy.

**Transport retry stops once the first event is emitted.** After a `text-delta` has reached the caller, restarting the request would duplicate delivered output. Past that point a transport fault becomes an `error` event like any other. This constraint is what makes the retry safe rather than merely convenient.

```ts
interface ClientOptions {
  /** Transport-fault retries before the first event. Default 2; 0 disables. */
  readonly transportRetries?: number;
}
```

### 10.2 ThinkingLevel: adopt the six-level scale

**Resolved against nax's current behaviour rather than preference.** nax has no thinking vocabulary of its own: `src/agents/acp/reasoning-effort.ts` discovers the provider's option *name* per agent (`codex → reasoning_effort`, `claude`/`opencode` → `effort`, `pi → thought_level`) and forwards the configured value opaquely. Narrowing to four values would therefore *remove* expressiveness nax has today — profiles could no longer express `minimal` or `xhigh`.

```ts
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

This matches pi-ai's scale, which means the pi backend needs no mapping table of its own and a future native backend inherits a vocabulary already proven across providers. It is a normalisation that happens to agree with upstream, not a leaked type: the union is declared in nax-ai's own `types.ts` and no pi-ai type is imported.

**Unsupported levels clamp, and the model says what it supports.** `ResolvedModel` carries `thinkingLevels: readonly ThinkingLevel[]` so a consumer can validate configuration up front. If a request names a level outside that list, the protocol clamps to the nearest supported level rather than failing — a valid-looking profile should not become a hard error because one model exposes a coarser scale. Clamping is documented per protocol and covered by conformance tests.

### 10.3 Live-provider testing: a scheduled canary, explicitly not a gate

**Yes, but it must never block a merge.**

- Runs on a schedule and by manual dispatch. **Never on pull requests.**
- Cheapest models only — `deepseek` and `groq` cost fractions of a cent per call.
- Asserts **shape, not content**: the event sequence, that `usage` arrives with the expected fields populated, that a tool call round-trips. Model output varies between runs and is not assertable.
- Requires repository secrets and a spend cap.

The distinction matters more than the job: this is a **detector of upstream wire changes**, not a correctness gate. A provider outage or a transient 503 turning the badge red must not be readable as "the branch is broken", or the first false alarm trains everyone to ignore it. It is labelled accordingly in the workflow, and the recorded-fixture suite from §9 remains the thing that actually gates merges.
