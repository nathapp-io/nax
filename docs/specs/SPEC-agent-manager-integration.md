# SPEC: Agent Manager — Ownership & Integration Design

> **Status:** Draft. Companion to [ADR-012](../adr/ADR-012-agent-manager-ownership.md). Details how `AgentManager` takes ownership of agent lifecycle, fallback policy, and config resolution, and how it integrates with the existing `AgentAdapter` interface and `SessionManager`.
>
> **Tracking:** #552 · **ADR:** PR #551
> **Related issues:** #523 (prompt-audit → SessionManager, non-blocking) · #529 (AgentRunOptions cleanup, blocks Phase 4) · #518 (credential pre-validation, folded into Phase 2) · #519 (fallback aggregates, folded into Phase 5)

---

## Scope Boundaries

### Retry layers — what moves and what does not

Three retry layers exist. This spec moves **only one**.

| Layer | Trigger | Current location | Post-ADR location |
|:---|:---|:---|:---|
| **Availability retry** | Auth (401), quota (429), service-down (5xx), connection refused | `AcpAgentAdapter._unavailableAgents` + execution-stage inline loop | **AgentManager.runWithFallback** |
| **Transport retry** | Broken socket, stale session, `QUEUE_DISCONNECTED_BEFORE_COMPLETION` | `AcpAgentAdapter` — `sessionErrorRetryable` loop | **Adapter** (unchanged) |
| **Payload-shape retry** | JSON parse failed, schema-validation failed | `src/review/semantic.ts`, `src/review/adversarial.ts` | **Caller** (unchanged) |

Availability retry is cross-agent policy; transport retry is same-agent protocol concern; payload-shape retry is output-validation concern. The boundary matters — if `runWithFallback` swallows a JSON-parse retry, the agent gets swapped mid-review and the next reviewer starts cold without conversation history.

### `run()` vs `complete()` — not consolidated

`AgentAdapter.run()` (multi-turn, tool use, interaction bridge, `AgentResult` with `adapterFailure`) and `AgentAdapter.complete()` (one-shot, no tools, returns `CompleteResult`) remain separate entry points. Option shapes (~18 fields each, ~4 overlap) diverge enough that a single entry point produces option-soup.

AgentManager exposes `runWithFallback(request)` in this spec. `completeWithFallback(prompt, options)` is tracked in **#567** as a follow-up. Today `complete()` has no fallback at all.

### Cost tracking — no new manager

`src/agents/cost/` already parses and populates `AgentResult.estimatedCost` + `tokenUsage` on every call. `src/metrics/tracker.ts` aggregates across stories. AgentManager adds one field — `AgentFallbackRecord.costUsd` — for wasted-hop visibility. No new cost subsystem.

### Prompt audit — lives on SessionManager

Prompt audit moves from `AcpAgentAdapter` to `SessionManager` per #523, independent of this spec. AgentManager emits `onSwapAttempt` events that SessionManager correlates into the audit trail via stable `sess-<uuid>`. #523 can land before or after #552 Phase 1-3; phases 4-6 prefer #523 landed first for cleaner handoff emission.

---

## Current Architecture

### Who owns what today

```
                      AGENT POLICY (scattered across 3 owners)
                      ========================================

Config                                 src/config/schemas.ts
  autoMode.defaultAgent       ──┐
  autoMode.fallbackOrder      ──┤
  context.v2.fallback.map     ──┤     79 direct reads of autoMode.defaultAgent
  context.v2.fallback.enabled ──┤      3 direct reads of autoMode.fallbackOrder
  context.v2.fallback.maxHops ──┤      2 direct reads of context.v2.fallback
                                 │
                                 ▼
  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
  │ AcpAgentAdapter      │  │ Execution stage      │  │ ContextOrchestrator  │
  │ (adapter.ts)         │  │ (execution.ts)       │  │ (context/engine/)    │
  ├──────────────────────┤  ├──────────────────────┤  ├──────────────────────┤
  │ _unavailableAgents   │  │ ctx.agentSwapCount   │  │ rebuildForAgent()    │
  │ resolveFallback-     │  │ ctx.agentFallbacks[] │  │                      │
  │   Order(config)      │  │ inline swap loop     │  │                      │
  │ markUnavailable()    │  │ shouldAttemptSwap()  │  │                      │
  │ auth handler         │  │   ← from escalation/ │  │                      │
  │   throws             │  │     agent-swap.ts    │  │                      │
  │   AllAgentsUnavail-  │  │                      │  │                      │
  │   ableError          │  │                      │  │                      │
  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
         │                           │                          │
         └───────────── no shared state ─────────────────────────┘
```

### Problems with this design

| # | Problem | Evidence |
|:--|:--------|:---------|
| 1 | Three configs for one concern | `autoMode.defaultAgent`, `autoMode.fallbackOrder`, `context.v2.fallback` all affect agent selection |
| 2 | Two mechanisms silently disagree | T16.3 fixture set `context.v2.fallback.map` but not `fallbackOrder` → auth failure, `AllAgentsUnavailableError` thrown, Phase 5.5 never runs, tier escalation kicks in instead |
| 3 | Adapter owns cross-agent policy | `_unavailableAgents` is private state on one `AcpAgentAdapter` instance; a second adapter has no shared view |
| 4 | Context engine owns a non-context decision | "Should we swap?" lives in `src/execution/escalation/agent-swap.ts` but is driven by a config key under `context/` — semantic mismatch |
| 5 | No shared default-agent accessor | 79 call sites read `config.autoMode.defaultAgent` directly; no audit trail of selection decisions |
| 6 | Adapter throws where it should return | Auth failure with empty fallback list throws `AllAgentsUnavailableError`; bypasses `adapterFailure` contract Phase 5.5 relies on |

