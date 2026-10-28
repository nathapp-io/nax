# SPEC: native-custom-providers — custom native providers, opt-in http endpoints, and terminal account errors

## Summary

Three changes to the native agent's provider layer, bundled at the user's request:

1. **Terminal account and credential errors stop being retried.** An out-of-credit reply (HTTP 402) and a missing credential are classified today as `transport`. So nax-ai retries them, the manager tier retries them three more times, and the run reports `fail-service-down`. They become `quota` and `auth` respectively, which nothing retries.
2. **`agent.native.catalogOverrides` can declare a brand-new provider.** Example: a self-hosted Strata or llama.cpp server under its own name (`strata`). It is reached at the override's `baseUrl`, authenticated from an environment variable named by a new `authEnv` field, and spoken to over `openai-completions` or `anthropic-messages`. Today any override naming a provider unknown to pi-ai throws during native client construction, and that kills every native run, not only the ones using the custom provider.
3. **Plain `http:` to a non-loopback host becomes an explicit opt-in.** A new per-override `allowInsecureHttp: true` admits it. Without the flag the current rule stands (https, or http to localhost/127.0.0.1 only). Precheck warns when the flag is in use, because the credential travels in clear.

It also adds `"openrouter"` to the accepted `thinkingFormat` values. That is the only pi-ai thinking format that sends both a disable signal (`reasoning: {effort: "none"}`) and graded effort (`reasoning: {effort: "low"|"medium"|"high"}`). Strata accepts exactly that shape.

## Motivation

Observed 2026-10-28, all reproduced live through `getNativeClient`:

- **402 retried as a transport fault.** MiniMax-M3 with an empty balance returns an error event with `kind: "transport"` and message `402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}`. The Anthropic SDK path in pi-ai never fires `onResponse` for a failed request, so `observed?.status` is `undefined`. `classifyProviderError(undefined, message)` then falls into `classifyBrokenStream`, which finds no marker and returns `transport`. nax-ai's `retryTransportFaults` retries it, nax-agent maps `transport` to `fail-service-down` (retriable), and `defaultRetryStrategy` retries again: about 40 s spent on an account that has no credit. The OpenAI-SDK path has the same fault in a different spelling: a Strata request with a wrong key returns `kind: "transport"` with message `401: {"type":"authentication_error","message":"missing or wrong API key"}` (pi-ai's `formatProviderError` writes `<status>: <body>` when the SDK message does not carry the body), and nax-ai sends it three times.
- **Missing credential retried as a transport fault.** With no `TOGETHER_API_KEY` and no stored credential, a `together` request yields `{kind: "transport", message: "Provider is not configured: together"}`. That gets the same retries and the same misleading `fail-service-down`.
- **A custom provider breaks every native run.** `applyOverrides` in `packages/nax-ai/src/protocols/pi-client.ts` throws `Cannot apply a provider override for "<id>": the backend catalog does not know that provider ... Overrides amend a provider; they cannot introduce one.` The override list is process-global (`getNativeClient` builds one client), so one override for `strata` makes the native client unbuildable for every model. The current workaround hijacks the bundled `together` provider: `baseUrl` points at a local proxy and the local key is exported as `TOGETHER_API_KEY`.
- **A LAN endpoint needs a proxy.** `isSafeBaseUrl` in `packages/nax/src/config/schemas-model.ts` accepts plain http only for `localhost`/`127.0.0.1`/`[::1]`. A Strata server on `http://192.168.1.175:8080/v1` (Strata serves plain http only) is a config load error. That forced the user to run a proxy on 127.0.0.1:18080 that forwards to the LAN host.
- **Strata effort cannot be fully controlled.** Probed against Strata (docs: `github.com/Niko1221/Strata/blob/main/docs/DETAILS.md`, Chat Completions accepts `reasoning_effort` / `reasoning.effort` = `none|low|medium|high`, default `high`):
  - `thinkingFormat` unset or `"qwen"`: `off` is ignored.
  - `"qwen-chat-template"`: `off` works, but every level collapses to "on".
  - `"openai"`: levels work, but `off` sends nothing, so the server default `high` applies.
  - pi-ai's `"openrouter"` format sends `reasoning: {effort: "none"}` at `off` (zero thinking returned) and `reasoning: {effort: <level>}` otherwise. nax-ai already forwards it to pi untouched, but nax's config schema rejects it.

## Design

### Approach

