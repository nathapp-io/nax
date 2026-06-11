# Agent Routing — Design Draft

**Status:** Draft for review
**Date:** 2026-06-11
**Related:** ROUTE-001 (routing simplification), ADR-012 (agent manager ownership), `docs/specs/SPEC-enhanced-debate-phase-1.md` (ConfiguredModel)

## Problem

Today every story in a run executes on the single configured default agent
(`config.agent.default`), with `agent.fallback.map` used only for *failure*
recovery (availability swaps). There is no way to say:

> "Stories in this PRD that are mechanical migrations should run on codex,
> the complex frontend refactor should run on claude@powerful, everything
> else stays on opencode."

The desired capability: **route each story to an (agent, model-tier) pair
based on what the story is**, decided intelligently (not by keyword
heuristics — explicitly rejected as unreliable), reviewable by the user,
and off by default.

## Current State (what already exists)

| Capability | Status | Where |
|:---|:---|:---|
| Per-story agent override field | ✅ exists, flows end-to-end | `StoryRouting.agent?` (`src/prd/types.ts:87`) → routing stage preserves it (`src/pipeline/stages/routing.ts:63`) → execution applies it (`src/pipeline/stages/execution.ts:79`: `agentName: ctx.routing.agent ?? defaultAgent`) → `callOp` dispatch |
| Cross-agent target type | ✅ exists | `ConfiguredModel` = tier string \| `{agent, model}` (`src/config/schema-types.ts:36`), resolved in `callOp` via `resolveConfiguredModel()` |
| Per-agent fallback chains | ✅ exists | `agent.fallback.map` keyed per agent; `runWithFallback(request, primaryAgentOverride)` already accepts a primary override (`src/agents/manager.ts:209`) |
| LLM story classification | ✅ exists (tier/complexity only) | `routing.strategy: "llm"`, `classifyRouteOp` / `classifyRouteBatchOp`, modes `one-shot` / `per-story` / `hybrid`, content-hash cached |
| Plugin routing override | ✅ exists | plugin routers run first in `resolveRouting()` (`src/routing/router.ts`) |
| Router producing an agent decision | ❌ **the gap** | `RoutingDecision` (`src/routing/decision.ts`) has no `agent` field |
| Structured story metadata for classification | ❌ **the gap** | decompose emits prose (title/description/ACs/tags) only |
| Definition of agent capabilities | ❌ **the gap** | nothing describes what each agent/model is good at |

Conclusion: this is an **extension of the existing routing subsystem**, not a
new router. Per ROUTE-001 the strategy chain was deliberately removed —
agent routing slots into `resolveRouting()`'s existing precedence model
(PRD wins → config → LLM → safe default) rather than reintroducing a chain.

## Goals

1. Route stories to an (agent, tier) pair based on story content.
2. LLM-decided with full-PRD context — **no keyword heuristics for agent
   choice** (a wrong agent is worse than a wrong tier; tier mistakes are
   recoverable via escalation, agent mistakes are not).
3. Off by default; zero behavior change until explicitly enabled.
4. Agent capabilities defined declaratively, including model tier
   ("claude@powerful" and "claude@fast" are different tools).
5. Decisions persisted in the PRD — human-reviewable and correctable
   between `nax plan` and `nax run`; deterministic replay via content hash.
6. Compose cleanly with existing escalation (tier ladder) and fallback
   (availability swaps).

## Non-Goals

- **Dynamic per-stage routing.** Per-stage/per-role agent choice is already
  expressible statically via `ConfiguredModel` `{agent, model}` objects on
  op-level configs (e.g. `tdd.sessionTiers.*`, `acceptance.model`). No new
  mechanism. (Caveat: verify each per-role config is actually consumed —
  `tdd.sessionTiers` has a dead-config history; out of scope here.)
- **Mid-story agent switching.** Agent is fixed at story start; swaps remain
  the fallback system's job.
- **Cost-based routing.** Leaf routing code must stay cost-blind
  (adapter-wiring Rule 7). `costTier` on profiles is prompt *content* for
  the LLM, not a runtime input.
- **Keyword/rules-based agent assignment.** Explicitly rejected.

## Design

