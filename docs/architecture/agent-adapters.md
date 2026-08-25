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

The stage rides on each `Operation.stage` (or `pipelineStage` on a direct manager call) and is resolved once at the resource opener:

| Stage | Carried by | Typical profile |
|:------|:--------|:----------------|
| `plan` | `planOp` / `planInteractiveOp` | Same as config (plan writes prd.json) |
| `run` | run-kind ops (write-test, implementer, etc.) | Primary execution — most permissive |
| `verify` | `verifyScopedOp`, `fullSuiteGateOp` | Read-heavy — could be restricted in Phase 2 |
| `rectification` | autofix / full-suite-rectify ops | Needs write access for fixes |
| `complete` | `completeAs` one-shots (`decomposeOp`, etc.) | One-shot LLM calls — varies by caller |
| `acceptance` | Acceptance generator ops | Write access for test files |
| `regression` | Regression gate | Read + test execution |
| `review` | semantic / adversarial review ops | Read-only in Phase 2 |

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
- **Resource openers (only resolvers):** `src/session/manager.ts` (`openSession`), `src/agents/manager.ts` (`completeAs`)
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
4. Both `plan.ts` and `decompose-prompt.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/cli/plan.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/agents/shared/decompose-prompt.ts` | Same prompt fragments |
| `src/pipeline/stages/routing.ts` | `resolveTestStrategy()` (via prd/schema.ts normalization) |
| `src/prd/schema.ts` | `resolveTestStrategy()` for PRD validation |

---

## §16 Agent Adapter Conventions

*Added: 2026-03-16 (MR !52 — agents folder restructure). Updated 2026-04-27 for ADR-019 4-primitive surface.*

### Adapter surface — 4 primitives (ADR-019) + one optional teardown hook

```typescript
interface AgentAdapter {
  // Session-related work — composed by SessionManager
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
  closeSession(handle: SessionHandle): Promise<void>;

  // Sessionless one-shot — called directly by AgentManager.completeAs
  complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult>;

  // Optional: close a session this process holds no live handle for (#1702)
  closePhysicalSession?(handle: string, workdir: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}
```