**Failure classification (nax-ai).**
- Recover the status an SDK printed into the message. pi-ai produces three spellings: the Anthropic SDK path writes `<status> <body>` (`402 {"type":"error",...}`), `formatProviderError` on the OpenAI-completions path writes `<status>: <body>` (`401: {"type":"authentication_error",...}`), and a bodiless failure reads `429 status code (no body)`. A new exported helper `statusFromSdkMessage(message: string | undefined): number | undefined` in `packages/nax-ai/src/protocols/errors.ts` returns the leading status when the message matches `/^([45]\d\d):? (\{|status code)/`, and `undefined` otherwise. The `error` case in `createPiProtocol`'s event loop calls it **only when `observed?.status` is `undefined`**. It passes the recovered status to `classifyProviderError` and reports it as the event's `status`. An observed status always wins over a recovered one. Accepted consequences: a recovered 503 becomes `overloaded` and a recovered 408/409 `bad-request`, both previously retried as `transport`; a plain-text body (`401 Unauthorized`) is not recovered and stays `transport`.
- `classifyHttpError(402)` returns `"quota"`: payment required means the account cannot pay, and waiting does not help.
- `classifyBrokenStream` (non-failing or absent status) checks a new credential-marker table **before** `STREAM_POLICY_MARKERS`. A message containing `provider is not configured` or `no api key for provider` (case-insensitive) is `"auth"`.
- `QUOTA_MESSAGE_PATTERN` accepts an underscore as well as a space: `insufficient[ _](credits|quota|balance)`. The twin `QUOTA_PATTERN` in `packages/nax/src/agents/errors/parse-agent-error.ts` changes identically, because the file comments require the two to stay in step.

Downstream needs no change. `packages/nax-agent/src/native/errors.ts` already maps `quota` to `fail-quota` (not retriable) and `auth` to `fail-auth` (not retriable). `failurePolicyFor` grants terminal backoff only to `fail-rate-limit`, `fail-stale` and `fail-service-down`.

**Custom providers (nax-ai).**
- `ProviderOverride` (`packages/nax-ai/src/providers/types.ts`) gains `readonly authEnv?: string`.
- In `applyOverrides` (`packages/nax-ai/src/protocols/pi-client.ts`), when `models.getProvider(override.provider)` is `undefined`, the override **introduces** a provider instead of throwing, provided all of these hold:
  - `override.baseUrl` is declared.
  - Every model's `protocol` is `"openai-completions"` or `"anthropic-messages"`.
  - Every model declares `maxTokens`. There is no sibling to inherit a ceiling from.
  - `models` is non-empty.
  - No earlier entry in the same override list introduced the same provider id (two entries for one new id are rejected rather than letting the second be read as an amendment).
  The existing per-model checks `assertOverrideModelProvider`, `assertOverrideModelRouting` and `assertOverrideModelThinkingFormat` run on introduced models exactly as on amended ones.