The T16.3 failure was the canary. Polyglot agent support (≥2 real agents) is the forcing function.

---

## Target Architecture

### Separation of concerns

```
AGENT MANAGER                             AGENT ADAPTER
(src/agents/manager.ts)                   (src/agents/acp/adapter.ts)
========================================  ========================================
Owns:                                     Owns:
  - Default agent resolution                - Physical session (acpx process)
  - Fallback chain (keyed map)              - Protocol-specific operations
  - Per-run unavailable-agent state           (loadSession, createSession,
  - shouldSwap(failure) decision              sendPrompt, closeSession)
  - nextCandidate(current, failure)         - Multi-turn interaction loop
  - runWithFallback(request)                - Token usage / cost tracking
  - Agent event emission                    - Prompt audit
    (onSelected, onSwapAttempt,             - Returns RunResult with
     onUnavailable)                           adapterFailure on failure

Does NOT own:                             Does NOT own:
  - acpx process                            - Fallback decisions
  - Context rendering                       - Unavailable-agent state
  - Session state                           - Cross-agent policy
  - Protocol details                        - Default agent resolution
                                            - Throwing AllAgentsUnavailableError


CONTEXT ORCHESTRATOR                      SESSION MANAGER (unchanged — ADR-011)
(src/context/engine/)                     (src/session/manager.ts)
========================================  ========================================
Owns:                                     Owns:
  - rebuildForAgent(bundle, profile)        - Stable session ID
    called by AgentManager                  - State machine
                                            - Scratch dir
Does NOT own:                               - handoff(id, newAgent) called by
  - Fallback decisions                        AgentManager on swap
  - Agent selection
```

### New call flow — execution stage with fallback

```
Pipeline stage (execution.ts)
  │
  │  ctx.agentManager.runWithFallback({
  │    prompt, workdir, modelTier, sessionId, ...
  │  })
  │
  ▼
AgentManager.runWithFallback(request)
  │
  │  1. RESOLVE primary agent
  │     manager.getDefault()  →  "claude"
  │     manager.isUnavailable("claude")  →  false
  │
  │  2. CALL adapter.run(request)
  │     returns RunResult with success / adapterFailure
  │
  │  3. ON availability failure
  │     manager.shouldSwap(failure)  →  true
  │     manager.nextCandidate("claude", failure)  →  "codex"
  │     manager.markUnavailable("claude")
  │
  │  4. REBUILD context (if config.agent.fallback.rebuildContext)
  │     contextOrchestrator.rebuildForAgent(bundle, "codex")
  │     writeRebuildManifest(...)
  │
  │  5. HANDOFF session (ADR-011 integration)
  │     sessionManager.handoff(sessionId, "codex", failure.outcome)
  │
  │  6. EMIT event
  │     manager.events.emit("onSwapAttempt", { from, to, failure, hop })
  │
  │  7. RETRY adapter.run() with "codex"
  │     on success → return result with agentFallbacks[] populated
  │     on failure → loop (up to maxHopsPerStory)
  │
  │  8. EXHAUSTED
  │     return final RunResult; never throws
  │
  ▼
RunResult { success, agentFallbacks: [{priorAgent, newAgent, hop, …}] }
```

---

## Interface Changes

### New: `IAgentManager`

```typescript
// src/agents/manager.ts
export interface IAgentManager {
  /** Resolve the default agent name from config.agent.default */
  getDefault(): string;

  /** True if the agent is marked unavailable for this run */
  isUnavailable(agent: string): boolean;

  /** Mark an agent unavailable for this run (auth/quota/service-down) */
  markUnavailable(agent: string, reason: AdapterFailure): void;

  /**
   * Resolve the ordered fallback chain for a given agent given a failure.
   * Consults config.agent.fallback.map[agent] and filters unavailable ones.
   */
  resolveFallbackChain(agent: string, failure: AdapterFailure): string[];

  /**
   * Pure-function decision: should we attempt a swap for this failure?
   * Checks: fallback.enabled, hop cap, failure.category === "availability"
   *         (or onQualityFailure flag), bundle exists, candidate exists.
   */
  shouldSwap(
    failure: AdapterFailure | undefined,
    hopsSoFar: number,
    bundle: ContextBundle | undefined,
  ): boolean;

  /**
   * Return the next candidate agent given the current agent and swap count.
   * Returns null when no more candidates at this hop.
   */
  nextCandidate(current: string, hopsSoFar: number): string | null;

  /**
   * Higher-level op — runs the adapter and drives the swap loop.
   * Returns the final RunResult (success or exhausted-failure).
   * Never throws.
   */
  runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome>;

  /** Reset per-run state (at run boundary) */
  reset(): void;

  /** Event surface */
  readonly events: AgentManagerEvents;
}

export interface AgentRunOutcome {
  result: RunResult;
  /** List of fallback hops taken during this run */
  fallbacks: AgentFallbackRecord[];
}

export interface AgentFallbackRecord {
  storyId?: string;
  priorAgent: string;
  newAgent: string;
  hop: number;
  outcome: AdapterFailure["outcome"];
  category: AdapterFailure["category"];
  timestamp: string;
  /** Cost (USD) of the failed hop that triggered this swap — sourced from RunResult.estimatedCost. Consumed by #519 aggregates. */
  costUsd: number;
}
```

