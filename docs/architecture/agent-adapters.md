# Agent Adapters — nax

> §14–§16: Permission resolution, test strategy, adapter conventions.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

---

## 14. Permission Resolution

> Introduced in v0.43.0 (PERM-001). Single source of truth for all agent permission decisions.

### Architecture

All permission decisions flow through one function: `resolvePermissions(config, stage)` in `src/config/permissions.ts`. Under ADR-019 it is called by exactly two resource openers — `SessionManager.openSession` and `AgentManager.completeAs` — and never by callers above.

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│ Config       │────▶│ resolvePermissions()  │────▶│ ResolvedPermissions │
│ • profile    │     │ src/config/           │     │ • mode              │
│ • legacy bool│     │ permissions.ts        │     │ • skipPermissions   │
│ • stage      │     └──────────────────────┘     │ • allowedTools?     │
└─────────────┘                ▲                  └─────────────────────┘
                               │ called once, pre-chain        │
                  ┌────────────┴────────────┐                  ▼
                  │                          │      ┌──────────────────┐
        SessionManager.openSession   AgentManager.completeAs           │
        (session-bound calls)        (sessionless one-shots)           │
                  │                          │                         │
                  ▼                          ▼                         │
        adapter.openSession          adapter.complete                  │
                  │                          │                         │
                  ▼                          ▼                         │
        receives resolvedPermissions in opts ←─────────────────────────┘
```

### Permission Profiles

| Profile | ACP mode | When to use |
|:--------|:---------|:------------|
| `unrestricted` | `approve-all` | Development, trusted environments |
| `safe` | `approve-reads` | Production, untrusted projects |
| `scoped` | Per-stage (Phase 2) | Fine-grained control (future) |

### Config Precedence

```jsonc
// nax/config.json — execution block
{
  "execution": {
    // NEW — preferred (v0.43.0+)
    "permissionProfile": "unrestricted",

    // DEPRECATED — backward compat only, ignored when permissionProfile is set
    "dangerouslySkipPermissions": true
  }
}
```

Resolution order:
1. `execution.permissionProfile` → used if present
2. `execution.dangerouslySkipPermissions` → mapped: `true` → `"unrestricted"`, `false` → `"safe"`
3. Neither set → defaults to `"safe"` (approve-reads)

### Pipeline Stages

Every call to `resolvePermissions()` includes the pipeline stage:

| Stage | Used by | Typical profile |
|:------|:--------|:----------------|
| `plan` | `plan.ts` | Same as config (plan writes prd.json) |
| `run` | `execution.ts`, `session-runner.ts` | Primary execution — most permissive |
| `verify` | Verification strategies | Read-heavy — could be restricted in Phase 2 |
| `rectification` | `rectification-loop.ts`, `rectification-gate.ts` | Needs write access for fixes |
| `complete` | `acp/adapter.ts` | One-shot LLM calls — varies by caller |
| `acceptance` | Acceptance generator | Write access for test files |
| `regression` | Regression gate | Read + test execution |
| `review` | Code review | Read-only in Phase 2 |

In Phase 1, all stages resolve to the same profile. Phase 2 (`scoped`) will enable per-stage overrides.

### Rules (Mandatory)

| Rule | Rationale |
|:-----|:----------|
| **Resource openers resolve permissions; nobody else does** | Only `SessionManager.openSession` and `AgentManager.completeAs` call `resolvePermissions` (ADR-019 §3) |
| **Never hardcode permission booleans** | No `?? true`, `?? false`, or literal `"approve-all"` |
| **Never read `dangerouslySkipPermissions` directly** | Deprecated field — resolver handles backward compat |
| **Always pass `pipelineStage` upward** | Callers above the resource opener pass `pipelineStage`; the manager resolves once before invoking the adapter |
| **Adapter primitives receive `resolvedPermissions`** | `OpenSessionOpts` / `CompleteOpts` carry pre-resolved permissions — adapters never re-resolve |

### Adding New Call Sites

ADR-019 split permission resolution between two resource openers:

| Caller | Where it resolves |
|:---|:---|
| `SessionManager.openSession(name, opts)` | Internally — caller passes `pipelineStage`, manager calls `resolvePermissions` once and forwards `resolvedPermissions` to `adapter.openSession` |
| `AgentManager.completeAs(name, prompt, opts)` | Internally — manager calls `resolvePermissions(this._config, opts.pipelineStage)` and forwards to `adapter.complete` |

Above those entry points, callers pass `pipelineStage`, never raw permission
booleans:

```typescript
// ✅ Correct — sessionless one-shot
await ctx.runtime.agentManager.completeAs(agentName, prompt, {
  pipelineStage: "decompose",
  jsonMode: true,
  config,
});

