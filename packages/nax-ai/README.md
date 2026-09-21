# @nathapp/nax-ai

Provider-agnostic LLM client: completions, streaming, tool calls, usage accounting and auth across API-key and OAuth providers.

> **Pre-1.0 — the API is unstable and will change without deprecation cycles.**
> Pre-1.0 and API-unstable. Pin an exact version; do not use a caret range.
>
> ```
> npm install @nathapp/nax-ai@next
> ```

## Where to start

New to this repository, or picking the work up cold? **[`ROADMAP.md`](ROADMAP.md)** records the current milestone, what is next, and links to the design spec and the feasibility analysis behind it.

## Usage

```ts
import { createClient, piProtocols, piProviders } from "@nathapp/nax-ai";

const client = createClient({
  providers: await piProviders(["deepseek", "anthropic"]),
  protocols: piProtocols(),
});

const model = await client.model("deepseek", "deepseek-v4-flash");
const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });
```

While the API is unstable, `latest` and `next` both point at the current 0.x release, so `npm install @nathapp/nax-ai` and `npm install @nathapp/nax-ai@next` are equivalent. Canary builds are published to `canary` and are not covered by either.

### Provider overrides

The bundled catalog comes from pi-ai and is a snapshot: it can carry stale pricing, and it will not know a model your provider added last week. `providerOverrides` amends it — per provider, and only with declaration data.

```ts
import { createClient, defaultProtocols, piProviders, type ProviderOverride } from "@nathapp/nax-ai";

const providerOverrides: readonly ProviderOverride[] = [
  {
    provider: "openrouter",
    models: [
      {
        id: "z-ai/glm-5.3-flash",
        provider: "openrouter",
        protocol: "openai-completions",
        pricing: { input: 0.15, output: 0.5, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_768,
        supportsTools: true,
        thinkingLevels: ["off", "high"],
      },
    ],
  },
];

const client = createClient({
  providers: await piProviders(["openrouter"]),
  // The factory form hands the client's own overrides to the protocol side, so
  // the array is written once. Prefer it whenever overrides are in play — and
  // add `credentials` here too if you use a credential store (see below).
  protocols: (o) => defaultProtocols({ ...o }),
  providerOverrides,
});
```

**An override must reach both catalogs.** The client prices and resolves against one; the wire resolves against another. Declaring the array on `createClient` alone is a real bug with no symptom until the first request, so `createClient` rejects it at construction. The factory form above is how you avoid writing the array twice; passing the same array to both `createClient` and `defaultProtocols({ providerOverrides })` works too.

**What an override can say.** A `ProviderOverride` carries `baseUrl`, `headers` and `models`. `baseUrl` and `headers` replace rather than merge, and apply to every model of that provider, bundled ones included — that is how a proxy or a tenant header is wired. Each entry in `models` is a full `ResolvedModel`: `pricing`, `contextWindow`, `maxTokens`, `supportsTools`, `thinkingLevels`, `thinkingLevelMap` and `supportsStrictToolSampling`.

**What it cannot say.** Declaration data only: behaviour belongs in a protocol backend, not here. An override also amends a provider — it cannot introduce one, since there would be no `stream` implementation to inherit.

**Two rules that throw rather than warn.** A model's own `provider` field must equal the override's `provider` (otherwise the request would be signed against a provider you never named), and a model the base catalog does not carry must be declared on both sides.

**Fields you do not state are inherited from a sibling.** `ResolvedModel` is narrower than the wire's model, so `name`, `baseUrl`, `input` and the provider compatibility settings come from another model of the same provider on the same protocol — preferring one that supports your declared thinking levels, and preferring this model's own bundled entry when the catalog already carries that id. State `maxTokens` and `thinkingLevelMap` explicitly when they matter: an inherited ceiling is a silent truncation, and an inherited thinking map can mark a level you declared unsupported.

### Pinning an OpenRouter endpoint

Against an aggregator, one model id is many endpoints: different machines, different prices, different quantizations, chosen per request. A `ResolvedModel` carried on a `ProviderOverride` can pin that choice with `openRouterRouting`, which is sent verbatim as the request's `provider` field:

```ts
const overrides = [
  {
    provider: "openrouter",
    models: [
      {
        id: "deepseek/deepseek-v4-flash",
        provider: "openrouter",
        protocol: "openai-completions",
        pricing: { input: 0.25, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 163840,
        supportsTools: true,
        thinkingLevels: [],
        openRouterRouting: { allow_fallbacks: false, only: ["deepinfra"], quantizations: ["fp8"] },
      },
    ],
  },
];
```

Pass the same array to both `createClient` and `defaultProtocols` — declaring it on the client alone fails at construction with a message explaining why.

This is declaration data on a model, not a per-request option: pinning belongs to the model entry so that two runs of one configuration are served the same way. Only `protocol: "openai-completions"` can send it, and declaring it on any other protocol throws rather than being ignored.