### Modified: `AcpAgentAdapter.run()`

**Before:**
```typescript
// Auth handler at line ~531
if (parsed.type === "auth") {
  this.markUnavailable(currentAgent);
  const fallbacks = this.resolveFallbackOrder(config, currentAgent);
  if (fallbacks.length === 0) {
    throw new AllAgentsUnavailableError([...this._unavailableAgents]);
  }
  currentAgent = fallbacks[0];
  // retry...
}
```

**After:**
```typescript
// Auth handler — no internal fallback, just surface the failure
if (parsed.type === "auth") {
  return {
    success: false,
    exitCode: 1,
    output: error.message,
    rateLimited: false,
    durationMs: Date.now() - startTime,
    estimatedCost: 0,
    adapterFailure: {
      category: "availability",
      outcome: "fail-auth",
      retriable: false, // at adapter level; manager decides cross-agent retry
      message: error.message.slice(0, 500),
    },
  };
}
// manager.runWithFallback() will see the adapterFailure and drive the swap
```

Rate-limit handler follows the same pattern — returns `adapterFailure` instead of looping internally.

**Deleted:**
- `AcpAgentAdapter._unavailableAgents` (state)
- `AcpAgentAdapter.resolveFallbackOrder()` (policy)
- `AcpAgentAdapter.markUnavailable()` (now on AgentManager)
- `AllAgentsUnavailableError` class (no longer thrown)

### Config — `AgentConfigSchema`

```typescript
// src/config/schemas.ts
const AgentFallbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  map: z.record(z.array(z.string())).default({}),
  maxHopsPerStory: z.number().int().min(1).max(10).default(2),
  onQualityFailure: z.boolean().default(false),
  rebuildContext: z.boolean().default(true),
});

const AgentConfigSchema = z.object({
  protocol: z.enum(["acp", "cli"]).default("acp"),           // existing
  default: z.string().trim().min(1).default("claude"),       // from autoMode.defaultAgent
  maxInteractionTurns: z.number().int().min(1).default(20),  // existing
  fallback: AgentFallbackConfigSchema.default({}),           // consolidates 2 legacy keys
});
```

Canonical config shape:

```jsonc
{
  "agent": {
    "protocol": "acp",
    "default": "claude",
    "maxInteractionTurns": 20,
    "fallback": {
      "enabled": true,
      "map": { "claude": ["codex"], "codex": ["claude"] },
      "maxHopsPerStory": 2,
      "onQualityFailure": false,
      "rebuildContext": true
    }
  }
}
```

---

## Migration Shim

Pattern exists — see `.claude/rules/config-patterns.md` §Compatibility Shim.

```typescript
// src/config/loader.ts — applied BEFORE safeParse
function applyAgentConfigMigration(
  conf: Record<string, unknown>,
  logger: Logger,
): Record<string, unknown> {
  const migrated = { ...conf };
  const agent = { ...((migrated.agent as Record<string, unknown>) ?? {}) };

  // 1. autoMode.defaultAgent → agent.default
  const autoMode = migrated.autoMode as Record<string, unknown> | undefined;
  if (autoMode?.defaultAgent !== undefined && agent.default === undefined) {
    logger.warn(
      "config",
      "autoMode.defaultAgent is deprecated — use agent.default (see ADR-012)",
      { legacy: autoMode.defaultAgent },
    );
    agent.default = autoMode.defaultAgent;
  }

  // 2. autoMode.fallbackOrder → agent.fallback.map[default]
  //    flat list [A, B, C] with default=A becomes { A: [B, C] }
  if (Array.isArray(autoMode?.fallbackOrder) && autoMode.fallbackOrder.length > 1) {
    logger.warn(
      "config",
      "autoMode.fallbackOrder is deprecated — use agent.fallback.map (see ADR-012)",
      { legacy: autoMode.fallbackOrder },
    );
    const [primary, ...rest] = autoMode.fallbackOrder as string[];
    const fallback = { ...((agent.fallback as Record<string, unknown>) ?? {}) };
    const map = { ...((fallback.map as Record<string, string[]>) ?? {}) };
    if (!map[primary]) map[primary] = rest;
    fallback.map = map;
    if (fallback.enabled === undefined) fallback.enabled = true;
    agent.fallback = fallback;
  }

  // 3. context.v2.fallback → agent.fallback (direct shape match)
  const ctxFallback = (migrated.context as Record<string, unknown>)?.v2 as
    | Record<string, unknown>
    | undefined;
  if (ctxFallback?.fallback !== undefined && agent.fallback === undefined) {
    logger.warn(
      "config",
      "context.v2.fallback is deprecated — use agent.fallback (see ADR-012)",
      {},
    );
    agent.fallback = ctxFallback.fallback;
    // leave ctxFallback.fallback in place; schema will ignore unknown keys post-Phase 6
  }

  migrated.agent = agent;
  return migrated;
}
```

