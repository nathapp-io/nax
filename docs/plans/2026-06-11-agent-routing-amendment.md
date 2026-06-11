# Agent Routing — Amendment: Plan-time Selection via Config Profiles + Cross-agent Escalation

**Status:** Draft for review
**Date:** 2026-06-11
**Amends:** `docs/plans/2026-06-11-agent-routing-design.md`
**Supersedes:** §2 (classification block as a routing prerequisite), §4 (separate `assignAgentsOp`), §6 (escalation is tier-only-within-an-agent — factually wrong), Goal 2's "wrong agent is non-recoverable" premise, Open Question 1 & 2

## TL;DR — the v1 design

Three findings reorganize the original:

1. **Agent selection happens at `nax plan`, not at run** (Part C). The plan
   agent picks an agent profile per story — from capability cards injected into
   the decompose prompt — and writes it to the PRD. No separate router op, no
   run-time routing call. The decision is a reviewable PRD artifact; `nax run`
   replays it deterministically.
2. **The override unit is the existing config-profile mechanism** (Part C).
   `nax plan --profile <name>` overlays `/.nax/profiles/<name>.json`, which can
   bundle *both* the agent-profile registry *and* the escalation `tierOrder`.
   This works today via `loadProfile` + `deepMergeConfig` — no new flag.
3. **Cross-agent escalation already exists in the execution layer but is dead
   at the config boundary** (Part B) — a one-field schema fix
   (`TierConfigSchema.agent`) lights it up. A wrong initial agent becomes
   *recoverable* by climbing the ladder, which dissolves the original "agent
   choice is non-recoverable" premise.

The unifying idea: **`autoMode.escalation.tierOrder` is the agent+model
ranking.** Each rung is an `(agent, tier)` pair. Plan-time selection picks a
*starting rung*; escalation advances along the same ladder, crossing agents
where the ladder does. **v1 ships a single global ladder** (per-domain ladders
deferred).

### v1 scope vs. deferred

| | Status |
|:---|:---|
| **Part C** — plan-time selection + config-profile override + decompose prompt injection | **v1** |
| **Part B** — `tierOrder.agent` schema fix + `escalateTier` index fix + origin fields | **v1** (independent, ship first) |
| **Part A** — run-time routing (fold into `classifyRouteOp`) | **Deferred** — kept as the documented future feature; built behind `routing.agents.strategy` later |

The cheap-model concern that drove the earlier router design is dissolved in
v1: selection cost is **absorbed into the existing decompose call** (a few
extra output tokens), so there is no separate routing call to provision.

## Why this amendment exists

The original design assumed agent assignment needs (a) a new structured
`classification` block emitted at decompose time and (b) a new dedicated
one-shot op (`assignAgentsOp`) with its own session role. Review surfaced a
simpler truth: **the existing LLM tier classifier already does the
expensive work, on a model whose cost is already configurable.**

The driving constraint was sharpened during review:

> The router is itself an LLM call. It must run on a **cheap/low-end model**.
> A cheap model can't be trusted with open-ended judgment, so the **prompt
> must carry the evaluation procedure** — a structured rubric the weak model
> executes, not a free-form "pick the best agent" question.

This is compatible with the original core requirement (§Goal 2: *no
keyword/rules-based agent choice; a wrong agent is non-recoverable*). The
rubric is **prompt scaffolding for an LLM that still adjudicates** — not
deterministic code rules. The distinction is load-bearing:

| | Decides | Handles the unusual story | Recoverability property |
|:---|:---|:---|:---|
| Code rules (rejected) | `if/else` | No — brittle | Lost |
| Rubric-in-prompt (this) | LLM, guided | Yes — can override the rubric | Preserved |

---

# Part A (DEFERRED) — Run-time routing: fold the router into `classifyRouteOp`

