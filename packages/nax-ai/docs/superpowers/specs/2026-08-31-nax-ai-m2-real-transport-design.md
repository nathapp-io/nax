# nax-ai M2: real transport

**Status:** design, approved 2026-08-31 · **Milestone:** M2 · **Depends on:** M1 (merged, PR #1 `d3a3968`)

M1 built a protocol seam that cannot make a network call. Every backend takes an injected client and `createPiClient` throws. M2 is where nax-ai becomes usable: a real pi-ai transport, nax-ai-owned catalog and auth, and a first completion against a live provider.

Read [the M1 design](2026-08-31-nax-ai-protocol-architecture-design.md) first. Its section 10 records three questions that look open and are settled; this document does not revisit them.

## 1. What M2 delivers

| Delivers | Section |
|---|---|
| `createPiProtocol` — pi-ai's 12 event kinds mapped to our 7 | 4 |
| HTTP status recovery, so error classification is not a decoration | 5 |
| `piProviders()` — pi-ai's 1,290-model catalog normalised into our types | 6 |
| `AuthResolver` and a credential store adapter, with automatic OAuth refresh | 7 |
| `piProtocols()` — the registration surface M1 left unexported | 8 |
| A first real completion, and recorded material for M3 | 10 |

Everything measured below was read from pi-ai 0.84.4 as installed, on 2026-08-31.

## 2. Decisions

| Decision | Ruling |
|---|---|
| Layering | Split by concern: streaming delegated to pi-ai, catalog and auth owned by nax-ai |
| Backend files | One `pi-client.ts`, four registry keys |
| `PiStreamEvent` intermediate | Deleted; pi events map straight to `ProtocolEvent` |
| Catalog delivery | Opt-in `piProviders()`; `ClientOptions.providers` stays required |
| Tiered pricing | Passed through as `Pricing.tiers` |
| Provider offering both auth kinds | api-key selected, so the live OAuth gate does not lock out Anthropic |
| OAuth login | Out of scope; resolution and refresh only |
| M2 evidence | Scripted units gate CI; an opt-in live test records fixtures |

## 3. Layering: split by concern, not by layer

pi-ai is not only a transport. `builtinModels({ credentials })` returns a `Models` collection that already owns a catalog, auth resolution with OAuth refresh, and dispatch on `model.api`. Taking all of it would be the least code. Taking none of it would rebuild machinery that works.

The right cut is by **what survives the native migration**, because a native backend is the destination, not a hypothetical.

| Concern | Owner | Reasoning |
|---|---|---|
| Streaming and api dispatch | pi-ai | Pure throwaway. Lives behind `Protocol` and is deleted per-protocol at migration, so nothing here can cost anything later. |
| Catalog | nax-ai types, pi-ai as data source | A native backend needs `baseUrl`, headers and model metadata without importing pi-ai. M1 section 5 already requires this. |
| Auth | nax-ai port, pi-ai as the M2 implementation | The trap. pi-ai refreshes OAuth correctly, serialized inside the store lock. If that lives only inside `streamSimple`, deleting the pi backend deletes auth with it. |

The migration path is unchanged from M1 section 4: a native backend implements `Protocol` directly. It never sees anything in this document except the shared helpers named in section 4.

## 4. The pi protocol

One factory, parameterised by protocol name, registered under four keys:

```ts
export function createPiProtocol(name: string, deps: PiDeps): Protocol
```

The four per-protocol `backend-pi.ts` files that M1 shipped are deleted. They differed only in where `system` was placed in the wire request, and pi-ai's `Context` has a `systemPrompt` field, so that difference does not exist on this path. A per-api quirk, if one appears, becomes a branch in one file where all four can be read side by side.

### 4.1 No intermediate event type

M1 routed pi events through `PiStreamEvent` before `ProtocolEvent`. That type is deleted, along with `PiClientPort`.

Its stated justification (`backend-pi.ts:6`) was that `PiClientPort` is "exactly the seam a future hand-written backend implements directly against HTTP". M1 section 4 says the opposite: a native backend implements `Protocol`. The spec is authoritative, which leaves `PiStreamEvent` with one producer and one consumer forever — a detour, not a seam. It was also only half pi-shaped: its `done.stopReason` already used our vocabulary (`"tool_use"`, not pi's `"toolUse"`).

The logic it appeared to share is shared as pure functions instead, which is the precedent `usage.ts` set in M1:

- `accumulateToolArgs()` — fragment accumulation and parse
- `classifyHttpError()` — M1's `classify()`, which existed as four identical private copies
- `toTokenUsage()` — unchanged

A native backend imports these directly. Sharing logic does not require a union type to carry it.

### 4.2 Request translation

`ProtocolRequest` maps onto `Context` plus `SimpleStreamOptions`. `streamSimple` is the entry point rather than `stream`, because `SimpleStreamOptions` is already provider-neutral: `toolChoice`, `reasoning`, `cacheRetention`, `maxTokens`, `temperature`.

| `ProtocolRequest` | pi-ai |
|---|---|
| `system` | `Context.systemPrompt` |
| `messages` | `Context.messages` |
| `tools` | `Context.tools` |
| `toolChoice`, `maxTokens`, `temperature`, `cacheRetention`, `signal` | `SimpleStreamOptions`, same names |
| `thinking` | `SimpleStreamOptions.reasoning`; `"off"` omits the field |
| `model` | resolved to `Model<Api>` via `models.getModel` |

`toolChoice` and `cacheRetention` were accepted but unmapped in M1; this closes that gap.

### 4.3 Event mapping

| pi-ai event | `ProtocolEvent` | Note |
|---|---|---|
| `start` | — | nothing to emit |
| `text_start`, `text_end` | — | content already delivered as deltas |
| `text_delta` | `text-delta` | |
| `thinking_start`, `thinking_end` | — | |
| `thinking_delta` | `thinking-delta` | |
| `toolcall_start` | — | id and name not yet known |
| `toolcall_delta` | `tool-call-partial` | id and name read from `partial.content[contentIndex]` |
| `toolcall_end` | `tool-call` | arguments accumulated and parsed |
| `done` | `usage`, then `done` | |
| `error` | `usage` if reported, then `error` | |

Three rulings:

**Usage is synthesised at the terminal event.** pi-ai has no usage event — its twelve kinds carry none. Usage rides on `AssistantMessage.usage`, reachable through every event's `partial` and through the terminal `message`. Our `ProtocolEvent` has a discrete `usage` kind and the conformance suite requires it to precede `done`, so the mapping emits it at the terminal event, converted by `toTokenUsage`, whose `UpstreamUsage` is already pi-ai's `Usage` subset.

**An errored call still emits usage.** A failed request that consumed tokens still bills for them. Dropping usage on the error path would under-report cost exactly when something went wrong.

**`stopReason: "deferred"` is a defect, not a mapping.** We never pass `deferred`, so receiving it means an assumption broke. It emits an error rather than silently becoming `"stop"`. `"content_filter"` has no pi-ai equivalent and is unreachable here; it stays in the vocabulary for a native backend.

Tool call ids deserve their own note. `toolcall_delta` carries only `contentIndex` and `delta` — no id, no name. Both arrive at `toolcall_end`. Since `tool-call-partial` requires them up front, they are read out of `partial.content[contentIndex]`, which holds the in-progress `ToolCall`.

## 5. Error classification needs the response, not the event

pi-ai's error event is:

```ts
{ type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

There is no HTTP status and no `retry-after`. `AssistantMessage` offers only `errorMessage?: string`. M1's `classify(status)` would therefore receive `undefined` on every error and return `"unknown"` every time, so `ProtocolError.kind` could never be `"rate-limit"` and `retryAfter` could never be populated.

That is not a cosmetic gap. M1 section 10.1 deliberately assigns rate-limit retry to the consumer, because backoff interacts with concurrency and cost budget. Shipping a classifier that cannot classify would hand the consumer a blindfold and call it a policy split.

`ProviderRequestOptions.onResponse?: (response: { status, headers }) => void` fires per request, before the body is consumed. The pi protocol installs it, captures status and the `retry-after` header, and correlates them with the error event. Without this, `classifyHttpError` is decoration.

## 6. Catalog

```ts
export async function piProviders(ids?: readonly string[]): Promise<RawProvider[]>
```

`ClientOptions.providers` stays required and there is no hidden default. M1 section 4 holds that selection is an explicit parameter and nax-ai never decides behaviour on the consumer's behalf; a catalog that silently materialised from pi-ai would break that, and would hide the pi-ai dependency at exactly the moment the point is to migrate off it. Subsetting also matters: nax wants roughly five providers, not thirty-nine.

Measured: `@earendil-works/pi-ai/providers/all` is a public subpath export, imports in 50 ms, and yields 1,290 models across 39 providers. The import is dynamic, so nothing pays that cost unless it calls this.

Per model, `model.api` becomes `protocol`, and `thinkingLevels` comes from pi-ai's `getSupportedThinkingLevels(model)`, which reads `thinkingLevelMap` where `null` marks a level unsupported. 543 models carry such a map. Our seven-level scale and pi-ai's `ModelThinkingLevel` agree, `"off"` included, so this is a direct read rather than an inference.

Per provider, `baseUrl` and `headers` come off the models, and `defaultProtocol` is the most common `api` among them.

### 6.1 Tiered pricing

22 of the 1,290 models price in tiers, and they are not in providers we can ignore: `openai` (7), `openai-codex` (5), `github-copilot` (8), `cloudflare-ai-gateway` (2). `openai-codex` is the OAuth path M2 wires.

```
openai/gpt-5.4  base: input 2.5, output 15
                tier: inputTokensAbove 272000 -> input 5, output 22.5
```

A long-context call on that model costs twice what flat rates report. `Pricing` therefore gains an optional `tiers`:

```ts
interface PricingRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface Pricing extends PricingRates {
  readonly tiers?: readonly PricingTier[];
}

interface PricingTier extends PricingRates {
  readonly inputTokensAbove: number;
}
```

The rates are factored out rather than having `PricingTier` extend `Pricing`, which would let a tier carry its own tiers.

A consumer that ignores `tiers` behaves exactly as it does today; one that honours it is correct. nax-ai still computes no cost, so this remains faithful to M1 section 7. It deliberately does not call pi-ai's `calculateCost`, which would put cost logic inside nax-ai and re-import pi-ai on a path a native backend must not touch.

### 6.2 Choosing an auth variant, and what the OAuth gate does to Anthropic

The OAuth gate is **already wired**. M1 section 5 described `oauth-policy.ts` as tested but unwired; that spec predates M1's implementation, which calls `assertOAuthFlowPermitted(rawProvider.auth.flow)` at `catalog.ts:64`. Nothing further is needed to wire it, and this document does not claim credit for doing so.

What M2 must decide is which auth variant a pi-ai provider maps to, and that decision collides with the live gate.

pi-ai's `ProviderAuth` has independently optional `apiKey` and `oauth`. Ours is a single variant. Measured across the 39 built-in providers: 33 offer api-key only, 1 offers OAuth only (`openai-codex`), and **6 offer both** — `anthropic`, `github-copilot`, `kimi-coding`, `openrouter`, `radius`, `xai`.

**When a provider offers both, `piProviders` selects api-key.**

This is not a tie-break for tidiness. `anthropic` offers both, and mapping it to OAuth would make `assertOAuthFlowPermitted("anthropic")` throw during normalisation, rendering Anthropic unloadable through nax-ai entirely. Selecting api-key makes it work through `ANTHROPIC_API_KEY`, which is the intended policy: the prohibition is on Anthropic *subscription* OAuth, never on the API. `openai-codex` is OAuth-only, maps to OAuth, and passes the allowlist.

A test asserts both halves through `piProviders`: `anthropic` normalises to api-key and loads, and a synthetic provider declaring `{ kind: "oauth", flow: "anthropic" }` still fails.

### 6.3 The env var name cannot be filled honestly

Our api-key variant declares `env: string`, the environment variable name. `piProviders` leaves it unset, and the field becomes optional:

```ts
{ readonly kind: "api-key"; readonly env?: string }
```

pi-ai does hold a provider-to-variable table, in `env-api-keys.ts`. It is reachable in three ways, and all three fail for different reasons. Verified against installed pi-ai 0.84.4 and against pi's own source at `github.com/earendil-works/pi`.

| Route | Why not |
|---|---|
| `getApiKeyEnvVars(provider)` — the candidate table itself | Module-private. Not exported from `env-api-keys.ts`, not re-exported by `compat.ts`. |
| `findEnvKeys(provider)` — public via `/compat` | Returns only the variables **currently set in the process environment**, filtered by `getProviderEnvValue`. Verified: with no keys exported, it returns `undefined` for all of `anthropic`, `deepseek`, `groq`, `openai`, `openai-codex`, `minimax`, `opencode-go`. Calling it at catalog time would make the catalog's contents depend on ambient environment — exactly what M1 section 4 forbids: "nax-ai never reads the environment to decide behaviour... would make tests order-dependent." |
| `getEnvApiKey(provider)` — public via `/compat` | Returns the key's **value**. Putting a live secret in a descriptive catalog field is not a naming solution. |

Even with the table in hand, `env: string` is the wrong shape: `anthropic` maps to three candidates — `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` — which is why pi-ai's own accessor returns `string[]`.

Guessing by convention from the provider id would be silently wrong for a long tail (`google` reads `GEMINI_API_KEY`, `azure-openai-responses` reads `AZURE_OPENAI_API_KEY`, `opencode-go` reads `OPENCODE_API_KEY`). The field is descriptive only — section 7 resolves auth through `AuthResolver`, which never reads it — and a hand-written `RawProvider` can still declare it. `AuthResult.source` reports the real variable name after resolution, which is the honest place for status display to get it.

`piProviders(["nope"])` throws rather than silently returning fewer providers.

## 7. Auth

```ts
export interface ResolvedAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AuthResolver {
  resolve(model: ResolvedModel): Promise<ResolvedAuth>;
}
```

The pi implementation calls `models.getAuth(model)`, which refreshes an expired OAuth token inside the credential store's lock so concurrent requests cannot double-refresh a rotated token, and returns `{ apiKey?, headers?, baseUrl? }`.

**The pi protocol resolves auth explicitly and passes it into `streamSimple`** via `ProviderRequestOptions.apiKey` and `headers`, rather than letting `Models` resolve internally. Both work. The difference is that the second leaves `AuthResolver` with no callers until the native milestone, and an interface whose only implementation is never exercised is not a seam that has been proven — it is one that has been asserted. Resolving explicitly makes auth nax-ai's on both paths from day one and leaves pi-ai doing transport only, which is the concern split section 3 chose.

### 7.1 Credential store adapter

nax-ai's `CredentialStore` is adapted onto pi-ai's. Both are `read`/`modify`/`delete` with a read-modify-write `modify`, so the shapes correspond directly.

`StoredCredential`'s api-key variant gains an optional `env`:

```ts
{ readonly kind: "api-key"; readonly key: string; readonly env?: Readonly<Record<string, string>> }
```

pi-ai's `ApiKeyCredential` carries `env?: ProviderEnv`. Because `modify` is read-modify-write, an adapter without a slot for it would drop that field on every write. The failure would be silent and would only appear as a provider that stops resolving.

That field carries more than it first appears. pi's own agent — `packages/coding-agent/src/core/auth-storage.ts`, the `CredentialStore` backing `~/.pi/agent/auth.json` — stores `key` as a literal, a `$VAR` / `${VAR}` template, or a `!command`, and its `read()` resolves templates through `resolveConfigValue(credential.key, credential.env)`. So `env` is the **substitution scope** for the stored key, not merely a bag of Cloudflare account ids. Dropping it would break every `$VAR`-style credential, not one provider's edge case.

Two consequences for nax-ai:

- **`key` is opaque.** It may not be a literal secret. nax-ai never inspects, compares, logs or validates it; it round-trips it and passes it on. Template and command resolution belongs to the store, which is consumer-supplied — pi-ai itself receives an already-resolved literal.
- **The reference implementation is worth copying at M4.** That same file locks `auth.json` with `proper-lockfile` and writes with mode `0o600` under a `0o700` directory. Our deferred cross-process locking item should follow it rather than invent something, and it confirms `modify` is the right place for the lock.

### 7.2 A caveat carried into the plan

`ProviderRequestOptions` has `apiKey` and `headers` but no `baseUrl`; base URL comes off the `Model`. A provider with a per-credential base URL — GitHub Copilot is the one pi-ai documents — cannot have it injected per request. None of the nine providers in M1's inventory need it.

More consequentially, that an explicitly-passed `apiKey` takes precedence over `Models`' own resolution, rather than being ignored or causing a double resolution, is an assumption and not a finding. The plan carries it as a task that proves precedence against a live provider before the remaining auth wiring is built on it.

**Verified 2026-08-31** by `scripts/probe-apikey-precedence.ts` against `deepseek`: an explicitly passed `apiKey` does take precedence over pi-ai's own resolution. The deliberately wrong key was rejected with `401` naming that key's own masked tail, while the real key authenticated and failed only on `402 Insufficient Balance` — a billing state of the zero-balance test account, not an auth outcome; with no explicit key, pi-ai's own resolution reaches the same `402`, so the two explicit keys provably took different paths. Task 9 therefore passes resolved auth explicitly.

## 8. Public surface

Added:

| Export | Purpose |
|---|---|
| `piProviders(ids?)` | catalog, normalised into our types |
| `piProtocols(options?)` | four registry entries sharing one `Models` |
| `AuthResolver`, `ResolvedAuth` | the auth port |
| `PricingRates`, `PricingTier`, `Pricing.tiers` | tiered rates |
| `StoredCredential.env` | faithful api-key round-trip |

Changed: `ProviderAuth`'s api-key variant relaxes `env` from required to optional (section 6.3).

Removed: `PiStreamEvent`, `PiClientPort`.

`piProtocols()` closes M1's carried follow-up that `src/index.ts` exports no registration factories. It matters beyond convenience: the four protocol entries must share a single `Models`, and therefore a single credential store and catalog, rather than constructing four.

```ts
const client = createClient({
  providers: await piProviders(["deepseek", "anthropic"]),
  protocols: piProtocols({ credentials: myStore }),
});
```

## 9. Folder structure

```
src/protocols/pi-client.ts     createPiProtocol, createPiDeps; owns pi-ai
src/protocols/pi-protocols.ts  piProtocols; four registry keys, one Models
src/protocols/tool-args.ts     createToolArgAccumulator, parseToolArgs
src/protocols/errors.ts        classifyHttpError, parseRetryAfter
src/providers/pi-catalog.ts    piProviders
src/auth/resolver.ts           AuthResolver, ResolvedAuth (no pi-ai import)
src/auth/pi-auth.ts            credential store adapter, pi AuthResolver
src/protocols/registry.ts      unchanged
src/usage.ts                   unchanged

deleted: src/protocols/{anthropic-messages,openai-completions,
         openai-responses,openai-codex-responses}/
```

`scripts/check-pi-ai-imports.ts`'s ALLOWED list becomes exactly `pi-client.ts`, `pi-catalog.ts` and `pi-auth.ts`. The gate scans `src/` only, so the test that feeds scripted pi-ai events needs no allowance — which is what lets it test what ships.

The auth split is driven by that gate: `resolver.ts` holds the port with no pi-ai import, so a native backend can depend on it; `pi-auth.ts` holds the adapter that does import pi-ai.

## 10. Testing

`vitest.config.ts` currently includes `test/**/*.test.ts`, so a live file would run in CI by default. The config excludes `**/*.live.test.ts` and a separate `test:live` script includes it. Each live test also skips on a missing key, so a mis-run costs nothing.

**CI gate, no network and no credentials:**

- One case per pi event kind, twelve in all: scripted `AssistantMessageEvent`s in, `ProtocolEvent`s out.
- The sharp edges get their own cases: tool id and name recovered from `partial.content[contentIndex]`; usage synthesised before `done`; usage before `error` when the failed message reports tokens; `"deferred"` treated as a defect; `onResponse`-captured status reaching `classifyHttpError`; the full stopReason table.
- The pi protocol runs through M1's `runProtocolConformance`. Its header promises a hand-written backend inherits those invariants the day it is created; the pi protocol is the first backend to claim them.
- Catalog tests run against pi-ai's real bundled data, which needs no network: tiers survive, `thinkingLevels` match `getSupportedThinkingLevels`, an unknown id throws, `anthropic` normalises to api-key and loads, and a synthetic `{ kind: "oauth", flow: "anthropic" }` provider still fails through `piProviders`.
- Auth: the store adapter round-trips without dropping `env`; the resolver returns a refreshed token from a fake `Models`.

**Opt-in live**, run by hand, recording raw event sequences to `test/fixtures/recorded/` so M3 inherits real material rather than starting from nothing.

Until M3, correctness rests on scripted events plus one recorded live run. That is a real limit and is stated rather than papered over.

## 11. Definition of done

1. [x] `lint`, `typecheck`, `test`, `build` green, with the pi-ai import gate extended as section 9 describes.
2. [x] A real completion against a cheap provider returns text and non-zero usage.
3. [x] A real tool call round-trips end to end.
4. [x] A Codex OAuth request succeeds given a pre-existing credential.
5. [x] Explicit `apiKey` precedence over `Models`' own resolution proven live (section 7.2).
6. [ ] `0.1.0` published under the `next` dist-tag. Never `latest`. — pending explicit consent; not run yet.
7. [x] ROADMAP position updated in the same commit as the work.

## 12. Out of scope

| Item | Where it lands | Why not here |
|---|---|---|
| OAuth login flows | consumer, or a later milestone | `login()` needs prompt and notify callbacks. That is UI, and nax-ai holds no UI or domain concepts. It is also the hardest part of a provider to hand-roll, so owning it here would deepen the pi-ai coupling where it is most expensive to undo. |
| Recorded-fixture merge gate | M3 | Fixture shape is easiest to get right after seeing how the mapping behaves, which is what M2 teaches. |
| Transport retry | M4 | M1 section 10.1 |
| Cross-process credential locking | M4 | pi-ai's in-process serialisation covers a single nax process |
| Live-provider canary | M4 | M1 section 10.3: a detector, never a gate |