**Warn-once semantics:** warnings fire once per `loadConfig()` call, not per `loadConfig()` read from multiple places. The logger dedupes by message.

**Shim lifetime:** 3 canary releases (per ADR). After Phase 6 the shim is deleted and the schema no longer accepts the legacy keys.

---

## Pipeline Stage Integration — Who Calls What

### execution.ts — before vs after

**Before (current, 150+ lines of inline swap loop):**
```typescript
const result = await agent.run({ ...options });
ctx.agentResult = result;

if (!result.success) {
  const fallbackConfig = ctx.config.context?.v2?.fallback;
  if (fallbackConfig && ctx.contextBundle) {
    const primaryAgentId = ctx.routing.agent ?? ctx.rootConfig.autoMode.defaultAgent;
    let workingBundle = ctx.contextBundle;
    let failure = result.adapterFailure;

    while (_executionDeps.shouldAttemptSwap(failure, fallbackConfig, ctx.agentSwapCount ?? 0, workingBundle)) {
      // 100+ lines: resolve target, rebuild bundle, write manifest, handoff session,
      //             emit log, rerun adapter, update ctx.agentFallbacks, continue loop
    }
  }
}
```

**After (~5 lines):**
```typescript
const outcome = await ctx.agentManager.runWithFallback({
  prompt: ctx.prompt,
  bundle: ctx.contextBundle,
  sessionId: ctx.sessionId,
  runOptions: baseRunOptions,
});
ctx.agentResult = outcome.result;
ctx.agentFallbacks = outcome.fallbacks;
ctx.agentSwapCount = outcome.fallbacks.length;
```

### All 79 `autoMode.defaultAgent` sites

Codemod pattern:

```diff
- config.autoMode.defaultAgent
+ ctx.agentManager.getDefault()      // when ctx is in scope
+ agentManager.getDefault()          // when agentManager is threaded through

- ctx.rootConfig.autoMode.defaultAgent
+ ctx.agentManager.getDefault()
```

Reviewer must confirm `agentManager` is threaded into each call site; the runner already owns `agentManager` and passes it through `PipelineContext` alongside `sessionManager`.

---

## Failure Classification

`AdapterFailure.category` is the single discriminator `AgentManager.shouldSwap` uses.

| Category | When adapter returns it | Manager action |
|:---|:---|:---|
| `availability` | Auth (401), quota (429), rate-limit with retryAfter, service down (5xx), connection refused | `shouldSwap = true` (if hops left, bundle exists, config enabled) |
| `quality` | Review rejected, verify failed, test regression, unknown error | `shouldSwap = true` only if `onQualityFailure: true` |
| *(none — success)* | `result.success === true` | No swap |

**Invariant:** the adapter must NEVER throw for a classifiable failure. If the adapter throws, `AgentManager.runWithFallback` catches it as a last-resort `{ category: "quality", outcome: "fail-unknown" }` and still returns a `RunResult` — never propagates the exception.

---

## Event Surface

```typescript
export interface AgentManagerEvents {
  on(event: "onAgentSelected", listener: (e: { agent: string; reason: string }) => void): void;
  on(event: "onSwapAttempt", listener: (e: AgentFallbackRecord) => void): void;
  on(event: "onAgentUnavailable", listener: (e: { agent: string; failure: AdapterFailure }) => void): void;
  on(event: "onSwapExhausted", listener: (e: { storyId?: string; hops: number }) => void): void;
}
```

**Consumers:**
- `Reporter` plugins — surface swaps in run summary
- TUI — show current agent + recent swaps in the status bar
- Prompt audit — correlate which agent produced which prompt

---

## File Surface

### New
- `src/agents/manager.ts` — AgentManager implementation (~300 LOC)
- `src/agents/manager-types.ts` — `IAgentManager`, `AgentRunOutcome`, `AgentFallbackRecord`, events
- `test/unit/agents/manager.test.ts` — unit tests for manager
- `test/integration/agents/manager-fallback.test.ts` — end-to-end fallback scenarios

### Modified
- `src/config/schemas.ts` — add `AgentConfigSchema`, deprecate legacy keys in JSDoc
- `src/config/loader.ts` — add `applyAgentConfigMigration()` shim
- `src/agents/acp/adapter.ts` — delete `_unavailableAgents`, `resolveFallbackOrder`, throw → return
- `src/agents/registry.ts` — `createAgentRegistry` stays, but `AgentManager` wraps it
- `src/pipeline/types.ts` — add `agentManager: IAgentManager` to `PipelineContext`
- `src/pipeline/stages/execution.ts` — collapse swap loop into `manager.runWithFallback()`
- `src/execution/escalation/agent-swap.ts` — delete (logic moves into manager)
- `src/context/engine/orchestrator.ts` — `rebuildForAgent()` stays, used only by manager
- **79 call sites reading `autoMode.defaultAgent`** — codemod to `agentManager.getDefault()`

### Deleted
- `src/errors.ts::AllAgentsUnavailableError` (never thrown)
- Legacy fields in `AutoModeConfigSchema`: `defaultAgent`, `fallbackOrder` (after Phase 6)
- `context.v2.fallback` schema entry (after Phase 6)