// ✅ Correct — session-bound (orchestrator opens its own handle)
const handle = await ctx.runtime.sessionManager.openSession(name, {
  agentName,
  workdir,
  pipelineStage: "run",
  signal: ctx.signal,
});

// ✅ Correct — through callOp (most ops): Operation.stage drives the stage,
// no manual permission threading
await callOp(ctx, semanticReviewOp, input);
```

```typescript
// ❌ Wrong: local fallback
const skip = config?.execution?.dangerouslySkipPermissions ?? true;

// ❌ Wrong: hardcoded
const args = ["--dangerously-skip-permissions", ...rest];

// ❌ Wrong: resolving permissions in a middle layer
// (only resource openers — SessionManager.openSession / AgentManager.completeAs — resolve)
const perms = resolvePermissions(config, "run");
await sessionManager.openSession(name, { resolvedPermissions: perms, ... });
```

**Rule:** the resource opener resolves permissions. Orchestrators, `callOp`,
middleware, and ops never call `resolvePermissions` themselves.

### Reference Files

- **Resolver:** `src/config/permissions.ts` — `resolvePermissions()`, types, profiles
- **Schema:** `src/config/schemas.ts` — `permissionProfile` field definition
- **ACP adapter:** `src/agents/acp/adapter.ts`
- **Call sites:** `execution.ts`, `session-runner.ts`, `rectification-loop.ts`, `rectification-gate.ts`, `plan.ts`
- **Spec:** `docs/specs/scoped-permissions.md` — PERM-001 + PERM-002 design

---

## §15 Test Strategy Resolution

### Single Source of Truth

`src/config/test-strategy.ts` defines all valid test strategies, shared prompt fragments,
and the `resolveTestStrategy()` normalizer. This module is the ONLY place where test
strategy values, descriptions, and classification rules are defined.

### Available Strategies

| Strategy | Complexity | Description |
|:---------|:-----------|:------------|
| `test-after` | simple | Write tests after implementation |
| `tdd-simple` | medium | Write key tests first, then implement |
| `three-session-tdd` | complex | 3 sessions: test-writer (strict, no src/ changes) → implementer (no test changes) → verifier |
| `three-session-tdd-lite` | expert | 3 sessions: test-writer (lite, may add src/ stubs) → implementer (lite, may expand coverage) → verifier |

### Rules

1. **resolveTestStrategy()** normalizes unknown/legacy values to valid strategies
2. **Security override**: Security-critical stories → minimum "medium" / "tdd-simple"
3. **No standalone test stories**: Testing is handled per-story via testStrategy
4. Both `plan.ts` and `claude-decompose.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/cli/plan.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/agents/shared/decompose.ts` | Same prompt fragments |
| `src/pipeline/stages/routing.ts` | `resolveTestStrategy()` (via prd/schema.ts normalization) |
| `src/prd/schema.ts` | `resolveTestStrategy()` for PRD validation |

---

## §16 Agent Adapter Conventions

*Added: 2026-03-16 (MR !52 — agents folder restructure). Updated 2026-04-27 for ADR-019 4-primitive surface.*

### Adapter surface — 4 primitives (ADR-019)

```typescript
interface AgentAdapter {
  // Session-related work — composed by SessionManager
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
  closeSession(handle: SessionHandle): Promise<void>;

