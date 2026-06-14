# ADR-025: Agent Routing via Plan-Time Selection and Cross-Agent Escalation

**Status:** Accepted
**Date:** 2026-06-12
**Author:** William Khoo, Claude
**Branch:** `worktree-feat+agent-routing-amendment`
**Supersedes:** `docs/plans/2026-06-11-agent-routing-design.md` §2, §4, §6, Goal 2's "wrong agent is non-recoverable" premise, and its Open Questions 1 & 2
**Source plans:**
- `docs/plans/2026-06-11-agent-routing-amendment.md` (design — the SSOT)
- `docs/plans/2026-06-11-agent-routing-amendment-fixes.md` (first review pass)
- `docs/plans/2026-06-12-agent-routing-review-fixes.md` (consolidated review fixes)

---

## Context

nax orchestrates multiple coding agents (Claude Code, opencode, etc.), each with
different strengths and cost. A story should run on the agent best suited to it,
and a poor initial choice should be recoverable rather than fatal.

The original routing design (`2026-06-11-agent-routing-design.md`) proposed:

1. A new structured `classification` block emitted at decompose time (§2).
2. A new dedicated one-shot op, `assignAgentsOp`, with its own session role (§4).
3. Escalation framed as **tier-only within a single agent** (§6).
4. A core premise (Goal 2): *agent choice must be LLM-driven, never rules-based,
   because a wrong agent is non-recoverable — unlike a wrong tier, which
   escalation can fix.*

Review surfaced three findings that collapse most of that machinery:

1. **The expensive work already exists.** The LLM tier classifier
   (`classifyRouteOp` / `classifyRouteBatchOp`) already runs a cost-configurable
   model with a rubric-shaped prompt and persists structured, reasoned,
   content-hash-cached output to the PRD. A separate router would reinvent it.

2. **Cross-agent escalation is already coded but dead at the config boundary.**
   The execution layer (`escalateTier`, `tier-escalation.ts`) already reads
   `next.agent` from each `tierOrder` rung and writes the next agent onto the
   story. The `TierConfig` **type** carries `agent?: string`. But the Zod
   **schema** (`schemas-model.ts`) parsed only `{ tier, attempts }`, so Zod's
   `.strip()` silently deleted any `agent` written in config — making `next.agent`
   always `undefined`. The feature was fully implemented and unreachable.

3. **The "wrong agent is non-recoverable" premise is therefore false.** Once the
   schema permits `(agent, tier)` rungs, a wrong *initial* agent is recoverable:
   the story climbs the ladder to a stronger agent. The initial route stops being
   a high-stakes, irreversible decision and collapses to "pick a starting rung."

The driving cost constraint — *the router is itself an LLM call and must run on a
cheap model, which can't be trusted with open-ended judgment* — is dissolved, not
solved: selection folds into the **existing decompose call** at plan time, costing
only a few extra output tokens. The cheap model still adjudicates, but guided by a
structured rubric carried in the prompt (prompt scaffolding for an LLM, not
deterministic `if/else` rules).

## Decision

**`autoMode.escalation.tierOrder` is the unified agent+model ranking. Each rung is
an `(agent, tier)` pair. Agent selection happens at `nax plan` (folded into
decompose), is written to the PRD as a reviewable artifact, and is replayed
deterministically at `nax run`. Escalation advances along the same ladder,
crossing agents where the ladder does.**

v1 ships a **single global ladder**; per-domain ladders are deferred.

### 1. One ladder, three behaviors

`tierOrder` is the ranking SSOT. The same capability-ordered ladder serves:

| Behavior | Mechanism on the ladder |
|:---|:---|
| **Initial route** | plan-time selection picks the starting rung |
| **Escalation** (quality failure) | advance the rung index — crosses agents where the ladder does |
| **Fallback** (availability failure) | sidestep an unreachable rung to the next reachable one, without consuming an escalation step |

Escalation and fallback remain **distinct triggers** keyed off different failure
outcomes; they share the ladder structure but are not merged.

