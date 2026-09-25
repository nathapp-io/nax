# Agent Adapters — nax

> §14–§17: Permission resolution, test strategy, adapter conventions, trust boundary.
> Part of the [Architecture Documentation](ARCHITECTURE.md).

---

## 14. Permission Resolution

> Introduced in v0.43.0 (PERM-001). Single source of truth for all agent permission decisions.

### Architecture

All permission decisions flow through one function: `resolvePermissions(config, stage)` in `src/config/permissions.ts`. Under ADR-019 it is called at the resource openers — `SessionManager.openSession` and `AgentManager.completeAs` (via `buildCompleteCallPreamble` in `src/agents/manager-dispatch.ts`), plus the manager's own `runAs` / `runAsSession` — and never by the orchestrators, ops or middleware above them. Two read-only consumers also call it so they cannot disagree with the tool offer: `resolveCodingToolSupport` (`src/agents/coding-tool-support.ts`, compiles the native tool policy) and the inert-Bash warning (`src/config/inert-bash-stages.ts`).

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ Config       │────▶│ resolvePermissions()  │────▶│ ResolvedPermissions  │
│ • profile    │     │ src/config/           │     │ • mode               │
│ • permissions│     │ permissions.ts        │     │ • toolGrants?        │
│   .<stage>   │     └──────────────────────┘     │ • denyRules?/askRules│
│ • bashApproval│               ▲                  │ • providerScope?     │
│ • stage      │               │ called once,     │ • bashApproval       │
└─────────────┘               │ pre-chain        └──────────────────────┘
                  ┌────────────┴────────────┐                  │
        SessionManager.openSession   AgentManager.completeAs    │
        (session-bound calls)        (sessionless one-shots)    │
                  │                          │                  │
                  ▼                          ▼                  │
        adapter.openSession          adapter.complete           │
                  │                          │                  │
                  ▼                          ▼                  │
        receives resolvedPermissions in opts ←──────────────────┘