> **Deferred out of v1.** v1 selects the agent at plan time (Part C). This
> section is retained as the design for a *future* run-time routing feature —
> useful when assignments should be computed at run (e.g. to pick up new
> profiles without re-planning, or to route stories a plan left unrouted). It
> would live behind `routing.agents.strategy: "llm"` and fill `routing.agent`
> only when the PRD leaves it unset, composing with Part C (PRD wins) and
> Part B (escalation) unchanged. Everything below is forward-looking, not v1
> work.

## What already exists (the basis for folding)

`classifyRouteOp` / `classifyRouteBatchOp` (`src/operations/classify-route.ts`)
already provide everything a separate router would reinvent:

- **Cost-configurable model:** `ctx.config.routing.llm?.model ?? "balanced"`.
  Set `routing.llm.model: "fast"` → the router runs on the low-end model.
  No new config, no new op needed for the cost lever.
- **Rubric-shaped prompt:** `ROUTING_INSTRUCTIONS` is already an ordered
  classification guide ("select the cheapest tier that will succeed").
- **One-shot batch mode** (`classifyRouteBatchOp`) — the PRD-scoped single
  call the original §4 wanted.
- **Structured, persisted, reasoned output** — the PRD `routing` block
  already carries `complexity`, `modelTier`, `reasoning`, `risks`,
  `estimatedLOC`, content-hash cached.

## Decision: extend the classifier, do not add a router

Agent selection folds into the existing classifier as **one combined call**
that emits tier **and** agent profile together. This resolves the original
**Open Question 2** ("one combined call or two?") in favour of one — both
decisions already have safe independent fallbacks (keyword tier; default
agent), so a combined-call failure degrades both gracefully.

### Delta 1 — `RoutingDecision` (`src/routing/decision.ts`)

```typescript
export interface RoutingDecision {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  agent?: string;          // NEW — resolved agent name from the chosen profile target
  agentProfileId?: string; // NEW — which profile produced it (audit / metrics / review)
}
```

`StoryRouting` (`src/prd/types.ts`) already has `agent?` and `reasoning`;
add `agentProfileId?` alongside for PRD persistence and human review.

### Delta 2 — the rubric (`src/routing/strategies/llm.ts`)

Keep `ROUTING_INSTRUCTIONS` as the base (the off-by-default path emits it
unchanged → zero behaviour change). Append an agent-selection step **only
when profiles exist**, so the cheap model reuses the complexity it just
computed:

```typescript
export function buildAgentRubric(profiles: AgentProfile[]): string {
  const cards = profiles
    .map(
      (p) =>
        `- ${p.id} -> ${p.target.agent}@${p.target.model} (cost: ${p.costTier ?? "?"})\n` +
        `    strengths: ${p.strengths.join("; ")}` +
        (p.weaknesses?.length ? `\n    weaknesses: ${p.weaknesses.join("; ")}` : ""),
    )
    .join("\n");

  return `
## Agent Selection
After deciding complexity, pick exactly ONE agent profile. In order:
1. Eliminate any profile whose weakness conflicts with the story.
2. Keep profiles whose strengths cover the story's main job (task type + primary domain).
3. If more than one remains, choose the LOWEST cost profile.
4. If none clearly fit, output the literal id "DEFAULT".
5. "agentReasoning" must be ONE line naming the single signal that decided it.

Choose "agentProfileId" from this list ONLY — never invent an agent name:
${cards}`;
}
```

Schema examples (`ROUTING_SCHEMA`, `BATCH_ROUTING_SCHEMA`) gain
`agentProfileId` + `agentReasoning`.

> **Convention note (Open Item A):** `forbidden-patterns.md` puts
> instruction-building on `OneShotPromptBuilder`. `ROUTING_INSTRUCTIONS` is
> grandfathered in `llm.ts`; `buildAgentRubric` should likely live as a
> builder method rather than set new precedent for loose prompt functions.
> **Recommendation:** add it to `OneShotPromptBuilder`.

### Delta 3 — resolve + validate in the SSOT (`src/routing/strategies/llm-parsing.ts`)