### 2. Part B — light up cross-agent escalation (ship first, independently valuable)

- **`TierConfigSchema` gains `agent?: string`** (`schemas-model.ts`) — the field
  was on the type, missing from the schema. This alone makes the already-coded
  cross-agent escalation reachable.
- **`escalateTier` matches by `(tier, agent)` tuple** (`escalation.ts`). A
  cross-agent ladder repeats tier names (`opencode@balanced`, `claude@balanced`),
  so matching on tier name alone always resolved to the first match — a latent
  bug the feature exposes. The signature now takes the current `{ tier, agent }`
  and `findIndex`es on both fields, falling back to tier-name-only matching when
  `agent` is absent (single-agent ladders). `getTierConfig` matches the same way.
- **Origin tracking** (`StoryRouting.initialAgent` / `initialProfileId`) — written
  once at first route, never overwritten by escalation (sibling to
  `initialComplexity`), so metrics and replay know where a story started.

Part B is a no-op for single-agent ladders and fixes a real dead-config bug, so it
ships first with no dependency on Part C.

### 3. Part C — plan-time selection via config profiles (the v1 selection path)

- **Config shape.** `routing.agents` carries `enabled` (boolean, default `true` —
  disable plan-time selection without deleting profiles), `strategy`
  (`"off"` = plan-time only / v1 default; `"llm"` = run-time routing, deferred
  Part A), `default` (fallback profile id), and `profiles`.
- **Override unit is the existing config-profile mechanism.** `nax plan --profile
  <name>` overlays `.nax/profiles/<name>.json` via `loadProfile` +
  `deepMergeConfig` — a full overlay that can bundle **both** the
  `routing.agents.profiles` registry **and** the `autoMode.escalation.tierOrder`
  ladder. No new flag, no new override mechanism.
- **Selection folds into decompose.** Capability cards (`OneShotPromptBuilder`)
  are injected into the decompose prompt only when profiles exist. The plan agent
  emits a per-story `agentProfileId`; decompose resolves it to `routing.agent` +
  the profile's `target.model` as the starting tier, and writes it to the PRD.
- **PRD is the reviewable, replayable artifact.** `nax run` honors the PRD's
  `routing.agent` (precedence level 1 — already worked), and defaults to the PRD's
  `routingProfile` (the resolved config-profile name) when `--profile` /
  `NAX_PROFILE` are absent, warning on mismatch so ladder drift is visible.

### 4. Profiles ↔ ladder unification (the binding invariant)

`routing.agents.profiles` and `tierOrder` are two views of the same `(agent, tier)`
pairs: profiles say *what each is good at* (for the start pick); the ladder says
*what order to climb*. They must not drift:

- **`tierOrder` is the ranking SSOT.**
- A profile binds to a rung by its `target` `(agent, tier)`.
- **Validation** (`NaxConfigSchema.superRefine`): every profile's `target` must
  correspond to a rung in `tierOrder` (else escalation from it has no defined
  next step), and every `target.agent` / `tierOrder[].agent` must exist in
  `config.models` with a defined tier. The binding error names the remedy
  (agent-qualify the ladder).

### 5. Selection rules (decided)

- **Profile tier fully overrides the complexity-derived tier (Interpretation A).**
  A selected profile sets the starting rung *unconditionally*, even below what
  complexity suggests; escalation climbs back up if needed. A complex story
  assigned a cheap profile starts at `fast` and escalates upward — this is the
  intended, designed behavior, locked by an explicit test.
- **PRD agent wins; `decision.agent` (future Part A) applies only when the PRD
  leaves agent unset** — never clobbered unconditionally.
- **Never invent an agent.** Unknown/missing `agentProfileId` → default profile →
  `agent` stays `undefined` → precedence falls to `agentManager.getDefault()`,
  with a warn. Degradation is in code, not prose.
- **`strategy: "llm"` requires ≥1 profile** (config error otherwise).

