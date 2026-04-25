# ADR-019: Adapter Primitives, Full SessionManager Ownership, and AgentManager/SessionManager Peer Boundary

**Status:** Accepted
**Date:** 2026-04-25
**Author:** William Khoo, Claude
**Supersedes:** ADR-013 §Decision (the "SessionManager orchestrates AgentManager" hierarchy claim)
**Amends:** ADR-018 §1 (drops `ISessionRunner` from Layer 3), §6 (the eventual 4-method adapter surface is reached jointly by ADR-019 + Wave 3 `plan`/`decompose` migration, not by ADR-018 alone)
**Preserves:** ADR-018 §2 (`NaxRuntime`), §3 (`runAs` middleware envelope + permissions pre-chain), §4 (`Operation` + `callOp`), §5 (TDD/debate orchestrators as plain functions), §7 (`composeSections`)
**Origin:** ADR-018 PR-697 Findings 1–5; [docs/specs/adr-018-wave-3-followups.md](../specs/adr-018-wave-3-followups.md) Problem 1

---

## Context

ADR-018 Wave 2 landed the `runAs` middleware envelope, permissions pre-chain, and audit/cost sinks. PR-697 review surfaced five drift points between what ADRs 011/012/013 declared and what live code does. The drift is structural, not cosmetic — ADRs declare a clean ownership boundary; the live code implements a different one.

### The five drift points