`validateRoutingDecision` is the one chokepoint both ops flow through, so
profile validation and agent resolution live here. Widen its config slice to
`Pick<NaxConfig, "models" | "tdd" | "routing">` and append:

```typescript
const profiles = config.routing.agents?.profiles ?? [];
if (config.routing.agents?.strategy !== "llm" || profiles.length === 0) {
  return base; // off by default → no agent fields, no behaviour change
}
const wanted = (parsed.agentProfileId as string | undefined)?.trim();
const chosen =
  profiles.find((p) => p.id === wanted) ??
  profiles.find((p) => p.id === config.routing.agents.default);
if (!chosen) return base; // unknown/missing -> agent undefined -> precedence floor

return {
  ...base,
  agent: chosen.target.agent,
  agentProfileId: chosen.id,
  modelTier: chosen.target.model, // profile is an (agent,TIER) pair — see Open Item B
  reasoning: parsed.agentReasoning
    ? `${base.reasoning} | agent: ${parsed.agentReasoning}`
    : base.reasoning,
};
```

Degradation is in code, not prose: unknown/missing `agentProfileId` →
default profile → `agent` stays `undefined` → precedence falls to
`agentManager.getDefault()`. Never a guess.

### Delta 4 — inject cards in `build()` (`src/operations/classify-route.ts`)

The op already selects `routingConfigSelector`, so `ctx.config.routing.agents`
is in hand. In both `classifyRouteOp.build` and `classifyRouteBatchOp.build`:

```typescript
const profiles = ctx.config.routing.agents?.profiles ?? [];
const rubric =
  ctx.config.routing.agents?.strategy === "llm" && profiles.length > 0
    ? `${ROUTING_INSTRUCTIONS}\n${buildAgentRubric(profiles)}`
    : ROUTING_INSTRUCTIONS;
```

Model, retry, cache, batch are untouched.

### Delta 5 — config schema (`src/config/schemas-infra.ts` + `schemas.ts`)

```typescript
const AgentProfileSchema = z.object({
  id: z.string().min(1),
  target: z.object({ agent: z.string().min(1), model: ModelTierSchema }),
  strengths: z.array(z.string().min(1)).min(1),
  weaknesses: z.array(z.string().min(1)).optional(),
  costTier: z.enum(["low", "medium", "high"]).optional(),
  affinity: z
    .object({
      taskTypes: z.array(z.string().min(1)).optional(),
      domains: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export const AgentRoutingConfigSchema = z
  .object({
    strategy: z.enum(["off", "llm"]).default("off"), // "structural" reserved (design §1)
    default: z.string().optional(),
    profiles: z.array(AgentProfileSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    // unique ids; default references a real id; llm strategy requires >=1 profile
  });

// RoutingConfigSchema gains:
agents: AgentRoutingConfigSchema.optional().default({ strategy: "off", profiles: [] }),
```