### 1. Capability profiles (config)

A new `routing.agents` block defines a registry of **profiles** — named
(agent, tier) targets with human-authored capability descriptions:

```jsonc
{
  "routing": {
    "strategy": "keyword",          // existing tier routing — unchanged
    "agents": {
      "strategy": "off",            // "off" | "llm" — DEFAULT "off"
      "default": "opencode-balanced",
      "profiles": [
        {
          "id": "claude-powerful",
          "target": { "agent": "claude", "model": "powerful" },
          "strengths": ["architecture", "complex multi-file refactors", "TS/React"],
          "weaknesses": ["slow", "expensive"],
          "costTier": "high"
        },
        {
          "id": "codex-fast",
          "target": { "agent": "codex", "model": "fast" },
          "strengths": ["mechanical migrations", "large repetitive diffs"],
          "costTier": "low"
        },
        {
          "id": "opencode-balanced",
          "target": { "agent": "opencode", "model": "balanced" },
          "strengths": ["general implementation work"],
          "costTier": "low"
        }
      ]
    }
  }
}
```

**Schema** (`src/config/schemas-infra.ts`, extending `RoutingConfigSchema`):

```typescript
const AgentProfileSchema = z.object({
  id: z.string().min(1),
  target: z.object({
    agent: z.string().min(1),
    model: ModelTierSchema,          // tier, NOT a concrete model name — see §6
  }),
  strengths: z.array(z.string()).min(1),
  weaknesses: z.array(z.string()).optional(),
  costTier: z.enum(["low", "medium", "high"]).optional(),
});

const AgentRoutingConfigSchema = z.object({
  strategy: z.enum(["off", "llm"]).default("off"),
  default: z.string().optional(),    // profile id; falls back to agentManager.getDefault()
  profiles: z.array(AgentProfileSchema).default([]),
});
// wired as: RoutingConfigSchema.extend({ agents: AgentRoutingConfigSchema.default({}) })
```

**Validation** (Zod `superRefine`, fail-fast at config parse per
config-patterns rules):

- Profile `id`s unique.
- Every `target.agent` must exist in `config.models` (the agent→tier→model
  map) — otherwise the run would dispatch to an unconfigured agent.