### 6. Availability seam

A planned-but-unavailable agent degrades to the default agent with a warning
instead of failing the story (`resolveExecutionAgent`, unit-testable without
booting the pipeline). Run-setup additionally warns per story when
`routing.agent` is absent from `config.models` (hand-edited PRD / removed model).

### 7. Part A — run-time routing (DEFERRED)

Run-time routing folds into `classifyRouteOp` (not a new op), filling
`routing.agent` only when the PRD leaves it unset, behind
`routing.agents.strategy: "llm"`. It composes with Part C (PRD wins) and Part B
(escalation) unchanged. Out of v1; retained as the documented future feature.

## Consequences

### Positive

- **No new op, no new session role, no separate router.** Selection reuses the
  decompose call; the cheap-model cost concern dissolves to a few output tokens.
- **Fixes a real dead-config bug.** Cross-agent escalation was implemented and
  unreachable; Part B lights it up with a one-field schema change plus the
  rung-index fix.
- **Initial route is low-stakes.** A wrong/cheap start is recoverable via
  cross-agent escalation — which is what makes plan-time (and future structural)
  selection safe.
- **Determinism + review for free.** The decision is a PRD field, editable in the
  plan→run gap and replayed at run (the cleanest realization of original Goal 5).
- **No behavior change until opt-in.** Every path is a no-op until a user defines
  a profile and plans with it; single-agent ladders are unaffected.

### Negative

- **Re-plan to apply changes.** New/edited profiles need a re-plan to take effect;
  a story edited after plan can carry a stale assignment. v1 accepts this as the
  trade for determinism + review. The content hash can flag staleness at run setup.
- **`TIER_RANK` is a hardcoded three-name map.** Custom tier names are unrankable;
  the escalation-record fallback preserves genuinely-escalated custom tiers, but a
  config-derived ranking is the proper long-term fix (tracked follow-up).
- **`initialProfileId` is forward-looking.** Escalation today never rewrites
  `agentProfileId`, so `initialProfileId` currently always equals the live value;
  it becomes meaningful only when escalation starts reassigning profiles.
- **Agent/profile provenance now recorded.** `EscalationAttempt` carries `fromAgent`/`toAgent`
  for cross-agent jumps (written by `buildEscalationRecord`); `StructuredFailure` carries
  `agent`/`agentProfileId` for the producing agent context. `initialModelTier` is now
  persisted alongside `initialAgent` and `initialProfileId` (write-once at first route
  and plan time), enabling deterministic reset behavior per `autoMode.escalation.resetMode`.

### Neutral

- **Original `classification` block** is dropped as a routing prerequisite — the
  classifier already emits complexity/risks that cards match against. Keep §2 only
  if `analyze`/metrics want it independently.
- **Fallback stays a separate trigger** from escalation; they share the ladder but
  are not merged.

## Alternatives Considered

### A. Separate `assignAgentsOp` + `agent-route` session role (original §4)
Reinvents the classifier's persisted, cached, reasoned output and adds a new
session role and a second LLM call. Rejected — selection folds into decompose
(v1) or `classifyRouteOp` (deferred Part A).

### B. Keep escalation tier-only within one agent (original §6)
Factually wrong: cross-agent escalation was already coded. Keeping the premise
would leave the dead config in place and preserve the false "non-recoverable
agent" asymmetry. Rejected.

### C. Code-rules / keyword agent selection
Brittle on unusual stories and loses recoverability framing. The rubric-in-prompt
keeps an LLM adjudicating, guided — handles the unusual story and preserves
recoverability. Rejected as the *sole* mechanism (though escalation now makes
deterministic initial routing a legitimate *future* option, since the ladder
self-corrects upward).

### D. Per-domain / per-language ladders
Key `tierOrder` by domain and select the ladder from `story.classification` /
`detectLanguage`. Deferred — a single global capability order is sufficient
because escalation is a blunt "throw more capability at it" instrument. Revisit if
the global order proves too coarse.