```

`mode` is the ACP permission mode (`approve-all` | `approve-reads` | `default`). `toolGrants` / `denyRules` / `askRules` are declarative `{tool, patterns}` data compiled into an enforceable policy by `src/tools/` (`compileToolPolicy`); `providerScope` (`all` | `rules` | `none`) bounds MCP provider tools; `bashApproval` is always present (ADR-030, below).

### Permission Profiles

| Profile | ACP mode | Tool grants | Provider (MCP) tools |
|:--------|:---------|:------------|:---------------------|
| `unrestricted` (default) | `approve-all` | Every coding tool with `["*"]`, except `Exec` (limited to `BUILT_IN_EXEC_PATTERNS` — installs/fetches) and `Bash` (never granted by a profile) | `all` |
| `safe` | `approve-reads` | `DEFAULT_CODING_TOOLS` only (Read, Glob, Grep, Scratchpad*) | `none` |
| `scoped` | `approve-reads` | Only what `execution.permissions.<stage>` allows (no baseline) | `rules` (`Mcp(...)` rules) |

### Config

```jsonc
// .nax/config.json — execution block
{
  "execution": {
    "permissionProfile": "unrestricted",   // default
    "bashApproval": "raw",                 // default; ADR-030
    "permissions": {
      "default": { "allow": ["Read(*)"] },
      "run": { "allow": ["Bash(ls *, cat *, git status*)"], "deny": ["Write(.env*)"], "bashApproval": "gated" },
      "review": { "inherit": "default" }
    }
  }
}
```

Resolution:
1. `execution.permissionProfile` → used if present
2. Unset → `DEFAULT_PERMISSION_PROFILE` = `"unrestricted"` (ruled 2026-08-30, ENH-45 — nax's own pipeline must run unattended). Opt out with `"safe"`.
3. An **invalid** profile (reachable only when schema validation was bypassed) fails closed to `approve-reads` with `bashApproval: "gated"` and logs a warning.

The legacy `dangerouslySkipPermissions` / `skipPermissions` booleans are removed, not deprecated — they have zero occurrences in `src/`.

Per-stage `execution.permissions.<stage>` blocks carry `allow`, `deny`, and `ask` rule lists (tool expressions such as `Write(src/**)`), evaluated under every profile, not only `scoped`; precedence is `deny > ask > allow`, and `allowedTools` remains the legacy alias of `allow`. Lookup is stage block → `inherit` chain → `default` block; `validatePermissionsBlock` (`src/config/config-guards.ts`) rejects cycles and dangling `inherit` targets at load. An `ask` match is resolved at call time through an injected `AskResolver` — see [Ask tier and approvals](#ask-tier-and-approvals). Full design: `docs/superpowers/specs/2026-09-13-nax-native-permission-subsystem-design.md`.

### Pipeline Stages

The stage rides on each `Operation.stage` (or `pipelineStage` on a direct manager call) and is resolved once at the resource opener. `PipelineStage` is: `plan`, `run`, `setup`, `verify`, `review`, `rectification`, `regression`, `acceptance`, `complete`.

| Stage | Carried by |
|:------|:--------|
| `plan` | `planInteractiveOp`, `planRefineOp`, `decomposeOp` |
| `run` | run-kind ops (test-writer, implementer, etc.); the default when none is passed |
| `setup` | `nax setup` config generation (`setupGenerateOp`) |
| `verify` | `verifyScopedOp`, `fullSuiteGateOp` |
| `rectification` | autofix / full-suite-rectify ops |
| `complete` | `finishNarrativeOp`; the default for a `completeAs` call that passes no stage |
| `acceptance` | Acceptance generator / fix ops |
| `regression` | Declared in the union; no op carries it today |
| `review` | semantic / adversarial review ops, `rectifyOp` |

The profile's mode is the same for every stage; per-stage differences come only from `execution.permissions.<stage>` rules and per-stage `bashApproval`.

### Bash approval modes (ADR-030)

`bashApproval` decides how a model-authored shell command string is adjudicated. Global `execution.bashApproval` (default `raw`), overridable per stage in `permissions.<stage>.bashApproval`; resolved by `resolveBashApproval` (`src/config/bash-approval.ts`) inside `resolvePermissions`.

| Mode | Behaviour |
|:-----|:----------|
| `raw` (default) | Pass-through: no lexer refusal, no per-segment grant matching, no root containment. Only an advisory protected-path screen (`src/tools/policy-bash-raw.ts`) refuses a *parseable* write to `.nax/config.json`, `.nax/mono/*/config.json`, `.nax/features/**/prd.json` or the queue-control files. Requires the OS sandbox when it is enabled (below). |
| `gated` | Mechanical gate (`src/tools/policy-bash.ts`): lexer refusals, deny rules, per-segment allow matching, containment. |
| `escalate` | `gated`, but a denial the gate could not adjudicate (lexer refusal, no covering allow rule) goes to the `ask` tier instead of `deny`. Affirmative out-of-bounds denials never escalate. |

Under `gated`/`escalate` the Bash tool is offered only when the stage's allow list holds exactly one human-written `Bash(...)` rule — no profile grants Bash. A stage that declares Bash without one is *inert*; `warnInertBashStages` (`src/execution/lifecycle/run-setup-warnings.ts`) logs one warning per inert stage at run start. Separately, `src/tools/nax-owned-writes.ts` keeps coding tools off nax's own files: `.nax/config.json` / `.nax/mono/*/config.json` for every tool (`quality.commands` run ungated on the strength of a human having written them), and feature `prd.json` plus the root queue-control files for write tools (the plan session may write only the one PRD path its op declares).

### Ask tier and approvals

The `AskResolver` is a chain (`chainAskLinks`, `src/permissions/ask-chain.ts`) built per dispatch scope by `buildDispatchAskWiring` (`src/interaction/dispatch-ask.ts`): the **approvals cache** link (`approvals.json`, `src/permissions/approvals-store.ts`) → the **human** link over the interaction chain → a terminal deny. A prompt waits `execution.approvalTimeout` (default 600000 ms, min 30000, max 3600000) and then denies. With no channel the run gets `headlessAskResolver()`, which denies; every refusal records the tool-ledger outcome `denied:ask`. Remembered approvals are managed with `nax approvals list [--json]` and `nax approvals rm [ids...] [--stage <stage>] [--all] [--yes]` (`src/cli/approvals.ts`). A run that could forge cache entries (a `raw` stage with the sandbox off) taints the store so later runs ignore those entries (`src/permissions/approvals-taint.ts`).

### OS sandbox and command safety

- **`execution.sandbox`** (`src/sandbox/`, schema `src/config/schemas-sandbox.ts`) wraps the two agent-authored spawn sites — Bash and RunCommand `Exec` — in an OS sandbox. Defaults: `enabled: true`, `backend: "srt"` (`@anthropic-ai/sandbox-runtime`), `filesystem.allowWrite: []`, `filesystem.denyRead: []`, `network.allowedDomains` absent (unrestricted egress). Paths must be literal (no glob characters). When enabled but the probe finds it unavailable, `raw` Bash is refused with a reason naming `gated`/`escalate`; those modes run unwrapped with a warning. nax's own declared commands (quality, acceptance, installs) are never wrapped. It limits the blast radius of agent mistakes; it is not a boundary against a hostile repo (see §17).
- **`execution.commandSafety.shadow`** (`src/command-safety/`) is a shadow classifier: it scores and classifies every agent command and writes a row per call, but **decides nothing**. Off unless `shadow.url` is set; the URL must be loopback unless `allowRemote: true`.
- `bashApproval`, `approvalTimeout`, `sandbox` and `commandSafety` are **root-scoped** (ADR-031, `src/config/root-only-keys.ts`): a package config that sets one is warned about and ignored. `permissionProfile` and `permissions` stay per-package.

### Rules (Mandatory)

| Rule | Rationale |
|:-----|:----------|
| **Resource openers resolve permissions; nobody above does** | `SessionManager.openSession` and `AgentManager` (`completeAs`, `runAs`, `runAsSession`) call `resolvePermissions` (ADR-019 §3); ops, `callOp`, middleware and orchestrators never do |
| **Never hardcode permission modes** | No `?? true`, `?? false`, or literal `"approve-all"` / `"approve-reads"` — enforced by `scripts/check-permission-mode-ssot.ts`; a site that only consumes an already-resolved mode takes `// nax-permission-mode-allow: <reason>` |
| **Session close is a ruled exemption** | `closePhysicalSession` uses `SESSION_CLOSE_PERMISSION_MODE` (SEC-12): `src/agents/acp/` cannot import `NaxConfig` (`check:adapter-no-config-import`), and no agent work runs under the loaded-then-closed session |
| **Always pass `pipelineStage` upward** | Callers above the resource opener pass `pipelineStage`; the manager resolves once before invoking the adapter |
| **Adapter primitives receive `resolvedPermissions`** | `OpenSessionOpts` / `ResolvedCompleteOptions` carry pre-resolved permissions — adapters never re-resolve |
| **Nothing grants Bash but a human rule** | Adding `"Bash"` to a profile's tool list breaks ADR-029 §3; `test/integration/permissions/bash-deny-suite.test.ts` fails on purpose |

### Adding New Call Sites

ADR-019 split permission resolution between two resource openers:

| Caller | Where it resolves |
|:---|:---|
| `SessionManager.openSession(name, opts)` | Internally — caller passes `pipelineStage`, manager calls `resolvePermissions` once and forwards `resolvedPermissions` to `adapter.openSession` |
| `AgentManager.completeAs(name, prompt, opts)` | Internally — `buildCompleteCallPreamble` calls `resolvePermissions(opts.config ?? config, stage)` and forwards to `adapter.complete` |

Above those entry points, callers pass `pipelineStage`, never raw permission
values:

```typescript
// ✅ Correct — sessionless one-shot
await ctx.runtime.agentManager.completeAs(agentName, prompt, {
  modelDef,
  workdir,
  pipelineStage: "complete",
  config,
});

// ✅ Correct — session-bound (orchestrator opens its own handle)
const handle = await ctx.runtime.sessionManager.openSession(name, {
  agentName,
  workdir,
  modelDef,
  timeoutSeconds,
  pipelineStage: "run",
  signal: ctx.signal,
});

// ✅ Correct — through callOp (most ops): Operation.stage drives the stage,
// no manual permission threading
await callOp(ctx, semanticReviewOp, input);
```

```typescript
// ❌ Wrong: hardcoded
const args = ["--dangerously-skip-permissions", ...rest];

// ❌ Wrong: resolving permissions in a middle layer
// (only resource openers — SessionManager.openSession / AgentManager — resolve)
const perms = resolvePermissions(config, "run");
await sessionManager.openSession(name, { resolvedPermissions: perms, ... });
```

**Rule:** the resource opener resolves permissions. Orchestrators, `callOp`,
middleware, and ops never call `resolvePermissions` themselves.

### Reference Files

- **Resolver:** `src/config/permissions.ts` — `resolvePermissions()`, `DEFAULT_PERMISSION_PROFILE`, `SESSION_CLOSE_PERMISSION_MODE`, `DEFAULT_CODING_TOOLS`, `BUILT_IN_EXEC_PATTERNS`
- **Schema:** `src/config/schemas-execution.ts` — `permissionProfile`, `bashApproval`, `approvalTimeout`, `sandbox`, `commandSafety`, `permissions`
- **Policy compilation / enforcement:** `src/tools/policy.ts`, `src/tools/policy-bash.ts`, `src/tools/policy-bash-raw.ts`, `src/tools/runtime.ts`; per-call audit rows in `src/tools/tool-audit.ts`
- **Ask tier:** `src/permissions/` (`ask-chain.ts`, `ask.ts`, `approvals-store.ts`, `approvals-taint.ts`), `src/interaction/dispatch-ask.ts`
- **ACP adapter:** `src/agents/acp/adapter.ts`
- **Resource openers:** `src/session/manager.ts` (`openSession`), `src/agents/manager.ts` (`completeAs`, `runAs`, `runAsSession`)
- **Specs / ADRs:** `docs/specs/scoped-permissions.md` (PERM-001 + PERM-002), ADR-029 (Phase C scope), ADR-030 (bash approval modes, sandbox amendments), ADR-031 (root-scoped keys)

---

## §15 Test Strategy Resolution

### Single Source of Truth

`src/config/test-strategy.ts` defines all valid test strategies, shared prompt fragments,
and the `resolveTestStrategy()` normalizer. This module is the ONLY place where test
strategy values, descriptions, and classification rules are defined.

### Available Strategies

`VALID_TEST_STRATEGIES`, with the default assignment the planning prompt (`TEST_STRATEGY_GUIDE`) gives each complexity:

| Strategy | Default for complexity | Description |
|:---------|:-----------|:------------|
| `no-test` | — | Zero behavioural change (config, docs, CI, dependency bumps). Requires `noTestJustification` (validated in `src/prd/schema-story.ts`) |
| `test-after` | — | Implementation first, then tests; exploratory/prototype stories only |
| `tdd-simple` | simple, medium | Failing tests first, then implement — one session |
| `three-session-tdd-lite` | complex | 3 sessions: test-writer (lite, may add src/ stubs) → implementer (may replace stubs) → verifier |
| `three-session-tdd` | expert | 3 sessions: test-writer (strict, no src/ changes) → implementer (no test changes) → verifier |

### Rules

1. **resolveTestStrategy()** normalizes legacy values (`none` → `no-test`, `tdd` → `tdd-simple`, `three-session` → `three-session-tdd`, `tdd-lite` → `three-session-tdd-lite`) and falls back to `test-after` for unknown or missing values
2. **Security override**: security-critical stories (auth, access control, credentials, tokens, sessions, cryptography) → `three-session-tdd` regardless of complexity
3. **No standalone test stories**: Testing is handled per-story via testStrategy
4. Classification predicates (`isThreeSessionStrategy`, `isSingleSessionTestOwningStrategy`) live here too — never re-derive them from string comparisons
5. Both `plan-builder.ts` and `decompose-builder.ts` import shared prompt fragments — never inline strategy definitions

### Consumers

| File | Uses |
|:-----|:-----|
| `src/prompts/builders/plan-builder.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` (plus the AC / spec-anchor / description rules) |
| `src/prompts/builders/decompose-builder.ts` | `COMPLEXITY_GUIDE`, `TEST_STRATEGY_GUIDE`, `GROUPING_RULES` |
| `src/prd/schema-story.ts` | `resolveTestStrategy()` for PRD validation |
| `src/agents/shared/decompose.ts` | `resolveTestStrategy()` when parsing decompose output |

---

## §16 Agent Adapter Conventions

*Added: 2026-03-16 (MR !52 — agents folder restructure). Updated 2026-04-27 for ADR-019 4-primitive surface; 2026-09-25 for the ACP/native transport split (ADR-027/028).*

### Adapter surface — 4 primitives (ADR-019) + one optional teardown hook

```typescript
interface AgentAdapter {
  // Session-related work — composed by SessionManager
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
  closeSession(handle: SessionHandle): Promise<void>;

  // Sessionless one-shot — called directly by AgentManager.completeAs
  complete(prompt: string, opts: ResolvedCompleteOptions): Promise<CompleteResult>;

  // Optional: close a session this process holds no live handle for (#1702)
  closePhysicalSession?(handle: string, workdir: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<void>;
}
```

Alongside the primitives the interface carries descriptive members — `name`, `displayName`,
`binary`, `capabilities`, `isInstalled()`, `buildCommand()` (dry-run display) and an optional
`hasCredentials()` probe used by `AgentManager.validateCredentials()` at run start. The native
adapter answers the process-shaped ones honestly (no binary, no command, no pid) rather than
faking them.

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

**`plan` and `decompose` are gone too** — they are typed operations under
`src/operations/` (`planInteractiveOp` / `planRefineOp` are `kind:"run"`, `decomposeOp` is `kind:"complete"`), dispatched through `callOp` (§37).

### `interactionHandler` — mid-turn callback

The framework injects an `interactionHandler` into every `sendTurn` call. It
handles permission prompts, tool calls, and context-tool resolution between the
adapter's request and final response. The adapter dispatches to the handler;
SessionManager and above never see these round-trips.

`TurnResult.internalRoundTrips` surfaces the count for audit/metrics, but it is
not state SessionManager tracks across turns.

### Folder Structure

Two transports, selected by agent **name** (ADR-027): `createAgentRegistry` (`src/agents/registry.ts`) returns `NativeAgentAdapter` for `native` and `AcpAgentAdapter` for every other known name (`claude`, `codex`, `opencode`, `gemini`, `aider`, `pi`).

| Adapter / concern | Folder | Contents |
|:--------|:-------|:------|
| ACP protocol (every CLI agent, via acpx) | `acp/` | adapter (+ `adapter-lifecycle`, `adapter-output`, `adapter-complete-flow`, `adapter-close-physical`, `adapter-session-types`), spawn-client (+ `-process`, `-session`, `-deps`), parser, stdout-line-reader, interaction-bridge, parse-agent-error, token-mapper, reasoning-effort, session-ids, agent-entries, wire-types, types, index |
| Native in-process path over `@nathapp/nax-ai` | `native/` | adapter, client (memoised nax-ai client), models (rate card, context window, catalog overrides), model-resolver, auth / credentials, errors, session-affinity, index |
| Native session + tool loop (ADR-028/029) | `native/session/` | `turn-loop` (plus `turn-*` steps: tool batch, compaction, retry, ask-human, completion), `loop-events/` (before/after-tool event registry), `tool-result` (the single tool-result constructor), `transcript-store` (persisted conversation; a transcript written by another model or op invocation reads as a new conversation), compaction, nudge, truncation-handler |
| nax-ai catalog boundary (non-native side) | `catalog/` | `lookupPricing()` — maps nax-ai `Pricing` onto `TokenPricing` |
| Centralized cost | `cost/` | calculate, estimate (`priceCall`, tier selection), rate-card (`resolveRateCard`, `FALLBACK_RATES`), model-aliases.json, token-mapper, types, index |
| Retry policy | `retry/` | `RetryStrategy`, default strategy, hop retry policy, presets |
| Cross-adapter helpers | `shared/` | see below |

The `src/agents/` root holds the transport-neutral layer: `AgentManager` (`manager*.ts`), the registry, the coding-tool wiring for native runs (`coding-tool-*.ts`, `universal-coding-tools.ts`), and shared types. `agent.protocol` (`acp` | `native` | `hybrid`, default `hybrid`) is a capability gate that decides which transports are permitted, not a router; `agent.default` defaults to `native` (`src/config/agent-defaults.ts`). `protocol: "acp"` with the `native` default is rejected at config load (`src/config/schemas-protocol-gate.ts`).

### Rules

1. **Adapter-specific code lives in the adapter's subfolder** — the `src/agents/` root is for the transport-neutral manager/registry/coding-tool layer, never for one adapter's internals
2. **Each multi-file adapter needs `index.ts`** — re-exports everything external callers need; internal modules import directly without going through the barrel
3. **Cross-adapter code goes in `shared/`** — if two different adapters import the same module, that module belongs in `shared/`, not inside either adapter's folder
4. **Cost is centralized** — rate cards and pricing live in `src/agents/cost/` (`resolveRateCard` on the ACP side, `buildRateCard` in `native/models.ts` on the native side, both priced by `priceCall`). Adapters stamp `pricingSource` and `rates` on their results; recording flows through the cost middleware (`DispatchEvent` → `CostAggregator`), per `.claude/rules/adapter-wiring.md`
5. **nax-ai stays behind two folders** — `@nathapp/nax-ai` may be imported only from `native/` and `catalog/` (`bun run check:nax-ai-imports`); `acp/` may not import `NaxConfig` (`check:adapter-no-config-import`)

### `shared/` Contents

| File | Purpose | Used by |
|:-----|:--------|:--------|
| `shared/decompose.ts` | Decompose output parser (`parseDecomposeOutput`, `coerceComplexity`) | `operations/decompose.ts` |
| `shared/agent-profile-resolver.ts` | `resolveAgentAssignment()` — per-story agent/model assignment | `plan/strategies/finalize-routing.ts` |
| `shared/env.ts` | `buildAllowedEnv()` — env allowlist for spawned processes | `acp/spawn-client.ts`, `hooks/runner.ts`, `utils/command-argv.ts` |
| `shared/model-resolution.ts` | `resolveBalancedModelDef()` | (no `src/` consumer today) |
| `shared/validation.ts` | Agent capability + tier validation | re-exported from `agents/index.ts` |
| `shared/version-detection.ts` | Binary version detection | `cli/agents.ts`, `precheck/checks-agents.ts` |
| `shared/types-extended.ts` | Plan/decompose/interactive types | `types.ts`, `operations/decompose.ts`, `cli/plan-decompose.ts`, `prd/decompose-mapper.ts` |

### Session Error Retries

Retry policy is expressed through `src/agents/retry/` (issue #856 SSOT — see `.claude/rules/retry-strategy.md`). The adapter classifies failures into an `AdapterFailure` (outcome, category, `retriable`; `SessionTurnError.retryable` carries the transport's own verdict), and the policy table in `failure-policy.ts` maps each outcome to a lane:

- **Same-agent hop retries** (`trySameAgentRetry`, `hop-retry-policy.ts`) — `fail-stale` up to `agent.idleWatchdog` `maxRetryAttempts`; timeouts per the timeout-retry config; and the adapter-error lane, bounded by `execution.sessionErrorRetryableMaxRetries` (default `3`) when the failure is retriable and `execution.sessionErrorMaxRetries` (default `1`) otherwise.
- **Manager-tier backoff** (`defaultRetryStrategy`) — `fail-rate-limit`, `fail-stale` and `fail-service-down` back off 2s/4s/8s across up to 3 retries, or honour a provider-reported `retryAfterSeconds`.
- **Op-tier** `op.retry` declarations handle parse/transient failures in `callOp`.

### Layered Retry Semantics

nax has three independent retry layers, each targeting a different failure class:

| Layer | Config | Triggers on | Behaviour |
|:------|:-------|:------------|:----------|
| Agent-internal retry | `agent.acp.promptRetries` (acpx, default `0`) / `agent.native.transportRetry` (native, default 3 attempts × 2000ms) | A transient provider fault inside one call — a stalled stream, a 502/503 | Re-issues that call, with backoff, before the dispatch layers ever see a failure |
| Op / manager retry (nax) | `op.retry` per `Operation` + `defaultRetryStrategy` (`src/agents/retry/`) | Parse failures, rate limits, transient adapter errors | `RetryStrategy.shouldRetry()` decides; bounded by `MAX_COMPLETE_RETRY_ATTEMPTS` |
| Tier escalation (nax) | `autoMode.escalation.*` (`tierOrder`, `escalateEntireBatch`) | Repeated rectification failures | Bumps model tier (fast → balanced → powerful) |

**The first layer has one meaning and two implementations**, because the two transports put the agent in different places:

- **ACP** — nax passes `--prompt-retries` to acpx, which spawns claude / codex / opencode. The retry happens inside that child process, on its own timeout, outside nax entirely. JSON output stays stable, and it is skipped once side effects have occurred.
- **Native** — there is no child process; nax *is* the agent. The equivalent retry therefore lives in nax, in the native turn loop (`src/agents/native/session/turn-retry.ts`, nax#1870). It re-issues a single round trip on a `transport` or `overloaded` fault, with equal-jitter backoff capped by the turn's remaining budget.

This is why neither one is a `RetryStrategy`: the op/manager tiers govern nax's **dispatch** — whether to re-dispatch a call — while this layer sits underneath both, inside the execution of a single call.

**Key rule:** agent-internal retry is the cheapest layer — on ACP it fires inside acpx before nax sees a result, and on native it fires inside the turn loop before a round trip is abandoned. Tune it for transient-provider tolerance without overlapping the escalation logic. The failure classes are disjoint: in-call transients vs. quality failures vs. repeated quality failures.

### Decompose Prompts

`src/prompts/builders/decompose-builder.ts`:
- `buildDecomposePromptSync()` — decompose prompt builder composed with `OneShotPromptBuilder`
- Two modes: **spec decomposition** (spec → user stories) and **plan sub-story splitting** (single story → sub-stories)
- Carries `DECOMPOSE_SPEC_SCHEMA` and `DECOMPOSE_PLAN_SCHEMA` for structured JSON output; the reply is parsed by `parseDecomposeOutput()` in `src/agents/shared/decompose.ts`

### Cost Recording

Both adapters price a call the same way: a `TokenPricing` rate card → `priceCall(usage, rates)` (`src/agents/cost/estimate.ts`), which selects a threshold tier (`tiers[].inputTokensAbove`, the whole request reprices) and falls back to `inputPer1M` for cache rates the card does not publish. The result carries `estimatedCostUsd`, `pricingSource` and the resolved per-1M `rates` (omitted when usage is zero, so "did not price" stays distinguishable from "priced at zero").

| Path | Rate card | `pricingSource` |
|:-----|:----------|:----------------|
| ACP | `resolveRateCard(modelId)` (`cost/rate-card.ts`): alias file / provider inference → nax-ai catalog via `catalog/lookupPricing` | `catalog-rates`, else `fallback-rates` (`FALLBACK_RATES`, $3 / $15 per 1M, warned per id) |
| Native | `buildRateCard(client.pricing(resolved), modelDef.pricing)` (`native/models.ts`) | `config-override` when `ModelDef.pricing` is set, else `catalog-rates` |

ACP sessions may also emit exact USD cost over the wire. `buildTurnResult` (`acp/adapter-output.ts`) keeps the wire-reported `exactCostUsd` as an independent field (`undefined` when the wire never reported one); the cost middleware decides that `wire` wins over the card. The native path never sets `exactCostUsd`.

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
| Provide tool-result content | `src/agents/acp/adapter-output.ts` | File contents are the repo's own — no prompt-injection delimiter escaping |
| Override security-sensitive config | project `.nax/config.json` (warned, not blocked — see SEC-2 / D-2) | Project layer wins the merge; the loader warns when a project layer changes `execution.permissionProfile` or `quality.stripEnvVars` from their global values |

### Explicitly NOT being built

Out-of-process plugin isolation, sandboxing of repo-declared commands
(`quality.commands`, hooks, acceptance), prompt-injection delimiter escaping,
first-run per-repo trust prompts. Do not raise these again in reviews — see the
D-1 ruling from the 2026-08-14 deep code review.

The OS sandbox that *does* exist (`execution.sandbox`, on by default — §14)
does not change this: it wraps only **agent-authored** Bash and `Exec`
commands, as a blast-radius limiter for the agent's own mistakes, with network
egress open by default (ADR-030 amendments, "threat model unchanged (D1)").
Likewise `buildAllowedEnv()` / `quality.stripEnvVars` keep credentials out of
spawned agents; they are hygiene, not a boundary against the repo.

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
