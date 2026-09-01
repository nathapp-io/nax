# ADR-027: Adapter-Protocol Split for the Native LLM Path

**Status:** Proposed
**Date:** 2026-09-01
**Author:** William Khoo, Claude
**Builds on:** ADR-025 (Agent Routing and Cross-Agent Escalation), ADR-012 (Agent Manager Ownership)
**Related:** [Nax Native LLM Harness](https://claude.ai/code/artifact/3f52e26b-9614-411f-ba38-31dd6393f804) (feasibility analysis, the "why"), `@nathapp/nax-ai@0.1.1`, #374 (scoped permissions, blocked on Phase C)
**Implementation:** none yet — this ADR is the first concrete step the feasibility analysis names.

---

## Context

Every LLM call nax makes today goes through one transport: an acpx subprocess
speaking ACP. `src/agents/registry.ts:36` hard-codes `new AcpAgentAdapter(name)`
for each of `KNOWN_AGENT_NAMES`, and `AgentConfigSchema.protocol` is
`z.literal("acp")` — a one-value enum, which is to say a reserved extension
point nobody has yet extended.

`@nathapp/nax-ai` now exists and is published (`0.1.1`, `latest`). It offers
`client.complete(model, req)` over a provider-agnostic protocol layer, with
exact usage, pricing rates for ~1290 models, structured tool calls, and a
credential store. Phase A of the feasibility analysis is to route nax's
one-shot completion ops through it.

The analysis names the first step precisely:

> file a nax issue/ADR for the adapter-protocol split (registry discriminated
> union, `src/agents/native/` layout, wire-isolation gate)

and it names what must change:

> `src/agents/registry.ts:36` hard-codes `new AcpAgentAdapter(name)` and
> `protocol` is the literal type `"acp"` — becomes a per-agent discriminated
> selection.

**Per-agent** is the load-bearing word. It rules out a global
`agent.protocol: "native"` switch, and it means no separate "hybrid" mode is
needed: with per-agent selection, `claude → acp` coexisting with
`minimax → native` *is* the hybrid case. The analysis relies on that
coexistence — "keeping acpx entries for opencode/pi preserves A/B ability
during migration."

### What the analysis deliberately left open

> Agent names map to adapters: `claude → acp`, new native provider-agents
> (**e.g. `native:minimax` or reuse of `ModelDef.provider`**) → native.

That "or" is the one open decision. This ADR closes it.

### Two facts that constrain the answer

**`ModelDef.provider` exists but is dead.** `ModelDef` is
`{provider, model, pricing?, env?}` (`src/config/schema-types.ts:20`). Repo-wide,
the only reads of `.provider` are in `src/config/validate.ts:56` checking it is
non-empty. Nothing consumes it.

**It is dead because acpx never needed it.** Under ACP the model string is
opaque — nax passes `--model` through and the *agent* resolves the provider.
That is why the live config smuggles the provider into the model string:

```json
"claude":   { "fast": "haiku" },
"opencode": { "fast": "minimax/MiniMax-M2.7" },
"pi":       { "fast": "huggingface/MiniMaxAI/MiniMax-M2.7" }
```

Native cannot do this. `client.model(provider, model)` takes the two as
separate arguments and resolves the wire protocol from the catalog. So
`agent` and `provider` are genuinely different axes, and ACP let nax conflate
them by doing the resolving on nax's behalf.

## Decision

### 1. Native providers are agent names: `native:<provider>`

An agent named `native:<provider>` routes to the native adapter, where
`<provider>` is a nax-ai provider id. Everything else routes to acpx, exactly
as today.

```json
{
  "agent": { "default": "claude" },
  "models": {
    "claude":              { "fast": "haiku" },
    "native:opencode-go":  { "fast": "deepseek-v4-flash" }
  }
}
```

Note what disappears: the slash-encoded provider prefix. With the provider in
the agent name, the model string is just a model.

**The reason is ADR-025, not aesthetics.** ADR-025 built agent selection,
cross-agent escalation and profile-based routing entirely on *agent names*:
PRD `routing.agent`, `agent.fallback.map`, the escalation ladder, profiles, and
`config.models` keying. If native providers are agent names, all of that
machinery works on them **unchanged** — a native provider can be a fallback
target for an acpx agent and vice versa, and cross-engine escalation costs
nothing to build. If native selection were instead expressed through
`ModelDef.provider`, the agent axis would stay acpx-only, ADR-025's routing
would not see the native path at all, and cross-engine escalation would need
new machinery to reach it.

Two ADR-025 rules also land correctly with no amendment:

- **"Never invent an agent."** An unknown `native:*` name degrades to the
  default agent with a warning, like any other unknown agent. No new
  validation path.
- **The availability seam.** A native agent whose credentials do not resolve is
  *unavailable*, and `resolveExecutionAgent` already degrades unavailable
  agents to the default with a warning. This gives `isInstalled()` an honest
  meaning for an adapter with no binary: credentials resolve.

### 2. The registry becomes a discriminated selection

`buildAdapterList()` and `createAgentRegistry()` map a name to an adapter kind
rather than assuming one:

```ts
function adapterFor(name: string): AgentAdapter {
  const provider = nativeProviderOf(name);        // "native:x" -> "x", else undefined
  return provider === undefined
    ? new AcpAgentAdapter(name)
    : new NativeAgentAdapter(provider);
}
```

`AgentConfigSchema.protocol` stays `z.literal("acp")` and keeps meaning what it
means today: the protocol for *acpx* agents. It is not the native switch. The
discriminator is the agent name, which is what ADR-025's routing already
carries end to end. (`_registryTestAdapters` already proves this injection
shape.)

### 3. `src/agents/native/` layout and the wire-isolation gate

Six files, sized against `SRC_LIMIT = 600`:

| File | Purpose |
|---|---|
| `adapter.ts` | `NativeAgentAdapter implements AgentAdapter` |
| `client.ts` | builds and holds the nax-ai `Client` |
| `models.ts` | `ModelDef` → nax-ai `ResolvedModel`; cost from rates |
| `errors.ts` | `ProtocolError.kind` → `AdapterFailure` |
| `credentials.ts` | the `~/.nax/credentials` store |
| `index.ts` | the only surface `registry.ts` imports |

**Gate:** mirror `scripts/check-adapter-no-config-import.sh` for this directory, so
`@nathapp/nax-ai` is importable *only* from `src/agents/native/`. This is the
same shape as nax-ai's own `check-pi-ai-imports`, and for the same reason: a
wire dependency that leaks past its boundary stops being replaceable.

**`src/agents/acp/adapter.ts` is at 593/600 and must not be touched.** The
native path adds no lines to it; the discrimination lives in `registry.ts`.

### 4. Decisions already settled for Phase A

Recorded here so the implementation plan does not relitigate them:

- **Credentials:** `createFileCredentialStore` at `~/.nax/credentials`.
  Resolution order is store → ambient env → fail, so CI needs no store.
- **Credential entry:** `nax auth login <provider>` (API key, prompted, never
  echoed or logged), `nax auth import` (from `~/.pi/agent/auth.json`, which
  brings an existing `openai-codex` OAuth credential across), `nax auth list`
  (provider names only), `nax auth rm`. No OAuth *flow* is built: nax-ai scoped
  login flows out of M2, and Anthropic subscription OAuth is prohibited outright
  (`PROHIBITED_OAUTH_FLOWS`) — Claude subscription traffic stays on acpx
  permanently, by ToS, not by preference.
- **Cost:** `modelDef.pricing ?? client.pricing(model)`. A model with no rate
  throws at resolution rather than reporting `$0`. `src/agents/cost/pricing.ts`
  is untouched and keeps serving the acpx path.
- **Interface fit:** `NativeAgentAdapter` implements all of `AgentAdapter`.
  `binary` is `""`, `buildCommand()` returns `[]` for dry-run display,
  `isInstalled()` reports whether credentials resolve, and
  `openSession`/`sendTurn`/`closeSession` throw `NativeSessionUnsupportedError`
  until Phase B. `onPidSpawned`/`onPidExited` are never called — there is no
  process. `timeoutMs` becomes an `AbortSignal`, which its own doc comment
  already promises adapters do.

### 5. Error mapping is typed, not parsed

`classifyCompleteException` currently routes through `parseAgentError`, which
parses ACP error *strings*. nax-ai returns a typed `ProtocolError.kind`, so the
native path maps directly:

| `ProtocolError.kind` | `AdapterFailure` |
|---|---|
| `rate-limit` | `availability` / `fail-rate-limit` (carries `retryAfter`) |
| `auth` | `availability` / `fail-auth` |
| `overloaded` | `availability` / `fail-service-down` |
| `transport` | `availability` / `fail-service-down` — nax-ai already retried it before the first event |
| `bad-request` | `quality` / `fail-adapter-error` — our request is wrong; swapping agents will not help |
| `unknown` | `quality` / `fail-unknown` |

Four of six are `availability`, which is what makes `shouldSwap`'s fallback
branch reachable. The classifier's own history is the warning here: a blanket
`quality / fail-unknown` once made every transient failure terminal for exactly
these complete-kind ops.

## Consequences

### Positive

- Native and acpx coexist per-agent, so every op can be A/B'd against its
  current behaviour before any default changes.
- ADR-025's routing, profiles, fallback map and escalation ladder work on
  native providers with no amendment.
- `ModelDef.provider` stops being dead config: under native the provider is the
  agent name, and the slash-encoding hack is no longer needed for new entries.
- Exact usage and pricing for ~1290 models, versus a hand-maintained rate card
  (`RATE_CARD_REVIEWED = "2026-08-30"`).
- One fewer process spawn per classification call.

### Negative

- `native:` is a naming convention enforced by a parser, not by the type system.
  A typo like `nativ:minimax` becomes an unknown agent — it degrades with a
  warning rather than failing loudly. Acceptable because ADR-025 already made
  that the defined behaviour for every unknown agent.
- Two adapter code paths coexist indefinitely. acpx is permanent for Claude, so
  this is the end state, not a migration window.
- An `AgentAdapter` whose session methods throw. Honest, but the interface now
  describes a shape not all implementers satisfy. Splitting
  `CompletionAdapter` from `SessionAdapter` is the right end state; it is
  deferred to Phase B, when the real boundary is known rather than guessed.
- A native agent's credential check is a network-free local probe, so
  `isInstalled()` can report available for a provider whose key is revoked.
  That surfaces as `fail-auth` at call time and falls back through ADR-025's
  availability path.

### Neutral

- `agent.protocol` stays `z.literal("acp")`. A future third transport may
  widen it; the native path does not need it widened.
- Phase A covers 7 ops, not the 9 the feasibility analysis states — the count
  drifted after it was written. `kind: "complete"` today is `acceptance-refine`,
  `classify-route`, `decompose`, and four debate ops (`propose`, `rebut`,
  `judge`, `synthesis`). The 25 `kind: "run"` ops are Phase B.
- `scripts/generate-changelog.ts`'s hand-rolled `fetch` is in Phase A scope per
  the analysis, and is the one native call outside the adapter.

## Alternatives Considered

### A. Reuse `ModelDef.provider` as the native discriminator

`models: { minimax: { fast: { provider: "opencode-go", model: "deepseek-v4-flash" } } }`,
with the presence of a resolvable provider selecting the native path.

Rejected. It revives a field that already exists and requires no new naming
convention, which is genuinely attractive — but it puts the native/acpx
discriminator on the *model* while ADR-025 puts every routing decision on the
*agent*. Cross-agent escalation, profiles and `agent.fallback.map` would not
see the native path, so cross-engine fallback (`claude` → a native provider)
would need machinery that the naming approach gets for free. It also makes the
discriminator implicit: nothing distinguishes "provider set because this is
native" from "provider set and ignored", which is what the field means today.

### B. A per-model `protocol` field

`{ protocol: "native", agent: "opencode-go", model: "deepseek-v4-flash" }`.

Rejected. Explicit per entry, but `agent` would carry a provider id under
`native` and an agent name under `acp` — one field meaning two things depending
on a sibling field. It also contradicts the analysis's "per-agent discriminated
selection" directly, and adds a third routing axis where ADR-025 has one.

### C. Global `agent.protocol: "acp" | "native" | "hybrid"`

Rejected. `hybrid` is not a real third mode — it is what per-agent selection
already produces — and a global switch cannot express `claude` on acpx while
`minimax` is native, which is the configuration the analysis requires for A/B
during migration.

### D. A single `native` agent, provider carried per model

One `native` entry in `KNOWN_AGENT_NAMES`, provider read from `ModelDef`.

Rejected for the same reason as A, plus one: `agent.fallback.map` could then
only name `native` as a whole, so a fallback could not move from one native
provider to another.

## Open Questions

1. **Does `nax auth` belong in this ADR's scope or its own?** It is a new CLI
   surface with its own UX, and nothing else in Phase A depends on its shape —
   only on the store existing.
2. **Should `native:` be a prefix or a separator convention** that a future
   transport can reuse (`acp:claude` becoming explicit)? Introducing the
   explicit form for acpx too would be a breaking config change and is not
   proposed here.
3. **Does `capabilities.maxContextTokens` come from the catalog per provider?**
   nax-ai's `ResolvedModel` carries context limits, but `AgentCapabilities` is
   per-adapter, not per-model. Phase A can hardcode a conservative value; the
   right answer probably makes capabilities model-derived, which is a wider
   change.

## Implementation

Not started. This ADR precedes the spec. On acceptance the next artifacts are a
spec under `.nax/specs/` and an implementation plan, covering in order:

1. Registry discriminated selection + `nativeProviderOf` parsing, with the
   existing 86 test files under `test/**/agents/**` staying green.
2. `src/agents/native/` skeleton + the wire-isolation gate (the gate lands with
   the directory, not after it).
3. `ModelDef` → `ResolvedModel` resolution and cost mapping.
4. Typed error mapping, with a test per `ProtocolError.kind`.
5. The credential store and `nax auth`.
6. One op migrated end to end (`classify-route` is the smallest), A/B'd against
   acpx before any default moves.

The docs change lands in **`.nax/context.md`**, never `CLAUDE.md` — the latter is
generated by `nax generate` and says so at the top. Its "Single protocol: ACP …
the registry hard-codes it" paragraph and the `src/agents/` directory table are
both stated as fact today and stop being true when step 1 lands. `.nax/rules/adapter-wiring.md`
is path-scoped to `src/agents/**` and will need the native path described in it;
`bun run check:rules-drift` fails if the generated copies are not regenerated.