**Cross-section invariant** ("every `target.agent` exists in
`config.models`, and `target.model` is a defined tier for that agent") —
`models` is a top-level sibling of `routing`, so this check lives in the
**`NaxConfigSchema.superRefine`** (`src/config/schemas.ts`), not in the
routing sub-schema's refine.

Export `AgentProfile = z.infer<typeof AgentProfileSchema>` so the rubric
builder and validator share one type (config-patterns: leaf-path types, no
re-derivation).

---

# Part B — Escalation is the same ladder (and already half-exists)

## The premise this overturns

The original design (Goal 2, §6) justified "agent choice must be LLM, never
rules" with an asymmetry:

> a wrong agent is worse than a wrong tier; tier mistakes are recoverable via
> escalation, agent mistakes are not.

**This is false in the current codebase.** Escalation already crosses agents —
it just can't be configured to. Once it can, a wrong *initial* agent is
recoverable: the story climbs the ladder to a stronger agent. The initial
route stops being a high-stakes, irreversible decision and collapses to "pick
a starting rung." That is what makes the cheap router of Part A safe — and it
re-opens deterministic/structural initial routing as a legitimate option,
since escalation self-corrects upward regardless of how the start was chosen.

## The finding: cross-agent escalation is coded but dead at the config boundary

The execution layer already performs `(agent, tier)` escalation:

- `escalateTier()` returns `{ tier, agent }`, reading `next.agent` from each
  rung (`src/execution/escalation/escalation.ts:39`). Its own doc example is
  `[{tier:"fast",agent:"claude",attempts:3}, ...]`.
- `tier-escalation.ts` writes the next agent into the story on every rung
  advance: `...(nextAgent !== undefined ? { agent: nextAgent } : {})`
  (lines 175, 180, 390).
- The `TierConfig` **type** carries `agent?: string`
  (`src/config/schema-types.ts:47`).

But the Zod **schema** that parses config is `{ tier, attempts }` only —
**no `agent` field** (`src/config/schemas-model.ts:50-53`). Zod's default
`.strip()` silently deletes any `agent` written in `tierOrder`, so the
execution code's `next.agent` is *always* `undefined`. The feature is fully
implemented and unreachable. The original design doc's §6 ("escalation
operates on `modelTier` within the routed agent") was written without
knowledge of this code.

## The unified model

`autoMode.escalation.tierOrder` **is** the agent+model ranking. One ranked
ladder, three behaviors:

| Behavior | Mechanism on the ladder |
|:---|:---|
| **Initial route (pre-escalation)** | router (Part A) picks the lowest rung whose strengths cover the job |
| **Escalation (quality failure)** | advance rung index — crosses agents where the ladder does |
| **Fallback (availability failure)** | skip the current rung's agent if unreachable; try the next reachable rung |

```jsonc
// v1: ONE global ladder, low -> high capability
"autoMode": {
  "escalation": {
    "tierOrder": [
      { "tier": "balanced", "agent": "opencode", "attempts": 3 },
      { "tier": "balanced", "agent": "claude",   "attempts": 2 },
      { "tier": "powerful", "agent": "claude",   "attempts": 2 }
    ]
  }
}
```

This escalates `opencode@balanced -> claude@balanced -> claude@powerful`.

### Profiles ↔ ladder unification

Part A's `routing.agents.profiles` and `tierOrder` are two views of the same
`(agent, tier)` pairs: profiles say *what each is good at* (for the start
pick); the ladder says *what order to climb*. They must not drift.

- **`tierOrder` is the ranking SSOT** (escalation already consumes it).
- A profile binds to a rung by its `target` `(agent, tier)`.
- **Validation:** every profile the router can pick MUST correspond to a rung
  in `tierOrder` (else escalation from it has no defined next step). Enforced
  in `NaxConfigSchema.superRefine`.

### Delta 6 — `TierConfigSchema` gains `agent` (`src/config/schemas-model.ts`)

```typescript
export const TierConfigSchema = z.object({
  tier: z.string().min(1, "Tier name must be non-empty"),
  attempts: z.number().int().min(1).max(20),
  agent: z.string().min(1).optional(), // NEW — was on the TYPE, missing from the SCHEMA
});
```

Cross-section check in `NaxConfigSchema.superRefine`: each rung's `agent` (when
set) must exist in `config.models`, and `tier` must be a defined tier for that
agent. (Mirrors the profile check from Delta 5.)

### Delta 7 — escalation must track rung INDEX, not tier name (`escalation.ts`)

`escalateTier` locates the current position by tier name alone:
`tierOrder.findIndex((t) => getName(t) === currentTier)` (line 32). A
cross-agent ladder repeats tier names (`opencode@balanced`,
`claude@balanced`), so `escalateTier("balanced", …)` can't tell which rung the
story is on and always resolves to the first `"balanced"` match — **a latent
bug the feature exposes.** Fix: traverse by rung index.