### Unchanged
- `AgentAdapter` interface shape — only implementation behaviour changes
- `SessionManager` interface — `handoff()` already exists, called by manager on swap
- `ContextOrchestrator.rebuildForAgent()` — already a pure utility

---

## Phased Implementation Detail

Maps ADR-012's 6 phases to concrete deliverables.

### Sequencing rules

- **#529 must land before Phase 4** — Phase 4 rewrites the same `AcpAgentAdapter` handlers that #529 cleans up.
- **#518 folds into Phase 2** — credential pre-validation lives on AgentManager.
- **#519 folds into Phase 5** — fallback aggregates consume `AgentFallbackRecord`.
- **#523 is non-blocking** — can land in parallel with Phase 1-3.
- **completeWithFallback** — tracked in **#567**, lands between Phase 4 and Phase 5.

### Dependency integration plan

Detail for each dependency — what lands where, what code moves, what tests cover it, how it proves the fold-in completed.

#### #529 — AgentRunOptions cleanup (hard blocker before Phase 4)

**Why blocker:** Phase 4 rewrites `AcpAgentAdapter.run()`'s auth / rate-limit handlers — the same ~100-line region that still branches on `options.keepSessionOpen`, `options.acpSessionName`, and the `buildSessionName()` fallback. Landing Phase 4 first forces the rewrite to carry Phase-5.5 legacy comments and rebases badly when #529 finally lands.

**Landing order:**

1. **#529 PR** — removes `keepSessionOpen`, `acpSessionName`, `buildSessionName`, deletes the `!options.keepSessionOpen` branches in `_runWithClient` finally block. Adapter's close-decision now reads `SessionDescriptor` state.
2. **Phase 4 PR** — opens *only after #529 is merged*, with a blocking checklist item "`grep -rn 'buildSessionName\\|keepSessionOpen\\|acpSessionName' src/` returns 0 hits".

**Tripwire:** CI grep check added in Phase 4 so the same legacy fields cannot be reintroduced.

#### #518 — Fallback credential pre-validation (folds into Phase 2)

**Status:** Implemented in PR (feat/agent-manager-foundation)

**What moves to AgentManager:**

```typescript
// src/agents/manager.ts — added in Phase 2
interface IAgentManager {
  /**
   * Validate credentials for the default agent and every agent referenced in
   * agent.fallback.map. Called once at runSetupPhase().
   *
   * - Missing primary credentials → throws NaxError (fail fast)
   * - Missing fallback candidate → logger.warn + prune from runtime map
   *
   * The runtime (pruned) map is the one consulted by resolveFallbackChain().
   */
  validateCredentials(): Promise<void>;
}
```

**Integration point:** `src/execution/lifecycle/run-setup.ts`

```typescript
// run-setup.ts — added next to existing validation calls
await ctx.agentManager.validateCredentials();
```

**Credential probe:** delegated to each adapter via a new `adapter.hasCredentials(): Promise<boolean>` capability (or a reusable env-var check keyed off `modelDef.env`). The probe contract is a boolean — adapters own how they test (env var presence, ping endpoint, etc.).

**Logging format:**
```
[agent-manager] WARN Fallback candidate pruned — missing credentials
  { primary: "claude", pruned: "codex", reason: "CODEX_API_KEY not set" }
```

**AC alignment with #518:**
- [ ] `runSetupPhase` validates every agent referenced in `agent.fallback.map` — satisfied via `validateCredentials()`
- [ ] Missing credentials → warning + pruned — satisfied by returning a filtered map from `resolveFallbackChain()`
- [ ] Primary missing credentials → `NaxError` — satisfied by throw in `validateCredentials()`
- [ ] Unit test in `test/unit/execution/lifecycle/run-setup.test.ts`

**Closure:** #518 closed by the same PR that merges Phase 2.

#### #519 — Run-level fallback aggregates (folds into Phase 5)

**What changes in Phase 5:**

1. `AgentFallbackRecord.costUsd` populated per hop (already in spec §Interface Changes) — sourced from failed-hop `RunResult.estimatedCost`.
2. `src/metrics/tracker.ts` gains a `deriveRunFallbackAggregates()` helper that walks `storyMetrics[].fallback.hops[]`.
3. `RunSummary` gains a `fallback` section:

```typescript
// src/metrics/types.ts — extended in Phase 5
interface RunSummary {
  // ... existing
  fallback?: {
    totalHops: number;
    perPair: Record<string, number>;        // "claude->codex": 3
    exhaustedStories: string[];             // storyIds that ran out of candidates
    totalWastedCostUsd: number;             // sum of failed-hop costs
  };
}
```

4. `src/execution/lifecycle/run-completion.ts` populates `RunSummary.fallback` from the aggregate helper.
5. Optionally emit a parallel `metrics.events.push({ type: "agent.fallback.triggered", ... })` stream for consumers keyed on the spec's original event shape.

**AC alignment with #519:**
- [ ] `RunSummary` includes `fallback: { totalHops, perPair, exhaustedStories }` — satisfied by the extended shape above
- [ ] Unit test in `test/unit/metrics/tracker.test.ts` covers aggregation
- [ ] Run-completion surfacing covered in `test/unit/execution/lifecycle/run-completion*.test.ts`

**Closure:** #519 closed by the same PR that merges Phase 5.

