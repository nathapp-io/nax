# Phase A plan 3 — credential probe and tier-aware fallback targets

Date: 2026-09-02
Status: design, awaiting review
Depends on: ADR-027, `2026-09-01-native-llm-adapter-phase-a-design.md`,
`2026-09-01-nax-auth-credentials-design.md` (plan 2, merged as #1790)

## 1. What this plan is, and how it differs from ADR-027 §9

ADR-027 §10 defines plan 3 as "routing amendments — §9's two changes". This
plan delivers the first of those, plus the `hasCredentials()` fix that plan 2
explicitly deferred here. **§9's second amendment moves out**, to its own plan.

| | Item | Source |
|---|---|---|
| A | `NativeAgentAdapter.hasCredentials()` answers honestly | plan 2 §6 deferral |
| B | Fallback targets may name a tier | ADR-027 §9, first amendment |
| — | `{ agent, model }` resolution unified | **moved out**, see §5 |

The move is deliberate. §9's second amendment reads as "`resolveConfiguredModel`
must stop dropping `modelTier`", which sounds like adding a missing field. It is
not. Investigation (§5) found the same string is treated as a tier in one place
and a model name in another, that the two disagree, and that the disagreement
reaches `prd.json`. That is a user-facing config contract, and it deserves a
spec of its own rather than a bullet in this one.

Nothing here depends on that work, and nothing here is blocked by it.

## 2. Item A — `hasCredentials()`

### The problem

`NativeAgentAdapter.hasCredentials()` currently reports whether the nax-ai
client *constructs*, which is effectively always true, so
`AgentManager.validateCredentials()` can never prune the native agent. The
adapter's own docstring records this as known and points here.

The reason it was deferred: answering honestly means asking whether a *specific
provider* resolves, and the method takes no provider. The registry receives the
manager's config slice, and `agentManagerConfigSelector` excludes
`config.models` by design under ADR-019.

### The asymmetry that decides the design

A false negative is catastrophic: wrongly pruning an agent that would have
worked kills the run, or silently degrades it to a fallback. A false positive is
cheap: it falls through to the request-time mapping from `ProtocolError.kind
"auth"` to availability / fail-auth, which plan 1 already built and plan 2
already tests.

Every choice below follows from that. Where the honest answer is unavailable,
return `true`.

### The design

`hasCredentials()` answers **"can this agent authenticate to at least one
provider?"** — not "is the provider this run needs satisfied?", which is the
question it has no argument for.

```
hasCredentials():
  if listStoredProviders() is non-empty -> true
  race(
    anyOf(ambientAuthAvailable(id) for every provider id in the catalog),
    timeout -> true                      // fail OPEN: never prune on a slow probe
  )
```

- **No `config.models` access**, so ADR-019's boundary is untouched and the
  method keeps its zero-argument signature.
- **Reuses plan 2's surface only** — `listStoredProviders()` and
  `ambientAuthAvailable()` are already imported in `src/agents/native/`. No new
  nax-ai API, no version bump.
- **Prunes exactly one case**: nothing stored anywhere and no ambient credential
  for any provider. That is the real failure — a user who has never run
  `nax auth login` and has no provider environment variables — and it is the
  case where every native call is going to fail anyway.
- **Wrong-provider stays a request-time error**, as today.

Measured on the current catalog: **39 providers, 2.1 ms** for a full parallel
probe, because no bundled pi provider defines `check()` and every `resolve()`
reads environment variables and credential files only.

That measurement is a snapshot, not a guarantee, which is why the timeout
exists. pi's own contract warns that `resolve()` "may execute commands"; probing
39 providers amplifies that 39×. Note the polarity: a timeout here yields
`true`. The equivalent timeout was rejected in nax-ai (review ENH-1) precisely
because there it would have produced a spurious `false` — a wrong answer. Here
expiry produces the safe answer.

### `isInstalled()` splits off

`isInstalled()` currently delegates to `hasCredentials()`. It stops doing that
and returns `true` unconditionally.

The native agent is in-process: there is no binary and nothing to install, so
"installed" is unconditionally true, and "credentialed" is the separate axis
`validateCredentials()` already owns. Two honest answers to two different
questions. `checkAgentHealth()` stops reporting "not installed" for something
that is always present, and `getInstalledAgents()` stops hiding an agent that a
credential could make usable.

This does not change which adapter `validateCredentials()` finds:
`registry.getAgent()` looks up by name and does not filter on `isInstalled()`.
The blast radius is `getInstalledAgents()` and `checkAgentHealth()` only.

### Tests

- stored credential present -> `true`, and the ambient probe is never reached
- nothing stored, one ambient provider satisfied -> `true`
- nothing stored, nothing ambient -> `false`
- the probe short-circuits: a satisfied provider resolves without waiting for
  the rest
- **a hung probe returns `true`**, driven by an injected never-settling probe.
  Prove it fails without the timeout, or the timeout is not proven to work
- `isInstalled()` is `true` when `hasCredentials()` is `false` — the split
  itself, which a delegating implementation would fail
- `AgentManager.validateCredentials()` prunes the native agent as a fallback
  candidate, and throws `AGENT_CREDENTIALS_MISSING` when it is primary

## 3. Item B — fallback targets may name a tier

### The problem

`agent.fallback.map` values are agent names only:

```ts
map: z.record(z.string().min(1), z.array(z.string().min(1)))
```

ADR-027 §9 wants values to additionally accept `{ agent, tier }` — the shape
`tierOrder` rungs already use — so one native provider can fall back to another.
Plain strings keep working.

### The seam that makes this real work

Widening the schema alone produces a feature that does nothing. Zod would accept
`{ agent, tier }`, `availableCandidates` would filter it, `nextCandidate` would
return the agent name, and **the tier would be dropped on the floor**. The
config would validate, the documentation would be true, and no swap would ever
use the tier.

`nextCandidate()` returns `string | null` and is the only path from the map to
an actual swap. So the change is a chain, not a schema edit:

1. `AgentFallbackConfigSchema.map` accepts `string | { agent, tier }`
2. `credentialCandidates` normalises to names — it only ever wanted names
3. `availableCandidates` normalises, preserving the tier on the entry it returns
4. `nextCandidate` returns `{ agent, tier? } | null`
5. The two swap sites (`manager.ts:400`, `manager.ts:561`) consume `.agent`
   everywhere they consume a name today, and carry the tier forward
6. `hop-budget.ts:45` takes `.agent`; otherwise untouched

Plain strings normalise to `{ agent, tier: undefined }` and behave exactly as
before at every step.

**The tier is applied in two different places, because the two dispatch paths
resolve their model differently.** This is the part that makes item B larger
than a schema change:

- **complete path** — `resolveHopCompleteOptions` (`manager-dispatch.ts:229`)
  already re-resolves per hop via `options.modelDefFor?.(currentAgent)`, whose
  type is `(agentName: string) => ModelDef | undefined` (`types.ts:253`). The
  tier reaches it by widening that callback to
  `(agentName: string, tier?: ModelTier) => ModelDef | undefined` and having
  `resolveHopCompleteOptions` pass the hop's tier. `call.ts`'s implementation
  then uses `tier ?? effectiveTier`, so an absent tier is exactly today's
  behaviour.
- **run path** — the model is resolved by the *caller*, in
  `build-hop-callback.ts:313/338-340`, from an `effectiveTier` passed into
  `buildHopCallback`. The manager does not resolve it, so the hop's tier must
  cross the hop-callback boundary to be applied.

Both paths must be covered, or `{ agent, tier }` works for `complete` ops and
is silently ignored for `run` ops — a split behaviour worse than not shipping
it. A test per path is therefore mandatory, asserted at the dispatch, not the
schema.

### Tests

- a plain-string map behaves identically to today (regression floor)
- a `{ agent, tier }` target **reaches the swap carrying its tier** — asserted at
  the swap site, not at the schema. A parse-only test passes while the feature is
  inert, which is the exact failure this item exists to avoid
- a mixed array of both forms in one entry
- `credentialCandidates` yields names for both forms, so
  `validateCredentials()` still checks both sides of every entry
- an unknown tier on a target surfaces as the existing `MODEL_NOT_FOUND`, not a
  silent fallback to `balanced`

## 4. What this plan does not touch

- The native adapter's `complete()` path, unchanged since plan 1.
- acpx behaviour. The 94 test files under `test/**/agents/**` stay green.
- `registerBundledOAuthFlows()`, which stays unused: keeping nax-ai external
  already fixes bundled OAuth at the cause. It is held for a self-contained
  `bun build --compile` binary, which this repo does not produce.

## 5. Moved out: unify `{ agent, model }` resolution

Its own plan, before plan 4. Recorded here so the reasoning is not lost.

The rule, as ruled by the user: **`{ agent, model }` means a tier when the string
names a tier for that agent, and a literal model name otherwise** — consistently,
everywhere the shape appears. Three places disagree with that today:

1. **`resolveConfiguredModel`** (`schema-types.ts:115-118`) never asks the tier
   question in the object form. Measured: the string form `"turbo"` throws
   `MODEL_NOT_FOUND`, while `{ agent: "native", model: "turbo" }` silently
   returns `{ provider: "unknown", model: "turbo" }`. The same user error, in two
   spellings, behaves completely differently — and `resolvePlanModelSelection`'s
   `try/catch` fallback only rescues the spelling that throws.
2. **`agent-profile-resolver.ts:39`** assigns `profileModelTier: p.target.model`
   unconditionally. A literal model pin is recorded as though it were a tier,
   persisted into `prd.json` by `finalize-routing.ts`, propagated to substories
   by `decompose-mapper.ts`, and used to bias tier selection at run time.
3. **`resolveOperatingTier`** ranks against a hardcoded
   `TIER_RANK = { fast: 0, balanced: 1, powerful: 2 }` and only guards
   `previousTier`. A custom tier ranks `undefined`, so escalation cannot compare
   it — and ADR-027's settled native config uses custom tier names.

Nothing is broken today: all nine routing profiles under `~/.nax/profiles/` use
only `fast`, `balanced` and `powerful`. All three bite the moment a native
profile is written, because native models are `provider/model` strings grouped
under custom tier names. That makes this a prerequisite for plan 4's op cutover,
not for anything in flight.

Likely shape: one shared resolver answering "tier or literal model?", called by
both `resolveConfiguredModel` and `agent-profile-resolver`; tier-first
precedence stated explicitly; a PRD field that can hold a pinned model without
disguising it as a tier; and `TIER_RANK` derived from
`autoMode.escalation.tierOrder` rather than hardcoded.

## 6. Verification

Every gate this repo already runs, plus:

- `bun run test` green, including the 94 acpx test files
- `bun run lint` — all 23 check scripts
- `bun run test:coverage` — per-file ratchet stays at 0 below floor
- Each new guard proven to fail without its fix. A gate never proven to fail is
  not a gate; a timeout never observed to fire is not a timeout.