| Method | Owner of the call | Purpose |
|:---|:---|:---|
| `openSession` | `SessionManager.openSession` | Open or resume a physical session. Receives pre-resolved permissions. |
| `sendTurn` | `SessionManager.sendPrompt` (via the framework's `interactionHandler`) | Send one prompt; agent runs to completion (with internal interaction round-trips handled inside the adapter). |
| `closeSession` | `SessionManager.closeSession` | Idempotent close. |
| `complete` | `AgentManager.completeAs` | Sessionless single-shot. No state, no interactionHandler. |
| `closePhysicalSession?` | run teardown (`src/execution/session-manager-runtime.ts`) | Close a session left behind, addressed by **id and workdir** rather than by `SessionHandle` — the process no longer holds one. Optional; callers invoke it best-effort and treat absence as "nothing to close". |

**`closeSession` and `closePhysicalSession` are not alternatives.** The first closes an
open in-process session; the second reconnects to the agent to close one this process
has lost the handle for. Until #1702 the second was undeclared and teardown reached it
through a `LegacySessionCloser` cast, so an adapter without it silently no-opped instead
of failing to compile, and the two disagreed on the handle type unnoticed.

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
| ACP protocol (all agents) | `acp/` | adapter, adapter-lifecycle, adapter-output, spawn-client, parser, interaction-bridge, parse-agent-error, token-mapper, wire-types, types, index |
| Centralized cost | `cost/` | calculate, pricing, token-mapper, types, index |

All agents (Claude Code, OpenCode, Codex, Gemini, Aider, and any ACP-compatible agent) are driven through `AcpAgentAdapter`. There are no per-agent CLI adapter folders. The CLI protocol mode was removed before ADR-019 — the schema declares `agent.protocol: z.literal("acp").default("acp")`.

### Rules

1. **One subfolder per adapter** — never flat files at `src/agents/` root (only `index.ts`, `types.ts`, `registry.ts` live at root)
2. **Each multi-file adapter needs `index.ts`** — re-exports everything external callers need; internal modules import directly without going through the barrel
3. **Cross-adapter code goes in `shared/`** — if two different adapters import the same module, that module belongs in `shared/`, not inside either adapter's folder
4. **Cost is centralized** — all cost calculation lives in `src/agents/cost/` (model-name-based pricing in `pricing.ts`, computed in `calculate.ts`). The ACP adapter is cost-blind; recording flows through the cost middleware (`DispatchEvent` → `CostAggregator`), per `.claude/rules/adapter-wiring.md`

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

### Session Error Retries

Session-error retry logic is expressed through the `RetryStrategy` interface in `src/agents/retry/` (issue #856 SSOT — see `.claude/rules/retry-strategy.md`). The adapter classifies failures (e.g. a `retryable?: boolean` flag on the ACP response, `SessionTurnError.retryable`); the manager-tier `defaultRetryStrategy` retries `fail-rate-limit` outcomes, and op-tier `op.retry` declarations handle parse/transient failures. There are no longer standalone `sessionErrorMaxRetries` / `sessionErrorRetryableMaxRetries` config keys — retry policy is a `RetryStrategy`, not a flat config count.

### Layered Retry Semantics

nax has three independent retry layers, each targeting a different failure class:

| Layer | Config | Triggers on | Behaviour |
|:------|:-------|:------------|:----------|
| `agent.acp.promptRetries` (acpx) | `agent.acp.promptRetries` (default `0`) | Transient ACP-layer errors before side effects | acpx retries the same prompt with exponential backoff; JSON output stays stable; skipped if side effects already occurred |
| Op / manager retry (nax) | `op.retry` per `Operation` + `defaultRetryStrategy` (`src/agents/retry/`) | Parse failures, rate limits, transient adapter errors | `RetryStrategy.shouldRetry()` decides; bounded by `MAX_COMPLETE_RETRY_ATTEMPTS` |
| Tier escalation (nax) | `autoMode.escalation.*` (`tierOrder`, `escalateEntireBatch`) | Repeated rectification failures | Bumps model tier (fast → balanced → powerful) |

**Key rule:** `promptRetries` is the cheapest layer — it fires inside acpx before nax even sees the result. Set it to `2` for transient-rate-limit tolerance without overlapping the escalation logic. The failure classes are disjoint: prompt-level transients vs. quality failures vs. repeated quality failures.

### Async Decompose Prompts

`src/agents/shared/decompose-prompt.ts`:
- `buildDecomposePromptAsync()` — async decompose prompt builder using `OneShotPromptBuilder`
- Two modes: **spec decomposition** (spec → user stories) and **plan sub-story splitting** (single story → sub-stories)
- Includes `DECOMPOSE_SPEC_SCHEMA` and `DECOMPOSE_PLAN_SCHEMA` for structured JSON output

### ACP Cost Alignment

ACP sessions emit exact USD cost over the wire. The adapter records token-based `estimatedCostUsd` and the wire-reported `exactCostUsd` as independent fields (`exactCostUsd` is `undefined` when the wire never reported one):

```ts
const estimatedCostUsd =
  totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0
    ? estimateCostFromTokenUsage(totalTokenUsage, modelDef.model)
    : 0;
const exactCostUsd = totalExactCostUsd; // undefined if wire never reported
```

Wire token fields (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) are mapped to the nax-internal **camelCase** `TokenUsage` by `AcpTokenUsageMapper` (`acp/token-mapper.ts`):
- `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`

The parser (`acp/parser.ts`) handles both the JSON-RPC envelope format (acpx v0.3+) and legacy flat NDJSON for backward compatibility.

---

## §17 Trust Boundary

*Added: 2026-08-14 (deep code review, decision D-1).*

**nax trusts the repository it is pointed at.** An untrusted repo is **NOT** in
nax's threat model.

Running `nax` on a repo grants that repo the same authority as running its own
`npm test` — because invoking `quality.commands.*` is literally that. A repo
can execute code, read the environment, and load plugins. This is the design,
not a defect.

### What is inside the boundary

| Authority | Where | Why it is granted |
|:----------|:------|:------------------|
| Run arbitrary commands | `quality.commands.*` (`src/quality/runner.ts`) | Equivalent to running the repo's own `npm test` — the repo's own commands with the repo's own env |
| Execute hooks | `src/hooks/runner.ts` | Hooks are repo-authored code the user opted into running |
| Load plugins in-process | `src/plugins/loader.ts` | Plugin loading is the granted authority |
| Vendor flow modules | `nax-finish/index.ts` | Same authority as any other repo-supplied code path |
| Provide tool-result content | `src/agents/acp/adapter-output.ts` | File contents are the repo's own — no prompt-injection delimiter escaping |
| Override security-sensitive config | project `.nax/config.json` (warned, not blocked — see SEC-2 / D-2) | Project layer wins the merge; the loader warns when a project layer changes `execution.permissionProfile` or `quality.stripEnvVars` from their global values |

### Explicitly NOT being built

Sandboxing, out-of-process plugin isolation, env allowlists, prompt-injection
delimiter escaping, first-run per-repo trust prompts. Do not raise these again
in reviews — see the D-1 ruling in `docs/reviews/2026-08-14-deep-code-review.md`.

### Scope limits

The trust model excuses a repo exercising authority the user granted. It does
**not** excuse:

- nax silently overriding a setting the user deliberately chose (SEC-2/D-2 — warned, not blocked)
- ordinary correctness bugs that merely happen to live in security-shaped code (SEC-4/D-3)
- attackers outside the repo boundary, e.g. co-tenant local processes (SEC-8 — webhook rate limiting is real work)

### Interaction plugins

- **Webhook** (`src/interaction/plugins/webhook.ts`): binds `127.0.0.1` with an
  HMAC-SHA256 secret and a global request rate limit. `requireSecret: false` is
  supported but warns — the loopback endpoint is then unauthenticated against
  co-tenant local processes.
- **Telegram** (`src/interaction/plugins/telegram.ts`): authenticates by chat ID
  only. Use a **private chat with the bot** — any member of a shared/group chat
  can tap approve/abort/skip buttons. There is no per-user allowlist.