- `default`, if set, must reference a defined profile id.
- `strategy: "llm"` with zero profiles → config error ("define at least one
  profile or set strategy off").

**Built-in defaults:** ship no profiles by default (empty array). A
follow-up may add suggested profiles for known agents via `nax init` /
`nax-setup`, but defaults in the schema would silently drift from users'
actual installed agents.

**Why `strategy: "off"` instead of `enabled: false`:** leaves room for
future strategies (`"structural"` — route by package language/workdir,
which is deterministic and reliable) without a second flag. `"off"` is the
schema default.

### 2. Decompose enrichment (`nax plan`)

The router's LLM needs to know *what the job is*. Decompose already
analyzes the full PRD; it just doesn't write its analysis down. Add a
structured `classification` block to each decomposed story:

```typescript
// src/prd/types.ts
export interface StoryClassification {
  taskType: "feature" | "refactor" | "bugfix" | "migration" | "test" | "docs" | "infra";
  domains: string[];          // e.g. ["frontend", "api"] — suggested vocabulary, not enum
  language?: string;          // authoritative source is detectLanguage(packageDir) when workdir is set
  estimatedSize: "small" | "medium" | "large";
  risk: "low" | "medium" | "high";
}

export interface UserStory {
  // ...existing fields
  classification?: StoryClassification;   // optional — absent in old PRDs
}
```

Changes:

- **Decompose prompt** — extend in `src/prompts/builders/` (prompt-builder
  convention; no inline prompt strings in `src/prd/` or stages).
- **Decompose parse/validation** — accept and validate the block; tolerate
  absence (older agents / malformed output degrade to `undefined`, never
  fail decompose over metadata).
- **`language` is cross-checked, not trusted**: when `story.workdir` is
  set, `detectLanguage(join(repoRoot, story.workdir))` overrides whatever
  the LLM said (monorepo-awareness rule — detection beats inference).
- Persisted in the PRD like any other story field → human-correctable.

The block is useful beyond agent routing (tier routing, analyze, metrics),
which is why it lives on `UserStory` rather than inside routing config.

### 3. Routing decision extension

```typescript
// src/routing/decision.ts
export interface RoutingDecision {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  agent?: string;          // NEW — resolved agent name (from profile target)
  agentProfileId?: string; // NEW — which profile produced it (metrics/audit)
}
```

`StoryRouting` (`src/prd/types.ts`) already has `agent?`; add
`agentProfileId?` alongside for traceability.

### 4. Assignment flow (one-shot, PRD-scoped)

Agent assignment is a **single LLM call over all unassigned stories of the
run**, not N per-story calls. Per-story calls lack cross-PRD context; the
one-shot call can reason about the PRD's overall shape and make consistent
assignments. This mirrors the existing `classifyRouteBatchOp` one-shot
tier-routing mode and runs at the same point in the run lifecycle (run
setup, before the story loop).

New complete-kind operation `assignAgentsOp` (`src/operations/assign-agents.ts`):

- **Input:** stories lacking an explicit `routing.agent` (each with title,
  ACs, tags, `classification` if present, `workdir`/detected language) +
  the profile registry.
- **Prompt:** new method on `OneShotPromptBuilder`
  (`src/prompts/builders/`). Presents profiles as capability cards
  (id, target, strengths, weaknesses, costTier) and asks for
  `{ assignments: [{ storyId, profileId, reasoning }] }`. The LLM picks a
  **profile id** — constrained choice, trivially validatable — never a
  free-form agent string.
- **Parsing:** `parseLLMJson` (SSOT) + validation: every `profileId` must
  exist in the registry; unknown/missing → that story falls to the default
  profile (warn, with `storyId` in the log data).
- **Retry:** declarative `retry` on the op (`transient-network` preset) per
  the retry-strategy rules; no inline loops.
- **Session role:** complete-kind; needs a role registry entry (proposal:
  `agent-route`) in the session-role table (adapter-wiring Rule 2).
- **Dispatch model:** the op's own `model` is a `ConfiguredModel`
  (default `"balanced"`) — the router LLM itself is *not* routed.
- **Failure semantics:** if the call fails after retries → **all stories
  fall back to the default agent**, warn once, run proceeds. Never fall
  back to keyword guessing for agent choice; "no routing" is the safe
  degradation.

Results are written into `story.routing.agent` / `agentProfileId` /
`modelTier` and persisted to the PRD with the existing content-hash
mechanism — re-running does not re-classify unchanged stories; editing a
story's text invalidates its assignment.

### 5. Precedence (extends ROUTE-001's model)

For the `agent` field, resolved in `resolveRouting()` / the routing stage:

```
1. story.routing.agent set in PRD (human or prior run)   → use it
2. Plugin router returned an agent                       → use it
3. routing.agents.strategy == "llm" → assignAgentsOp result (profile)
4. routing.agents.default profile                        → its target
5. agentManager.getDefault()                             → final floor
```

Notes:

- Levels 1–2 work **even when `strategy: "off"`** — they already work
  today; "off" only disables automatic assignment (level 3–4).
- The keyword tier-routing path never touches `agent` (stays `undefined`
  → level 4/5).
- When a profile assigns an agent, its `target.model` also sets
  `modelTier` for that story — but an explicit PRD `modelTier` still wins,
  and escalation's tier bumps are preserved exactly as today
  (ROUTE-001 escalation rule unchanged).

### 6. Interplay with escalation and fallback

This is why `target.model` is a **tier**, not a concrete model name:

- **Escalation** (fast → balanced → powerful on repeated failure) operates
  on `modelTier` *within* the routed agent, via the routed agent's own
  `config.models.<agent>` tier map. Pinning concrete model names would
  fight the ladder.
- **Fallback** (availability failures) keys off the routed agent: the
  routed agent is passed as `primaryAgentOverride` to
  `runWithFallback()` — already supported — and `agent.fallback.map` is
  keyed per agent, so `{ "codex": ["claude"] }` chains apply to
  codex-routed stories automatically. A story swapped by fallback records
  the swap in `AgentFallbackRecord` as today; the *routing* decision in
  the PRD is not rewritten (the assignment stays, the swap is a runtime
  event).
- **Validation seam:** at run setup, routed agents that are unavailable
  (failed credential pre-validation, ADR-012 Phase 2) degrade to the
  default agent with a warning, rather than burning a fallback hop on a
  known-dead primary.

### 7. Observability

- `metrics/tracker.ts` already records `ctx.routing.agent`; add
  `agentProfileId` to the story metrics row.
- Run summary: when agent routing is active, log the assignment table once
  at routing time (`storyId → profileId (agent@tier) — reasoning`), each
  line carrying `storyId` per the structured-logging rule.
- `nax analyze` should surface `classification` + assignment so users can
  sanity-check routing before `nax run`.

## What this is NOT (rejected alternatives)

| Alternative | Why rejected |
|:---|:---|
| New `IRouter` / parallel router subsystem | Duplicates `resolveRouting()`; ROUTE-001 deliberately deleted the strategy chain; violates one-resolver-per-concept |
| Keyword/rules-based agent matching | Unreliable (user-confirmed); wrong agent is non-recoverable, unlike wrong tier |
| Free-form agent name from LLM | Unvalidatable; profile-id constrained choice instead |
| Concrete model names in profiles | Breaks escalation ladder and `config.models` SSOT |
| Decompose-time agent assignment (v1) | Richest context, but couples `nax plan` to executor config; classification metadata (§2) captures the context without the coupling. Revisit if decomposition itself should ever be agent-aware (e.g. story sizing per agent). |

## Phasing

| Phase | Scope | Behavior change |
|:---|:---|:---|
| **1** | Config schema (`routing.agents`, profiles, superRefine validation), `RoutingDecision.agent`/`agentProfileId`, precedence merge in routing stage, run-setup availability degradation | None (`strategy: "off"` default); explicit PRD `routing.agent` continues to work |
| **2** | Decompose `classification` block: prompt builder, parse, PRD types, `detectLanguage` cross-check, persistence | None for routing; PRDs gain metadata |
| **3** | `assignAgentsOp` + `OneShotPromptBuilder` method + one-shot invocation at run setup + PRD persistence + metrics/log table | Only when `strategy: "llm"` |

Each phase is independently shippable and testable; Phase 3 works without
Phase 2 (falls back to raw story text in the prompt) but is better with it.

## Files Touched (Phases 1–3)

| File | Change |
|:---|:---|
| `src/config/schemas-infra.ts` | `AgentRoutingConfigSchema`, `AgentProfileSchema`, superRefine |
| `src/config/selectors.ts` | extend routing selector slice if needed |
| `src/routing/decision.ts` | `agent?`, `agentProfileId?` |
| `src/routing/router.ts` | precedence wiring for the agent field |
| `src/pipeline/stages/routing.ts` | merge + persistence + assignment-table log |
| `src/prd/types.ts` | `StoryClassification`, `StoryRouting.agentProfileId?` |
| `src/prompts/builders/` (decompose + one-shot) | classification block; profile-card assignment prompt |
| `src/operations/assign-agents.ts` (new) + barrel | one-shot assignment op |
| Session-role registry (adapter-wiring docs + nameFor) | `agent-route` role |
| `src/metrics/` | `agentProfileId` on story metrics |
| `test/unit/...` mirrors of the above | per test-architecture rules |

## Open Questions (to resolve at spec time)

1. **Exact invocation site for `assignAgentsOp`** — same site as the
   existing one-shot `classifyRouteBatchOp` (run setup) is the working
   assumption; confirm against the current `routing.llm.mode` wiring.
2. **Interaction when tier strategy is `llm` AND agent strategy is `llm`** —
   one combined call or two? Working assumption: keep separate ops
   (orthogonal concerns, independent failure/fallback semantics); revisit
   if the extra call's cost matters.
3. **Should `classification` feed the existing tier router too?** Likely
   yes (cheap win), but out of scope for the phases above.
4. **`nax analyze` UX** for previewing assignments.
5. **Per-package default profiles** (`.nax/mono/<pkg>/config.json`
   overriding `routing.agents.default`) — design rule A says new config
   should support per-package layering; confirm the resolution order for
   this key.