| Concern | ADR says | Live code does | File:line |
|:---|:---|:---|:---|
| Turn count | SessionManager (lifecycle) | Adapter owns `turnCount` | [src/agents/acp/adapter.ts:634](../../src/agents/acp/adapter.ts#L634) |
| Session naming | SessionManager (agent-agnostic, ADR-011) | Adapter computes via `computeAcpHandle` | [src/agents/acp/adapter.ts:173](../../src/agents/acp/adapter.ts#L173) |
| Resume detection | SessionManager state machine | Adapter sets `sessionResumed` flag | [src/agents/acp/adapter.ts:598](../../src/agents/acp/adapter.ts#L598) |
| Inner interaction-bridge loop | Documented as "session multi-turn" but never split out | Adapter owns the loop (correct, but conflated with outer multi-prompt semantics that don't exist today) | [src/agents/acp/adapter.ts:634-716](../../src/agents/acp/adapter.ts#L634-L716) |
| `ensureSession`/`closeSession` | SessionManager (ADR-011) | Adapter calls inline | [src/agents/acp/adapter.ts:598,736](../../src/agents/acp/adapter.ts#L598) |

### Why this is now load-bearing

ADR-018 §6 commits to a permanent 2-method adapter surface (`run` + `complete`). That commitment was made before the dual-ownership glitches were confronted. Resolving them requires the adapter to expose session-lifecycle primitives that SessionManager calls — which contradicts the 2-method end state.

ADR-018 §1 introduced `SingleSessionRunner` (`ISessionRunner`) as the Layer-3 bookkeeping shim — the "shared call site for `SessionManager.runInSession`." That shim is load-bearing **only because SessionManager doesn't own the multi-turn loop today.** Once SessionManager owns the loop, the shim is unnecessary.

ADR-013 declares `SessionManager` > `AgentManager` as a strict hierarchy. In practice that creates an awkwardness: sessionless calls (Plan, Route, semantic review, debate-propose/rebut/rank, acceptance diagnose) have to be expressed through a fake-session wrapper or bypass SessionManager entirely. The hierarchy was the wrong shape for the actual workload mix.

### What changed since ADR-018

The CLI adapter is fully removed. [src/config/schemas.ts](../../src/config/schemas.ts) declares `protocol: z.literal("acp").default("acp")`. There is no longer any case for "adapters that don't have sessions." Every adapter, current and future, has session lifecycle. That removes the structural reason for the adapter to ever own session policy — the adapter exposes primitives, the framework orchestrates.

---

## Decision

Three numbered statements.

### 1. AgentAdapter exposes session-related work as 3 primitives + sessionless `complete`

```typescript
interface AgentAdapter {
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;
  closeSession(handle: SessionHandle): Promise<void>;
  complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult>;
  // plan, decompose: see scope note below — owned by Wave 3, not ADR-019
}
```

`AgentAdapter.run` is removed by Phase D below; its functionality lives in `SessionManager.runInSession` composing the 3 session primitives.

**Scope: `plan` and `decompose` are out of scope for ADR-019.** Both are sessionless one-shots and have nothing to do with session lifecycle reshape. Their migration to typed `kind:"complete"` Operations + adapter-method removal stays inside ADR-018 Wave 3 (and Wave 3.5 release gate). After ADR-019 lands but before Wave 3 finishes, the adapter has 6 methods (4 primitives + `plan` + `decompose`). After Wave 3 finishes, the adapter has 4 methods. The "permanent 4-method end state" is the joint product of ADR-019 + Wave 3, not of either alone.

### 2. SessionManager owns the full session lifecycle

Naming, descriptor state machine, turn count, resume detection, `sendPrompt`, and the multi-turn loop. The adapter is called via primitives; SessionManager owns the orchestration around them. SessionManager does not know AgentManager exists.

### 3. AgentManager and SessionManager are pure peers

Neither imports the other. Integration happens at the operation / `callOp` layer via the `executeHop` callback ([src/agents/manager-types.ts:75-80](../../src/agents/manager-types.ts#L75-L80)) — a typed seam already present in the live code (#596 / Wave 2). `runWithFallback` iterates the fallback chain and invokes the callback per hop; the callback owns context rebuild, session opening/handoff, prompt rewriting, and adapter dispatch.

AgentManager has three entry points:

- `completeAs(prompt, opts)` — sessionless. Calls `adapter.complete` directly. No SessionManager involvement.
- `runAs(agent, handle, prompt, opts)` — caller-provided handle. For orchestrators with custom session strategies (multi-session keep-open, multi-prompt-per-session). The middleware envelope wraps `sessionManager.sendPrompt(handle, prompt)`. The *caller* is responsible for opening the handle. No internal fallback.
- `runWithFallback(request)` — iterates the fallback chain, invokes `request.executeHop` per attempt. The callback owns the per-hop work (rebuild + open + send). AgentManager itself never calls SessionManager.

---

## 1. Layer architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Pipeline                                                         │
│   Story loop, escalation, run setup/teardown                     │
└──────────────────────────────────────────────────────────────────┘
                            │ each stage invokes one of:
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
┌──────────────┐   ┌──────────────────┐   ┌────────────────┐
│ Operation    │   │ Orchestrator     │   │ Non-AI work    │
│ (atomic)     │   │ (compound,       │   │ (test runs,    │
│ via callOp   │   │  multi-session)  │   │  file scans)   │
└──────────────┘   └──────────────────┘   └────────────────┘
        │                   │
        └─────────┬─────────┘
                  │ callOp constructs buildHopCallback for kind:"run";
                  │ calls completeAs directly for kind:"complete"
                  ▼
       ┌──────────────────────────────────────────┐
       │  Shape C — peer relationship             │
       │  AgentManager and SessionManager are     │
       │  composed at the callOp / runtime layer  │
       │  via the executeHop callback             │
       └──────────────────────────────────────────┘
        │                                  │
        ▼                                  ▼
┌─────────────────────────────┐    ┌─────────────────────────────────────┐
│ AgentManager                │    │ SessionManager                      │
│   Agent selection +         │    │   Lifecycle (CREATED → RUNNING →    │
│   fallback chain iteration  │    │     COMPLETED/FAILED)               │
│   Middleware (audit, cost,  │    │   Naming (agent-agnostic)           │
│   cancellation, logging)    │    │   Turn count, resume detection      │
│   resolvePermissions for    │    │   handoff (preserves descriptor     │
│     completeAs only         │    │     across fallback agent swaps)    │
│   Entry: completeAs / runAs │    │   sendPrompt (delegates to adapter) │
│       / runWithFallback     │    │   resolvePermissions for openSession│
└─────────────────────────────┘    └─────────────────────────────────────┘
        │ completeAs                        │
        ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ AgentAdapter (4 primitives)                                         │
│   openSession / sendTurn / closeSession / complete                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer responsibilities

| Layer | Owns | Doesn't own |
|:---|:---|:---|
| Pipeline | Story loop, escalation policy, run lifecycle | LLM calls, sessions, agents |
| Operation + `callOp` | Op shape, config selector, dispatch routing | Fallback iteration, session lifecycle |
| Orchestrator (when needed) | Multi-session sequencing, between-session logic | Single-session ops, session internals |
| AgentManager | Agent selection, fallback, permissions, middleware | Session lifecycle, protocol details |
| SessionManager | Session name + descriptor + turn count + resume + `sendPrompt` | Agent choice, agent fallback |
| Adapter | 4 protocol primitives | Session policy, agent choice |

**Peer-relationship invariant:** Pipeline → callOp; callOp → AgentManager (sessionless: completeAs) and callOp constructs `buildHopCallback` which uses both AgentManager and SessionManager. Neither AgentManager nor SessionManager imports the other. Adapter primitives are called only by SessionManager (for openSession/sendTurn/closeSession) and AgentManager (for complete) — the wiring layer per ADR-013 Phase 4 extends to `src/agents/manager.ts` + `src/agents/utils.ts` + `src/session/manager.ts`.

---

## 2. AgentAdapter — 4 primitives

```typescript
interface AgentAdapter {
  /** Open or resume a session by name. Caller (SessionManager) provides the name; adapter handles open-or-resume internally. */
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;

  /** Send one prompt; agent runs to completion (with internal interaction round-trips handled via opts.interactionHandler). Returns one final result. */
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;

  /** Close the session. Idempotent. */
  closeSession(handle: SessionHandle): Promise<void>;

  /** Sessionless one-shot. No session, no state, no interactionHandler. */
  complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult>;
}

interface OpenSessionOpts {
  agentName: string;                  // claude, codex, etc.
  workdir: string;
  resolvedPermissions: ResolvedPermissions;  // pre-resolved by SessionManager.openSession (see §3)
  resume?: boolean;                          // SessionManager sets true when descriptor exists
  signal?: AbortSignal;
  // ... protocol-specific opts pass through
}

interface SendTurnOpts {
  interactionHandler: InteractionHandler;  // mid-turn permission/tool/context-tool callback
  signal?: AbortSignal;
}

interface TurnResult {
  output: string;                     // final agent answer
  tokenUsage: TokenUsage;
  cost?: CostBreakdown;
  internalRoundTrips: number;         // formerly adapter.turnCount — useful as a metric
}

interface SessionHandle {
  readonly id: string;                // opaque to callers above SessionManager
  readonly agentName: string;
  readonly protocolIds?: ProtocolIds; // canonical source — established at openSession, immutable after
}
```

### `interactionHandler` — mid-turn callback

The `interactionHandler` is the framework's callback for protocol-level interactions during a single `sendTurn` invocation: permission prompts, tool calls, context-tool resolution, anything the agent emits between request and final response. The adapter runs the inner loop (what was today's `turnCount` loop in the ACP adapter) and dispatches to the handler whenever the agent asks for something. SessionManager and above never see these round-trips.

This keeps protocol details inside the adapter. SessionManager owns the *outer* turn — one prompt, one final result. The adapter owns the *inner* turn — interaction round-trips before the agent says "done."

The `internalRoundTrips` field on `TurnResult` surfaces the count for audit/metrics, but it is not state SessionManager tracks across turns.

### `InteractionHandler` contract

The handler is the only seam where the framework injects policy into the adapter's inner loop. Implementations MUST:

| Obligation | Reason |
|:---|:---|
| Honor the `resolvedPermissions` policy passed at `openSession` time. Reject out-of-scope permission requests by responding "deny." | Permissions are resolved once per session by SessionManager.openSession (see §3); the handler enforces them per-interaction. |
| Forward context-tool requests to the framework's context resolver | Context tools are framework-owned; adapter should not reach into project files itself. |
| Cooperate with `signal` cancellation — abort cleanly when the signal aborts mid-handler | Without signal honoring, an aborted run can leave the agent waiting for a response that never comes, hanging the session. |
| Be re-entrant within one `sendTurn` (the adapter may dispatch multiple interactions per turn) | The inner loop is N round-trips; handler runs N times per turn. |

Implementations MAY emit telemetry events for observability but MUST NOT mutate descriptor state or session metadata — those are SessionManager's domain. The handler returns a typed response shape per interaction kind; full type lives in `src/agents/interaction-handler.ts` (introduced in Phase A).

### What `run` becomes

`AgentAdapter.run` is gone after Phase D. The functionality lives in `SessionManager.runInSession`, which composes `openSession` + `sendTurn` + `closeSession`. Existing `run()` callers migrate to either `SessionManager.runInSession` (most callers) or `SessionManager.openSession` + `sendPrompt` + `closeSession` (orchestrators with custom session strategies).

### What stays untouched: `plan` and `decompose`

`AgentAdapter.plan` and `AgentAdapter.decompose` are out of scope for ADR-019. Their migration to typed `kind:"complete"` Operations and adapter-method removal stays inside ADR-018 Wave 3. ADR-019 leaves them alone — `plan` and `decompose` are sessionless one-shots, structurally unrelated to the session-lifecycle reshape this ADR is about.

After ADR-019 Phase D the adapter surface is `{ openSession, sendTurn, closeSession, complete, plan, decompose }`. Wave 3 (independently) migrates the latter two to typed Operations and removes the adapter methods. After Wave 3 the surface is `{ openSession, sendTurn, closeSession, complete }`.

---

## 3. SessionManager — full session ownership

### API surface

```typescript
interface ISessionManager {
  // Lifecycle
  openSession(name: string, opts: OpenSessionRequest): Promise<SessionHandle>;
  closeSession(handle: SessionHandle): Promise<void>;
  resume(name: string): Promise<Descriptor | null>;

  // Per-prompt operation — single-flight per handle (see invariant below)
  sendPrompt(handle: SessionHandle, prompt: string, opts: SendPromptOpts): Promise<TurnResult>;

  // Convenience — two overloads
  runInSession(name: string, prompt: string, opts: RunInSessionOpts): Promise<TurnResult>;
  runInSession<T>(name: string, runFn: (handle: SessionHandle) => Promise<T>, opts: RunInSessionOpts): Promise<T>;

  // Naming (agent-agnostic, was previously adapter-internal)
  nameFor(req: NameForRequest): string;

  // Descriptor introspection
  descriptor(name: string): Descriptor | null;
  bindHandle(name: string, handle: SessionHandle): void;
}
```

**Two `runInSession` overloads, two use cases:**

- **Prompt form** `runInSession(name, prompt, opts)` — convenience for "open, send one prompt, close." Equivalent to `openSession + sendPrompt + closeSession` with try/finally cleanup. Most ops use this via `callOp`.
- **Callback form** `runInSession(name, runFn, opts)` — transactional multi-prompt. Caller's `runFn` runs against a live handle; SessionManager handles open/close around it. Used by orchestrators that send 2+ prompts in one session (debate-stateful debater rounds, future keep-open patterns).

For ad-hoc multi-prompt without transactional semantics, callers can use `openSession` + `sendPrompt` × N + `closeSession` directly.

### Single-flight invariant

`SessionHandle` is single-flight. Concurrent `sendPrompt` calls against the same handle are not supported — the second one throws `NaxError SESSION_BUSY` until the first completes. Rationale: ACP and most session protocols are single-request-in-flight per session; supporting concurrent prompts would require multiplexing the transport, which no current adapter does. Callers needing parallelism open multiple sessions.

### Permission resolution at session boundary

`SessionManager.openSession` resolves permissions internally:

```typescript
async openSession(name: string, opts: OpenSessionRequest): Promise<SessionHandle> {
  const resolvedPermissions = resolvePermissions(
    this._configLoader.current(),
    opts.pipelineStage,
  );
  const handle = await this._adapter.openSession(name, {
    agentName: opts.agentName,
    workdir: opts.workdir,
    resolvedPermissions,                  // adapter receives pre-resolved
    signal: opts.signal,
  });
  // ... record descriptor, etc.
  return handle;
}
```

`OpenSessionRequest` (the SessionManager API input) takes `pipelineStage`, not `resolvedPermissions`. SessionManager owns the resolution because it is the resource opener. `OpenSessionOpts` (the adapter primitive input — see §2) still receives `resolvedPermissions` because the adapter needs the policy upfront and is the consumer; SessionManager is the producer.

The unified rule: **the resource opener resolves permissions.** SessionManager.openSession (for sessions) and AgentManager.completeAs (for sessionless one-shots — see §4) both call `resolvePermissions(config, stage)` once before invoking the adapter. Orchestrators, callOp, and middleware never resolve permissions themselves. `resolvePermissions` is a config-domain utility from `src/config/permissions.ts`; SessionManager imports it directly without depending on AgentManager.

### `handoff()` — descriptor preserved across fallback agent swaps

```typescript
handoff(descriptorId: string, newAgent: string, reason?: string): SessionDescriptor;
```

When `runWithFallback` swaps to the next agent in the chain, the descriptor stays alive — `handoff()` updates `descriptor.agent` and re-binds `protocolIds` (via `bindHandle`) for the new agent's session. **One descriptor per story attempt, even if multiple agents try.** This preserves cross-fallback audit correlation: the audit trail for one storyId attempt has one descriptor lifecycle, with `descriptor.agent` history captured via the `reason` parameter.

The alternative — closing the descriptor and opening a new one per fallback agent — was rejected. Fragmenting one logical attempt into N descriptors loses correlation and gains nothing, since `handoff()` already cleanly expresses "same logical attempt, different protocol-level session."

**Scope of `handoff()` — metadata only.** `handoff()` updates the descriptor (sets `descriptor.agent`, records the `reason`, persists the change). It does NOT call `adapter.openSession` or `adapter.closeSession`. Those are separate calls made by `buildHopCallback` (§5).

**Per-hop session lifecycle, end-to-end:** for each fallback iteration, `buildHopCallback` does:

1. (if fallback hop) `handoff(descriptorId, newAgent)` — update descriptor metadata
2. `openSession(name, { agentName, … })` — open a fresh adapter-level session for this agent
3. `agentManager.runAs(agent, handle, prompt)` — send prompt (middleware wraps this)
4. `closeSession(handle)` in `finally` — clean up this hop's adapter session

Each hop is self-contained. The prior hop's adapter session was already closed in its own `finally`. The descriptor stays alive across all hops; only adapter-level sessions come and go. Splitting `handoff()` (state) from `openSession`/`closeSession` (adapter calls) keeps each method scoped and lets tests verify each independently.

**Implication for the adapter primitive surface (§2):** `adapter.openSession`/`closeSession` are called per agent (each agent gets its own ACP-level session). The framework descriptor wraps these adapter-level sessions over its lifetime — one descriptor, N adapter sessions, with `bindHandle` re-binding `protocolIds` on each swap.

### Mid-turn cancellation invariants

If `sendPrompt` aborts mid-turn (signal abort during the adapter's inner interaction-bridge loop), SessionManager marks the descriptor `CANCELLED`. Subsequent `sendPrompt` against the same handle throws `NaxError SESSION_CANCELLED` — the session must be closed and a new one opened to continue. Adapters MUST clean up any in-flight protocol state (open subscriptions, partial responses) before returning from the aborted call.

This is conservative — partial-turn recovery is feasible in some protocols but is not load-bearing today.

### Responsibilities moved from adapter

| Responsibility | Was | Now |
|:---|:---|:---|
| Turn count (outer) | adapter `turnCount` field | SessionManager descriptor `turnCount` |
| Session naming | adapter `computeAcpHandle()` | SessionManager `nameFor()` (agent-agnostic; protocol-specific details go through adapter at `openSession`) |
| Resume detection | adapter `sessionResumed` flag | SessionManager checks descriptor before calling `adapter.openSession` with resume hint |
| Open-or-resume call site | adapter `ensureAcpSession` inline | SessionManager calls `adapter.openSession(name, { resume: descriptor != null })` |
| Close call site | adapter inline | SessionManager calls `adapter.closeSession(handle)` |
| Multi-turn outer loop | adapter loop body 634–716 | SessionManager (when caller sends multiple prompts in one session) |

### What stays adapter-internal

- Inner interaction-bridge loop (per `sendTurn`): tool calls, permission prompts, context-tool resolution. Surfaces to SessionManager only via `internalRoundTrips` count.
- Protocol-specific handle representation (the actual ACP session ID, JSON-RPC client state). `SessionHandle` is the framework's typed view; the adapter holds the live state.

### Naming

`SessionManager.nameFor()` produces an agent-agnostic session name. The function takes the request fields the today's `computeAcpHandle()` reads (`workdir`, `featureName`, `storyId`, `agentName`, `pipelineStage`) and produces a stable string. Adapter no longer computes names. If a future protocol needs a transformed name on the wire, that transformation happens inside `adapter.openSession`, not at the framework name level.

---

## 4. AgentManager — three entry points

### `completeAs` — sessionless

```typescript
async completeAs(prompt: string, opts: CompleteOpts): Promise<CompleteResult> {
  const permissions = resolvePermissions(this._config, opts.pipelineStage);
  return this._middleware.execute(
    { kind: "complete", agentName: opts.agentName, options: { ...opts, resolvedPermissions: permissions }, signal: opts.signal },
    async () => this._dispatch(opts.agentName).complete(prompt, { ...opts, resolvedPermissions: permissions }),
  );
}
```

No SessionManager involvement. The `runAs` middleware envelope (audit, cost, cancellation, logging — ADR-018 §3) wraps `adapter.complete` directly.

Used by: Plan, Route, semantic review, adversarial review, debate-propose/rebut/rank, acceptance diagnose, any future `kind:"complete"` op.

### `runAs` — caller-managed session

```typescript
async runAs(agent: string, handle: SessionHandle, prompt: string, opts: RunAsOpts): Promise<TurnResult> {
  // Permissions were resolved at openSession time. runAs trusts the handle.
  return this._middleware.execute(
    { kind: "run", agentName: agent, options: opts, signal: opts.signal, sessionHandle: handle },
    async () => this._sendPrompt(handle, prompt, opts),
  );
}
```

The caller (typically `buildHopCallback`, see §5) opened the session via SessionManager and provides the handle. AgentManager applies the middleware envelope (audit, cost, cancellation, logging) around prompt dispatch. The dispatch function `_sendPrompt` is injected at AgentManager construction by `NaxRuntime` — wiring `sessionManager.sendPrompt` in production, mock dispatch in tests.

**On the "no import" claim:** AgentManager imports *types* from the session domain (`SessionHandle`, `TurnResult` — these live in `src/session/types.ts`, importable without taking a SessionManager class dependency). What AgentManager does not import is the SessionManager *class* or its module-level state. The injected `_sendPrompt` is a function reference, not a method bound to a SessionManager instance the manager knows about. This is the standard "depend on interface, not implementation" pattern — type imports for shape, DI for behavior. Tests can construct AgentManager with any compatible `_sendPrompt` callable; no SessionManager mock needed.

No internal fallback. If the adapter fails, the error propagates to the caller. The caller decides what to do (retry, swap, abort).

Used by: orchestrators that keep a session open across multiple prompts (TDD multi-prompt within one session, debate-stateful with persistent debater context, acceptance fix-then-verify in one session).

### `runWithFallback` — chain iteration, callback delegation

`runWithFallback` matches the existing live shape ([src/agents/manager.ts:159-296](../../src/agents/manager.ts#L159-L296), [src/agents/manager-types.ts:75-80](../../src/agents/manager-types.ts#L75-L80)). It iterates the fallback chain and invokes `request.executeHop` per attempt. The callback owns the per-hop work; `runWithFallback` owns the chain.

```typescript
async runWithFallback(request: AgentRunRequest): Promise<AgentRunOutcome> {
  const fallbacks: AgentFallbackRecord[] = [];
  let currentAgent = this.getDefault();
  let currentBundle = request.bundle;
  let currentFailure: AdapterFailure | undefined;
  let finalPrompt: string | undefined;

  while (true) {
    const hopOut = await request.executeHop!(currentAgent, currentBundle, currentFailure, request.runOptions);

    if (hopOut.result.success) {
      return { result: hopOut.result, fallbacks, finalBundle: hopOut.bundle, finalPrompt: hopOut.prompt, finalAgent: currentAgent };
    }

    const failure = hopOut.result.adapterFailure;
    if (!this.shouldSwap(failure, fallbacks.length, !!hopOut.bundle)) {
      // Rate-limit retry stays internal: signal-aware backoff race, max 3 retries.
      // Other non-swap-eligible failures terminate the loop.
      if (failure?.outcome === "fail-rate-limit") return await this.handleRateLimitOrReturn(/* … */);
      return { result: hopOut.result, fallbacks, finalBundle: hopOut.bundle, finalPrompt: hopOut.prompt, finalAgent: currentAgent };
    }

    this.markUnavailable(currentAgent);
    const next = this.nextCandidate(currentAgent);
    if (!next) return { /* exhausted */ };

    fallbacks.push({ from: currentAgent, to: next, reason: failure?.outcome });
    currentAgent = next;
    currentBundle = hopOut.bundle ?? currentBundle;
    currentFailure = failure;
    finalPrompt = hopOut.prompt ?? finalPrompt;
  }
}
```

`runWithFallback` owns:
- Chain iteration and `currentAgent` advancement
- `shouldSwap` eligibility checking
- `nextCandidate` selection from the fallback map
- Agent unavailability tracking (`markUnavailable`)
- Rate-limit retry with signal-aware backoff (max 3 retries; race against `request.signal`)
- `AgentRunOutcome` shape with `fallbacks` audit trail

`runWithFallback` does NOT own (callback's job):
- Opening sessions or calling `SessionManager`
- Calling `contextEngine.rebuildForAgent`
- Rewriting prompts via `RectifierPromptBuilder.swapHandoff`
- Calling adapter primitives

The `bundle` and `failure` parameters thread agent-aware state across hops without coupling AgentManager to ContextEngine. Each hop's callback receives the prior bundle and the failure that triggered this hop; the callback decides how to use them.

### Why callback delegation, not inline session opening

Earlier ADR-019 drafts had `runWithFallback` open sessions internally (Shape B — one-way dependency from AgentManager → SessionManager). Code analysis surfaced that the live `runWithFallback` already uses callback delegation via `executeHop` ([single-session-runner.ts:96-196](../../src/session/runners/single-session-runner.ts#L96-L196)) — what's now called Shape C in §6. Callback delegation is preserved because:

- AgentManager and SessionManager become genuine peers (no import either direction)
- Phase 4 boundary (no direct adapter calls outside `src/agents/manager.ts` / `src/agents/utils.ts`, see ADR-013) is preserved naturally — adapter primitives flow through SessionManager only
- Migration is rename-and-relocate (move `executeHopFn` body to `buildHopCallback`), not rewrite
- The 140 lines of carefully-tuned chain iteration / rate-limit retry / signal handling in `runWithFallback` stay untouched

### Why three entry points, not one

A single entry point `runAs(prompt, opts)` would force the choice between "internally managed session lifecycle" (= `runWithFallback`) and "caller-provided handle" (= `runAs`). They are genuinely different shapes — one returns after one session, one iterates the fallback chain. Collapsing them either forces every caller to accept fallback behavior they may not want (orchestrators) or forces every caller to manage handles (most ops). Three entry points lets each caller pick the granularity.

`completeAs` is structurally separate — sessionless calls have no session state to manage and no fallback iteration to do (well, they have fallback, but it's degenerate — try next agent and retry the one-shot, no session bookkeeping).

---

## 5. `callOp` — dispatch routing + `executeHop` construction

```typescript
async function callOp<I, O, C>(ctx: OperationContext, op: Operation<I, O, C>, input: I): Promise<O> {
  const config = ctx.packageView.select(op.configSelector);
  const buildCtx: BuildCtx<C> = { ...ctx, config };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt = join(sections);

  if (op.kind === "complete") {
    const result = await ctx.runtime.agentManager.completeAs(prompt, ctx.toCompleteOpts(op));
    return op.parse(result.output, input, buildCtx);
  }

  // kind:"run" — Shape C: callOp constructs the executeHop callback
  const initialBundle = ctx.contextBundle;  // already assembled by the upstream context pipeline stage
  const executeHop = buildHopCallback(ctx, op, input, prompt);

  // sessionId provenance: comes from PipelineContext.sessionId (set by the session pipeline stage
  // that runs before any op invocation). For ad-hoc orchestrators that didn't go through the pipeline,
  // sessionId is undefined and buildHopCallback skips the descriptor handoff path.
  const outcome = await ctx.runtime.agentManager.runWithFallback({
    runOptions: ctx.toRunOptions(op, prompt),
    bundle: initialBundle,
    sessionId: ctx.sessionId,
    executeHop,
    signal: ctx.signal,
  });
  return op.parse(outcome.result.output, input, buildCtx);
}
```

For `kind:"complete"`, `callOp` calls `agentManager.completeAs` directly — no session involvement. For `kind:"run"`, `callOp` constructs `buildHopCallback` (the `executeHop` factory) and passes it to `runWithFallback`. The callback owns rebuild + open + send for each hop.

**`initialBundle` provenance:** the context bundle is assembled by the upstream context pipeline stage ([src/pipeline/stages/context.ts](../../src/pipeline/stages/context.ts)) and stored on `PipelineContext.contextBundle` before any op runs. `callOp` reads it from there rather than re-assembling. For tests that bypass the pipeline, `ctx.contextBundle` may be `undefined` and `buildHopCallback` skips bundle-aware code paths gracefully.

For multi-session orchestrators (TDD three-session, debate), they call `callOp` once per sub-op for the simple cases, or open sessions via `SessionManager.openSession` directly and call `AgentManager.runAs(agent, handle, prompt)` for advanced cases (keep-open multi-prompt).

### `buildHopCallback` — the per-hop integration factory

The factory returns an `executeHop` callback bound to the current operation, input, and runtime. Lives in `src/operations/build-hop-callback.ts` (relocated from today's `src/session/runners/single-session-runner.ts`).

```typescript
// src/operations/build-hop-callback.ts (~80 lines, replaces SingleSessionRunner.executeHopFn)
// Generic over the op's input type I so field accesses (input.workdir, input.featureName, input.storyId)
// are typed at the call site. The body below assumes I extends a base "story-shaped" input — concrete
// ops parameterize accordingly via their Operation<I, O, C>.
export function buildHopCallback<I extends StoryInputBase>(
  ctx: OperationContext,
  op: Operation<I, unknown, unknown>,
  input: I,
  initialPrompt: string,
): NonNullable<AgentRunRequest["executeHop"]> {
  return async (agentName, priorBundle, failure, resolvedRunOptions) => {
    let workingBundle = priorBundle;
    let workingPrompt = initialPrompt;

    // 1. Rebuild context for the new agent if this is a fallback hop
    if (failure && priorBundle) {
      workingBundle = ctx.runtime.contextEngine.rebuildForAgent(priorBundle, {
        newAgentId: agentName,
        failure,
        storyId: input.storyId,
      });
      workingPrompt = RectifierPromptBuilder.swapHandoff(initialPrompt, workingBundle.pushMarkdown);

      // Audit: write rebuild manifest (preserves today's behavior at single-session-runner.ts:140-160)
      if (ctx.runtime.projectDir && input.featureName && workingBundle.manifest.rebuildInfo) {
        await writeRebuildManifest(/* … */);
      }
    }

    // 2. Handoff descriptor to the new agent (one descriptor preserved across fallback hops)
    if (failure && resolvedRunOptions.sessionId) {
      ctx.runtime.sessionManager.handoff(resolvedRunOptions.sessionId, agentName, failure.outcome);
    }

    // 3. Open a fresh adapter-level session for this agent
    const handle = await ctx.runtime.sessionManager.openSession(
      ctx.runtime.sessionManager.nameFor({ agentName, ...input, pipelineStage: op.stage }),
      { agentName, workdir: input.workdir, pipelineStage: op.stage, signal: ctx.signal },
    );

    try {
      // 4. Send prompt via AgentManager.runAs (middleware fires here: audit, cost, cancellation, logging)
      const result = await ctx.runtime.agentManager.runAs(agentName, handle, workingPrompt, {
        ...resolvedRunOptions,
        contextPullTools: workingBundle?.pullTools,
        contextToolRuntime: workingBundle
          ? createContextToolRuntime({ bundle: workingBundle, story: input, config: ctx.config, repoRoot: ctx.runtime.workdir, runCounter: ctx.contextToolRunCounter })
          : undefined,
      });

      // 5. Capture protocolIds early (#591) — bind to descriptor before runWithFallback returns
      if (result.protocolIds && resolvedRunOptions.sessionId) {
        const desc = ctx.runtime.sessionManager.get(resolvedRunOptions.sessionId);
        if (desc) {
          ctx.runtime.sessionManager.bindHandle(resolvedRunOptions.sessionId, desc.name, result.protocolIds);
        }
      }

      return { result, bundle: workingBundle, prompt: workingPrompt };
    } finally {
      // 6. Close this hop's adapter session — each hop is self-contained.
      // On fallback: the next hop opens a fresh session for the new agent.
      // On success: runWithFallback exits the loop; this is the only session that mattered.
      // On non-swap-eligible failure: same as success — runWithFallback exits.
      await ctx.runtime.sessionManager.closeSession(handle);
    }
  };
}
```

This is structurally identical to today's [executeHopFn](../../src/session/runners/single-session-runner.ts#L96-L196) — same five steps, same inputs and outputs. The only differences:
- Lives in `src/operations/` instead of `src/session/runners/`
- Calls `agentManager.runAs(agent, handle, prompt, opts)` instead of `hopAgent.run(...)` (Phase 4 boundary preserved — adapter primitives stay inside SessionManager / AgentManager wiring layer)
- Uses `ctx.runtime.contextEngine.rebuildForAgent` and `ctx.runtime.sessionManager` instead of `_singleSessionRunnerDeps.rebuildForAgent` and direct `sessionManager` parameter (uniform `ctx.runtime` access)

### Migration footprint

`SingleSessionRunner` deletes entirely. Its `run()` method's body (chain iteration + bundle threading + outcome shaping) collapses into `callOp` directly. `executeHopFn` becomes `buildHopCallback`. `ISessionRunner` interface deletes (it had one implementation, now zero).

This is a net code reduction: ~250 lines of `SingleSessionRunner` collapse to ~80 lines of `buildHopCallback` + ~30 lines of `callOp` orchestration. Behavior is preserved verbatim because the callback shape is unchanged — only the call site moves.

---

## 6. Why Shape C (pure peer)

Three shapes were considered:

**Shape A — SessionManager owns AgentManager (today's ADR-013 hierarchy).**
Rejected. Sessionless calls (Plan, Route, review, debate-propose/rebut/rank, diagnose) have to be expressed through a fake-session wrapper. The wrapper adds ceremony and creates a lifecycle event for a thing that has no lifecycle. Mixed workload (sessionless + session-bound) does not fit a single hierarchy where sessions are the top-level concept.

**Shape B — AgentManager → SessionManager one-way dependency.**
Rejected. Earlier drafts adopted this. Code analysis showed it requires rewriting `runWithFallback` (140 lines of carefully-tuned chain iteration + rate-limit retry + signal-aware backoff + swap eligibility) to inline session opening, and it forces AgentManager to type-import SessionManager. The `executeHop` callback pattern already in the live code ([manager-types.ts:75-80](../../src/agents/manager-types.ts#L75-L80)) provides the same separation more cleanly. Marginal conceptual elegance for non-trivial code churn.

**Shape C — Pure peer via `executeHop` callback (this ADR).**
Adopted. Neither AgentManager nor SessionManager imports the other. Integration happens at the operation/`callOp` layer via `buildHopCallback` (§5). `runWithFallback` iterates the chain and invokes the callback per attempt; the callback does the rebuild + open + handoff + dispatch work. AgentManager's domain stays "agent selection + fallback chain + cross-cutting middleware" — it never sees a session. SessionManager's domain stays "session lifecycle + descriptor state" — it never sees agent fallback policy. The operation layer owns the integration, which is exactly where context-bundle threading naturally belongs.

The deciding factor: the live code already implements Shape C via `executeHop`. Adopting it as the ADR-019 end state is "rename and relocate" (move `executeHopFn` body to `buildHopCallback` in `src/operations/`); adopting Shape B requires rewriting working code. Equal structural cleanliness, vastly lower migration cost.

ADR-013 Phase 4 boundary (no direct `adapter.run/complete/plan/decompose` calls outside `src/agents/manager.ts` and `src/agents/utils.ts`) extends naturally under Shape C: SessionManager joins the wiring layer (it owns adapter primitive calls); the `buildHopCallback` factory uses `SessionManager` and `AgentManager.runAs` rather than calling adapter methods directly.

---

## 7. Drift point resolution

| Drift point | New owner | Mechanism |
|:---|:---|:---|
| Turn count | SessionManager | Descriptor field, incremented per `sendPrompt`. Adapter's per-`sendTurn` `internalRoundTrips` is a metric, not state. |
| Session naming | SessionManager | `nameFor(request)` — agent-agnostic. Adapter receives the name as input to `openSession`. |
| Resume detection | SessionManager | Looks up descriptor by name; if exists, passes `resume: true` to `adapter.openSession`. Adapter no longer owns the flag. |
| Multi-prompt outer loop (when used) | SessionManager | The "outer turn loop" doesn't exist in today's code — every `run()` call sends exactly one prompt. ADR-019 makes the *capability* a SessionManager API surface (`runInSession` callback form, multiple `sendPrompt` calls per handle) without changing today's single-prompt callers. Adapter's per-prompt inner interaction-bridge loop stays adapter-internal. |
| `ensureSession`/`closeSession` | SessionManager | SessionManager calls adapter primitives; adapter exposes them, doesn't choose when to call. |

`AgentResult.sessionMetadata` (the ADR-018 PR-697 plumbing for `sessionName`/`turn`/`resumed`) deletes. Audit middleware reads from `MiddlewareContext.sessionHandle` which exposes the descriptor view. No more bouncing state through `AgentResult`.

---

## 8. Migration

Four phases, each individually shippable and revertible. Phase ordering matters; bundling is tempting but increases blast radius.

### Phase A — Adapter primitive extraction (~3 days)

Add `openSession`, `sendTurn`, `closeSession` to `AgentAdapter` interface. ACP adapter implements them by extracting code from today's `run()` body:

- `openSession` extracts `ensureAcpSession` invocation
- `sendTurn` extracts the inner per-prompt loop (interaction-bridge handling); accepts `interactionHandler` callback
- `closeSession` extracts `closeAcpSession` invocation

`AgentAdapter.run()` stays during Phase A as a wrapper around the new primitives, so existing callers are not broken yet. New adapter tests target the primitives directly.

**Phase A shim semantics:** `adapter.run()` during the migration window is implemented as `this.openSession + this.sendTurn + this.closeSession` directly inside the adapter — adapter-internal composition only. It does NOT call SessionManager. Reason: SessionManager hasn't yet been extended with `openSession`/`sendPrompt`/`closeSession` until Phase B; routing the shim through SessionManager before that point creates a forward dependency on code that doesn't exist. Keeping the shim adapter-internal preserves the existing behavior verbatim and lets Phase B add the SessionManager surface without coordinating with the shim.

**Exit criteria:** ACP adapter exposes 4 primitives; `run()` still functional but implemented via the primitives (adapter-internal composition); new primitive-targeted unit tests pass.

### Phase B — SessionManager owns the loop (~5 days)

`SessionManager.openSession` / `closeSession` / `sendPrompt` / `runInSession` implemented. Naming moves to `SessionManager.nameFor`. Resume detection moves to SessionManager.

The riskiest change is the ACP retry loop's interaction-bridge handling. Today the loop lives in the adapter; under Phase B the outer-prompt loop moves to SessionManager while the inner interaction-bridge loop stays in `adapter.sendTurn`. The split has to be precise — `interactionHandler` is the seam.

**Exit criteria:** SessionManager exposes the new API; `runInSession` works for both single-prompt and callback overloads; mid-turn cancellation invariants enforced (descriptor → CANCELLED on signal abort); existing tests still green via `AgentAdapter.run()` shim.

### Phase C — `buildHopCallback` extraction; `SingleSessionRunner` deletes (~2 days)

`buildHopCallback` factory created in `src/operations/build-hop-callback.ts`. Body is `executeHopFn` from [single-session-runner.ts:96-196](../../src/session/runners/single-session-runner.ts#L96-L196), with two changes:
1. `hopAgent.run(...)` → `agentManager.runAs(agent, handle, prompt, opts)` (Phase 4 boundary preserved)
2. `_singleSessionRunnerDeps.*` → `ctx.runtime.*` (uniform runtime access)

`callOp` updated to construct `buildHopCallback` for `kind:"run"` ops and pass it as `executeHop` to `runWithFallback`.

`AgentManager.runAs` exposed as a separate entry point for caller-managed sessions. `runWithFallback` body unchanged from today (already does callback delegation).

`SingleSessionRunner` class deletes. `ISessionRunner` interface deletes (had one implementation, now zero). `_singleSessionRunnerDeps` deletes.

**Exit criteria:** No `SingleSessionRunner` / `ISessionRunner` references in the codebase. `buildHopCallback` is the sole `executeHop` factory. `callOp` constructs and passes the callback for `kind:"run"`. Middleware `MiddlewareContext.sessionHandle` set from the callback's `runAs` invocation. `AgentResult.sessionMetadata` plumbing deletes (was Wave 2 PR-697 stopgap; now redundant since `MiddlewareContext.sessionHandle` is the canonical view).

### Phase D — Adapter cleanup (~1 day)

Delete `AgentAdapter.run`. Delete `AgentResult.sessionMetadata`. Delete adapter's `turnCount` field. Delete `ISessionRunner` and `SingleSessionRunner` (already unimported after Phase C).

`AgentAdapter.plan` / `.decompose` and `IAgentManager.planAs` / `.decomposeAs` are NOT touched here — they remain on the adapter through ADR-019 and are removed by ADR-018 Wave 3 / Wave 3.5 independently.

**Exit criteria:** `AgentAdapter.run` no longer exists. No `ISessionRunner` references in the codebase. `bun run typecheck` clean. Adapter surface: `openSession` + `sendTurn` + `closeSession` + `complete` + `plan` + `decompose` (the last two awaiting Wave 3).

### Phase total: ~11 days (~2 weeks)

### Sequencing relative to ADR-018 Wave 3

ADR-019 and Wave 3 are partially overlapping. Honest split:

**Wave 3 op extractions are independent of ADR-019.** They target `callOp(ctx, op, input)` whose contract is stable across ADR-019. The op extractions for `acceptance×4`, `semantic-review`, `adversarial-review`, `rectify`, `plan`, `decompose` — all of them — can ship in parallel with ADR-019. Each one targets `callOp`; whether `callOp` internally delegates to `SingleSessionRunner` (today) or to `AgentManager.runWithFallback` directly (post-ADR-019) is invisible at the op-author level.

**ADR-019 should land before Wave 3's TDD orchestrator and Debate orchestrator work.** Those two are the parts of Wave 3 that touch `SingleSessionRunner` directly. Doing them on the about-to-be-deleted shim and then redoing them is rework on freshly-merged code.

**`plan` and `decompose` op migrations stay in Wave 3.** ADR-019 explicitly does not own these (see §2 Scope note). Wave 3 keeps the adapter-method deprecation pattern (Wave 3.5 release gate) for plan/decompose — that pattern is unaffected by ADR-019.

**Recommended order:**

1. Wave 3 op extractions for non-session-heavy ops (acceptance, review, rectify, plan, decompose) ship in parallel with ADR-019 if you have multi-author capacity, or sequentially before ADR-019 if single-author.
2. ADR-019 phases A→D land.
3. Wave 3 TDD orchestrator + Debate orchestrator land on the cleaned foundation (no `SingleSessionRunner`).
4. Wave 3.5 release gate deletes `plan`/`decompose` adapter methods after their op migrations have soaked.

If single-author and time-pressed, the simplest serial order is: Wave 3 op extractions (acceptance, review, rectify, plan, decompose) → ADR-019 → Wave 3 TDD + Debate orchestrators → Wave 3.5. **Do not** ship Wave 3 TDD/Debate before ADR-019 — that would build orchestrators on `SingleSessionRunner`, which Phase C of ADR-019 deletes, forcing rework.

### Backwards compatibility during migration

Phases A–C maintain `AgentAdapter.run()` as a shim over the new primitives. Existing callers (the few not yet migrated) keep working. Phase D removes the shim and any remaining callers.

`AgentResult.sessionMetadata` is read-only during A–C and removed in D. Audit middleware switches to reading from `MiddlewareContext.sessionHandle` in C; `sessionMetadata` is unread by the time D removes it.

### Rollback

Each phase reverts independently. Phase B is the highest-risk revert (rolls back SessionManager API additions); A/C/D are mechanical.

---

## 9. Rejected alternatives

### A1. Keep `ISessionRunner` as Layer 3

**Rejected.** ADR-018 §1 argued `ISessionRunner` was load-bearing as the "shared call site for `SessionManager.runInSession`" so per-session bookkeeping concerns (state transitions, bindHandle, token propagation, protocolIds, abort plumbing) land once. Under ADR-019, those concerns land in `SessionManager` itself — the runner shim is the indirection. #596's six drift-paths concern is still solved: `SessionManager.runInSession` is the one place per-session bookkeeping lives, just without an interface above it. Same outcome, one fewer abstraction.

### A2. Keep ADR-013's `SessionManager` > `AgentManager` hierarchy

**Rejected.** ADR-013 declared SessionManager as the top-level orchestrator that calls AgentManager internally. In practice this awkwardly handles sessionless calls — they need a fake-session wrapper or bypass SessionManager entirely. The mixed workload (sessionless one-shots + session-bound multi-turn) does not fit a single-hierarchy shape. Pure peer (Shape C) accommodates both naturally.

### A3. Shape B — AgentManager → SessionManager one-way dependency

**Rejected.** Earlier ADR-019 drafts proposed this shape. Code analysis surfaced that the live code already uses callback delegation via `executeHop` ([single-session-runner.ts:96-196](../../src/session/runners/single-session-runner.ts#L96-L196)), which is Shape C. Adopting Shape B would require:

- Rewriting `runWithFallback` (140 lines of chain iteration + rate-limit retry + signal-aware backoff + swap eligibility) to inline session opening
- AgentManager type-importing SessionManager
- Forcing every `kind:"run"` op into the inline-session-management shape, even when bundle/context concerns make per-hop callback delegation cleaner
- Walking back the per-hop callback that's already battle-tested in production

Shape C achieves the same structural goal (clean ownership, no dual-import) at a fraction of the migration cost. See §6 for full rationale.

### A4. Pure peer with fallback in `callOp` (no `runWithFallback`)

**Rejected.** A more aggressive form of Shape C: delete `runWithFallback` entirely; have `callOp` iterate the fallback chain itself. This pulls all of AgentManager's chain logic (`shouldSwap`, `nextCandidate`, rate-limit backoff, swap-eligibility) out of AgentManager and into `callOp`. Walks back Wave 2 work and forces every `callOp` invocation to know about fallback iteration. Shape C as adopted keeps `runWithFallback` as the chain owner; only the per-hop work moves to the callback.

### A5. Pipeline-stage-as-orchestrator + `Builder` (collapse `Operation` framework)

**Rejected.** Considered during ADR-019 design discussion. Walks back ADR-018 Wave 1 + Wave 2 work (the typed `Operation<I,O,C>` framework, `callOp` envelope, `src/operations/` directory). Conceptually cleaner — `kind` moves from spec to call site, `Builder` defines content, `Orchestrator` defines flow — but the cost is rewriting shipped infrastructure. The structural insight (SessionManager owns sessions; AgentManager and SessionManager are not hierarchical) is captured by Shape C without the rewrite.

### A6. Composite typed `Operation` (ADR-018 §M repeat)

**Rejected for the same reasons as ADR-018 §M.** Multi-session flows (TDD three-session, debate) have between-session logic (greenfield detection, verdict reading, rollback, mode dispatch) that does not fit a typed `subOps: readonly Operation[]` shape. Orchestrators stay plain functions/classes in domain dirs (`src/tdd/`, `src/debate/`).

### A7. 11→6 pipeline stage collapse

**Deferred.** The pipeline stage simplification (collapse execute + verify + review + escalate into one Implementation orchestrator) is a separate concern from ownership reshape. Worth a focused ADR when you're ready, but bundling it with ADR-019 doubles blast radius. ADR-019 leaves pipeline stage count unchanged.

### A8. Generalize `interactionHandler` to a typed enum across protocols

**Deferred until concrete.** The `InteractionHandler` callback shape today reflects ACP's interaction model (permission prompts, tool calls, context-tool resolution). If a second protocol arrives with a different interaction model, generalize then. Speculating now creates an abstraction that fits one protocol awkwardly and a hypothetical second one badly.

---

## 10. Open questions

1. **Resume contract — still deferred to ADR-008.** ADR-019 clarifies that `SessionManager` owns the *responsibility* for resume (was ambiguous between adapter and SessionManager under ADR-011). The on-disk descriptor schema and the wire-level resume protocol stay deferred until ADR-008 lands. `SessionManager.resume(name)` works for in-memory same-run resume today (descriptor lookup against the live SessionManager state). Cross-run resume — a Monday session resumed Tuesday — requires descriptor persistence and is gated on ADR-008. ADR-019 does not introduce new persistence; it only fixes ownership.

2. **`SessionHandle` opacity.** Whether `SessionHandle.protocolIds` should be exposed up to AgentManager / `callOp`, or stay strictly inside SessionManager and surface only via descriptor introspection. Leaning toward "expose via `SessionManager.descriptor(name)` only" — keeps the layer boundary tight. Audit middleware reads from descriptor, not from the live handle.

3. **`runAs` for non-fallback callers.** Whether orchestrators that call `AgentManager.runAs` directly (no fallback) should explicitly opt into "no fallback" (e.g. `runAs` always means no fallback, `runWithFallback` always means with). Current shape says yes — the method name is the contract. Keep it.

4. **Middleware visibility into session state.** Audit middleware needs `sessionName` / `turn` / `resumed`. `SessionHandle` carries `id` / `agentName` / `protocolIds` only — the other fields live on the descriptor. Two paths to expose them:
   - (a) Add a `descriptor` reference (or a `descriptorView()` method) to `SessionHandle` so middleware reaches descriptor fields without importing SessionManager.
   - (b) Pass `SessionManager` (or just `descriptorOf: (id) => Descriptor | null`) to middleware via `MiddlewareContext.sessionLookup`.
   
   Leaning toward (a) — keeps middleware decoupled from SessionManager. Decided in Phase C during audit-middleware rewrite.

5. **Per-session cost aggregation.** `CostAggregator` is run-scoped today. For a future debate orchestrator running 5 debaters, "which debater session was most expensive?" is currently not directly answerable — costs aggregate at run level only. Adding a per-session cost view would require descriptor-side accumulation (each `sendPrompt` writes incremental cost back to the descriptor) plus a snapshot accessor. Deferred unless a concrete reporting need surfaces — today's run-level aggregate covers all known callers.

6. **`bundle` field on `AgentRunRequest` after Phase D.** Today's [manager-types.ts:58](../../src/agents/manager-types.ts#L58) carries `bundle?: ContextBundle`. Under Shape C this stays — `runWithFallback` threads the bundle through hop iterations, passing it to each `executeHop` invocation as the prior bundle. The field is load-bearing for context rebuild on fallback. Open question: whether to keep `bundle` directly on `AgentRunRequest`, or push it into a separate `RunContext` opt object alongside `runOptions`. Stylistic; defer to Wave 3 ergonomics.

7. **`AdapterFailure` shape stability.** Today's adapter returns `AgentResult { success: false, adapterFailure: { category, outcome, retriable, message, retryAfterSeconds? } }` ([src/agents/types.ts:22-54](../../src/agents/types.ts#L22-L54)) instead of throwing for fallback-eligible failures (Phase 4+ of ADR-012). ADR-019 preserves this shape — fallback works via returned-failure inspection, not exception catching. Worth flagging because earlier ADR-019 drafts implied try/catch semantics; the actual contract is "inspect `result.adapterFailure?.category === 'availability'` to decide swap eligibility."

---

## References

- **Supersedes:** ADR-013 §Decision (hierarchy claim)
- **Amends:** ADR-018 §1 (drops `ISessionRunner` as Layer 3 — `SessionManager` owns the loop directly), §6 (the 4-method adapter end state is reached jointly by ADR-019 + Wave 3 `plan`/`decompose` migration; ADR-019 does NOT subsume Wave 3.5 — those adapter methods stay until Wave 3 finishes)
- **Preserves:** ADR-018 §2 (`NaxRuntime`), §3 (middleware envelope), §4 (`Operation` + `callOp`), §5 (TDD/debate orchestrators), §7 (`composeSections`)
- **Builds on:** ADR-008 (session lifecycle — resume contract still deferred), ADR-011 (SessionManager ownership — boundary now enforced), ADR-012 (AgentManager ownership — preserved)
- **Origin documents:** [docs/specs/adr-018-wave-3-followups.md](../specs/adr-018-wave-3-followups.md) Problem 1; PR-697 Findings 1–5
- **Related issues:** [#523](https://github.com/nathapp-io/nax/issues/523) (orphan AgentManagers), [#589](https://github.com/nathapp-io/nax/issues/589)–[#591](https://github.com/nathapp-io/nax/issues/591) (state transitions, token propagation, early protocolIds capture), [#596](https://github.com/nathapp-io/nax/pull/596) (`SingleSessionRunner` Phase 1 — superseded by SessionManager owning the loop directly)
- **Code anchors:** [src/agents/acp/adapter.ts:173,598,634,736](../../src/agents/acp/adapter.ts#L173) (drift points); [src/session/manager.ts](../../src/session/manager.ts) (SessionManager today); [src/agents/manager.ts](../../src/agents/manager.ts) (AgentManager today)