#### #523 — Prompt-audit → SessionManager (non-blocking, parallel track)

**Why non-blocking:** ownership of prompt-audit is a SessionManager concern (per ADR-011); AgentManager only needs to *emit* swap events that SessionManager correlates. The two extractions touch disjoint files except for the adapter call-site.

**Coordination contract between AgentManager and SessionManager:**

```typescript
// AgentManager emits:
manager.events.on("onSwapAttempt", (record: AgentFallbackRecord) => {
  // SessionManager subscribes — annotates audit trail with swap boundary
  sessionManager.recordSwap({
    sessionId: record.sessionId,           // stable sess-<uuid>
    priorAgent: record.priorAgent,
    newAgent: record.newAgent,
    hop: record.hop,
  });
});
```

**Landing scenarios:**

| #523 lands first | #523 lands after | Recommended |
|:---|:---|:---|
| Phase 4 emits directly to `sessionManager.auditPrompt()` via the new API — cleanest | Phase 4 emits via legacy `src/agents/acp/prompt-audit.ts`, then #523 rewires the subscription path after the fact | **#523 first** if bandwidth allows; either order is safe |

**Coordination during the migration window:** both paths coexist (adapter may call both `prompt-audit.ts` and the new session-manager hook) — standard 2-writer pattern until #523 closes.

**No AC changes to #552 phases** — #523 has its own acceptance list.

#### #567 — `completeWithFallback()` (lands between Phase 4 and Phase 5)

**Why sandwiched between Phase 4 and Phase 5:**

- After Phase 4 — the adapter's return-vs-throw contract exists for `run()`; #567 applies the same pattern to `complete()`.
- Before Phase 5 — Phase 5 execution-stage consolidation shouldn't have to reason about two different fallback primitives evolving in parallel.

**Delta for AgentManager:**

```typescript
// Added in #567, not in #552
interface IAgentManager {
  completeWithFallback(
    prompt: string,
    options: CompleteOptions,
  ): Promise<CompleteOutcome>;
}

interface CompleteOutcome {
  result: CompleteResult;
  fallbacks: AgentFallbackRecord[];
}

// CompleteResult gains optional adapterFailure
interface CompleteResult {
  output: string;
  costUsd: number;
  source: "exact" | "estimated" | "fallback";
  adapterFailure?: AdapterFailure;  // added in #567
}
```

**Call sites migrated by #567** (~10, all single-line):
- `src/routing/strategies/llm.ts`
- `src/agents/shared/decompose.ts`
- `src/acceptance/generator.ts`, `refinement.ts`, `fix-generator.ts`
- `src/interaction/plugins/auto.ts`
- `src/debate/session-helpers.ts`, `resolvers.ts`
- `src/verification/rectification-loop.ts`

**Closure:** #567 closed before Phase 5 opens its PR.

### Dependency graph summary

```
                 #529 ────────────┐
                                  ▼
   Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ #567 ──▶ Phase 5 ──▶ 3 canaries ──▶ Phase 6
                 ▲                                              ▲
                 │                                              │
               #518                                           #519

   #523 ────── can land in parallel with Phase 1-3 ─────┘
   #391 ────── fully independent, any time
```

### Phase 1: AgentManager skeleton (no behaviour change)

**Goal:** `AgentManager` exists and is threaded everywhere, but still delegates to the old code paths.

**Deliverables:**
- `src/agents/manager.ts` with `IAgentManager` interface
- Methods `getDefault()`, `isUnavailable()`, `markUnavailable()` as pass-throughs:
  - `getDefault()` reads `config.autoMode.defaultAgent` (unchanged)
  - `isUnavailable()` / `markUnavailable()` delegate to `AcpAgentAdapter._unavailableAgents` via the registry
- `Runner` creates one `AgentManager` per run, passes via `PipelineContext`
- `shouldSwap`, `nextCandidate`, `runWithFallback` exist but are thin wrappers over current code

**Acceptance criteria:**
- [ ] `IAgentManager` interface exported from `src/agents/manager.ts` (reachable via `src/agents` barrel)
- [ ] `PipelineContext.agentManager` populated by `Runner` — exactly one instance per run (grep: `new AgentManager` in `src/execution/` returns 1 hit)
- [ ] `AgentManager.getDefault()` returns `config.autoMode.defaultAgent` unchanged (legacy pass-through)
- [ ] `shouldSwap`, `nextCandidate`, `runWithFallback` exist as thin wrappers over current code
- [ ] All existing tests pass without modification (no call-site changes yet)
- [ ] `test/unit/agents/manager.test.ts` covers `getDefault()`, per-run state isolation, event emission on `markUnavailable()`
- [ ] No config changes

### Phase 2: Config consolidation + migration shim

**Goal:** `config.agent` is the canonical shape; legacy keys still work with a warning.

**Deliverables:**
- `AgentConfigSchema` added to `src/config/schemas.ts` (Zod `.default()` values per `config-patterns.md`)
- Migration shim in `src/config/loader.ts` (warns per legacy key, warn-once)
- `DEFAULT_CONFIG` includes the new `agent.*` fields
- `AgentManager.getDefault()` now reads from `config.agent.default` first, falls back to legacy
- **T16.3 starts passing** because the migration shim propagates `context.v2.fallback.map` → `agent.fallback.map` before the manager consults it
- **Fold #518** — `AgentManager.validateCredentials()` called from `runSetupPhase()`: prune missing fallback candidates, fail fast on missing primary

