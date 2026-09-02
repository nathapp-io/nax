# ADR-027: Adapter-Protocol Split for the Native LLM Path

**Status:** Proposed
**Date:** 2026-09-01
**Author:** William Khoo, Claude
**Builds on:** ADR-025 (Agent Routing and Cross-Agent Escalation), ADR-012 (Agent Manager Ownership)
**Amends:** the AgentManager fallback map from ADR-012 / ADR-013 (§6), and ADR-025 §4's profile↔rung binding (§7)
**Related:** [Nax Native LLM Harness](https://claude.ai/code/artifact/3f52e26b-9614-411f-ba38-31dd6393f804) (feasibility analysis, the "why"), `@nathapp/nax-ai@0.1.1`, #374 (scoped permissions, blocked on Phase C)
**Implementation:** none yet — this ADR is the first concrete step the feasibility analysis names.

---

## Context

Every LLM call nax makes today goes through one transport: an acpx subprocess
speaking ACP. `src/agents/registry.ts:36` hard-codes `new AcpAgentAdapter(name)`
for each of `KNOWN_AGENT_NAMES`, and `AgentConfigSchema.protocol`
(`src/config/schemas-infra.ts:282`) is `z.literal("acp")` — a one-value enum,
which is to say a reserved extension point nobody has yet extended.

`@nathapp/nax-ai` now exists and is published (`0.1.1`, `latest`). It offers
`client.complete(model, req)` over a provider-agnostic protocol layer, with
exact usage, pricing rates for ~1290 models, structured tool calls, and a
credential store. Phase A of the feasibility analysis routes nax's one-shot
completion ops through it.

The analysis names the first step precisely:

> file a nax issue/ADR for the adapter-protocol split (registry discriminated
> union, `src/agents/native/` layout, wire-isolation gate)

and what must change:

> `src/agents/registry.ts:36` hard-codes `new AcpAgentAdapter(name)` and
> `protocol` is the literal type `"acp"` — becomes a per-agent discriminated
> selection.

**Per-agent** is load-bearing. The registry discriminates by agent, so
`claude → acp` coexisting with `native → nax-ai` needs no third routing axis.
The analysis depends on that coexistence: *"keeping acpx entries for
opencode/pi preserves A/B ability during migration."*

### The one thing the analysis left open

> Agent names map to adapters: `claude → acp`, new native provider-agents
> (**e.g. `native:minimax` or reuse of `ModelDef.provider`**) → native.

This ADR closes it, and rejects both sketched options in favour of a third the
analysis did not consider: **one `native` agent, with the provider carried in
the model string** — the encoding the config already uses.

### Why the model string already carries a provider

`ModelDef` is `{provider, model, pricing?, env?}` (`src/config/schema-types.ts:20`).
Repo-wide, the only reads of `.provider` are in `src/config/validate.ts:56`
checking it is non-empty. Nothing consumes it.

It is unused because **acpx never needed it**. Under ACP the model string is
opaque: nax passes `--model` through and the *agent* resolves it. And because
opencode is itself multi-provider, the provider has to travel with the model —
so the live config already encodes it in the string:

```json
"claude":   { "fast": "haiku" },
"opencode": { "fast": "minimax/MiniMax-M2.7" },
"pi":       { "fast": "huggingface/MiniMaxAI/MiniMax-M2.7" }
```

That is not a hack to be reused. It is the same requirement: a multi-provider
agent needs the provider in the model reference. Native is multi-provider for
exactly the reason opencode is, so it uses exactly the same encoding.

## Decision

### 1. Native is one agent; the provider travels in the model string

```json
{
  "agent": { "protocol": "hybrid", "default": "claude" },
  "models": {
    "claude": { "fast": "haiku" },
    "native": {
      "cheap":  "opencode-go/deepseek-v4-flash",
      "mid":    "openai/gpt-5.4-mini",
      "strong": "anthropic/claude-sonnet-5"
    }
  }
}
```

`native` is a single entry in `KNOWN_AGENT_NAMES`. Under it, a model string is
parsed as `<provider>/<model>`, split on the **first** `/` — which handles
`huggingface/MiniMaxAI/MiniMax-M2.7` correctly, as the existing config already
requires. Under any acpx agent the string stays opaque and is passed through
unchanged, as today.

A native model string with **no `/` is a config error**, naming the remedy. There
is no default provider to fall back on (Open Question 2), and silently treating
a bare model id as a provider would fail later and further away.

`anthropic/claude-sonnet-5` under `native` and `claude` under acpx are the same
vendor on **two different billing paths** — API key versus subscription. Keeping
them distinct entries makes that visible in config rather than inferred.

### 2. `agent.protocol` becomes a capability gate, not a router

```ts
protocol: z.enum(["acp", "native", "hybrid"]).default("acp")
```

The agent name routes; `protocol` decides what is *permitted*:

| value | meaning |
|---|---|
| `acp` (default) | a `native` entry in `models` is a **config error** |
| `hybrid` | both engines allowed |
| `native` | acpx entries rejected — for an install with no subscription CLI |

Under `native`, `agent.default` must name `native` — the schema default is
`"claude"`, so an install choosing `native` without changing it would default to
a rejected agent. Validation says so rather than leaving it to fail at run time.

It is a gate rather than a router because the two would be redundant, and
because native calls hit a **different billing path**: reaching it should be an
explicit opt-in, not the consequence of a typo in `models`. Defaulting to `acp`
means no existing config changes behaviour.

### 3. The registry becomes a discriminated selection

```ts
function adapterFor(name: string): AgentAdapter {
  return name === NATIVE_AGENT ? new NativeAgentAdapter() : new AcpAgentAdapter(name);
}
```

`_registryTestAdapters` already proves this injection shape.

**One wrinkle to resolve deliberately rather than discover:** `createAgentRegistry`
takes config (`registry.ts:96`), but `buildAdapterList` and the two module-level
functions above it (`getAllAgents`, `getInstalledAgents`) are **config-less by
design** — so they cannot consult `protocol`. `native` therefore appears in those
listings whatever the gate says, and its `isInstalled()` answers about
credentials, not about permission. The gate bites where config is available: at
`createAgentRegistry` and at config validation. Consequence: `nax agents` and the
multi-agent-health precheck may list `native` under `protocol: "acp"`. Threading
config into those two functions would fix it and is a wider change than this ADR;
see Open Question 4. (`registry.ts:100` also logs a hard-coded
`"Agent protocol: acp"`, which becomes a lie at step 1 and should log the
resolved value.)

Two ADR-025 rules land with no amendment:

- **"Never invent an agent."** `native` is a known agent name; an unknown one
  still degrades to the default with a warning.
- **The availability seam.** At call time, a native call with no resolvable
  credentials fails with a typed `auth` error, mapped by §9 to
  `availability / fail-auth`, and `resolveExecutionAgent` already degrades
  unavailable agents to the default with a warning. Phase A's `isInstalled()`
  must not be read as the seam's trigger, though: the probe is client
  construction, not credential resolution — nax-ai resolves credentials at call
  time inside the protocol backend, so a machine without keys still reports
  `native` installed. The availability seam fires from `fail-auth` at request
  time, and a real credential probe arrives with plan 2 (the
  `~/.nax/credentials` store / `nax auth`); the construction probe is all
  `isInstalled()` can honestly answer until then.

### 4. `src/agents/native/` layout and the wire-isolation gate

Six files, sized against `SRC_LIMIT = 600`:

| File | Purpose |
|---|---|
| `adapter.ts` | `NativeAgentAdapter implements AgentAdapter` |
| `client.ts` | builds and holds the nax-ai `Client` |
| `models.ts` | parse `<provider>/<model>`; resolve; cost from rates |
| `errors.ts` | `ProtocolError.kind` → `AdapterFailure` |
| `credentials.ts` | the `~/.nax/credentials` store |
| `index.ts` | the only surface `registry.ts` imports |

**Gate:** mirror `scripts/check-adapter-no-config-import.sh` for this directory
so `@nathapp/nax-ai` is importable *only* from `src/agents/native/`. Same shape
as nax-ai's own `check-pi-ai-imports`, same reason: a wire dependency that leaks
past its boundary stops being replaceable.

**`src/agents/acp/adapter.ts` is at 593/600 and must not be touched.** The
discrimination lives in `registry.ts`.

### 5. Tiers are already open-ended — recorded, because it looks like a limit and is not

`fast` / `balanced` / `powerful` read like a closed three-value enum. They are
not, and native needs no schema change to carry five models or fifty:

- `ModelTier = "fast" | "balanced" | "powerful" | (string & {})`
  (`src/config/schema-types.ts:13`) — the three are autocomplete hints.
- `ModelTierSchema = z.string().min(1)` (`src/config/schemas-model.ts:41`).
- `PerAgentModelMapSchema = z.record(z.string().min(1), z.record(z.string().min(1), ModelEntrySchema))`
  (`src/config/schemas-model.ts:33`) — **tier keys are arbitrary non-empty
  strings**, per agent.
- `MODEL_SHORTHAND_TIERS` and `isBuiltinModelTier` (`schema-types.ts:66,72`)
  special-case the three for *shorthand convenience* only.

**`tierOrder` is the ranking SSOT** (ADR-025 §4), and its rungs are
agent-qualified: `TierConfig` is `{tier, attempts, agent?}`
(`schema-types.ts:55`), the array is `z.array(TierConfigSchema).min(1)`
(`src/config/schemas-execution.ts:19`), and `NaxConfigSchema.superRefine`
(`src/config/schemas.ts:500-508`) already requires each rung's agent to exist in
`config.models`.

So a five-rung native ladder that also crosses into acpx is expressible today,
with no change to this ADR's account of it:

```json
"tierOrder": [
  { "agent": "native", "tier": "cheap",    "attempts": 2 },
  { "agent": "native", "tier": "mid",      "attempts": 2 },
  { "agent": "native", "tier": "strong",   "attempts": 1 },
  { "agent": "claude", "tier": "balanced", "attempts": 1 }
]
```

**Consequence: no tier schema change is needed, and none is proposed.** What is
needed is §7.

### 6. Amendment to ADR-025: fallback targets may name a tier

`agent.fallback.map` is `z.record(z.string().min(1), z.array(z.string().min(1)))`
(`src/config/schemas-infra.ts:207`) — agent names only. With one `native` agent
that makes "deepseek is down, try anthropic, still native" inexpressible: the
whole native path is a single fallback node.

Map values additionally accept an `(agent, tier)` target, the shape `tierOrder`
rungs already use:

```json
"map": { "native": [{ "agent": "native", "tier": "strong" }, "claude"] }
```

Plain strings keep working and keep meaning "that agent, same tier". This adds
no concept — it applies `tierOrder`'s existing agent-qualification to the one
other place that names a fallback target. Validation mirrors the `tierOrder`
`superRefine`: a named `(agent, tier)` must exist in `config.models`.

This is a widening, not a behaviour change: no existing config's meaning moves.

### 7. Amendment to ADR-025: custom tiers lose their attribution

`resolveConfiguredModel` (`src/config/schema-types.ts:85-119`) has two paths, and
only one of them is broken. A **string** selection already returns
`modelTier: selection` for any tier name, builtin or not. The **object** form
`{agent, model}` branches on `isBuiltinModelTier`, and a non-builtin tier there
falls through to `resolveModel(selection.model)` and returns **no `modelTier`**.

The object form is exactly the shape ADR-025 profiles use for `target`, so this
is the profile path specifically — fixing the string branch would be fixing the
half that works.

Today that is nearly harmless — custom tiers are exotic. Under §5 they become
ordinary, and the loss matters twice: `modelTier` is recorded on cost rows for
attribution (#1433), and ADR-025 §4 binds a profile to a ladder rung by its
`target.(agent, tier)`. A profile targeting `native`/`strong` would resolve
without a tier and could not bind.

`resolveConfiguredModel` must carry `modelTier` for any tier present in
`models[agent]`, builtin or not. `isBuiltinModelTier` stays what it is — a
shorthand test — and stops gating attribution.
**Implemented by plan C** with two refinements: membership is fallback-inclusive
(`models[agent]`, else `models[defaultAgent]`), and a non-tier object-form string resolves as a
literal pin (warned when unrecognizable) rather than throwing.

### 8. Decisions already settled for Phase A

Recorded so the implementation plan does not relitigate them:

- **Credentials:** `createFileCredentialStore` at `~/.nax/credentials`.
  Resolution order is store → ambient env → fail, so CI needs no store.
- **Credential entry:** `nax auth login <provider>` (prompted, never echoed or
  logged), `nax auth import` (from `~/.pi/agent/auth.json`, which brings an
  existing `openai-codex` OAuth credential across), `nax auth list` (provider
  names, kinds, and OAuth expiry status — never key material), `nax auth rm`.

  **Amended 2026-09-01: OAuth login is in scope.** This bullet previously read
  "No OAuth *flow* is built", on the grounds that nax-ai had scoped login out of
  M2 and that Anthropic subscription OAuth is prohibited outright. The first
  ground has expired: nax-ai M5 (PR #16) shipped `login()`, covering API-key
  entry and OAuth behind a per-method policy gate. The second never supported
  the conclusion it was attached to — what keeps Anthropic subscription traffic
  off the native path is `PROHIBITED_OAUTH_FLOWS` being enforced *per method*,
  not the absence of a flow runner. Claude subscription traffic still stays on
  acpx permanently, by ToS, not by preference; `anthropic` simply offers its
  API-key method and never its OAuth one.

  Building the flow in nax-ai rather than nax is what makes this safe: reaching
  pi-ai's flows from nax directly would mean a direct dependency on a transitive
  package, and one call away from the prohibited Anthropic flow with no
  allowlist in front of it.

  The design is `docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md`.
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

### 9. Error mapping is typed, not parsed

`classifyCompleteException` routes through `parseAgentError`, which parses ACP
error *strings*. nax-ai returns a typed `ProtocolError.kind`, so the native path
maps directly:

| `ProtocolError.kind` | `AdapterFailure` |
|---|---|
| `rate-limit` | `availability` / `fail-rate-limit` (carries `retryAfter`) |
| `auth` | `availability` / `fail-auth` |
| `overloaded` | `availability` / `fail-service-down` |
| `transport` | `availability` / `fail-service-down` — nax-ai already retried before the first event |
| `bad-request` | `quality` / `fail-adapter-error` — our request is wrong; swapping agents will not help |
| `unknown` | `quality` / `fail-unknown` |

Four of six are `availability`, which is what makes `shouldSwap`'s fallback
branch reachable. The classifier's own history is the warning: a blanket
`quality / fail-unknown` once made every transient failure terminal for exactly
these complete-kind ops.

### 10. Not in scope: sessions and multi-turn — and what that will cost

`openSession`/`sendTurn`/`closeSession` throw until Phase B (§8). This ADR
deliberately does not design them, because the shape of a session boundary
depends on what runs across it, and Phase A has no multi-turn op to learn from.
Deciding it here is the guess §Negative already says to avoid.

What is worth recording now, because it is easy to under-read as a mapping
exercise:

**nax has never stored a transcript.** `SessionDescriptor`
(`src/session/types.ts:65`) carries id, role, state, agent, workdir,
`protocolIds`, `handle`, scratch dir, completed stages and timestamps — and no
message, history or transcript field of any kind. `handle` is documented as the
string "used by the adapter to resume the physical ACP session", and
`OpenSessionOpts.resume` (`src/agents/session-types.ts:77`) means "reattach to
that session". Conversation state lives in the acpx subprocess, not in nax.

nax-ai's client is **stateless**: `complete(model, req)` takes the whole
`ConversationMessage[]` every call. So against the native path nax must persist
and replay conversations itself, and `openSession`/`closeSession` become either
no-ops or transcript-file handles rather than calls to a backend that remembers.

That makes Phase B a **storage feature** — persistence format, resume semantics,
the mapping between a nax session id and a stored transcript, and retention —
sitting alongside the tool-loop work the analysis describes. Nothing in this ADR
forecloses it: `AgentAdapter` is unchanged, `SessionDescriptor` is untouched, and
the `CompletionAdapter`/`SessionAdapter` split stays available once the boundary
is real. It is called out so Phase B is scoped from this, not from the
assumption that sessions are a thin mapping over `complete()`.

## Consequences

### Positive

- One new agent name and no new model syntax. The provider encoding is the one
  the config already uses, for the same reason it already uses it.
- **Cross-provider tier ladders in one agent**: `cheap` on a budget provider,
  `strong` on a premium one, climbing through the existing escalation ladder
  rather than requiring an agent swap.
- Native and acpx coexist per-agent, so every op can be A/B'd against current
  behaviour before any default changes.
- API-key Anthropic and subscription Claude are distinct config entries, so the
  billing path is visible rather than inferred.
- `protocol` defaults to `acp`, so no existing config changes behaviour and the
  API path cannot be reached by accident.
- Exact usage and pricing for ~1290 models, versus a hand-maintained rate card
  (`RATE_CARD_REVIEWED = "2026-08-30"`).

### Negative

- `native` is named as an agent but is a transport. `claude` and `opencode` name
  a CLI; `native` names its absence. Accepted: the alternative is a second
  routing axis, which §2 rejects.
- The model string means two different things depending on the agent — opaque
  under acpx, parsed under native. Mitigated by the parse living in one place
  (`native/models.ts`) and by the encoding being identical in both.
- Two adapter code paths coexist indefinitely. acpx is permanent for Claude, so
  this is the end state, not a migration window.
- An `AgentAdapter` whose session methods throw. Splitting `CompletionAdapter`
  from `SessionAdapter` is the right end state; deferred to Phase B, when the
  boundary is known rather than guessed (§10).
- Two ADR-025 amendments (§6, §7) that are not native-specific. They are
  consequences of native making custom tiers ordinary, and this ADR is not
  implementable without them.

### Neutral

- Phase A covers 7 ops, not the 9 the analysis states — the count drifted after
  it was written. `kind: "complete"` today is `acceptance-refine`,
  `classify-route`, `decompose`, and four debate ops (`propose`, `rebut`,
  `judge`, `synthesis`). The 25 `kind: "run"` ops are Phase B.
  `adapter.complete()` has exactly one caller, `src/agents/manager.ts:492`.
- `scripts/generate-changelog.ts`'s hand-rolled `fetch` is in Phase A scope per
  the analysis, and is the one native call outside the adapter.

## Alternatives Considered

### A. `native:<provider>` agent names

`native:opencode-go`, `native:anthropic`, one agent per provider, provider in
the agent name.

Rejected. It reads well against ADR-025 — each provider becomes a first-class
routing node, so `agent.fallback.map` addresses providers with no amendment and
§6 would be unnecessary. But it **pins each agent to one provider across all
tiers**, so a `cheap`→`strong` climb that crosses providers needs an agent swap
instead of the tier ladder, and the tier ladder is the better mechanism for it.
It also invents a second place to encode a provider while the model string
already encodes one, for the same multi-provider reason.

### B. Reuse `ModelDef.provider` (the object form)

`{ fast: { provider: "opencode-go", model: "deepseek-v4-flash" } }`, with a
resolvable provider selecting the native path.

Rejected. It revives a field that already exists, but makes the discriminator
implicit — nothing distinguishes "provider set because this is native" from
"provider set and ignored", which is what the field means today. The string form
expresses the same thing in the encoding already in use.

### C. A per-model `protocol` field

`{ protocol: "native", agent: "opencode-go", model: "deepseek-v4-flash" }`.

Rejected. `agent` would carry a provider id under `native` and an agent name
under `acp` — one field meaning two things depending on a sibling. It also adds
a third routing axis where the registry already discriminates per agent.

### D. `protocol` as the router rather than a gate

Rejected. A global switch cannot express `claude` on acpx while `native` is
live, which is the configuration the analysis requires for A/B during migration.
As a gate (§2) the same field is useful without being a second router.

## Open Questions

1. ~~**Does `nax auth` belong in this ADR or its own?**~~ **Closed
   2026-09-01: it stays here.** The credential decisions are §8's and the
   reversal above belongs beside them; a second ADR would split one story across
   two documents that then drift. The command UX itself is spec-level detail,
   not an architectural decision, and lives in
   `docs/superpowers/specs/2026-09-01-nax-auth-credentials-design.md`.
2. **Should a native model string be allowed to omit the provider**, falling
   back to a configured default provider? Convenient for single-provider users,
   and ambiguous the moment a model id contains no slash by accident. Not
   proposed.
3. **Does `capabilities.maxContextTokens` become model-derived?** nax-ai's
   `ResolvedModel` carries context limits, but `AgentCapabilities` is
   per-adapter. Phase A can hardcode a conservative value; the right answer
   probably makes capabilities model-derived, which is wider than this ADR.
4. **Should `getAllAgents` / `getInstalledAgents` take config** so agent listings
   reflect the `protocol` gate (§3)? It would change two config-less signatures
   and their call sites in `src/cli/agents.ts` and the multi-agent-health
   precheck. Deferred because listing an agent that resolution would reject is
   misleading but not harmful.
5. **Should `MODEL_SHORTHAND_TIERS` gain native-shaped shorthands?** Today
   `haiku`/`sonnet`/`opus` map to the three builtin tiers, which is
   Anthropic-shaped. Cosmetic, and safe to defer.

## Implementation

Not started. This ADR precedes the spec. On acceptance the next artifacts are a
spec under `.nax/specs/` and an implementation plan, covering in order:

1. `protocol` widened to the three-value gate, defaulting to `acp`, with
   validation rejecting entries the gate forbids.
2. Registry discriminated selection, with the existing 86 test files under
   `test/**/agents/**` staying green.
3. `src/agents/native/` skeleton + the wire-isolation gate (the gate lands with
   the directory, not after it).
4. `<provider>/<model>` parsing, model resolution and cost mapping.
5. Typed error mapping, with a test per `ProtocolError.kind`.
6. §7 tier attribution fix, then §6 fallback-target widening.
7. The credential store and `nax auth`.
8. One op migrated end to end (`classify-route` is the smallest), A/B'd against
   acpx before any default moves.

The docs change lands in **`.nax/context.md`**, never `CLAUDE.md` — the latter
is generated by `nax generate` and says so at the top. Its "Single protocol: ACP
… the registry hard-codes it" paragraph and the `src/agents/` directory table
are both stated as fact today and stop being true at step 2.
`.nax/rules/adapter-wiring.md` is path-scoped to `src/agents/**` and needs the
native path described in it; `bun run check:rules-drift` fails if the generated
copies are not regenerated.
