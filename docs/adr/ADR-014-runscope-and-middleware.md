# ADR-014: RunScope, Agent Middleware, and Orphan Consolidation

**Status:** Proposed
**Date:** 2026-04-23
**Author:** William Khoo, Claude
**Extends:** ADR-013 (SessionManager → AgentManager Hierarchy); ADR-012 (AgentManager Ownership); ADR-011 (SessionManager Ownership)
**Superseded-by / Followed-by:** ADR-015 (Operation Contract), ADR-016 (Prompt Composition & PackageView)
**Related:** #523 (fallback state divergence across orphan AgentManagers — unblocked by this ADR)

---

## Context

ADR-011, ADR-012, and ADR-013 established the canonical hierarchy: `SessionManager.runInSession()` orchestrates `IAgentManager.run()` / `IAgentManager.complete()`, and adapter methods are manager-internal. That work fixed retry/fallback correctness on the main execution path.

Two architectural problems remain and are in scope for this ADR:

### Problem 1 — Orphan `AgentManager` instances (#523)

`createAgentManager(config)` is called from **eight** locations — **seven orphans plus the canonical Runner instance**:

| Site | Scope |
|:---|:---|
| [src/routing/router.ts:271](../../src/routing/router.ts#L271) | Pre-execution LLM classification |
| [src/cli/plan.ts:61](../../src/cli/plan.ts#L61) | `nax plan` standalone CLI |
| [src/debate/session-helpers.ts:83](../../src/debate/session-helpers.ts#L83) | Debate proposer pool |
| [src/review/semantic.ts:35](../../src/review/semantic.ts#L35) | Semantic review debate fallback |
| [src/verification/rectification-loop.ts:129](../../src/verification/rectification-loop.ts#L129) | Nested retry agent |
| [src/acceptance/refinement.ts:25](../../src/acceptance/refinement.ts#L25) | Pre-execution AC refinement |
| [src/acceptance/generator.ts:75](../../src/acceptance/generator.ts#L75) | Pre-execution test generation |
| [src/execution/runner.ts:117](../../src/execution/runner.ts#L117) | Canonical owned instance |

Each orphan has its own fallback state, availability marks, and token counters. A 401 on routing does not inform the execution-phase manager. Costs accumulated in rectification do not roll up into `StoryMetrics`. #523 is blocked on this and has only a partial workaround inside the ACP adapter.

### Problem 2 — Cross-cutting concerns are hand-wired per call site

Cost aggregation, prompt audit, cancellation propagation, permission resolution, and logging are hand-wired at every agent call site. Each new call site copies the ceremony. Each drift (forgotten audit, missing cost tag, absent `storyId` on a log line) is a silent bug. There is no interception point.

### Out of scope (deferred to follow-up ADRs)

- **Operation contract + removal of `.plan()` / `.decompose()` from the adapter** → ADR-015.
- **IPromptBuilder sections, prompt middleware, and PackageView enforcement** → ADR-016.
- **Monorepo-awareness violations (#533–#536)** → closed as part of ADR-016 (PackageView).

This narrow ADR delivers the foundation — `RunScope` + agent middleware + orphan consolidation — which unblocks #523 and makes cost/audit uniform. The operation and prompt layers land on top of this foundation in the follow-ups.

---

## Decision

We introduce two structural pieces:

1. **RunScope** — composite lifecycle owner for one run / plan / ephemeral unit. Wraps `SessionManager` + `AgentManager` with scope-level services (cost, audit, permissions, logger).
2. **Agent middleware chain** — interceptor around every `IAgent` returned by the scope. Hoists permissions, audit, cost, cancellation, and logging out of individual call sites.

Both preserve every ADR-011/012/013 invariant (adapter methods manager-internal, single `runInSession()`, `ISessionRunner` for topology) and add the layer above.

---

### 1. RunScope

The composite owner for one logical execution unit. Exactly one `RunScope` per `nax run`, per `nax plan`, per standalone CLI invocation that touches agents.

```typescript
// src/runtime/scope.ts
export interface RunScope {
  readonly id: RunScopeId;
  readonly kind: "run" | "plan" | "ephemeral";
  readonly repoRoot: string;

  // Frozen at construction — configuration and cancellation
  readonly config: NaxConfig;
  readonly signal: AbortSignal;

  // Managers (ADR-011, ADR-012, ADR-013) — unchanged interfaces
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;

  // Scope-level services (drained by middleware)
  readonly services: {
    readonly costAggregator: ICostAggregator;
    readonly promptAuditor: IPromptAuditor;
    readonly permissionResolver: IPermissionResolver;
    readonly logger: Logger;
  };

  // Obtain a middleware-wrapped agent. The only way outside src/runtime/ to get an IAgent.
  getAgent(agentName: string): IAgent;

  // Lifecycle — idempotent, cascades to sessions → services.drain() → agentManager.dispose()
  close(): Promise<void>;
}
```

**Ownership contract:**

- `RunScope` **owns** the lifecycle of `agentManager`, `sessionManager`, and the services. Constructed once, disposed once.
- `config` is frozen at scope construction. Configuration changes require a new scope — there is no hot reload.
- `signal` is produced by a scope-internal `AbortController` created in the factory. `close()` aborts it, which cascades to in-flight agent calls via the `cancellation` middleware.
- `RunScope.close()` cascades: signal aborts → sessions close → services flush → agent manager disposes. Idempotent.
- **No `child()` method.** Per-call isolation (debate proposers, rectification loops) is achieved via per-call `signal` / `logger` overrides, not scope forking. See Rejected Alternatives §C.

**SessionManager wiring — middleware must reach session-internal calls:**

Today's `SessionManager` holds agent references captured at session-open time. For the middleware chain to wrap every LLM call including those made inside a running session, `SessionManager` construction changes:

- The factory constructs `SessionManager` with a `getAgent: (name) => IAgent` callback supplied by the scope.
- That callback is `scope.getAgent` — every agent obtained by a session is middleware-wrapped.
- Sessions never capture a raw `AgentAdapter` or unwrapped `IAgent`. The existing agent-registry parameter on `SessionManager` is replaced by the callback.

Without this change, Phase 2's "every LLM call goes through middleware" invariant is false for in-session calls. The change is a one-line constructor signature shift but must land alongside the scope introduction.

**Construction — single factory, not ad-hoc:**

```typescript
// src/runtime/scope-factory.ts
export interface IRunScopeFactory {
  forRun(config: NaxConfig, workdir: string, opts?: ForRunOptions): Promise<RunScope>;
  forPlan(config: NaxConfig, workdir: string, opts?: ForPlanOptions): Promise<RunScope>;
  forEphemeral(config: NaxConfig, workdir: string, label: string): Promise<RunScope>;
}

export interface ForRunOptions {
  readonly hooks?: HookRegistry;          // loaded hooks; scope exposes them to the Runner
  readonly parentSignal?: AbortSignal;    // e.g. CLI SIGINT — linked into scope.signal
}
```

Every `createAgentManager(config)` call outside this factory becomes a compile error. The symbol is removed from the public barrel (`src/agents/index.ts`) and relocated to `src/runtime/internal/` where only the factory may call it.

**Hooks and scope:** `hooks` is threaded into the scope as-is for the Runner to fire at pipeline phase boundaries. Scope-aware hook authoring (hooks that read cost snapshots or emit audit entries) is deferred to ADR-017. In this ADR, hooks continue to receive their existing loose refs; the factory parameter exists only to carry the registry from CLI into the Runner without re-loading.

---

### 2. Agent middleware chain

Wraps every `IAgent` returned by `scope.getAgent()` and every agent used inside a `sessionManager.runInSession()`. Intercepts `run()` and `complete()`.

```typescript
// src/runtime/agent-middleware.ts
export interface AgentMiddleware {
  readonly name: string;
  run?(ctx: MiddlewareContext, next: () => Promise<AgentResult>): Promise<AgentResult>;
  complete?(ctx: MiddlewareContext, next: () => Promise<CompleteResult>): Promise<CompleteResult>;
}

export interface MiddlewareContext {
  readonly prompt: string;
  readonly options: RunOptions | CompleteOptions;
  readonly agentName: string;
  readonly scope: RunScope;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly signal: AbortSignal;
}
```

**Canonical middleware (Phase 1):**

| Middleware | Concern | Semantics |
|:---|:---|:---|
| `permissions` | Resolve permission mode from stage + config, apply to options | **Observer** — reads stage, enriches options; does not mutate prompt |
| `audit` | Capture prompt + response via `IPromptAuditor` | Observer — emits `PromptAuditEntry` on success and on error |
| `cost` | Emit `CostEvent` to `ICostAggregator` tagged with `{ agentName, stage, storyId, packageDir }` | Observer — emits on success only; partial/errored calls emit a separate `CostErrorEvent` |
| `cancellation` | Thread `signal` into adapter call; translate `AbortError` to `NaxError CANCELLED` | Pass-through with error translation |
| `logging` | Structured JSONL per `project-conventions.md`, `storyId` first | Observer |

**Middleware invariants:**

- **Middleware are observers, not transformers** (Phase 1 constraint). No middleware mutates the prompt or response for the next middleware in the chain. This keeps ordering irrelevant in Phase 1 — middleware can be registered in any order and produce equivalent behavior.
- **On error:** every middleware must be resilient to the call throwing. `audit` emits an error entry, `cost` emits a `CostErrorEvent`, `cancellation` translates the error. No middleware may swallow the thrown error.
- **Frozen at scope construction.** The chain is registered once in `IRunScopeFactory.forRun()` and immutable for the scope lifetime. No per-call reordering, no per-op opt-out.
- **Future extension:** if a later middleware needs to transform (e.g. inject system prompt, rewrite options), the invariant tightens to a declared order. Deferred until a concrete case exists.

---

### 3. CostAggregator

Single sink for cost events across the run. Drained by the `cost` middleware. Replaces the per-`AgentManager` internal counter, which today is lost for orphan instances.

```typescript
// src/runtime/cost-aggregator.ts
export interface ICostAggregator {
  record(event: CostEvent): void;
  recordError(event: CostErrorEvent): void;
  snapshot(): CostSnapshot;
  byAgent(): Record<string, CostSnapshot>;
  byStage(): Record<string, CostSnapshot>;
  byStory(): Record<string, CostSnapshot>;
  drain(): Promise<void>;  // flushes to StoryMetrics on scope close
}

export interface CostEvent {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly agentName: string;
  readonly model: string;                                // resolved model string (successful calls always have this)
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface CostErrorEvent {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly agentName: string;
  readonly model?: string;                               // may be unresolved (e.g. auth failure before dispatch)
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
}

// Rule: successful calls emit CostEvent (model required). Failed calls emit only CostErrorEvent.
// The cost middleware never emits both for the same call.
```

Nested calls (rectification, debate proposers, pre-execution refinement) all flow through the same aggregator via the shared scope. `StoryMetrics` reads aggregate totals on `scope.close()`.

**Per-operation and per-package breakdowns** are added in ADR-015 when `Operation.name` becomes available as a tag, and in ADR-016 when `PackageView` formalizes `packageDir`. Phase 1 tags with `{ stage, storyId }` only.

---

### 4. IPromptAuditor

Scope-level service. Captures every prompt via agent middleware, so session-less calls (routing, decompose, refinement) are audited too.

**Explicitly rejected:** putting prompt audit on `SessionManager`. That would bypass session-less paths — exactly the class of bug this ADR removes.

```typescript
// src/runtime/prompt-auditor.ts
export interface IPromptAuditor {
  record(entry: PromptAuditEntry): void;
  recordError(entry: PromptAuditErrorEntry): void;
  flush(): Promise<void>;  // writes to .nax/audit/<runId>.jsonl
}

export interface PromptAuditEntry {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly agentName: string;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPreview: string;   // first 500 chars
  readonly responseHash: string;
  readonly responsePreview: string;
  readonly tokens: { input: number; output: number };
  readonly durationMs: number;
  readonly sessionId?: string;
}

export interface PromptAuditErrorEntry {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly agentName: string;
  readonly model?: string;                       // may be unresolved when the error happens pre-dispatch
  readonly promptHash?: string;                  // absent if failure happened before prompt was captured
  readonly promptPreview?: string;
  readonly errorCode: string;                    // matches CostErrorEvent.errorCode for correlation
  readonly errorMessage: string;                 // single-line summary
  readonly durationMs: number;
  readonly sessionId?: string;
}
```

---

### 5. Test fixture — `makeTestScope()`

The canonical test fixture. Every test that needs a `RunScope` constructs one via this helper rather than assembling a bespoke mock. Published from `test/helpers/scope.ts`.

```typescript
// test/helpers/scope.ts
export interface MakeTestScopeOptions {
  readonly config?: Partial<NaxConfig>;                           // merged into DEFAULT_CONFIG
  readonly agents?: Record<string, IAgent>;                       // stubbed agents by name, default: empty
  readonly middleware?: readonly AgentMiddleware[];               // default: no middleware (raw agents)
  readonly services?: Partial<RunScope["services"]>;              // override any service with a stub
  readonly workdir?: string;                                      // default: temp dir via test/helpers/temp.ts
}

export function makeTestScope(opts?: MakeTestScopeOptions): RunScope;
```

**Construction rules:**

- If `agents` is provided, `scope.getAgent(name)` returns the stubbed `IAgent` wrapped by the supplied `middleware` (default: no middleware → raw stub).
- If no middleware is supplied, tests observe raw call behavior — useful for assertion tests on stub agents.
- If services are not overridden, default in-memory implementations are used (`InMemoryCostAggregator`, `InMemoryPromptAuditor`, etc.) which expose `snapshot()` for assertion.
- `close()` is a no-op unless the test explicitly asserts lifecycle behavior.

**Migration from today's fixtures:**

- `_deps.createManager` mock fields (debate, rectification) delete. Tests supply stub agents via `makeTestScope({ agents: { claude: stubAgent } })`.
- `agentGetFn` injection in pipeline-stage tests delete. `ctx.scope = makeTestScope({ agents: {...} })` replaces.
- Cost/audit assertion tests read `scope.services.costAggregator.snapshot()` instead of inspecting private manager fields.

The fixture is part of Phase 1 deliverables so migrated tests have a landing pad from day one.

---

## Architecture After ADR-014

```
RunScope (per run / plan / ephemeral)
  ├─ agentManager: IAgentManager                 // ADR-012, ADR-013 — unchanged interface
  ├─ sessionManager: ISessionManager             // ADR-011, ADR-013 — unchanged interface
  ├─ services:
  │    ├─ costAggregator                         // NEW
  │    ├─ promptAuditor                          // NEW
  │    ├─ permissionResolver
  │    └─ logger
  ├─ getAgent(name) → IAgent                     // middleware-wrapped
  └─ close() → Promise<void>

Agent middleware chain (observers only, order-independent)
  permissions / audit / cost / cancellation / logging → rawAgent

IAgent (ADR-013, unchanged)
  ├─ run(prompt, opts): Promise<AgentResult>
  └─ complete(prompt, opts): Promise<CompleteResult>
     — .plan() and .decompose() remain until ADR-015
```

Stages still call `ctx.agentManager.runAs(...)` / `ctx.agentManager.completeAs(...)` as today. The only observable change per call site is that `ctx.agentManager` (threaded via `PipelineContext`) now comes from `scope.agentManager` and every call is middleware-wrapped. No stage logic changes.

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 unblocks** | `createAgentManager` removed from public barrel. One `AgentManager` per run. Fallback state survives across routing → execution → rectification → debate. |
| **Orphan-free by construction** | 8 orphan sites collapse to scope-owned access. `IAgent` can only be obtained via `scope.getAgent()` → guaranteed middleware-wrapped. |
| **Uniform cost attribution** | Every LLM call emits a `CostEvent` tagged with `{ stage, storyId }`. `StoryMetrics` sees nested calls (rectification, debate proposers) that today vanish into orphan counters. |
| **Uniform prompt audit** | Every LLM call — including session-less routing, decompose, refinement — is audited. Single JSONL per run at `.nax/audit/<runId>.jsonl`. |
| **Cross-cutting concerns hoisted** | Permissions, cost, audit, cancellation, logging removed from call sites. Future additions (rate limiting, budget enforcement) slot in as middleware without touching stages. |
| **Testing simplifies** | Scope fixture (`makeTestScope(opts)`) covers 90% of agent-using tests. Per-call mocks (adapter, manager, cost tracker) consolidate into one scope mock. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `PipelineContext` gains a `scope` field | Threaded from runner alongside existing fields. Stages opt-in: Phase 1 migrates one stage as proof; remaining stages migrate during Phase 2. |
| Existing tests construct bare managers | `makeTestScope()` fixture matches the shape of today's test construction; mechanical migration. |
| Scope-lifetime discipline required | `RunScope.close()` is idempotent and cascades. Every scope construction must be followed by a `try/finally` close at the CLI/runner boundary. |
| Plugin API change (`IReporter`, `IContextProvider`, etc.) | Out of scope — plugins continue to receive individual refs in Phase 1. A versioned plugin API with `PluginContext` derived from `RunScope` is deferred to a follow-up ADR. |

---

## Migration Plan

Three phases, each independently shippable. Each phase preserves all ADR-011/012/013 invariants.

### Phase 1 — RunScope shell + services + test fixture

- Introduce `src/runtime/scope.ts` and `src/runtime/scope-factory.ts`.
- `IRunScopeFactory.forRun()` wraps existing `AgentManager` + `SessionManager` + instantiates `CostAggregator`, `PromptAuditor`.
- Update `SessionManager` constructor to take the `getAgent` callback (§1 SessionManager wiring note).
- Runner constructs scope at the top of `runSetupPhase()`, closes it in `runCompletionPhase()`.
- Thread `scope: RunScope` through `PipelineContext` alongside existing fields.
- Publish `test/helpers/scope.ts` with `makeTestScope()` (§5).
- **No middleware yet.** `scope.getAgent()` returns bare adapter-wrapped agent.
- **Exit criteria:**
  1. The `implement` stage obtains its agent via `ctx.scope.agentManager` (not the threaded `agentManager` field) and the call succeeds end-to-end against today's integration tests.
  2. At least three existing tests migrate to `makeTestScope()` as proof-of-fit for the fixture.
  3. Runner constructs and closes scope cleanly; `close()` idempotency verified by test.
- **Risk:** Low. Purely additive. The one behavior change (SessionManager's `getAgent` callback) is constructor-level and invisible to call sites.

### Phase 2 — Agent middleware chain + orphan consolidation

- Implement `AgentMiddleware` interface and canonical middleware (permissions, audit, cost, cancellation, logging) as independent observers.
- `scope.getAgent()` returns middleware-wrapped agent.
- Migrate orphan call sites in order of lowest blast radius:
  1. `routing/router.ts` — use `scope.getAgent(defaultAgent).complete()`
  2. `acceptance/refinement.ts`, `acceptance/generator.ts`
  3. `verification/rectification-loop.ts`
  4. `debate/session-helpers.ts` (drops the orphan `createAgentManager` import; the runner topology is left to ADR-015)
  5. `review/semantic.ts`
  6. `cli/plan.ts` — uses `forPlan()` factory
- **Delete `createAgentManager` from public barrel.** Move to `src/runtime/internal/`.
- **Exit criteria:** Zero `createAgentManager` imports outside `src/runtime/`. #523 verifiable: a 401 on routing activates the same fallback chain as execution.
- **Risk:** Medium. Mechanical migrations touch many files; each site's behavior change is small and individually reviewable.

### Phase 3 — Drain aggregator and auditor into metrics/disk

- `StoryMetrics` reads from `scope.services.costAggregator.snapshot()` on story completion.
- `scope.close()` flushes `PromptAuditor` to `.nax/audit/<runId>.jsonl`.
- Remove the per-`AgentManager` internal cost counter (now redundant).
- **Exit criteria:** Cost totals in `StoryMetrics` match orphan-free ground truth. Every run produces an audit JSONL covering all agent calls.
- **Risk:** Low. Additive plus one dedup.

**Rollback plan:** Phase 1 and Phase 2 are gated behind the phase boundary — scope exists alongside legacy paths until Phase 2 removes the orphans. Each phase reverts independently.

---

## Rejected Alternatives

### A. Make SessionManager fully own AgentManager

**Rejected.** SessionManager and AgentManager have different lifecycle scopes, and ~30% of agent calls are legitimately session-less (routing, pre-execution decompose, AC refinement). Forcing those through synthetic sessions is ceremony that produces exactly the kind of ad-hoc workarounds this ADR removes. The peer relationship (both owned by `RunScope`) is the correct model.

### B. Put prompt audit on SessionManager

**Rejected.** Would bypass session-less paths. Audit is cross-cutting; it belongs as middleware on the scope-owned `IAgent`, where no call can escape it. SessionManager stays focused on session lifecycle only.

### C. Nested `RunScope` via `child()`

**Rejected as speculative.** The initial draft proposed `scope.child(label)` for debate proposers and rectification loops. On inspection, both need per-call isolation (own logger sub-scope, own `AbortSignal`), not scope-level isolation — they already share everything else (`agentManager`, `sessionManager`, services). Per-call `signal` and `logger` overrides cover the real need without introducing scope-lifecycle questions (who owns what, what does child close dispose). If a future case genuinely needs scope-level isolation (sandboxed sub-run with own cost budget), `child()` can be added then with a concrete motivation documented.

### D. Middleware as transformers from day one

**Rejected.** Transformers (middleware that can rewrite prompt/response for the next middleware) introduce load-bearing ordering semantics: permissions-then-audit captures the permission-mutated prompt; audit-then-permissions captures caller intent. Phase 1 ships observers only — all middleware read `MiddlewareContext` and emit side effects without affecting the chain. If a future middleware needs to transform, the invariant tightens to a declared order at that point, with the concrete case as justification.

---

## Open Questions

1. **Plugin API versioning.** `IReporter`, `IContextProvider`, `IReviewPlugin` currently take loose refs. A narrow `PluginContext` view derived from `RunScope` is the eventual shape; exact form deferred until the operation/prompt follow-ups land.

2. **Middleware order when transformers are introduced.** Phase 1 is observer-only and order-free. When the first transformer is justified, the ADR that introduces it must also specify the canonical order and the rationale for each neighbor pairing.

3. **Session resume across scope restarts.** Scope lifecycle is per-invocation; session descriptors persist on disk. Resume semantics (crashed run's scope is gone, its sessions can be reattached) need a clear contract — likely "scope opens, discovers resumable descriptors via `SessionManager`, offers reattach." Deferred to an ADR-008 follow-up.

---

## References

- ADR-008 — Session lifecycle
- ADR-011 — SessionManager ownership
- ADR-012 — AgentManager ownership
- ADR-013 — SessionManager → AgentManager hierarchy
- ADR-015 — Operation Contract (follow-up — adds `Operation<I, O, C>`, removes `.plan/.decompose` from adapter, introduces `ISessionRunner` implementations incl. `DebateSessionRunner`)
- ADR-016 — Prompt Composition & PackageView (follow-up — immutable `IPromptBuilder` sections, prompt middleware, monorepo-awareness enforcement)
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (unchanged by this ADR)