**Acceptance criteria:**
- [ ] Load a config with `autoMode.defaultAgent = "claude"` — warning emitted, `agent.default = "claude"` post-migration
- [ ] Load a config with `autoMode.fallbackOrder = ["claude", "codex"]` — warning, `agent.fallback.map = {"claude": ["codex"]}`
- [ ] Load a config with `context.v2.fallback = {...}` — warning, direct copy to `agent.fallback`
- [ ] Mixed legacy + canonical config: canonical wins, warning still emitted
- [ ] Warn-once per `loadConfig()` call (deduped by message)
- [ ] T16.3 `fallback-probe` dogfood now exhibits observable swap (canary pass)
- [ ] `AgentManager.validateCredentials()`: missing fallback candidate → warning + pruned from runtime map; missing primary → `NaxError` with clear message
- [ ] `test/unit/config/loader-migration.test.ts` covers 3 legacy keys × 3 shape variants
- [ ] `test/unit/execution/lifecycle/run-setup.test.ts` covers credential pre-validation (satisfies #518)

### Phase 3: Migrate call sites

**Goal:** no direct reads of `autoMode.defaultAgent` / `autoMode.fallbackOrder` / `context.v2.fallback` outside the config layer.

**Deliverables (one PR per subsystem):**
- 3A: routing (`src/routing/**`) — largest site count
- 3B: execution (`src/pipeline/stages/execution.ts`, `src/execution/**`)
- 3C: tdd (`src/tdd/**`)
- 3D: acceptance (`src/acceptance/**`)
- 3E: debate / review / autofix (`src/debate/**`, `src/review/**`, `src/pipeline/stages/autofix.ts`)
- 3F: CLI + commands (`src/cli/**`, `src/commands/**`)

**Acceptance criteria (each sub-PR):**
- [ ] `grep -rn "config.autoMode.defaultAgent" src/<subsystem>` returns 0 hits
- [ ] `grep -rn "config.autoMode.fallbackOrder" src/<subsystem>` returns 0 hits
- [ ] `grep -rn "context.v2.fallback" src/<subsystem>` returns 0 hits
- [ ] Full test suite green
- [ ] Dogfood fixture for that subsystem, if any, still passes
- [ ] No behaviour change — manager still pass-through to legacy
- [ ] Codemod artefact preserved in `scripts/codemods/agent-manager-migration.ts`

### Phase 4: Adapter cleanup *(requires #529 merged first)*

**Goal:** `AcpAgentAdapter` no longer knows about fallback.

**Deliverables:**
- Delete `_unavailableAgents`, `resolveFallbackOrder()`, `markUnavailable()` from adapter
- Rewrite auth/rate-limit handlers to return `adapterFailure`, never throw `AllAgentsUnavailableError`
- Delete `AllAgentsUnavailableError` from `src/errors.ts` and `src/agents/index.ts`
- `AgentManager.runWithFallback()` now drives the full loop end-to-end (no longer a wrapper)

**Acceptance criteria:**
- [ ] #529 closed before this phase opens its PR
- [ ] `AcpAgentAdapter._unavailableAgents` deleted
- [ ] `AcpAgentAdapter.resolveFallbackOrder()` deleted
- [ ] `AcpAgentAdapter.markUnavailable()` deleted
- [ ] `AllAgentsUnavailableError` deleted from `src/errors.ts` and `src/agents/index.ts`
- [ ] Auth failure → adapter returns `{ success: false, adapterFailure: { category: "availability", outcome: "fail-auth" } }`, never throws
- [ ] Rate-limit failure → adapter returns `adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true }`, never throws
- [ ] Invariant test: adapter never throws for classifiable failures (last-resort catch in manager stays as backstop only)
- [ ] Transport retries (`sessionErrorRetryable` loop) remain in adapter, unchanged
- [ ] Payload-shape retries in `src/review/semantic.ts`, `src/review/adversarial.ts` untouched
- [ ] Integration test: simulated auth failure triggers `AgentManager` swap, observable hop metadata populated
- [ ] T16.3 dogfood — full observable swap with context rebuild and manifest write

### Phase 5: Execution-stage consolidation

**Goal:** `pipeline/stages/execution.ts` has no inline swap logic.

**Deliverables:**
- Replace 150+ line swap loop with single `manager.runWithFallback(...)` call
- Delete `src/execution/escalation/agent-swap.ts` (logic now in manager)
- `ctx.agentFallbacks`, `ctx.agentSwapCount` populated from `AgentRunOutcome`
- `context.v2.fallback` schema entry removed (shim still accepts it)
- **Fold #519** — `AgentFallbackRecord.costUsd` populated per hop; `RunSummary.fallback` aggregates surfaced at run completion

**Acceptance criteria:**
- [ ] `pipeline/stages/execution.ts` LOC reduced by ≥120
- [ ] `src/execution/escalation/agent-swap.ts` deleted
- [ ] `context.v2.fallback` schema entry removed (migration shim still accepts legacy key)
- [ ] `AgentFallbackRecord` includes `costUsd: number`, sourced from failed-hop `RunResult.estimatedCost`
- [ ] `RunSummary.fallback: { totalHops, perPair, exhaustedStories, totalWastedCostUsd }` surfaced at run completion
- [ ] All integration tests for execution stage pass
- [ ] Snapshot tests for rebuild-manifest writes unchanged
- [ ] T16.3 dogfood `run.complete` shows `agentFallbacks: [{priorAgent: "claude", newAgent: "codex", hop: 1, costUsd: ...}]`
- [ ] `test/unit/metrics/tracker.test.ts` covers aggregation (satisfies #519)
- [ ] `test/unit/execution/lifecycle/run-completion*.test.ts` covers run-summary surfacing

### Phase 6: Remove migration shim

**Goal:** single config surface, no legacy support.

**Deliverables:**
- Delete `applyAgentConfigMigration()` from `src/config/loader.ts`
- Remove `defaultAgent`, `fallbackOrder` from `AutoModeConfigSchema`
- Remove `ContextV2FallbackConfigSchema` from `src/config/schemas.ts`
- Update `CHANGELOG.md` — breaking change note
- Update project docs (`docs/architecture/conventions.md`, `.claude/rules/config-patterns.md`)

**Acceptance criteria:**
- [ ] `applyAgentConfigMigration()` deleted from `src/config/loader.ts`
- [ ] `defaultAgent`, `fallbackOrder` removed from `AutoModeConfigSchema`
- [ ] `ContextV2FallbackConfigSchema` removed from `src/config/schemas.ts`
- [ ] Loading a pre-migration config → Zod validation error with clear "migrate to `agent.*` per ADR-012" message
- [ ] 3 canary releases have passed between Phase 2 and Phase 6
- [ ] CHANGELOG breaking-change note added
- [ ] `docs/architecture/conventions.md` and `.claude/rules/config-patterns.md` updated

---

## Testing Strategy

### Unit tests

- **`manager.test.ts`** — 30+ test cases:
  - `getDefault()` reads `agent.default`, falls back to legacy during Phase 1–5
  - `shouldSwap()` covers all branches: disabled config, no bundle, hop cap, quality vs availability
  - `nextCandidate()` handles empty map, single candidate, multi-candidate, unavailable-filter
  - `markUnavailable()` + `isUnavailable()` are per-run scoped
  - `reset()` clears unavailable state
  - Event emission: every public state change emits an event

- **`loader-migration.test.ts`** — 15+ test cases:
  - Each legacy key migrates correctly (3 keys × 3 shapes)
  - Warnings fire once per load
  - Current-shape configs pass through unchanged
  - Mixed old+new in the same file — new wins, warning fires

### Integration tests

- **`manager-fallback.test.ts`** — full end-to-end:
  - Mock adapter that returns `adapterFailure: { category: "availability" }` first time, success second
  - Verify: swap triggered, context rebuilt, manifest written, session handoff called, `AgentRunOutcome.fallbacks.length === 1`
  - Verify: exhausted hops returns failure without throwing

### Dogfood

- **T16.3 (`fallback-probe`)** — the canary. Must show:
  - `[execution] Agent-swap triggered` log line with hop=1
  - `context-manifest-rebuild-*.json` written under `.nax/features/.../stories/.../`
  - Final `run.complete` has `agentFallbacks: [{priorAgent: "claude", newAgent: "codex", hop: 1, …}]`
  - Story passes via codex (or fails cleanly if codex also unavailable — but swap was attempted)

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|:---|:---|:---|
| 79-site codemod misses a call | High | Automate via AST codemod, CI grep check for `config.autoMode.defaultAgent` in `src/` outside `config/` |
| Adapter return-vs-throw change breaks callers that depend on exception | Medium | Phase 4 is a single atomic PR; all callers of `adapter.run()` already handle `result.success === false` |
| Event emission allocation pressure on tight loops | Low | Events are synchronous, no allocation on zero listeners (EventEmitter native behaviour) |
| Migration shim misreads partial configs | Medium | Extensive shim unit tests; keep shim purely additive (never delete legacy fields during migration window) |
| Config warnings spam the logs | Low | Warn-once semantics per `loadConfig()` call; deduped by message |

---

## Out of Scope

- Renaming `autoMode` → `routing` (routing concerns: `complexityRouting`, `escalation.tierOrder`). Legitimate but separate cleanup.
- Multi-agent concurrent execution (one story running on two agents in parallel). Would need per-story agent locking; this spec is fallback-only.
- Persisting unavailable-agent state across runs. Intentional — auth transients should not permanently exclude an agent from future runs.
- Alternative protocol support (beyond ACP). `config.agent.protocol` already discriminates; this spec does not change that axis.

---

## References

- ADR-012 — AgentManager Ownership (decision record)
- ADR-011 — SessionManager Ownership (precedent; same extraction pattern)
- SPEC-session-manager-integration — companion spec for session extraction
- SPEC-context-engine-agent-fallback — Phase 5.5 original design (superseded in Phase 5)
- `.claude/rules/config-patterns.md` — Compatibility Shim pattern
- Issue #552 — tracking issue with 6-phase checklist
- PR #551 — ADR-012 itself
- T16.3 dogfood evidence: `/nax-dogfood/fixtures/fallback-probe/.nax/features/fallback-probe/runs/2026-04-18T09-27-27.jsonl`
