# ADR-012: Agent Manager Ownership

**Status:** Proposed
**Date:** 2026-04-18
**Author:** William Khoo, Claude
**Related:** ADR-011 (SessionManager precedent); #474 (Phase 5.5 fallback)

---

## Context

nax currently has three separate fallback / agent-selection mechanisms, each added at a different point in the project's evolution, each owned by the subsystem that first needed it. The result is behaviour that contradicts itself and config that no user can hold in their head.

### Current state — three owners, three configs

| Mechanism | Config key | Owner (code) | Era |
|:---|:---|:---|:---|
| Internal agent swap on auth / rate-limit | `autoMode.fallbackOrder` | `AcpAgentAdapter` (private state, `resolveFallbackOrder()`, `_unavailableAgents`) | Pre-ACP CLI era; migrated into ACP adapter verbatim |
| Default agent selection | `autoMode.defaultAgent` | Read from ~20+ call sites (routing, execution, tdd, acceptance, debate, review, autofix) | Pre-ACP CLI era |
| Execution-stage agent swap with context rebuild | `context.v2.fallback.{enabled,map,maxHopsPerStory,onQualityFailure}` | `src/pipeline/stages/execution.ts` + `src/execution/escalation/agent-swap.ts` + `src/context/engine/` | Phase 5.5 (#474) |

### Five concrete problems this created

1. **Auth fallback silently no-ops when `fallbackOrder` is unset.** T16.3 dogfood fixture configured `context.v2.fallback.map: {"claude":["codex"]}` but not `autoMode.fallbackOrder`. On 401 auth the adapter throws `AllAgentsUnavailableError` (because `resolveFallbackOrder` returns `[]`), the exception becomes a generic failure result with *no* `adapterFailure` set, `shouldAttemptSwap(undefined, …)` returns false, and Phase 5.5 never runs. Two fallback configs, zero actual fallback.

2. **Adapter owns cross-agent policy.** `AcpAgentAdapter` holds `_unavailableAgents` and `resolveFallbackOrder` as private state. A second adapter (codex, gemini) would need its own parallel copy of the same policy, with no shared view of which agents are already known-unavailable.

3. **Context engine owns a fallback decision it should not.** `context.v2.fallback` is under `context/` because Phase 5.5 needed context-bundle rebuild on swap. But "should we swap?" is not a context concern — context should only expose `rebuildForAgent(bundle, targetProfile)` as a utility that fallback logic can call.

4. **Default agent is read from 79 sites.** Every call site that needs to know "what's the primary agent?" does `config.autoMode.defaultAgent`. There is no shared accessor, no cache, no audit trail of agent selection decisions. Changing the selection policy requires touching every site.

5. **Config drift is user-visible.** Users cannot tell from the schema which key actually drives fallback. `autoMode.fallbackOrder: ["claude"]` (flat list) and `context.v2.fallback.map: {"claude":["codex"]}` (keyed map) coexist, default to incompatible shapes, and have overlapping-but-different semantics.

The T16.3 failure was the canary. The real forcing function is polyglot agent support — once there are ≥2 real agents a user might swap between, the current split ownership becomes untenable.

---

## Decision

Move agent *lifecycle and policy* out of the ACP adapter and out of the context engine into a dedicated `AgentManager` (mirrors the SessionManager extraction of ADR-011). Consolidate all three configs under `config.agent`.

### Ownership boundary

```
AgentManager  (src/agents/manager.ts)         AcpAgentAdapter  (src/agents/acp/adapter.ts)
─────────────────────────────────────────     ─────────────────────────────────────────
Owns:                                         Owns:
  - Default agent resolution                    - acpx process lifecycle
  - Fallback chain (flat or keyed map)          - sendPrompt / multi-turn loop
  - Per-run unavailable-agent tracking          - token / cost tracking
  - shouldSwap(failure) decision                - prompt audit
  - nextCandidate(current, failure)             - RunResult with adapterFailure
  - Swap event emission                           (category/outcome/retriable)
  - Registry cache (per-run)

Does NOT own:                                 Does NOT own:
  - acpx process                                - fallback decisions
  - context rendering                           - unavailable-agent state
                                                - cross-agent policy

ContextOrchestrator  (src/context/engine/)
─────────────────────────────────────────
Owns:
  - rebuildForAgent(bundle, targetProfile) — called by AgentManager
  - Does NOT own: "should we swap?" decision
```

### Canonical config shape — `config.agent`

```jsonc
{
  "agent": {
    "protocol": "acp",                 // existing
    "default": "claude",               // from autoMode.defaultAgent
    "maxInteractionTurns": 20,         // existing
    "fallback": {
      "enabled": true,                 // single source of truth for swap enablement
      "map": {                         // keyed by failing agent → candidates in order
        "claude": ["codex"]
      },
      "maxHopsPerStory": 2,
      "onQualityFailure": false,       // swap also on review/verify reject
      "rebuildContext": true           // whether to call ContextOrchestrator.rebuildForAgent
    }
  }
}
```

### Migration shim (pattern exists — see `.claude/rules/config-patterns.md` §Compatibility Shim)

In `src/config/loader.ts`, before schema parse:

| Legacy key | Migrated to | Warn level |
|:---|:---|:---|
| `autoMode.defaultAgent` | `agent.default` | `logger.warn` once per load |
| `autoMode.fallbackOrder: [A, B, C]` | `agent.fallback.map: { A: [B, C] }` (infer keyed map from flat list by using default agent as key) | `logger.warn` once per load |
| `context.v2.fallback` | `agent.fallback` (direct copy) | `logger.warn` once per load |

Shim lives for 3 canary releases, then removed. Users get a clear migration message during that window.

### Mapping to new primitives

| Old call | New call |
|:---|:---|
| `config.autoMode.defaultAgent` | `agentManager.getDefault()` |
| `AcpAgentAdapter.resolveFallbackOrder(config, agent)` | `agentManager.resolveFallbackChain(agent, failure)` |
| `shouldAttemptSwap(failure, fallbackConfig, hops, bundle)` from `src/execution/escalation/agent-swap.ts` | `agentManager.shouldSwap(failure)` |
| `context.v2.fallback.map[agent][i]` | `agentManager.nextCandidate(agent, failure)` |
| `AcpAgentAdapter._unavailableAgents` (private) | `agentManager.isUnavailable(agent)` (public) |
| Inline swap loop in `pipeline/stages/execution.ts` | `agentManager.runWithFallback(...)` (higher-level op) |

Adapters become dumb: `run()` returns `RunResult` with `adapterFailure: { category, outcome, retriable, message }`. They no longer throw `AllAgentsUnavailableError`. The manager decides what to do.

---

## Consequences

### Positive

- **Single source of truth**: one config block (`config.agent`), one manager, one set of decisions.
- **Fixes the T16.3 bug by construction**: `AgentManager.shouldSwap` runs regardless of which legacy key the user set, because both are migrated to `agent.fallback` before it is consulted.
- **Polyglot agents become feasible**: unavailable-agent state is shared across adapters, not siloed per-adapter.
- **Context engine is freed**: `context.v2.fallback` goes away; `ContextOrchestrator.rebuildForAgent` stays as a pure utility.
- **Auditability**: agent selection decisions become first-class events (`onAgentSelected`, `onSwapAttempt`, `onAgentUnavailable`), usable by reporters and the TUI.

### Negative

- **Broad blast radius**: 79 call sites read `autoMode.defaultAgent` today; all migrate to `agentManager.getDefault()`. Automatable with a codemod but still touches every subsystem.
- **One more manager to reason about**: AgentManager joins SessionManager and the Runner. The instinct will be to stuff more into it over time — we must be strict about the ownership boundary above.
- **Breaks in-flight user configs**: users who hand-wrote `autoMode.fallbackOrder` or `context.v2.fallback` see a warning for 3 canaries. Acceptable cost for consolidating; documented in CHANGELOG.

### Out of scope for this ADR

- Renaming `autoMode` → `routing` (routing concerns: `complexityRouting`, `escalation.tierOrder` — legitimate, but separate cleanup).
- Multi-agent concurrent execution (would need per-story agent locking; this ADR is fallback-only).
- Persisting unavailable-agent state across runs (intentionally per-run only — auth transients should not permanently exclude an agent).

---

## Implementation Plan (Phased)

**Phase 1 — AgentManager skeleton (no behaviour change)**
- Create `src/agents/manager.ts` with `IAgentManager` interface.
- Manager wraps existing `createAgentRegistry(config)` and exposes `getDefault()`, `isUnavailable()`, `markUnavailable()` as pass-throughs to current state.
- Thread `agentManager` through `PipelineContext` and `Runner`.
- All call sites still read `config.autoMode.defaultAgent`; no migration yet.

**Phase 2 — Config consolidation + migration shim**
- Add `AgentConfigSchema` with `default`, `fallback`, inheriting existing `protocol` + `maxInteractionTurns`.
- Add migration shim in `loader.ts` (pre-parse, logs warn on each legacy key).
- Update `src/config/defaults.ts` — `config.agent` becomes the canonical location.

**Phase 3 — Migrate call sites (codemod + manual review)**
- Replace `config.autoMode.defaultAgent` → `agentManager.getDefault()` at all 79 sites via codemod.
- Replace `config.autoMode.fallbackOrder` → `agentManager.resolveFallbackChain(agent)` at 3 sites.
- Replace `config.context.v2.fallback` → `agentManager.getFallbackConfig()` at 2 sites.
- Per-PR commit per subsystem: routing / execution / tdd / acceptance / debate / review / autofix.

**Phase 4 — Adapter cleanup**
- Remove `AcpAgentAdapter._unavailableAgents`, `resolveFallbackOrder()`, `_unavailableAgents` markers.
- Auth / rate-limit handlers now return `adapterFailure: { category: "availability", outcome: "fail-auth" | "fail-rate-limit", retriable: true }` instead of throwing `AllAgentsUnavailableError`.
- Delete `AllAgentsUnavailableError` class (no longer thrown).

**Phase 5 — Execution-stage consolidation**
- Collapse the inline swap loop in `pipeline/stages/execution.ts` into `agentManager.runWithFallback(request)`.
- `src/execution/escalation/agent-swap.ts` becomes a thin adapter over AgentManager (or deletes entirely, logic moves into manager).
- `ContextOrchestrator.rebuildForAgent` becomes the only context-side API; `context.v2.fallback` schema entry is removed (shim still accepts the legacy key).

**Phase 6 — Remove migration shim**
- 3 canaries after Phase 2 lands, delete the shim.
- Schema no longer accepts `autoMode.defaultAgent`, `autoMode.fallbackOrder`, `context.v2.fallback`.
- `AllAgentsUnavailableError` stays deleted.

---

## Alternatives Considered

**(a) Leave architecture, fix T16.3 fixture only.**
Add `autoMode.fallbackOrder: ["claude", "codex"]` to the fixture. File the uncaught-exception bug separately. Lowest blast radius, but leaves the structural drift — the next agent-related feature will pick a side and make it worse.

**(b) Merge fallback into SessionManager.**
SessionManager already owns session lifecycle; agent-per-session is adjacent. Rejected: SessionManager is about *this* session's state machine; agent-selection is about *which* adapter to use for the next session. Different axis; conflating them would re-create the ADR-008 → ADR-011 problem.

**(c) Keep both configs, document precedence.**
Declare `context.v2.fallback` wins when both are set. Rejected: documents the drift instead of fixing it; users still have to know both exist; T16.3-style silent no-ops still possible when one is set and the other is not.

---

## References

- ADR-011: SessionManager Ownership (precedent for extracting lifecycle from adapter)
- Issue #474: Phase 5.5 availability fallback (introduced `context.v2.fallback`)
- `.claude/rules/config-patterns.md` — Compatibility Shim pattern
- T16.3 dogfood finding: `/nax-dogfood/fixtures/fallback-probe/.nax/features/fallback-probe/runs/2026-04-18T09-27-27.jsonl`