```typescript
// signature gains the current rung index (or matches on agent+tier)
export function escalateTier(
  currentRung: { tier: string; agent?: string },
  tierOrder: TierConfig[],
): EscalateTierResult | null {
  const i = tierOrder.findIndex(
    (t) => t.tier === currentRung.tier && (t.agent ?? undefined) === (currentRung.agent ?? undefined),
  );
  if (i === -1 || i === tierOrder.length - 1) return null;
  const next = tierOrder[i + 1];
  return { tier: next.tier, agent: next.agent };
}
```

Callers in `tier-escalation.ts` (lines 313, 130) pass the story's current
`{ modelTier, agent }` instead of the bare tier string.

### Delta 8 — preserve the origin rung (`src/prd/types.ts`)

`StoryRouting` already keeps `initialComplexity` ("written once, never
overwritten by escalation", types.ts:67). Add siblings so metrics and replay
know where the story started before the ladder moved it:

```typescript
initialAgent?: string;       // NEW — agent at first route, before escalation
initialProfileId?: string;   // NEW — profile that produced the starting rung
```

`agent` / `agentProfileId` / `modelTier` continue to reflect the *current*
rung (rewritten on each escalation, as `modelTier` is today).

## Fallback stays a distinct trigger

Escalation (quality failure → climb) and fallback (availability failure →
sidestep to a reachable agent) remain separate triggers keyed off different
failure outcomes (`fail-rate-limit` / `fail-stale` vs. pipeline failure).
They share the ladder structure but are not merged: escalation advances the
rung index; fallback resolves an unreachable rung to the next reachable one
without consuming an escalation step. `runWithFallback(request,
primaryAgentOverride)` already accepts the routed agent (design §6) — unchanged.

## v1 scope boundary

- **One global ladder.** A single `tierOrder` for the whole run, capability-
  ordered. Sufficient because escalation is a blunt "throw more capability at
  it" instrument (as tier escalation is today).
- **Deferred:** per-domain / per-language ladders (e.g. frontend →
  opencode→claude, Go → opencode→codex). Would require keying `tierOrder` by
  domain and selecting the ladder from `story.classification`/`detectLanguage`.
  Out of scope; revisit if a single global capability order proves too coarse.

---

# Part C — Plan-time selection via config profiles (the v1 path)

## The flow

```
nax plan --profile aggressive
  -> resolveProfileName: --profile > NAX_PROFILE > config.json "profile" > "default"
  -> loadProfile("aggressive") + deepMergeConfig            [existing infra]
       overlays routing.agents.profiles AND autoMode.escalation.tierOrder
  -> decompose prompt gets agent capability cards injected   [NEW]
  -> plan agent emits stories WITH per-story agentProfileId   [NEW]
  -> PRD persists routing.agent / agentProfileId + the resolved profile name
       (human-reviewable / editable between plan and run)

nax run [--profile aggressive]
  -> honors PRD routing.agent (precedence level 1 — works today)
  -> escalates along tierOrder, crossing agents (Part B fix)
  -> run-setup availability degradation: dead agent -> default + warn
```

## Why this is the simplest path

- **The override unit already exists.** `loadProfile` (`src/config/profile.ts`)
  reads `/.nax/profiles/<name>.json`; the loader `deepMergeConfig`s it as a
  full overlay (`src/config/loader.ts:382-386`). A profile file can carry *any*
  config sections, so one `--profile` overrides **both** the agent-profile
  registry and the `tierOrder` ladder. No new flag, no new override mechanism.
- **No separate router.** Selection folds into `decompose` — the plan agent
  already reads the whole PRD; injecting capability cards lets it assign agents
  in the same pass. The earlier cheap-model concern dissolves: the cost is a
  few extra output tokens on a call that already happens.
- **Determinism + review for free.** The decision is a PRD field, edited in the
  plan→run gap and replayed at run. This is the cleanest realization of the
  original Goal 5.

## The profile file (bundles both concepts)

```jsonc
// .nax/profiles/aggressive.json
{
  "routing": {
    "agents": {
      "profiles": [
        { "id": "opencode-balanced", "target": { "agent": "opencode", "model": "balanced" }, "strengths": ["general implementation"] },
        { "id": "claude-powerful",   "target": { "agent": "claude",   "model": "powerful" }, "strengths": ["architecture","complex refactors","TS/React"] }
      ]
    }
  },
  "autoMode": {
    "escalation": {
      "tierOrder": [
        { "tier": "balanced", "agent": "opencode", "attempts": 3 },
        { "tier": "powerful", "agent": "claude",   "attempts": 2 }
      ]
    }
  }
}
```

Two concepts, distinct jobs:

- **`routing.agents.profiles`** — named `(agent, tier)` *starting points* +
  capability cards. The plan agent picks one per story.
- **`autoMode.escalation.tierOrder`** — the *ladder*. Each profile's
  `(agent, tier)` is a rung; the chosen profile sets the starting rung,
  escalation climbs from there (Part B).

## Deltas (v1)

### Delta C1 — `routing.agents.profiles` schema (`src/config/schemas-infra.ts`)

Same `AgentProfileSchema` / `AgentRoutingConfigSchema` as Delta 5, **minus the
run-time `strategy: "llm"` machinery** — for v1 the registry just needs to
exist and validate. `strategy` defaults `"off"`; when Part A ships it gains
meaning. Profiles are consumed by the decompose prompt, not a run-time op.

### Delta C2 — decompose prompt injection (prompt builder)

Render the capability cards in the **decompose prompt builder** (prompt-builder
convention — no inline strings in `src/prd/` or the op). Reuse `buildAgentRubric`
(Delta 2) so the card format is identical to the future run-time path. Inject
only when `routing.agents.profiles` is non-empty (else decompose is unchanged →
zero behaviour change for users without profiles).

### Delta C3 — decompose output + parse (`src/operations/decompose.ts`)

- Extend the decompose output schema with an optional per-story
  `agentProfileId`.
- Validate each against the registry; unknown/missing → leave `routing.agent`
  unset (falls to default at run) and warn with `storyId`. Never invent an
  agent.
- Resolve `agentProfileId` → `routing.agent` + starting-rung `modelTier` and
  write to the PRD (mirrors Delta 3's resolution, but at decompose).
- Thread `routing.agents` into `decomposeOp`'s config slice so `build()` can
  read the profiles.

### Delta C4 — persist the profile name in the PRD (`src/prd/types.ts`)

Plan and run must agree on which `tierOrder` is in force. Record the resolved
profile name on the PRD at plan time:

```typescript
// on the PRD root (not per-story)
routingProfile?: string;   // NEW — config profile resolved at plan time
```

`nax run` defaults to this profile when `--profile` is not passed, and **warns
on mismatch** (planned with `aggressive`, running with `cheap` → the ladder
differs from what plan assumed). Closes the only real plan/run coupling seam.

### Delta C5 — `--profile` wired on `nax plan`

`resolveProfileName` already accepts a CLI value; confirm the `plan` command
forwards its `--profile` flag into the config load (one-line wiring if absent).

## Validation seams (carried from Parts A/B)

- **Profile ↔ ladder binding** (`NaxConfigSchema.superRefine`): every
  `agentProfile.target` must be a rung in that profile's `tierOrder`, else a
  story has a start with no escalation path.
- **Cross-section** (`NaxConfigSchema.superRefine`): every `target.agent` and
  every `tierOrder[].agent` must exist in `config.models`, with a defined tier.
- **Availability** (run setup): a planned-but-unavailable agent degrades to the
  default with a warning — needed regardless of when selection happened.

## What the original design no longer needs

| Original | Status |
|:---|:---|
| §2 `classification` block as a routing prerequisite | **Dropped for routing.** Classifier already emits complexity/risks; cards match against those. Add `taskType`/`domains` to the classifier's output schema only if cards demand them. Keep §2 only if `analyze`/metrics want it independently. |
| §4 `assignAgentsOp` + `agent-route` session role | **Dropped.** v1 selects in `decompose`; the deferred run-time path (Part A) folds into `classifyRouteOp`, not a new op. |
| §6 "escalation is tier-only within the routed agent" | **Factually wrong.** Cross-agent escalation is already coded; §6 should describe the unified ladder (Part B). |
| Goal 2 "wrong agent is non-recoverable" | **Overturned.** Recoverable via cross-agent escalation; plan-time selection is therefore low-stakes. |
| Open Question 1 (invocation site for assignment) | **Resolved: `nax plan` (decompose), not run setup.** |
| Open Question 2 (one call vs. two) | **Resolved (v1): zero extra calls — selection folds into decompose.** |

## Revised phasing (v1 = Phases 0–2)

| Phase | Scope | Behaviour change |
|:---|:---|:---|
| **0** (v1) | **Part B core:** add `agent` to `TierConfigSchema` (Delta 6) + cross-section check; fix `escalateTier` rung-index traversal (Delta 7); `StoryRouting.initialAgent`/`initialProfileId` (Delta 8). Lights up the *already-coded* cross-agent escalation. | Enables cross-agent `tierOrder` rungs (opt-in via config); no change for single-agent ladders |
| **1** (v1) | **Part C config + plumbing:** `routing.agents.profiles` schema (Delta C1) + both superRefines (profile↔ladder binding, cross-section); `routing.agent`/`agentProfileId` on `StoryRouting`; `routingProfile` on the PRD root (Delta C4); `--profile` wired on `nax plan` (Delta C5) | None until a profile is defined + selected |
| **2** (v1) | **Part C selection:** `buildAgentRubric` (cards) injected into the decompose prompt builder (Delta C2); decompose output schema + parse + resolution + PRD write (Delta C3); run-side: honor PRD agent (works today) + profile-mismatch warning | Only when planned `--profile` defines profiles |
| **3** (deferred) | **Part A:** run-time routing — fold into `classifyRouteOp`, fill `routing.agent` when PRD leaves it unset, behind `routing.agents.strategy: "llm"` | Future feature; opt-in |

**Phase 0 is independently valuable** — it fixes a real dead-config bug and
delivers cross-agent escalation on its own, with no dependency on Part C. Ship
it first. Phases 1–2 are the plan-time selection feature; both are no-ops until
a user defines a profile and plans with it.

## Open items (decide during v1)

- **A. `buildAgentRubric` location** — `OneShotPromptBuilder` method
  (convention-compliant, recommended) vs. grandfathered in `llm.ts`. Applies to
  Part C's decompose injection too (same card renderer).
- **B. Tier precedence** — a profile is an `(agent, tier)` pair, so the chosen
  profile's `target.model` seeds the *starting rung* (Delta C3). Confirm this
  overrides the complexity-derived tier, while explicit PRD `modelTier` and
  escalation still win downstream (matches design §5).
- **C. Starting-rung resolution** — the plan agent picks a profile; its
  `(agent, tier)` must map to a `tierOrder` rung for escalation to have a
  start position. Confirm the binding rule (exact `(agent, tier)` match) and
  the behaviour when a profile has no matching rung (reject at config parse,
  per the validation seam).
- **D. `complexityRouting` vs. the ladder** — today the initial tier is
  derived from `complexity` via `autoMode.complexityRouting`, then escalates
  along `tierOrder`. When a profile is selected the starting rung comes from
  the profile. Confirm these two initial-position sources don't conflict
  (proposal: profile wins when the PRD has `agentProfileId`; complexity
  routing is the floor otherwise).
- **E. Re-plan to apply changes** — plan-time selection means new/edited
  profiles need a re-plan to take effect; a story edited after plan has a stale
  assignment. v1 accepts this (the trade for determinism + review). The content
  hash (`routing.contentHash`, RRP-003) can flag staleness at run setup —
  decide whether run warns, ignores, or (future Part A) re-routes.