### Knowing which response you got

`CompleteResult` and the `done` protocol event carry `responseId` and `responseModel` when the provider reports them. Against an aggregator these are the only handle on what actually served a request: one model id can resolve to different upstream endpoints at different prices and quantizations per call, so a cost ledger that multiplies tokens by the catalog rate is approximate, and `responseId` is what lets you reconcile it afterwards (OpenRouter resolves it through `/generation?id=`). `responseModel` appears only when the provider names a model different from the one requested, so its absence is not a statement that no remap happened.

### Constrained sampling

A `ToolDefinition` can carry an optional `constrainedSampling: { type: "json_schema"; strict: "prefer" | "require" }` to ask the provider to constrain a tool's arguments to its schema. Support is per-model, not caller-controllable — some models simply cannot honour it. `"prefer"` degrades silently to an unconstrained tool when the model lacks support, so a well-formed response is not evidence the constraint was applied; `"require"` throws instead of degrading.

`ResolvedModel.supportsStrictToolSampling === true` identifies a model whose catalog explicitly declares strict JSON Schema tool-argument sampling support; an absent value means nax-ai has no declaration and is not a statement about pi-ai's runtime defaults. This capability constrains arguments only when a tool is called: it does not require a tool call and does not provide structured completion output.

Do not filter models on an absent value. Whether an undeclared model behaves as supported is a property of the protocol, and pi-ai 0.85.1 defaults the two opposite ways: `anthropic-messages` treats an undeclared model as unsupported, while `openai-completions` falls back to endpoint detection that accepts most endpoints. Skipping every model without a declaration is therefore correct for the former and needlessly discards working models for the latter, where a `strict: "require"` call against an undeclared model succeeds whenever pi-ai's detection accepts the endpoint. Only `true` is a positive statement; the field records what the catalog declared, not what a request will do.

### Logging in

`login()` obtains a credential and writes it to the store you pass. It covers
both api-key entry and OAuth, choosing between them when a provider offers
both, and returns metadata rather than the credential — the store already has
it.

```ts
import { createFileCredentialStore, login } from "@nathapp/nax-ai";

const credentials = createFileCredentialStore({ path: `${homedir()}/.nax/credentials` });

const result = await login({
  providerId: "openrouter",
  credentials,
  interaction: {
    prompt: async (prompt) => ask(prompt.message),  // your UI
    notify: (event) => render(event),
  },
});
// result: { providerId: "openrouter", method: "oauth", kind: "oauth" }
```

Permitted OAuth flows are `openai-codex` and `openrouter`; see
`PERMITTED_OAUTH_FLOWS`. A provider outside that list keeps its api-key login.

There is no `logout`: removing a credential is `credentials.delete(providerId)`.
Note that nothing is revoked upstream — the provider-side token stays valid
until it expires, so a UI should say the credential was removed locally rather
than that the user was logged out.

## Scope

This package speaks a generic LLM vocabulary — models, messages, tool calls, usage, credentials. It knows nothing about any consumer's domain concepts, and that direction is one-way by design: consumers map onto their own types at their own boundary.

That constraint is what lets the implementation underneath this surface be replaced, provider by provider, without consumers noticing. It is also why domain-specific abstractions do not belong here, however convenient they would be for the first consumer.

## Requirements

- **Node >= 22.19** — the compatibility target. Runs unmodified on Bun and Deno.
- ESM only. There is no CommonJS build.

The package must not use runtime-specific APIs. `Bun.*` and `bun:` imports are rejected by a build gate (`scripts/check-no-bun-apis.ts`) because the primary consumer runs on Bun, so nothing would fail there — the breakage would surface only for someone else, on install.

## OAuth policy

OAuth flows are governed by an explicit allowlist in `src/auth/oauth-policy.ts`, enforced by tests rather than convention.

**Anthropic subscription OAuth is prohibited and must never be added.** Using Pro/Max tokens outside the official Claude CLI is server-blocked and a Consumer ToS violation. This is not a broken path awaiting repair — route Claude subscription traffic through the official CLI instead.

The underlying client bundles Anthropic's flow beside permitted ones behind a shared lazy loader, which is precisely why the prohibition is a gate: "we simply won't call it" is not enforceable, and the environment that would notice the mistake is not the one running the tests.

## Development

```bash
bun install
bun run test         # vitest
bun run typecheck    # tsc --noEmit
bun run lint         # biome + no-bun-apis gate
bun run build        # tsc -p tsconfig.build.json → dist/
```

**Vitest does not type-check.** It transpiles via esbuild, which strips types without verifying them, so a green suite proves nothing about compilation. `test` and `typecheck` cover disjoint ground and CI runs both.

Tests run on Node (the compatibility target) and the built package is smoke-tested on Bun (the primary consumer's runtime). Testing only on Bun would hide exactly the class of breakage the Node target exists to prevent.

## Licence

MIT