## Open Questions

1. **Custom-tier ranking.** `TIER_RANK` should become config-derived if custom
   tier names are formally supported; today they rely on escalation-record
   evidence to survive a routing pass.
2. **Reset behavior and determinism.** `initialModelTier` is now persisted and
   governs reset. With `autoMode.escalation.resetMode: "initial"` (default),
   `resetFailedStoriesToPending` restores the origin rung, clears escalation
   history, and resets attempts; `resetMode: "last"` keeps the escalated
   rung but resets attempts. Clearing `escalations[]` in `"initial"` mode
   prevents `routing.ts` tier-preservation (BUG-032) from re-pinning the
   story to the exhausted rung on re-run — acceptable because live PRD state
   is not the permanent audit log (run logs/metrics carry full history).
   Whether to surface `initialAgent`/`initialModelTier` in `metrics/tracker.ts`
   is deferred.
3. **Staleness handling at run.** The content hash can flag a story edited after
   plan; whether run warns, ignores, or (future Part A) re-routes is open.
4. **Part A activation.** When/whether to ship run-time routing behind
   `routing.agents.strategy: "llm"`.

## Implementation

Phasing (v1 = Phases 0–2):

| Phase | Scope |
|:---|:---|
| **0** | Part B: `TierConfigSchema.agent`, `escalateTier` rung-index traversal, `initialAgent`/`initialProfileId`, cross-section validation |
| **1** | Part C config + plumbing: `routing.agents.profiles` schema, both superRefines, `routingProfile` on the PRD root, `--profile` on `nax plan` |
| **2** | Part C selection: capability cards in the decompose prompt, decompose output schema + parse + resolution + PRD write; run-side honor + mismatch warn; availability seam |
| **3** (deferred) | Part A: run-time routing folded into `classifyRouteOp` behind `routing.agents.strategy: "llm"` |

Consolidated review fixes (`2026-06-12-agent-routing-review-fixes.md`) closed:
profile tier seeding at the mapper (HIGH), `routingProfile` recording the resolved
config-profile name + run-side adoption (Delta C4), capability cards rendering
`weaknesses`/`affinity` + the ordered rubric, the availability seam
(`resolveExecutionAgent`), unknown-`agentProfileId` warn, `decision.agent`
precedence + `initialAgent` origin gating, custom-tier escalation preservation,
and schema hardening (`strategy:"llm"` needs profiles; binding error names the
remedy).

See the source plans for per-delta detail, file-level edits, and acceptance
criteria.

### Follow-up: Escalation-Completeness (gaps #1–#4 closed)

After the initial ADR-025 implementation, four gaps were identified and closed:

1. **Prompt-injection drop (gap #1):** `formatContextAsMarkdown` in `src/context/formatter.ts` now renders `prior-failures` and `planning-analysis` element types; both were previously computed by `buildContext` but silently discarded, preventing the agent from seeing the prior context.

2. **Agent/profile provenance (gap #2):** `EscalationAttempt` carries `fromAgent`/`toAgent` for cross-agent jumps (written by `buildEscalationRecord`); `StructuredFailure` carries `agent`/`agentProfileId` rendered into the prior-failures block shown to the next rung's agent.

3. **Pre-iteration prior context (gap #3):** `preIterationTierCheck` now populates `priorErrors`/`priorFailures` (budget-based, capped at 3) before escalating, matching the existing `handleTierEscalation` behavior and ensuring the escalated agent sees the context.

4. **Deterministic reset (gap #4):** `resetFailedStoriesToPending` now always resets `attempts = 0`. Per `autoMode.escalation.resetMode` (default `"initial"`), with `"initial"` mode the story restores the origin rung (`initialModelTier`, `initialAgent`) and clears `escalations[]`, preventing tier-preservation from re-pinning the story to an exhausted rung; with `"last"` mode the escalated rung is kept but attempts reset. `initialModelTier` is stamped write-once at first route and plan time, parallel to `initialAgent`.