- The introduced provider is built with pi-ai's `createProvider` (exported from `@earendil-works/pi-ai/models`). It takes `id` and `name` equal to the override's provider id, the override's `baseUrl` and `headers`, and an `api` map keyed by protocol holding the result of calling each lazy API factory the models use: `openAICompletionsApi()` from `@earendil-works/pi-ai/api/openai-completions.lazy` and `anthropicMessagesApi()` from `@earendil-works/pi-ai/api/anthropic-messages.lazy`. It also takes `auth` (below) and `models` (the synthesised models below). It is registered with `models.setProvider`.
- Its `auth.apiKey` is `envApiKeyAuth(override.provider, override.authEnv !== undefined ? [override.authEnv] : [])`, exported from the `@earendil-works/pi-ai` root (the same helper pi's bundled `together` provider uses). A stored credential's `key` wins. Otherwise the value of the environment variable named by `authEnv` resolves. Otherwise it returns `undefined`, so pi reports the provider unconfigured and the event classifies as `auth` (above). The variable is read at dispatch through pi's `ctx.env`, the same ambient read pi's bundled providers make for their own key variables; nax's config boundary validates only the variable's name, not its presence (precheck warns when it is unset).
- Each introduced model is synthesised without a template. Its fields:
  - `id` and `name` are `model.id`; `api` is `model.protocol`; `provider` is the override id; `baseUrl` is the override's; `input` is `["text"]`.
  - `contextWindow` and `maxTokens` come from the model; `cost` is `toPiCost(model.pricing)`.
  - `reasoning` follows the same expression `synthesiseModel` uses today.
  - `compat` carries only a declared `thinkingFormat` / `openRouterRouting`.
  - `thinkingLevelMap` is `model.thinkingLevelMap ?? deriveThinkingLevelMap(model, undefined)`.
  - `reasoning` is true whenever a non-`off` level is declared, so pi's `openrouter` branch fires.
  - When the override declares `headers`, `headers` is a copy of them.
- `packages/nax-ai/README.md` (which says an override cannot introduce a provider) is updated to describe introduced providers.
- All pi-ai imports stay in `pi-client.ts` (`check:pi-ai-imports` allows only `pi-client.ts`, `pi-catalog.ts` and `pi-auth.ts`). nax-ai has no file-size gate, so `pi-client.ts` may grow.
- The client-side catalog (`normaliseCatalog`) already creates a model bucket for an unknown provider, so `client.model("strata", id)` resolves today. It is unchanged.

**Override rules for an existing provider are unchanged**, with one addition: `authEnv` on an override whose provider pi-ai already knows throws, naming the provider. Replacing a bundled provider's credential resolution is not this feature.

**`thinkingFormat: "openrouter"`.** It is added to nax-ai's `ThinkingFormat` union, nax-agent's `CatalogModelOverride.thinkingFormat` union and nax's `CatalogModelOverrideSchema` enum. nax-ai already places a declared `thinkingFormat` on `compat` verbatim. `deriveThinkingLevelMap(model, undefined)` leaves `off` unset, so pi's `openrouter` branch sends `reasoning: {effort: "none"}` at `off`. No wire code changes; the value only becomes declarable.

**Forwarding (nax-agent).** `ProviderCatalogOverride` (`packages/nax-agent/src/config/catalog-overrides.ts`) gains `authEnv?: string` and `allowInsecureHttp?: boolean`. The second exists so nax's parsed config (and `collectConfiguredModelPins`, typed `readonly ProviderCatalogOverride[]`) can carry the flag to precheck; nax-agent never acts on it and `toProviderOverrides` does not forward it. `toProviderOverrides` (`packages/nax-agent/src/native/models.ts`) forwards it as `...(override.authEnv !== undefined ? { authEnv: override.authEnv } : {})`, never `undefined`.

**Credential gate (nax-agent).** `NativeSessionAdapter.hasCredentials` (`packages/nax-agent/src/native/session-adapter.ts`) answers today from the owned store, an exec auth source, stored providers, or `anyAmbientCredential()`, which probes only pi's bundled providers. A run whose only native provider is introduced would be pruned by `validateAgentCredentials` (`AGENT_CREDENTIALS_MISSING`). Target: before the ambient probe, `hasCredentials` returns true when any of the adapter's `catalogOverrides` declares an `authEnv` whose variable is non-empty, read through a new `_adapterDeps.readEnv(name)` seam defaulting to a `process.env` lookup.

**Config and precheck (nax).**
- `ProviderCatalogOverrideSchema` gains two fields:
  - `authEnv`: an optional environment-variable name matching `/^[A-Z_][A-Z0-9_]*$/`. It is named after `commandSafety.shadow.authEnv` and deliberately not `apiKeyEnv`: `nax config` masks any key matching `API_?KEY`, which would hide the variable name.
  - `allowInsecureHttp`: an optional boolean.
- A new exported predicate `isRemotePlainHttp(url: string): boolean` in `packages/nax/src/config/schemas-model.ts` (exported through the `@/config` barrel) returns true exactly when the URL parses, its scheme is `http:`, and its hostname is not in the existing `LOOPBACK_HOSTS` set (`localhost`, `127.0.0.1`, `[::1]`, `::1`). Both the schema rule and the precheck below call it; neither re-derives the loopback decision.
- The per-field `isSafeBaseUrl` refine becomes an object-level `superRefine` (pattern: `CommandSafetyShadowSchema` in `packages/nax/src/config/schemas-command-safety.ts`) so it can read the flag:
  - userinfo is always rejected;
  - `https:` is accepted;
  - `http:` to a loopback host is accepted;
  - `http:` to any other host is accepted only when `allowInsecureHttp === true`;
  - every other scheme is rejected.
  The rejection message for remote http names the flag: `... set allowInsecureHttp: true to send this provider's credential over plain http`.
- A new file `packages/nax/src/precheck/checks-catalog-endpoints.ts` exports `checkCatalogEndpoints(catalogOverrides, env)`. It returns warning-tier `Check` rows, and `checkModelResolution` appends them (keeping that function's complexity flat):
  - **insecure-http warning**: for each override with `allowInsecureHttp === true` whose `baseUrl` is `http:` to a non-loopback host. The message names the provider and the host and says the credential is sent unencrypted.
  - **authEnv-unset warning**: for each override with `authEnv` whose variable is unset or empty in `env`. The message names the provider and the variable.
  - **authEnv-destination warning**: for each override with both `authEnv` and `baseUrl`, one row naming the provider, the variable and the `baseUrl` host, saying that variable's value is sent as the bearer credential to that host. This is the `authEnv` counterpart of the existing nax#2019 stored-credential redirect warning: a project-level config could otherwise point any secret-holding variable at any host without a visible line.
  
  `env` is supplied by a new `_modelResolutionDeps.env` seam defaulting to `process.env`.
- `FIELD_DESCRIPTIONS` gains `agent.native.catalogOverrides.authEnv` and `agent.native.catalogOverrides.allowInsecureHttp`. The `.baseUrl` description and the `.thinkingFormat` description (which gains `'openrouter'`) are updated.
- `docs/guides/configuration.md` gains a custom-provider example (a `strata` override with `baseUrl`, `authEnv`, `allowInsecureHttp`, and a model with `thinkingFormat: "openrouter"`).

### Integration

Read-only (verified 2026-10-28 at `9d6f66ed3`):
- `retryTransportFaults` (`packages/nax-ai/src/protocols/retry.ts` via `client.ts`): retries kind `transport` only.
- `FAILURES` table in `packages/nax-agent/src/native/errors.ts`: `quota` → `fail-quota` (retriable false); `auth` → `fail-auth` (retriable false); `transport` → `fail-service-down` (retriable true).
- `normaliseCatalog` (`packages/nax-ai/src/providers/catalog.ts`): `setModel` creates a bucket for any provider id, so the client catalog already resolves an introduced provider's models.
- `buildNativeClient` (`packages/nax-agent/src/native/client.ts`): passes `toProviderOverrides(catalogOverrides)` as `providerOverrides`, and the same array reaches `_clientDeps.defaultProtocols({ providerOverrides, ... })`.
- `CommandSafetyShadowSchema` (`packages/nax/src/config/schemas-command-safety.ts`): the `allowRemote` superRefine pattern to mirror.

Changed: the baseline locates the code only; the Target is the shape to implement.
- `classifyHttpError(status)`. Baseline: `402` → `"bad-request"`. Target: `402` → `"quota"`; every other row unchanged.
- `classifyBrokenStream(message)` (module-private). Baseline: policy markers, then overflow, else `transport`. Target: credential markers (→ `auth`), then policy markers, then overflow, else `transport`.
- `QUOTA_MESSAGE_PATTERN`. Baseline: `insufficient (credits|quota|balance)`. Target: `insufficient[ _](credits|quota|balance)`.
- `createPiProtocol` `case "error"`. Baseline: `const status = observed?.status`. Target: `const status = observed?.status ?? statusFromSdkMessage(event.error.errorMessage)`.
- `applyOverrides(models, overrides)`. Baseline: throws for an unknown provider. Target: introduces it when valid (rules above), throws a provider-naming error otherwise.
- `ProviderOverride`. Target adds `readonly authEnv?: string`.
- `ThinkingFormat` (nax-ai), `CatalogModelOverride.thinkingFormat` (nax-agent), `CatalogModelOverrideSchema.thinkingFormat` (nax). Target adds `"openrouter"`.
- `ProviderCatalogOverride` (nax-agent). Target adds `authEnv?: string`.
- `toProviderOverrides`. Target forwards `authEnv`.
- `ProviderCatalogOverrideSchema` (nax). Target adds `authEnv`, `allowInsecureHttp` and the object-level baseUrl rule.
- `QUOTA_PATTERN` (nax `parse-agent-error.ts`). Target: `insufficient[ _](credits|quota|balance)`.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| Error event, no observed status, message `402 {...}` | kind `quota`, `status: 402`; not retried by nax-ai |
| Error event, no observed status, message `429 {...}` | kind `rate-limit`, `status: 429` |
| Error event, no observed status, message `401: {...}` (OpenAI-completions path) | kind `auth`, `status: 401` |
| Error event, observed status 200, message starting `402 {` | observed status wins; classified as today (no recovery) |
| Error event, no observed status, message `500 tokens were generated` | no recovery (no `{` / `status code` after the digits); classified as today |
| Message `Provider is not configured: strata` or `No API key for provider: strata`, no status | kind `auth` |
| Override introduces a provider without `baseUrl` | construction throws naming the provider and `baseUrl` |
| Introduced provider's model on another protocol (e.g. `openai-responses`) | construction throws naming the model and the protocol |
| Introduced provider's model without `maxTokens` | construction throws naming the model and `maxTokens` |
| `authEnv` on an override for a provider pi-ai knows | construction throws naming the provider and `authEnv` (accepted: like any invalid override, this makes the native client unbuildable for every run) |
| Introduced provider with an empty `models` list | construction throws naming the provider |
| Two override entries introducing the same provider id | construction throws naming the provider |
| Only native provider is an introduced one with a set `authEnv` variable | `hasCredentials` is true; native is not pruned |
| `authEnv` variable unset at dispatch, no stored credential | pi reports provider unconfigured → kind `auth` (row above); precheck warned earlier |
| Remote `http:` baseUrl without `allowInsecureHttp` | config load error naming `allowInsecureHttp` |
| Remote `http:` baseUrl with `allowInsecureHttp: true` | accepted; precheck warning |
| `allowInsecureHttp: true` on an https or loopback baseUrl | accepted; no insecure-http warning (flag is inert) |
| Userinfo in baseUrl, with or without the flag | config load error (unchanged) |
| Override with `authEnv` and `baseUrl` | precheck warning naming provider, variable and host |

## Out of Scope

- `nax auth login <custom-provider>` and `nax auth import` for an introduced provider are not added: login enumerates pi-ai's builtin providers. An introduced provider authenticates from its `authEnv` variable, or from a credential already stored under its id.
- Keyless servers get no special path. An introduced provider with no resolvable key fails as `auth`. A server that needs no key is used by setting the `authEnv` variable to any placeholder value, as Strata's docs advise for OpenAI SDK clients.
- Introduced providers support only `openai-completions` and `anthropic-messages`. `openai-responses` and every other pi protocol are rejected at construction.
- `authEnv` cannot replace the credential resolution of a provider pi-ai already bundles; that combination is rejected.
- `nax-agent-acp`'s server config (`packages/nax-agent-acp/src/server/nax-config.ts`) keeps reading `catalogOverrides` as untyped records. It does not validate `allowInsecureHttp` or the baseUrl scheme.
- The ACP agent error parser in nax (`parse-agent-error.ts`) changes only its quota wording. Recovering an SDK status from ACP stderr is not part of this feature.
- The 402 status recovery is not applied to thrown errors (`classifyThrown`), which already read `status` off the thrown object.
- Switching the user's own `~/.nax/config.json` from the `together` proxy workaround to a `strata` override is a manual step after release, not a story.
- The existing nax#2019 redirect warning in `checkModelResolution` (stored credential sent to `baseUrl`) is left as is, including its wording for introduced providers.

## Stories

### US-001 — classify terminal account and credential errors in nax-ai

Workdir: packages/nax-ai. No dependencies.

Add `statusFromSdkMessage` and call it from `createPiProtocol`'s `error` case when no status was observed. Map `402` to `quota` in `classifyHttpError`. Add the credential-marker table ahead of `STREAM_POLICY_MARKERS` in `classifyBrokenStream`. Widen `QUOTA_MESSAGE_PATTERN` to accept an underscore.

### US-002 — keep nax's ACP quota wording in step

Workdir: packages/nax. No dependencies.

Widen `QUOTA_PATTERN` in `packages/nax/src/agents/errors/parse-agent-error.ts` to `insufficient[ _](credits|quota|balance)`, the twin of nax-ai's `QUOTA_MESSAGE_PATTERN`.

### US-003 — introduce custom providers and the openrouter thinking format in nax-ai

Workdir: packages/nax-ai. No dependencies.

Add `authEnv` to `ProviderOverride` and `"openrouter"` to `ThinkingFormat`. In `applyOverrides`, introduce an unknown provider through pi-ai's `createProvider` when the override is valid (baseUrl declared, every model on `openai-completions` or `anthropic-messages` with `maxTokens`). Its models are synthesised without a template, and its api-key auth resolves a stored credential first, then the `authEnv` variable. Reject an invalid introduction, and `authEnv` on a known provider, with provider-naming errors. Update `packages/nax-ai/README.md` to describe introduced providers.

### US-004 — forward authEnv and the openrouter format through nax-agent

Workdir: packages/nax-agent. Depends on US-003.

Add `authEnv?: string` and `allowInsecureHttp?: boolean` to `ProviderCatalogOverride` and `"openrouter"` to `CatalogModelOverride.thinkingFormat`. Make `toProviderOverrides` forward `authEnv` with a conditional spread and never forward `allowInsecureHttp`. Make `NativeSessionAdapter.hasCredentials` count a catalog override whose `authEnv` variable is set as an available credential, through a new `_adapterDeps.readEnv` seam. 

### US-005 — config schema, precheck warnings and docs for custom providers in nax

Workdir: packages/nax. Depends on US-004.

- Export `isRemotePlainHttp` from `schemas-model.ts` and use it in both the schema rule and the precheck.
- Add `authEnv` and `allowInsecureHttp` to `ProviderCatalogOverrideSchema`, replacing the field-level `isSafeBaseUrl` refine with an object-level `superRefine` that reads the flag.
- Add `"openrouter"` to the `thinkingFormat` enum.
- Add `checkCatalogEndpoints` (new file `packages/nax/src/precheck/checks-catalog-endpoints.ts`) and append its rows from `checkModelResolution`, with an `env` seam on `_modelResolutionDeps`.
- Add and update the `FIELD_DESCRIPTIONS` entries.
- Document a custom-provider example in `docs/guides/configuration.md`.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/errors.ts`
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/test/protocols/errors.test.ts`
- `packages/nax-ai/test/protocols/pi-client.test.ts`

**US-002**
- `packages/nax/src/agents/errors/parse-agent-error.ts`
- `packages/nax/test/unit/agents/errors/parse-agent-error-quota.test.ts`

**US-003**
- `packages/nax-ai/src/protocols/pi-client.ts`
- `packages/nax-ai/src/providers/types.ts`
- `packages/nax-ai/src/providers/override-model.ts`
- `packages/nax-ai/src/auth/pi-auth.ts`
- `packages/nax-ai/src/credentials/memory-store.ts`
- `packages/nax-ai/test/protocols/pi-client-overrides.test.ts`

**US-004**
- `packages/nax-agent/src/config/catalog-overrides.ts`
- `packages/nax-agent/src/native/models.ts`
- `packages/nax-agent/src/native/client.ts`
- `packages/nax-agent/src/native/session-adapter.ts`
- `packages/nax-agent/test/unit/native/client.test.ts`

**US-005**
- `packages/nax/src/config/schemas-model.ts`
- `packages/nax/src/config/schemas-command-safety.ts`
- `packages/nax/src/precheck/checks-model-resolution.ts`
- `packages/nax/src/cli/config-descriptions.ts`
- `packages/nax/test/unit/config/catalog-overrides-schema.test.ts`

### Creates

**US-001**
- `packages/nax-ai/test/protocols/pi-client-error-status.test.ts`

**US-003**
- `packages/nax-ai/test/protocols/pi-client-custom-provider.test.ts`

**US-004**
- `packages/nax-agent/test/unit/native/provider-overrides.test.ts`

**US-005**
- `packages/nax/src/precheck/checks-catalog-endpoints.ts`
- `packages/nax/test/unit/precheck/checks-catalog-endpoints.test.ts`

### Modifies

**US-001**
- `packages/nax-ai/test/protocols/errors.test.ts` — the `classifyHttpError` table has no 402 row today; add `[402, "quota"]` to it. Every existing row keeps its expected kind.

**US-002**

None. `parse-agent-error-quota.test.ts` gains cases but no existing assertion changes.

**US-003**
- `packages/nax-ai/test/protocols/pi-client-overrides.test.ts` — the case "throws at construction for a provider the backend catalog does not know" declares no `baseUrl`, so it must still throw. Keep it and keep its totally-made-up regex match. If the new error message no longer contains the old wording, only the matcher may change, and it must still require the provider id in the message.

**US-004**

None. `nax-agent.api.txt` lists exported names only, and no name changes; the new tests live in a new file.

**US-005**
- `packages/nax/test/unit/config/catalog-overrides-schema.test.ts` — the case "rejects a plaintext http scheme" (http to gateway.test) still holds without the flag. Keep it, and add a case asserting the error message names `allowInsecureHttp`. No existing case changes its expected outcome.

### Seams

- US-003 → US-004: `ProviderOverride.authEnv` (nax-ai) is produced by `toProviderOverrides` (nax-agent). Pinned by US-004's `buildNativeClient` spy AC and its real-wire AC (request URL and `Authorization` header).
- US-004 → US-005: `ProviderCatalogOverride.authEnv` is the type nax's parsed config is passed as. Pinned by US-005's schema round-trip AC and the precheck seam AC through `checkModelResolution`.

## Acceptance Criteria

### US-001 — classify terminal account and credential errors in nax-ai

1. [unit] `classifyHttpError(402)` returns `"quota"`.
2. [unit] `statusFromSdkMessage('402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}')` returns `402`.
3. [unit] `statusFromSdkMessage("429 status code (no body)")` returns `429`.
4. [unit] `statusFromSdkMessage('401: {"type":"authentication_error","message":"missing or wrong API key"}')` returns `401`.
5. [unit] `statusFromSdkMessage("500 tokens were generated before the stream broke")` returns `undefined`.
6. [unit] `statusFromSdkMessage(undefined)` returns `undefined`.
7. [unit] `classifyProviderError(undefined, "Provider is not configured: strata")` returns `"auth"`.
8. [unit] `classifyProviderError(undefined, "No API key for provider: strata")` returns `"auth"`.
9. [unit] `classifyProviderError(429, "insufficient_balance: top up your account")` returns `"quota"`.
10. [unit] A protocol built by `createPiProtocol` over fake deps is driven through `stream`. The deps' `stream` emits a pi `error` event whose `errorMessage` is the MiniMax 402 message `402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}`, and invokes no `onResponse`. The protocol then yields one `error` event with `kind: "quota"` and `status: 402`.
11. [unit] A protocol built by `createPiProtocol` over fake deps whose `stream` first invokes `onResponse` with status `200` and then emits a pi `error` event whose `errorMessage` is the MiniMax 402 message. The yielded `error` event has `status: 200`, and its `kind` equals `classifyProviderError(200, message)`. The observed status wins over the recovered one.
12. [unit] A protocol built by `createPiProtocol` over fake deps whose `stream` emits a pi `error` event with `errorMessage` `"Provider is not configured: strata"` and invokes no `onResponse`. The yielded `error` event has `kind: "auth"` and no `status` property.
13. [unit] A protocol built by `createPiProtocol` over fake deps whose `stream` emits a pi `error` event with `errorMessage` `'401: {"type":"authentication_error","message":"missing or wrong API key"}'` and invokes no `onResponse`. The yielded `error` event has `kind: "auth"` and `status: 401`.
14. [unit] A protocol built by `createPiProtocol` over fake deps whose `stream` emits a pi `error` event with `errorMessage` `'429: {"error":{"message":"slow down"}}'` and invokes no `onResponse`. The yielded `error` event has `kind: "rate-limit"` and `status: 429`.

### US-002 — keep nax's ACP quota wording in step

1. [unit] `isQuotaMessage('{"error":{"type":"insufficient_balance_error","message":"x"}}')` returns `true`.
2. [unit] `isQuotaMessage("insufficient balance (1008)")` returns `true`.

### US-003 — introduce custom providers and the openrouter thinking format in nax-ai

Tests that set `STRATA_TEST_KEY` restore the previous process-environment value afterwards. The injected `fakeStreamSimple` replaces pi's dispatch only; the `apiKey` it receives comes from nax-ai's auth resolver over the introduced provider's `auth`.

The fixture `STRATA` used below is a `ProviderOverride`:
- `provider: "strata"`, `baseUrl: "http://192.168.1.175:8080/v1"`, `authEnv: "STRATA_TEST_KEY"`.
- one model: `id: "qwen3.8-flash"`, `protocol: "openai-completions"`, `contextWindow: 262144`, `maxTokens: 32768`, `supportsTools: true`, `thinkingLevels: ["off","low","medium","high"]`, `thinkingFormat: "openrouter"`, all pricing rates 0.

1. [unit] `createPiDeps({ providerOverrides: [STRATA] })` does not throw.
2. [unit] `resolveModel("qwen3.8-flash", "strata")` on `createPiDeps({ providerOverrides: [STRATA] })` resolves to a model whose `baseUrl` is `"http://192.168.1.175:8080/v1"`, `api` is `"openai-completions"`, `provider` is `"strata"` and `maxTokens` is `32768`.
3. [unit] The model `resolveModel("qwen3.8-flash", "strata")` returns for `STRATA` has `compat.thinkingFormat` equal to `"openrouter"`.
4. [unit] The model `resolveModel("qwen3.8-flash", "strata")` returns for `STRATA` has a `thinkingLevelMap` whose `off` key is absent and whose `low` value is `"low"`.
5. [unit] The deps are built with `createPiDeps({ providerOverrides: [STRATA] }, fakeStreamSimple)`, with `STRATA_TEST_KEY` set to `"k-123"` in the process environment and no credential store. Streaming `qwen3.8-flash` of provider `strata` calls `fakeStreamSimple` with options whose `apiKey` is `"k-123"`.
6. [unit] Deps built with `createPiDeps({ providerOverrides: [STRATA], credentials: <store> }, fakeStreamSimple)`, `STRATA_TEST_KEY` set to `"k-123"`, and `<store>` an in-memory nax-ai `CredentialStore` (`createMemoryCredentialStore`) holding the nax-ai credential `{ kind: "api-key", key: "stored-1" }` under `"strata"`: streaming `qwen3.8-flash` gives `fakeStreamSimple` `apiKey: "stored-1"`: a stored credential wins over `authEnv`.
7. [unit] With `STRATA_TEST_KEY` unset and no credential store, streaming `qwen3.8-flash` of provider `strata` through `createPiDeps({ providerOverrides: [STRATA] }, fakeStreamSimple)` calls `fakeStreamSimple` with options that have no `apiKey` property.
8. [unit] `createPiDeps` with `STRATA` minus `baseUrl` throws an error whose message contains `"strata"` and `"baseUrl"`.
9. [unit] `createPiDeps` with `STRATA` whose model has `protocol: "openai-responses"` throws an error whose message contains `"qwen3.8-flash"` and `"openai-responses"`.
10. [unit] `createPiDeps` with `STRATA` whose model omits `maxTokens` throws an error whose message contains `"qwen3.8-flash"` and `"maxTokens"`.
11. [unit] `createPiDeps` with an override for `"openai"` that carries `authEnv: "X_KEY"` throws an error whose message contains `"openai"` and `"authEnv"`.
12. [unit] `createPiDeps({ providerOverrides: [STRATA] })` still resolves a bundled model of another provider (`resolveModel` on a known `openai` model id with provider `"openai"` succeeds). An introduced provider leaves the rest of the catalog usable.
13. [integration] `createClient` is called with `defaultProviders()`, the `defaultProtocols` factory and `providerOverrides: [STRATA]`. `client.model("strata", "qwen3.8-flash")` resolves to a `ResolvedModel` with `provider: "strata"` and `protocol: "openai-completions"`.
14. [unit] `createPiDeps` with `STRATA` whose `models` is empty throws an error whose message contains `"strata"`.
15. [unit] `createPiDeps` with two override entries both introducing provider `"strata"` throws an error whose message contains `"strata"`.
16. [unit] The model `resolveModel("qwen3.8-flash", "strata")` returns for `STRATA` has `reasoning` equal to `true`.
17. [unit] The resolved `STRATA` model is passed to pi's real openai-completions `streamSimple` (imported from `@earendil-works/pi-ai/api/openai-completions`, as `pi-client-overrides.test.ts` does) with no `reasoningEffort` and an `onPayload` hook; the captured payload has `reasoning` equal to `{ effort: "none" }`.
18. [unit] The same call with `reasoningEffort: "low"` captures a payload whose `reasoning` equals `{ effort: "low" }`.

### US-004 — forward authEnv and the openrouter format through nax-agent

1. [unit] `toProviderOverrides([{ provider: "strata", baseUrl: "http://192.168.1.175:8080/v1", authEnv: "STRATA_KEY", models: [<one valid model>] }])` returns one override whose `authEnv` is `"STRATA_KEY"`.
2. [unit] `toProviderOverrides` on an override without `authEnv` returns an override object that has no `authEnv` property.
3. [unit] `toProviderOverrides` on a model declaring `thinkingFormat: "openrouter"` returns a model whose `thinkingFormat` is `"openrouter"`.
4. [unit] `toProviderOverrides` on an override declaring `allowInsecureHttp: true` returns an override object that has no `allowInsecureHttp` property.
5. [integration] With `_clientDeps.defaultProtocols` replaced by a spy, `buildNativeClient([<strata override with authEnv "STRATA_KEY">])` invokes the spy once with `providerOverrides[0].authEnv` equal to `"STRATA_KEY"`.
6. [integration] With `STRATA_KEY` set to `"k-wire"` (restored afterwards) and `globalThis.fetch` replaced by an interceptor that records each request and answers 401, streaming `qwen3.8-flash` of provider `strata` through a client from `buildNativeClient([<strata override: baseUrl "http://192.168.1.175:8080/v1", authEnv "STRATA_KEY", one openai-completions model with maxTokens>], { transportRetries: 0 })` records exactly one request whose URL starts with `http://192.168.1.175:8080/v1/chat/completions` and whose `Authorization` header is `Bearer k-wire`, following the existing nax#2019 wire test in `client.test.ts`.
7. [unit] A `NativeSessionAdapter` constructed with catalog overrides `[<strata override with authEnv "STRATA_KEY">]`, with `_adapterDeps.authSourceIsExec` resolving false, `_adapterDeps.listStoredProviders` resolving `[]`, `_adapterDeps.anyAmbientCredential` resolving false and `_adapterDeps.readEnv` returning `"k"` for `"STRATA_KEY"`, answers `hasCredentials()` with `true`.
8. [unit] The same adapter with `_adapterDeps.readEnv` returning `undefined` for `"STRATA_KEY"` answers `hasCredentials()` with `false`.

### US-005 — config schema, precheck warnings and docs for custom providers in nax

1. [unit] Parsing `agent.native.catalogOverrides` with a valid override plus `baseUrl: "http://192.168.1.175:8080/v1"` and no `allowInsecureHttp` throws a validation error whose message contains `"allowInsecureHttp"`.
2. [unit] The same override with `allowInsecureHttp: true` parses, and the typed output keeps `baseUrl` and `allowInsecureHttp: true`.
3. [unit] An override with `allowInsecureHttp: true` and `baseUrl: "http://user:tok@192.168.1.175:8080/v1"` fails to parse.
4. [unit] An override with `allowInsecureHttp: true` and `baseUrl: "file:///etc/passwd"` fails to parse.
5. [unit] An override with `baseUrl: "http://127.0.0.1:8080/v1"` and no flag still parses.
6. [unit] An override with `allowInsecureHttp: true` and `baseUrl: "https://gw.test/v1"` parses.
7. [unit] An override with `authEnv: "STRATA_API_KEY"` parses and the typed output keeps `authEnv: "STRATA_API_KEY"`.
8. [unit] An override with `authEnv: "strata-key"` fails to parse (not an environment-variable name).
9. [unit] A catalog model declaring `thinkingFormat: "openrouter"` parses and keeps the value.
10. [unit] `checkCatalogEndpoints([<override provider "strata", baseUrl "http://192.168.1.175:8080/v1", allowInsecureHttp true>], {})` returns one warning-tier check, `passed: false`, whose message contains `"strata"`, `"192.168.1.175"` and `"allowInsecureHttp"`.
11. [unit] `checkCatalogEndpoints` on an override with `allowInsecureHttp: true` and `baseUrl: "https://gw.test/v1"` returns no insecure-http warning.
12. [unit] `checkCatalogEndpoints` on an override with `allowInsecureHttp: true` and `baseUrl: "http://127.0.0.1:18080/v1"` returns no insecure-http warning.
13. [unit] `checkCatalogEndpoints([<override provider "strata", authEnv "STRATA_API_KEY">], {})` returns one warning-tier check whose message contains `"strata"` and `"STRATA_API_KEY"`.
14. [unit] `checkCatalogEndpoints([<override provider "strata", authEnv "STRATA_API_KEY">], { STRATA_API_KEY: "x" })` returns no authEnv-unset warning.
15. [unit] `checkCatalogEndpoints([<override provider "strata", authEnv "STRATA_API_KEY", baseUrl "https://gw.test/v1">], { STRATA_API_KEY: "x" })` returns one warning-tier check whose message contains `"strata"`, `"STRATA_API_KEY"` and `"gw.test"`.
16. [unit] `isRemotePlainHttp("http://192.168.1.175:8080/v1")` returns `true`.
17. [unit] `isRemotePlainHttp("http://[::1]:8080/v1")` returns `false`.
18. [unit] `isRemotePlainHttp("https://gw.test/v1")` returns `false`.
19. [integration] `_modelResolutionDeps.env` is set to `{}` and `_modelResolutionDeps.resolveNative` to a stub resolving every id. `checkModelResolution` on a config with an `authEnv: "STRATA_API_KEY"` override then returns a warning row whose message contains `"STRATA_API_KEY"`.
20. [unit] `FIELD_DESCRIPTIONS["agent.native.catalogOverrides.authEnv"]` and `FIELD_DESCRIPTIONS["agent.native.catalogOverrides.allowInsecureHttp"]` are non-empty strings.
21. [unit] `FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingFormat"]` mentions `"openrouter"`.