  // Sessionless one-shot — called directly by AgentManager.completeAs
  complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult>;
}
```

| Method | Owner of the call | Purpose |
|:---|:---|:---|
| `openSession` | `SessionManager.openSession` | Open or resume a physical session. Receives pre-resolved permissions. |
| `sendTurn` | `SessionManager.sendPrompt` (via the framework's `interactionHandler`) | Send one prompt; agent runs to completion (with internal interaction round-trips handled inside the adapter). |
| `closeSession` | `SessionManager.closeSession` | Idempotent close. |
| `complete` | `AgentManager.completeAs` | Sessionless single-shot. No state, no interactionHandler. |

**`AgentAdapter.run` is gone** (deleted in ADR-019 Phase D). Functionality lives
in `SessionManager.runInSession`, which composes the three session primitives.

**`plan` and `decompose` are gone too** — they are typed `kind:"complete"`
operations under `src/operations/`, dispatched through `callOp` (§37).

### `interactionHandler` — mid-turn callback

The framework injects an `interactionHandler` into every `sendTurn` call. It
handles permission prompts, tool calls, and context-tool resolution between the
adapter's request and final response. The adapter dispatches to the handler;
SessionManager and above never see these round-trips.

`TurnResult.internalRoundTrips` surfaces the count for audit/metrics, but it is
not state SessionManager tracks across turns.

### Folder Structure

Each agent adapter lives in its own subfolder under `src/agents/`. The depth matches the adapter's complexity:

| Adapter | Folder | Files |
|:--------|:-------|:------|
| ACP protocol (all agents) | `acp/` | adapter, spawn-client, parser, cost, interaction-bridge, parse-agent-error, types, index |
| Centralized cost | `cost/` | calculate, parse, pricing, types, index |

All agents (Claude Code, OpenCode, Codex, Gemini, Aider, and any ACP-compatible agent) are driven through `AcpAgentAdapter`. There are no per-agent CLI adapter folders. The CLI protocol mode was removed before ADR-019 — the schema declares `agent.protocol: z.literal("acp").default("acp")`.

### Rules

1. **One subfolder per adapter** — never flat files at `src/agents/` root (only `index.ts`, `types.ts`, `registry.ts` live at root)
2. **Each multi-file adapter needs `index.ts`** — re-exports everything external callers need; internal modules import directly without going through the barrel
3. **Cross-adapter code goes in `shared/`** — if two different adapters import the same module, that module belongs in `shared/`, not inside either adapter's folder
4. **Adapter-specific cost stays with the adapter** — `claude/cost.ts` (tier-based) and `acp/cost.ts` (model-name-based) are separate; they have different pricing strategies and callers

### `shared/` Contents

| File | Purpose | Used by |
|:-----|:--------|:--------|
| `shared/decompose.ts` | PRD decomposition prompt + parser | `acp/adapter.ts` |
| `shared/decompose-prompt.ts` | Async decompose prompt builder (spec + plan modes) | `acp/adapter.ts` |
| `shared/env.ts` | Secure environment variable construction for spawned agents | `acp/adapter.ts` via `buildAllowedEnv()` |
| `shared/model-resolution.ts` | Resolve ModelDef from config | `acp/adapter.ts` |
| `shared/validation.ts` | Agent capability + tier validation | `registry.ts`, pipeline stages |
| `shared/version-detection.ts` | Binary version detection | `cli/agents.ts`, `precheck/checks-agents.ts` |
| `shared/types-extended.ts` | Plan/decompose/interactive types | `acp/adapter.ts`, `types.ts` |

### ACP Session Error Retry Tiers

The ACP adapter uses tiered retry logic for session errors, configurable via `execution` config:

| Error type | Config key | Default | Example |
|:-----------|:-----------|:--------|:--------|
| Non-retryable (stale/locked session) | `sessionErrorMaxRetries` | 1 | Session state corruption |
| Retryable (queue disconnect) | `sessionErrorRetryableMaxRetries` | 3 | `QUEUE_DISCONNECTED_BEFORE_COMPLETION` |

The adapter detects retryable errors via the `retryable?: boolean` flag in the ACP response. Error logs include the first 500 chars of output for diagnostics.

### Layered Retry Semantics (acpx 0.4.0+)

nax has three independent retry layers, each targeting a different failure class:

| Layer | Config | Triggers on | Behaviour |
|:------|:-------|:------------|:----------|
| `agent.acp.promptRetries` (acpx) | `agent.acp.promptRetries` (default `0`) | Transient ACP-layer errors before side effects | acpx retries the same prompt with exponential backoff; JSON output stays stable; skipped if side effects already occurred |
| Rectification loop (nax) | `execution.rectificationMaxAttempts` | Review or test failures after a complete turn | New prompt synthesised from failure details |
| Tier escalation (nax) | `execution.escalation.*` | Repeated rectification failures | Bumps model tier (fast → balanced → powerful) |

**Key rule:** `promptRetries` is the cheapest layer — it fires inside acpx before nax even sees the result. Set it to `2` for transient-rate-limit tolerance without overlapping the escalation logic. The failure classes are disjoint: prompt-level transients vs. quality failures vs. repeated quality failures.

### Async Decompose Prompts

`src/agents/shared/decompose-prompt.ts`:
- `buildDecomposePromptAsync()` — async decompose prompt builder using `OneShotPromptBuilder`
- Two modes: **spec decomposition** (spec → user stories) and **plan sub-story splitting** (single story → sub-stories)
- Includes `DECOMPOSE_SPEC_SCHEMA` and `DECOMPOSE_PLAN_SCHEMA` for structured JSON output

### ACP Cost Alignment

ACP sessions emit exact USD cost via `usage_update` (`cost.amount`). The adapter prefers this over token-based estimation:

```ts
// Prefer exact cost from acpx usage_update; fall back to token-based estimation
const estimatedCost =
  totalExactCostUsd ??
  (totalTokenUsage.input_tokens > 0 || totalTokenUsage.output_tokens > 0
    ? estimateCostFromTokenUsage(totalTokenUsage, options.modelDef.model)
    : 0);
```

Token fields from acpx are **camelCase** in the final JSON-RPC `result.usage`:
- `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`

The parser (`acp/parser.ts`) handles both the JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON for backward compatibility.
