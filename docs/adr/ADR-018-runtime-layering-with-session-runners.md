# ADR-018: Runtime Layering — NaxRuntime, Operations, SessionRunners, and runAs Envelope

**Status:** Reviewing
**Date:** 2026-04-24
**Author:** William Khoo, Claude
**Supersedes:** ADR-017 (Incremental Consolidation)
**Extends:** ADR-011 (SessionManager Ownership), ADR-012 (AgentManager Ownership), ADR-013 (SessionManager → AgentManager Hierarchy), ADR-009 (Test-File Pattern SSOT), ADR-008 (Session Lifecycle)
**Preserves:** #596 (`SessionManager.runInSession` + `ISessionRunner` Phase 1 — foundation for per-session bookkeeping)
**Related:** #523 (fallback state divergence across orphan AgentManagers), #533–#536 (monorepo awareness violations), #589 (state transitions), #590 (token propagation), #591 (early protocolIds capture)

---

## Context

ADR-017 accepted the right direction — collapse orphan `AgentManager` instances behind one runtime, type-check operation shape via `Operation<I, O, C>`, consolidate prompt composition in `composeSections()`, unify retry input — and correctly rejected ADR-014/015/016's middleware chains, `RunScope` composite, `src/control/` directory, and `scope.invoke()` envelope.

ADR-017's §E (Rejected Alternatives) also rejected `ISessionRunner`, arguing that wrapping single-session in a runner class is "ceremony over `scope.invoke`." That framing is wrong and this ADR corrects it.

### Why `ISessionRunner` is load-bearing — #596's concrete evidence

Issue #596 (merged) documents that **six past PRs added the same cross-cutting feature twice** — once to the single-session path in [src/pipeline/stages/execution.ts](../../src/pipeline/stages/execution.ts), once to the three-session path in [src/tdd/session-runner.ts](../../src/tdd/session-runner.ts):

| Concern | Landed twice | Issue |
|:---|:---|:---|
| Descriptor persistence | execution.ts + tdd/session-runner.ts | #522 |
| `bindHandle` wiring | execution.ts + tdd/session-runner.ts | #541 |
| State transitions | execution.ts + tdd/session-runner.ts | #589 |
| Token propagation | execution.ts + tdd/session-runner.ts | #590 |
| Early protocolIds capture | execution.ts + tdd/session-runner.ts | #591 |
| Abort signal plumbing | execution.ts + tdd/session-runner.ts | #585 / #593 |

The root cause is that there is no shared layer for per-session bookkeeping. #596 introduced one — `SessionManager.runInSession(sessionId, runFn, options)` as the primitive, with `ISessionRunner` + `SingleSessionRunner` as the shared call site. `ThreeSessionRunner` was scoped as the Phase 2 follow-up that would close #589 and #590 by construction — "every runner going through `runInSession` gets state transitions and the token-passthrough result shape for free."

ADR-017 §E framed `ISessionRunner` as a topology abstraction. It is not. It is a **per-session bookkeeping surface** — the single call site where future cross-cutting per-session concerns land once instead of twice. Removing it re-opens the six drift paths above.

### What still stands from ADR-017

Everything else in ADR-017 stands. The mistake was one rejected-alternative entry, not the ADR's direction. This ADR:

- **Keeps** `NaxRuntime`, `AgentManager.runAs()` envelope, `Operation<I, O, C>` + `callOp()`, `ConfigSelector<C>`, `composeSections()`, `RetryInput<TFailure, TResult>`, `PackageRegistry`, CI lint rules, `SessionRole` template-literal union, adapter shrinks to 2 methods.
- **Rejects** the same list ADR-017 rejected: `RunScope` composite, `IAgent` third type, agent middleware chain, prompt middleware chain, `src/control/` directory, `IPermissionTranslatorRegistry`, plugin operation registration, `scope.invoke()` 9-step envelope, third-party composability for cross-cutting concerns.
- **Amends** ADR-017 §E to accept `ISessionRunner` as the Layer-3 bookkeeping surface; `callOp()` delegates to it for `kind: "run"` operations.

---

## Decision

The runtime stack is **four layers**, each with exactly one reason to change:

| Layer | Owner | Reason to change |
|:---|:---|:---|
| 4 — Operation envelope | `callOp()` | new operation, new config slice |
| 3 — Session topology & bookkeeping | `SingleSessionRunner` (the `ISessionRunner` impl) | new per-session cross-cutting concern |
| 2 — Per-session lifecycle | `SessionManager.runInSession()` | lifecycle primitive (CREATED→RUNNING→COMPLETED/FAILED, bindHandle) — rarely changes |
| 1 — Per-call cross-cutting | `AgentManager.runAs()` + observer middleware chain | new per-call concern (permissions pre-chain; cost/audit/cancellation/logging as observer middleware) |

Nine self-contained refactors, shipped in sequence.

1. **`NaxRuntime`** — single lifecycle container owning `AgentManager`, `SessionManager`, `ConfigLoader`, `CostAggregator`, `PromptAuditor`, `PackageRegistry`, logger, signal. Replaces 3 orphan `createAgentManager` instantiations and threads through existing `PipelineContext`. `CostAggregator`/`PromptAuditor` are middleware-owned sinks, not manager fields.
2. **`ConfigLoader` + `ConfigSelector` interface** — loader caches config in memory with a future hot-reload seam; named selectors (`reviewConfigSelector`, `planConfigSelector`, …) in one registry file declare each subsystem's config slice. Memoized per selector name. **Ops never read from `configLoader.current()` directly — all slicing goes through `ctx.packageView.select(selector)` so per-package overrides always apply (polyglot-monorepo correctness by construction; no `scope` field needed).**
3. **Cross-cutting in `AgentManager.runAs()` + observer middleware** — `resolvePermissions()` pre-chain (once). Cost/audit/cancellation/logging as observer-only middleware registered at `createRuntime` time, frozen for runtime lifetime. Middleware is structurally uniform across all adapters and all session-internal calls. Three `resolvePermissions()` calls in the ACP adapter delete.
4. **`Operation<I, O, C>` spec + `callOp()` helper** — typed shape for internal extensibility; each op declares its `ConfigSelector<C>`. `callOp()` routes `kind: "run"` ops through Layer 3, `kind: "complete"` ops straight to Layer 1. Config slicing goes through `ctx.packageView.select(op.config)`, not the loader directly.
5. **`ISessionRunner` family stays tight — one implementation, `SingleSessionRunner`.** TDD's three-session flow stays an orchestrator in `src/tdd/orchestrator.ts` that sequences three `callOp(ctx, op, input)` calls through `SingleSessionRunner` (Gap 1 resolution). `DebateRunner` stays as a cohesive debate-domain orchestrator and does **not** implement `ISessionRunner` — it uses `callOp` uniformly across all modes (Gap 6 resolution). `SingleSessionRunner` remains the only class conforming to the interface, keeping "shared call site for `runInSession`" tight.
6. **`.plan()` / `.decompose()` leave the adapter** — become `Operation` specs under `src/operations/`. Adapter shrinks to `run` + `complete` permanently. One-release deprecation window: Wave 3 makes the old methods throw `NaxError ADAPTER_METHOD_DEPRECATED`; deletion lands in the next release.
7. **`composeSections()` + typed `PromptSection` slots — ships in Wave 1.** One helper, minimal `SLOT_ORDER` (grows per wave as builders migrate). Builders expose slot-specific methods in Wave 3; no middleware chain.
8. **Unified `RetryInput<TFailure, TResult>`** — five callers of `runSharedRectificationLoop` normalize on one shape. Progressive composition is a `buildPrompt(failure, previous)` callback, not middleware.
9. **CI lint + `SessionRole` tightening** — `process.cwd()` outside CLI banned; prompt builders' forbidden imports enforced; `SessionRole` admits `debate-${string}` / `plan-${number}`.

**Explicitly out of scope:** prompt caching / `cache_control`, third-party plugin composability for cross-cutting concerns, plugin operation registration API, transformer middleware (Phase 1 observer-only).

---

## 1. Four-layer architecture — the load-bearing insight

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4 — Operation semantic envelope                                │
│   callOp(ctx, op, input)                                             │
│     • slices config via ctx.packageView.select(op.config)            │
│     • op.build → composeSections → join                              │
│     • op.parse                                                       │
│     • routes kind:"run" → Layer 3, kind:"complete" → Layer 1         │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
┌──────────────────────────────────┐   ┌─────────────────────────────┐
│ Layer 3 — Session bookkeeping    │   │                             │
│   SingleSessionRunner (#596)     │   │                             │
│   — the ISessionRunner impl.     │   │                             │
│   One session + fallback + bundle│   │                             │
│   rebuild + swap-handoff rewrite.│   │                             │
│                                  │   │                             │
│   Orchestrators above (TDD 3-session│                             │
│   sequencer, DebateRunner) call    │                             │
│   callOp → SingleSessionRunner for │                             │
│   each underlying session.         │                             │
└──────────────────────────────────┘   │                             │
                │                      │                             │
                ▼                      │                             │
┌──────────────────────────────────┐   │                             │
│ Layer 2 — Per-session lifecycle  │   │                             │
│   SessionManager.runInSession    │   │                             │
│    • CREATED → RUNNING           │   │                             │
│    • runFn(options) executes     │   │                             │
│    • bindHandle(protocolIds)     │   │                             │
│    • RUNNING → COMPLETED/FAILED  │   │                             │
│   future per-session concerns    │   │                             │
│   land HERE, once                │   │                             │
└──────────────────────────────────┘   │                             │
                │                      │                             │
                ▼                      ▼                             │
┌──────────────────────────────────────────────────────────────────┐ │
│ Layer 1 — Per-call cross-cutting                                 │ │
│   AgentManager.runAs / runWithFallback / completeAs              │ │
│     • resolvePermissions (pre-chain, once)                       │ │
│     • observer middleware chain (frozen at runtime construction) │ │
│         - audit    (observes prompt + result → PromptAuditor)    │ │
│         - cost     (observes tokens + cost → CostAggregator)     │ │
│         - cancellation (threads signal; translates AbortError)   │ │
│         - logging  (structured JSONL)                            │ │
│     • error wrap                                                 │ │
│     • fallback on failure                                        │ │
└──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                           AgentAdapter.run / .complete
                           (2-method surface, permanently)
```

**One layer, one reason to change:**

- Adding a new operation (e.g. a variant of `review`) → Layer 4 (one file in `src/operations/`)
- Adding a fourth session topology (e.g. "pair-debate") → Layer 3 (one new `ISessionRunner` impl)
- Adding a new descriptor field that every session needs → Layer 2 (one edit to `runInSession`)
- Adding rate limiting → Layer 1 (one method-local branch in `runAs`)

Every past PR that landed twice in #596's table would have landed once under this model — because the Layer-3 runner would have been the single call site for the Layer-2 primitive.

---

## 2. `NaxRuntime` — single lifecycle container

```typescript
// src/runtime/index.ts (new, ~80 lines)
export interface NaxRuntime {
  readonly configLoader: ConfigLoader;       // §2.1 — in-memory cache, future hot-reload seam
  readonly workdir: string;
  readonly projectDir: string;
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly costAggregator: ICostAggregator;  // §3.2 — middleware-owned sink
  readonly promptAuditor: IPromptAuditor;    // §3.2 — middleware-owned sink
  readonly packages: PackageRegistry;        // §9.3 — always resolvable (root-equiv if no workdir)
  readonly logger: Logger;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export function createRuntime(
  config: NaxConfig,
  workdir: string,
  opts?: CreateRuntimeOptions,
): NaxRuntime;
```

### 2.1 `ConfigLoader` — cached, selector-aware, hot-reload-ready

```typescript
// src/config/loader-runtime.ts (new, ~60 lines — separate from the existing disk loader)
export interface ConfigLoader {
  /** Currently-loaded config snapshot. Frozen; callers must never mutate. */
  current(): NaxConfig;

  /** Apply a ConfigSelector and return the narrowed, memoized view. */
  select<C>(selector: ConfigSelector<C>): C;

  /** Future-only seam. No concrete plan today — documented so callers can depend
   *  on the loader rather than capturing a snapshot that would ignore reloads. */
  // onReload?(handler: (next: NaxConfig) => void): () => void;
}

export function createConfigLoader(config: NaxConfig): ConfigLoader;
```

**Contract:**

- `current()` returns the same frozen object every call until/unless hot-reload lands. Callers should not memoize a reference across suspension points (await) if hot-reload becomes real — they should call `current()` at use time or go through `select()`.
- `select(selector)` memoizes per `selector.name`. Same selector → same returned object reference across calls. Cache is keyed on `selector.name`, not identity.
- On future hot-reload: `current()` returns the new config; `select()` re-runs each registered selector and invalidates the memo; subscribers fire. No per-op code change required because ops read through `ctx.config` (the selector's output), not `runtime.configLoader` directly.

**Why a loader, not a bare `NaxConfig` field:**

- **One seam for caching.** Selector memoization lives on the loader, not scattered.
- **Future hot-reload is additive.** Today the loader is a thin wrapper over one frozen config; later, it can subscribe to `.nax/config.json` changes or plugin reload events without touching op code.
- **Tests gain a fixture.** `createConfigLoader(partialConfig)` is a one-liner; ops can be tested against narrow slices without constructing a full runtime.

No concrete hot-reload feature today. The loader exists so adding it later is a local change.

**Contract:**

- `createRuntime()` is the only public constructor for `AgentManager` and `SessionManager`. `createAgentManager` leaves the public barrel ([src/agents/index.ts:29](../../src/agents/index.ts#L29)) and moves to `src/runtime/internal/agent-manager-factory.ts`.
- `close()` is idempotent and cascades in explicit order: `signal.abort()` → `sessionManager.sweepAll()` → `promptAuditor.flush()` → `costAggregator.drain()` → `agentManager.dispose()`.
- `signal` is a scope-internal `AbortController`; `opts.parentSignal` (e.g. CLI SIGINT) links via `AbortSignal.any()`.
- `config` frozen at construction. No hot reload.
- Threaded through `PipelineContext` as `ctx.runtime` (single field; no new container types).

**Explicit non-goals (vs ADR-014's `RunScope`):**

- **No `getAgent(name)` method.** Callers use `runtime.agentManager.runAs(...)` / `.completeAs(...)` (today's shape).
- **No `invoke(op, ...)` method.** Call sites are plain function calls — `callOp(ctx, op, input)` (§4).
- **No `services` sub-object.** Flat top-level fields.
- **No `child()` or nested runtime.** Per-call isolation (debate proposers, rectification attempts) already expressed via per-call `signal`, `logger` overrides on `AgentRunOptions`.

### Orphan consolidation

Only 3 real `createAgentManager` call sites exist today (ADR-017 overcounted at 7; code grep confirms):

| Site | Today | After |
|:---|:---|:---|
| [src/execution/runner.ts:117](../../src/execution/runner.ts#L117) | direct instantiation | `createRuntime(config, workdir)` |
| [src/acceptance/generator.ts:75](../../src/acceptance/generator.ts#L75) | `createManager` factory field | `_generatorDeps.runtime` |
| [src/acceptance/refinement.ts:25](../../src/acceptance/refinement.ts#L25) | `createManager` factory field | `_refinementDeps.runtime` |

Other sites (`routing/router.ts`, `cli/plan.ts`, `debate/session-helpers.ts`, `verification/rectification-loop.ts`) **import** the factory but receive it via threaded deps; they migrate by swapping the `createManager` dep for `runtime`.

**Why this closes #523:** one `AgentManager` per run, so a 401 on routing falls into the same fallback chain as execution. Cost events from rectification and debate proposers roll into one `CostAggregator` via the shared middleware chain.

---

## 3. `AgentManager.runAs()` — Layer 1 cross-cutting envelope

**Problem:** [src/agents/acp/adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593) calls `resolvePermissions()` three times. Cost tagging and audit are inconsistent across orphan call sites.

**Fix:** one place — `AgentManager.runAs()` (and siblings `completeAs()`, `runWithFallback()`). Permissions resolve pre-chain (once); cost, audit, cancellation, and logging concerns ride an observer-middleware chain frozen at runtime construction.

```typescript
// src/agents/manager.ts — amend existing runAs()
async runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult> {
  // Pre-chain: permission resolution happens once, BEFORE middleware
  const permissions = resolvePermissions(
    request.runOptions.config,
    request.runOptions.pipelineStage,
  );
  const runOptions = { ...request.runOptions, resolvedPermissions: permissions };

  // Run through observer-middleware chain; terminal is the actual dispatch
  return this._middleware.execute(
    {
      agentName,
      options: runOptions,
      signal: request.signal,
      stage: runOptions.pipelineStage,
      storyId: runOptions.storyId,
      packageDir: request.packageDir,
    },
    async () => this._dispatch(agentName, { ...request, runOptions }),
  );
}
```

**`createAgentManager` grows one optional slot:**

```typescript
export function createAgentManager(
  config: NaxConfig,
  opts?: { middleware?: readonly AgentMiddleware[] },
): IAgentManager;
```

Default empty chain — keeps tests construction-cheap. `createRuntime` composes the production chain (audit + cost + cancellation + logging) and passes it in.

**Adapter simplification:** the three `resolvePermissions()` calls delete. The adapter reads `request.runOptions.resolvedPermissions` (pre-resolved by the manager).

**Wire mapping stays in the adapter's folder.** No `IPermissionTranslatorRegistry`. When a second transport arrives, add `toWirePolicy(resolved)` to `AgentAdapter`.

### 3.1 Agent middleware — observers only, frozen, pre-chain permissions

Ported from ADR-014 §2.8 with RunScope wording stripped. Three invariants carry over unchanged:

```typescript
// src/runtime/agent-middleware.ts (new, ~60 lines)
export interface AgentMiddleware {
  readonly name: string;
  run?(ctx: MiddlewareContext, next: () => Promise<AgentResult>): Promise<AgentResult>;
  complete?(ctx: MiddlewareContext, next: () => Promise<CompleteResult>): Promise<CompleteResult>;
}

export interface MiddlewareContext {
  readonly agentName: string;
  readonly options: AgentRunOptions | CompleteOptions;  // includes .resolvedPermissions (canonical)
  readonly signal: AbortSignal;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
}
```

**Phase 1 chain (observer-only):**

| Middleware | Concern | Semantics |
|:---|:---|:---|
| `audit` | Capture prompt + response via `IPromptAuditor`; record `options.resolvedPermissions.profile` | Observer — emits `PromptAuditEntry` on success, `PromptAuditErrorEntry` on error |
| `cost` | Emit `CostEvent` to `ICostAggregator`, tagged with `{ agentName, stage, storyId, packageDir }` | Observer — `CostEvent` on success, `CostErrorEvent` on error |
| `cancellation` | Thread `signal` into adapter call; translate `AbortError` to `NaxError CANCELLED` | Pass-through with error translation; does not observe prompt/response |
| `logging` | Structured JSONL per `project-conventions.md`; `storyId` first; includes canonical `profile` | Observer |

**Three invariants:**

- **Observer-only in Phase 1.** Middleware does not mutate prompt, response, or options for the next middleware in the chain. Order-independence is preserved. Transformer middleware reopens only when a concrete transformer case emerges with justification.
- **Frozen at runtime construction.** Chain registered once in `createRuntime()` and immutable for the runtime lifetime. No per-call / per-op middleware overrides.
- **Permissions pre-chain, not middleware.** `resolvePermissions()` fires before the chain executes (§3 code above); middleware reads `options.resolvedPermissions` for audit but does not compute it. Matches ADR-014's explicit rejection of permissions-as-middleware.

**Resilience:** every middleware is resilient to the terminal call throwing. `audit` emits an error entry; `cost` emits `CostErrorEvent`; `cancellation` translates the error; no middleware swallows the thrown error.

**Session-internal calls are covered by construction.** ADR-013 Phase 5 locked down direct adapter calls — everything flows through `IAgentManager`. `SessionManager.runInSession(id, manager, req)` therefore invokes `manager.run(req)` which routes through `runAs()` → middleware chain. No SessionManager rewire required (contrast ADR-014, which needed a `scope.getAgent` callback).

### 3.2 Observability sinks — `CostAggregator` + `PromptAuditor`

Ported from ADR-014 §3 + §4. Both live on `NaxRuntime`; drained/flushed on `runtime.close()`.

```typescript
// src/runtime/cost-aggregator.ts (new, ~50 lines)
export interface ICostAggregator {
  record(event: CostEvent): void;
  recordError(event: CostErrorEvent): void;
  snapshot(): CostSnapshot;
  byAgent(): Record<string, CostSnapshot>;
  byStage(): Record<string, CostSnapshot>;
  byStory(): Record<string, CostSnapshot>;
  drain(): Promise<void>;  // flushes to StoryMetrics on runtime close
}

export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model: string;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface CostErrorEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model?: string;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
}

// src/runtime/prompt-auditor.ts (new, ~40 lines)
export interface IPromptAuditor {
  record(entry: PromptAuditEntry): void;
  recordError(entry: PromptAuditErrorEntry): void;
  flush(): Promise<void>;  // writes to .nax/audit/<runId>.jsonl
}
```

Nested calls (rectification, debate proposers, pre-execution refinement) flow through the same aggregator via the shared runtime. `StoryMetrics` reads aggregate totals on `runtime.close()`.

**Audit writes from `src/agents/acp/adapter.ts:651-666` (existing inline `writePromptAudit`) delete in Wave 2** — the `audit` middleware writes uniformly for every adapter.

---

## 4. `Operation<I, O, C>` spec + `callOp()` helper — Layer 4

### 4.1 Operation shape

```typescript
// src/operations/types.ts
export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C>;

interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C>;
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string) => O;
}

export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  readonly mode?: string;                      // "plan" | "implement" | ...
  readonly session: {
    readonly role: SessionRole;
    readonly lifetime: "fresh" | "warm";
    // No topology field — every kind:"run" op routes through SingleSessionRunner.
    // Multi-session flows (TDD three-session, debate) sequence multiple callOps
    // from their domain orchestrator (src/tdd/orchestrator.ts, src/debate/runner.ts).
  };
}

export interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
  readonly jsonMode?: boolean;
}

export interface BuildContext<C> {
  readonly packageView: PackageView;
  readonly config: C;                          // pre-sliced to declared slice
}

export interface CallContext {
  readonly runtime: NaxRuntime;
  readonly packageView: PackageView;           // always present; root-equivalent when no workdir
  readonly packageDir: string;
  readonly storyId?: string;
  readonly agentName: string;
  readonly sessionOverride?: {
    readonly role?: SessionRole;
    readonly discriminator?: string | number;
  };
}
```

**`parse` contract clarification:** for `kind:"complete"` ops, `parse(output)` is a pure text→domain transform (typical JSON-mode completion result). For `kind:"run"` ops that need session-close post-work (autoCommit, isolation verification, changed-file diff, PID cleanup), that work lives in the domain orchestrator that called `callOp` (for TDD: in `src/tdd/session-op.ts`'s shared helper), not inside `parse`. This keeps `parse` side-effect-free for the common case while accommodating the session-based ops that need session-close bookkeeping.

### 4.2 `ConfigSelector<C>` — named, reusable, interface-based

`ConfigSelector<C>` is an **interface** — named selectors declare each subsystem's config dependency once and are reused across ops that share the same slice. This turns the config dependency graph from implicit (inline keyof-arrays scattered across ops) into explicit (one `src/config/selectors.ts` file).

```typescript
// src/config/selector.ts (new, ~40 lines)
export interface ConfigSelector<C> {
  readonly name: string;                       // used for debugging + memoization key
  select(config: NaxConfig): C;
}

// Factories for the two common cases.

/** Pick top-level keys — the 95% case. Name is required so memoization is stable. */
export function pickSelector<K extends keyof NaxConfig>(
  name: string,
  ...keys: readonly K[]
): ConfigSelector<Pick<NaxConfig, K>>;

/** Reshape / narrow nested fields. Use when Pick isn't enough. */
export function reshapeSelector<C>(
  name: string,
  fn: (config: NaxConfig) => C,
): ConfigSelector<C>;
```

### 4.2.1 The selector registry — `src/config/selectors.ts`

One file, one named selector per subsystem. This is the greppable "which config does each subsystem depend on?" answer.

```typescript
// src/config/selectors.ts (new, ~40 lines)
import { pickSelector, reshapeSelector } from "./selector";

export const reviewConfigSelector      = pickSelector("review", "review", "debate");
export const planConfigSelector        = pickSelector("plan", "planner", "debate");
export const decomposeConfigSelector   = pickSelector("decompose", "decomposer");
export const rectifyConfigSelector     = pickSelector("rectify", "rectification");
export const acceptanceConfigSelector  = pickSelector("acceptance", "acceptance");
export const tddConfigSelector         = pickSelector("tdd", "tdd", "verification");
export const debateConfigSelector      = pickSelector("debate", "debate");
export const routingConfigSelector     = pickSelector("routing", "routing");

// Reshape example — narrow nested fields when the op doesn't need the whole block.
export const verifyConfigSelector = reshapeSelector("verify", (c) => ({
  timeout: c.verification.timeout,
  testCommand: c.quality.commands.test,
}));
```

Two ops that need the same slice **share the selector**:

```typescript
// src/operations/semantic-review.ts
export const semanticReview: RunOperation<...> = {
  ...,
  config: reviewConfigSelector,     // ← named, reusable
  ...
};

// src/operations/adversarial-review.ts
export const adversarialReview: RunOperation<...> = {
  ...,
  config: reviewConfigSelector,     // ← same selector, same memoized view
  ...
};
```

### 4.2.2 Inline sugar — still supported for one-offs

`callOp()` also accepts the keyof-array form for genuinely one-off slices that don't belong in the registry:

```typescript
// Accepted — wrapped internally as pickSelector("anonymous:<op.name>", ...keys)
config: ["hooks"] as const
```

Rule of thumb: **if two ops would write the same inline array, hoist it to `src/config/selectors.ts`.** The registry is the SSOT for "which config does each subsystem depend on?" Inline forms are ephemera.

### 4.2.3 What this buys

- **Dependency graph is a single file.** `src/config/selectors.ts` is the "what config does nax use?" answer. No hunting through ops.
- **Refactor safety.** Renaming `config.rectification.maxRetries` breaks `rectifyConfigSelector` — the single definition — and the compiler surfaces every op that depends on it.
- **Memoization is free.** `configLoader.select(reviewConfigSelector)` returns the same object reference on repeated calls within a runtime. Composite ops (review = semantic + adversarial) don't double-slice.
- **Test fixture shrink.** Each op tests with `createConfigLoader({ review: {...}, debate: {...} }).select(reviewConfigSelector)` — ~3 fields, not full `NaxConfig`.
- **Named, not anonymous.** Stack traces and audit logs reference selector names (`"review"`, `"plan"`) rather than `"(config) => { ... }"` closures.

Enforcement: operations reading `ctx.config.*` outside their selector's output is a type error. Runtime slicing inside `callOp()` goes through `configLoader.select(op.config)`.

### 4.2.4 `ConfigLoader` ⇄ `ConfigSelector` contract

Six rules fix the integration shape between the two types. They are architectural, not implementation detail — changing any of them later forces re-migrating ops.

**1. Memoization lives in the loader; selectors are pure descriptors.**

Selectors are stateless and framework-free — a selector file has no runtime import. `select(config)` is a pure function of its input; it may not read globals, cannot throw (except on programmer error — missing required field in a non-default-populated config), and produces the same output for the same input. The loader owns the cache, the invalidation rules, and the future hot-reload subscription. Any loader hosts any selector.

**2. Memo key is `selector.name`. Duplicate registration is a programmer error and throws.**

```typescript
// src/config/selectors.ts registry enforces uniqueness at import time
export const reviewConfigSelector = pickSelector("review", "review", "debate");
// A second pickSelector("review", ...) anywhere → NaxError CONFIG_SELECTOR_DUPLICATE_NAME
```

Name-based keying means `configLoader.select(reviewConfigSelector)` always maps to one memo cell, stable across module reloads and test-fixture recreation. Identity-based keying would re-slice after Bun re-evaluates a module and would break under test hot-reload.

**3. Config validation happens once at disk load. Selectors never validate.**

The existing Zod `safeParse` in [src/config/loader.ts](../../src/config/loader.ts) stays the validation boundary. `ConfigLoader` receives an already-validated `NaxConfig`. Selectors project — they do not enforce invariants. This keeps `select()` O(1), exception-free on the happy path, and composable without each selector re-running Zod.

**4. `current()` is public but off-limits inside operations — and so is direct `configLoader.select(...)`.**

All ops read config through `ctx.packageView.select(selector)`. This is polyglot-monorepo-correct by construction: `packageView.config` is always a safe base because `mergePackageConfig` is a one-way merge — whitelisted sections get package overrides when present; root-only sections pass through unchanged. A repo-scoped op reading a root-only section (e.g. `planConfigSelector` over `config.plan`) gets the root value via `packageView.config.plan`; a package-scoped op reading a whitelisted section (e.g. `reviewConfigSelector` over `config.review`) gets the package-specific override. One code path, no `scope` field needed.

Three legitimate uses of `configLoader.current()` — **all outside ops**:

- Run-level setup (creating `PackageRegistry` views at the start of the run).
- `AgentManager.runAs()` threading the full config into `AgentRunOptions` for session-handle derivation / adapter internals (not semantically owned by any specific op).
- CLI commands that display config (`nax config show`).

Inside `src/operations/**` and inside prompt builders, **both** `configLoader.current()` and direct `configLoader.select(...)` are lint errors. The sliced `ctx.config` (via `ctx.packageView.select(op.config)`) is the only allowed path. Enforced by the same forbidden-import pattern as the Prompt Builder Convention.

**5. Hot-reload semantics (future — contract shape only, not shipped).**

When/if hot-reload lands, the contract is fixed now so callers can depend on the loader without guessing:

- `reload(next: NaxConfig)` — atomic swap. Zod validates `next` before swap; on failure, old config is retained and `reload` throws.
- After swap, `current()` returns `next`; `select()` memo is invalidated per selector (re-runs on next access); `onReload` subscribers fire.
- **In-flight calls keep their sliced view.** `callOp()` captures `ctx.config` once at the top of `op.build()`; the slice remains stable for the op's duration. Frozen-during-call is the invariant — reload affects *subsequent* ops only.
- Runtime does not re-fire or cancel in-flight ops on reload. That is a separate feature, deliberately not coupled.

No concrete plan today. Documented so the seam is real, not vapor.

**6. No selector composition in the interface.**

An op that needs the union of two existing slices uses `reshapeSelector` to project and name the result:

```typescript
// ✅ One named entry in the registry; one memo cell
export const reviewPlusPlanner = reshapeSelector("review-plus-planner", (c) => ({
  ...reviewConfigSelector.select(c),
  ...planConfigSelector.select(c),
}));
```

A hypothetical `composeSelectors(a, b)` combinator adds a second way to name a slice (by input list vs. by output shape) with no daylight between them. Skip it. If >2 call sites demand the same union and `reshapeSelector` becomes repetitive, add it then as a factory over the registry — the interface does not change.

---

**What this contract excludes (implementation detail, not ADR material):** memo data structure, sync-vs-async `select()` (sync, falls out of purity), telemetry granularity, error-message wording, whether the loader uses a Proxy, registry file layout (one flat file vs per-subsystem). Those get decided at PR time without re-opening the ADR.

### 4.3 `callOp()` — Layer-3 dispatch

```typescript
// src/operations/call.ts (new, ~60 lines)
export async function callOp<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): Promise<O> {
  // Config slicing goes through the packageView — always correct for polyglot monorepos.
  // No scope field: packageView.config is root-equivalent when no workdir, or root+package-merged
  // when workdir is set. Root-only sections pass through unchanged either way.
  const selector    = normalizeSelector(op.config, op.name);
  const slicedConfig = ctx.packageView.select(selector);
  const buildCtx: BuildContext<C> = { packageView: ctx.packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));  // §7 — ships in Wave 1
  const prompt   = join(sections);

  if (op.kind === "complete") {
    // Session-less path → straight to Layer 1 (through manager → middleware chain)
    const raw = await ctx.runtime.agentManager.completeAs(ctx.agentName, prompt, {
      jsonMode: op.jsonMode ?? false,
      pipelineStage: op.stage,
      storyId: ctx.storyId,
      packageDir: ctx.packageDir,
    });
    return op.parse(raw);
  }

  // kind:"run" → Layer 3 (SingleSessionRunner) → Layer 2 (runInSession) → Layer 1 (runAs + middleware)
  const runner = new SingleSessionRunner();
  const outcome = await runner.run({
    runtime: ctx.runtime,
    agentName: ctx.agentName,
    packageDir: ctx.packageDir,
    storyId: ctx.storyId,
    prompt,
    op,
    sessionOverride: ctx.sessionOverride,
  });
  return op.parse(outcome.primaryResult.output);
}

// Accepts a ConfigSelector OR the inline keyof-array sugar; returns a proper selector.
function normalizeSelector<C>(
  s: ConfigSelector<C> | readonly (keyof NaxConfig)[],
  opName: string,
): ConfigSelector<C> {
  return Array.isArray(s) ? pickSelector(`anonymous:${opName}`, ...s) : (s as ConfigSelector<C>);
}
```

`callOp` is ~60 lines. It does not mint sessionIds, does not resolve permissions, does not wrap errors redundantly — those are Layer 2, Layer 1, and Layer 1 respectively. Config slicing goes through `packageView.select` — single dispatch path, no scope branching.

### 4.4 Operation directory as discovery surface

```
src/operations/
├── types.ts             — Operation, RunOperation, CompleteOperation, ConfigSelector, ...
├── call.ts              — callOp() — single dispatch through SingleSessionRunner
├── index.ts             — barrel
├── plan.ts              — replaces AgentAdapter.plan()
├── decompose.ts         — replaces AgentAdapter.decompose()
├── rectify.ts           — per-attempt op used by runRetryLoop
├── classify-route.ts    — replaces routing LLM classifier (Wave-1 proof-of-shape)
├── acceptance-generate.ts
├── acceptance-refine.ts
├── acceptance-diagnose.ts
├── acceptance-fix.ts
├── semantic-review.ts
├── adversarial-review.ts
├── write-test.ts        — TDD: test-writer op (kind:"run")
├── implement.ts         — TDD: implementer op; also used by single-session execution stage
├── verify.ts            — TDD: verifier op (kind:"run")
├── debate-propose.ts    — kind:"complete" for oneshot mode
├── debate-rebut.ts      — kind:"complete" for oneshot mode
├── debate-rank.ts       — kind:"complete" for oneshot mode
├── debate-session.ts    — kind:"run" for stateful/hybrid modes
└── README.md            — standard shape, when to add a new op, migration checklist
```

`ls src/operations/` answers "what operations does nax have?" No hunting through subsystems.

**Domain orchestrators that sequence multiple ops live next to their domain, not in `src/operations/`:**

- `src/tdd/orchestrator.ts` — `runThreeSessionTdd`. Sequences three `callOp` calls (writeTestOp → implementOp → verifyOp), owning between-session concerns (greenfield detect, full-suite gate, verdict read, rollback).
- `src/debate/runner.ts` — `DebateRunner` class. Dispatches on mode: oneshot → N parallel complete-kind callOps; stateful/hybrid → N parallel run-kind callOps. Does **not** implement `ISessionRunner` — it's a debate-domain orchestrator, not a session-runner.

---

## 5. `ISessionRunner` — Layer 3 bookkeeping surface

### 5.1 The interface (preserved from #596; kept tight)

```typescript
// src/session/runners/types.ts (from #596, amended)
export interface ISessionRunner {
  readonly name: string;
  run(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome>;
}

export interface SessionRunnerContext {
  readonly runtime: NaxRuntime;
  readonly agentName: string;
  readonly packageDir: string;
  readonly storyId?: string;
  readonly prompt: string;                     // composed at Layer 4
  readonly op: RunOperation<unknown, unknown, unknown>;
  readonly sessionOverride?: CallContext["sessionOverride"];
  readonly noFallback?: boolean;               // opt-out of cross-agent fallback (TDD per-role sessions)
}

export interface SessionRunnerOutcome {
  readonly primaryResult: AgentResult;
  readonly fallbacks: readonly AgentResult[];  // for swap-metrics attribution
}
```

**`ISessionRunner` has exactly one implementation: `SingleSessionRunner`.** The interface exists to document the Layer-3 contract (shared call site for `runInSession`), not to enable polymorphism. Multi-session flows (TDD three-session, debate) are orchestrator-level concerns that sequence multiple `callOp` invocations — they live next to their domain in `src/tdd/orchestrator.ts` and `src/debate/runner.ts`.

**`noFallback` rationale:** TDD per-role sessions explicitly do not participate in cross-agent fallback (established behaviour — see [src/tdd/three-session-runner.ts:87](../../src/tdd/three-session-runner.ts#L87) `fallbacks: []`). Before ADR-018 this was expressed by passing `wrapAdapterAsManager(agent)` instead of the real `agentManager`. Under ADR-018, TDD ops set `noFallback: true` explicitly at the type level. Silent-regression-proof.

### 5.2 `SingleSessionRunner` (already shipped in #596)

One session per story. Migration from #596's code is the existing implementation at [src/session/runners/single-session-runner.ts](../../src/session/runners/single-session-runner.ts); signature aligns to the new `SessionRunnerContext`.

```typescript
export class SingleSessionRunner implements ISessionRunner {
  readonly name = "single-session";
  async run(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome> {
    const sessionId = deriveSessionId(ctx);     // via SessionManager factory
    const manager = ctx.noFallback
      ? wrapAdapterAsManager(ctx.runtime.agentManager.getAdapter(ctx.agentName))
      : ctx.runtime.agentManager;
    const result = await ctx.runtime.sessionManager.runInSession(
      sessionId,
      async (options) => manager.runWithFallback(ctx.agentName, {
        runOptions: {
          prompt: ctx.prompt,
          workdir: ctx.packageDir,
          pipelineStage: ctx.op.stage,
          mode: ctx.op.mode,
          storyId: ctx.storyId,
          sessionRole: resolveSessionRole(ctx.op.session.role, ctx.sessionOverride),
          keepOpen: ctx.op.session.lifetime === "warm",
          config: ctx.runtime.configLoader.current(),
          ...options,
        },
      }),
      { sessionRole: ctx.op.session.role },
    );
    return { primaryResult: result.primary, fallbacks: result.fallbacks };
  }
}
```

### 5.3 TDD orchestrator (not an `ISessionRunner`)

TDD's three-session flow (test-writer → implementer → verifier) stays in [src/tdd/orchestrator.ts](../../src/tdd/orchestrator.ts) as a plain function, not a runner class. `runThreeSessionTdd(options)` keeps its current responsibilities: recursion guard, dry-run short-circuit, retry-skip logic, greenfield detection, `runFullSuiteGate` between sessions 2 and 3, `readVerdict` post-session, `executeWithTimeout` post-verify fallback, `rollbackToRef` on failure, cost/token/duration aggregation.

**What changes:** the three `runTddSession(role, ...)` call sites become `callOp(ctx, writeTestOp, input)` / `callOp(ctx, implementOp, input)` / `callOp(ctx, verifyOp, input)`. A shared helper `src/tdd/session-op.ts :: runTddSessionOp(role, input, ctx)` (extracted from today's `runTddSession`) holds the post-session side effects (autoCommit, isolation verification, changed-file diff, PID cleanup). Each of the three TDD ops is a thin wrapper around the helper.

**TDD ops set `noFallback: true`** when invoking `callOp` (via `sessionOverride` or a dedicated field on input) so `SingleSessionRunner` wraps the adapter without fallback. Preserves today's `fallbacks: []` invariant at the type level.

**This closes #589, #590, #591 "by construction":** every TDD session still goes through `SingleSessionRunner → SessionManager.runInSession`. State transitions, token passthrough, early protocolIds capture apply per session, uniformly, via the one shared call site.

### 5.4 `DebateRunner` (not an `ISessionRunner`)

Today [src/debate/session.ts:24-174](../../src/debate/session.ts#L24-L174) dispatches between `one-shot`, `stateful`, and `hybrid` modes. That dispatch moves into `DebateRunner` — a cohesive debate-domain class that does **not** implement `ISessionRunner`.

The `*Runner` suffix here describes domain role (runs debates), not interface conformance. `ISessionRunner` conformance is reserved for classes that genuinely share the `runInSession` primitive — today, only `SingleSessionRunner`.

| Mode | Dispatch | Op kind |
|:---|:---|:---|
| `oneshot` | N parallel `callOp(ctx, debateProposeOp, ...)` | `kind: "complete"` |
| `stateful` | N parallel `callOp(ctx, debateSessionOp, ...)` | `kind: "run"` (via SingleSessionRunner) |
| `hybrid` | N parallel `callOp(ctx, debateSessionOp, ...)` + reviewer-dialogue rounds | `kind: "run"` (via SingleSessionRunner) |

```typescript
// src/debate/runner.ts
export class DebateRunner {
  async run(ctx: OpContext, input: DebateInput): Promise<DebateOutput> {
    switch (input.mode) {
      case "oneshot":
        return Promise.all(
          input.personas.map((p, i) =>
            callOp(ctx, debateProposeOp, { persona: p, topic: input.topic, discriminator: i }),
          ),
        ).then(aggregate);
      case "stateful":
      case "hybrid":
        return Promise.all(
          input.personas.map((p, i) =>
            callOp(ctx, debateSessionOp, { persona: p, mode: input.mode, discriminator: i }),
          ),
        ).then(aggregate);
    }
  }
}
```

Per-debater isolation: `Promise.allSettled` + per-debater `AbortController` (threaded via `sessionOverride`). A 401 on debater 0 is visibly distinct from a 401 on debater 2 (Layer-1 middleware audit tags each).

**`src/debate/session-*.ts` mode-specific files collapse into the orchestrator's body.** `_debateSessionDeps.createManager` is removed by the Wave-1 orphan consolidation.

### 5.5 `*Runner` naming convention

The `*Runner` suffix on a class name describes its domain role — "runs X." It does **not** imply `ISessionRunner` interface conformance. Only classes that genuinely share the `runInSession` call site (today: `SingleSessionRunner`) implement the interface. `DebateRunner`, `runThreeSessionTdd` (function), and any future domain orchestrators sit at Layer 4-or-above and use `callOp` to reach Layer 3.

### 5.6 What this does *not* change about sessions

Session primitives from ADR-007/008/011/013 and #596 stay intact:

| Primitive | Owner | Preserved |
|:---|:---|:---|
| `sess-<uuid>` descriptor ID | SessionManager | Yes |
| `nax-<hash8>-<feature>-<storyId>-<role>` wire handle | `computeAcpHandle` in adapter | Yes |
| `keepSessionOpen` per-role matrix | Caller of `agent.run()` | Yes (via `op.session.lifetime`) |
| `sweepFeatureSessions` at story completion | SessionManager | Yes |
| `AgentRunOptions.sessionHandle` override | Adapter | Yes (exposed through `sessionOverride`) |
| Implementer session continuity across rectification | `computeAcpHandle` determinism | Yes |
| Fresh sessionId per reviewer round | `keepOpen: false` + deterministic handle | Yes |
| `SessionManager.runInSession` primitive | SessionManager | Yes — **load-bearing, per #596** |

---

## 6. `.plan()` / `.decompose()` off the adapter

```typescript
// src/operations/plan.ts
export const plan: RunOperation<PlanInput, PlanResult, Pick<NaxConfig, "planner" | "debate">> = {
  kind: "run",
  name: "plan",
  stage: "plan",
  mode: "plan",
  session: { role: "plan", lifetime: "fresh", topology: "single" },  // debated plan uses topology: "debate"
  config: ["planner", "debate"],
  build: (input, ctx) => ({
    role: planBuilder.role(input),
    task: planBuilder.task(input),
    context: input.context,
    constitution: input.constitution,
    packageView: ctx.packageView,
    outputFormat: planBuilder.outputFormat(),
  }),
  parse: planBuilder.parse,
};

// src/operations/decompose.ts
export const decompose: CompleteOperation<DecomposeInput, DecomposeResult, Pick<NaxConfig, "decomposer">> = {
  kind: "complete",
  name: "decompose",
  stage: "complete",
  jsonMode: true,
  config: ["decomposer"],
  build: (input, ctx) => ({
    role: decomposeBuilder.role(input),
    task: decomposeBuilder.task(input),
    constitution: input.constitution,
    packageView: ctx.packageView,
    outputFormat: decomposeBuilder.outputFormat(),
  }),
  parse: decomposeBuilder.parse,
};
```

Adapter shrinks to `run(options)` + `complete(prompt, options)` — 2 methods, permanently. `IAgentManager.planAs` and `decomposeAs` delete.

---

## 7. `composeSections()` + typed `PromptSection` slots — ships in Wave 1

`composeSections` is a pure total function with no builder entanglement; Wave 1's `callOp` needs it to prove the Operation shape end-to-end. Builder migrations (slot-method exposure, rectifier collapse) stay in Wave 3.

**Wave 1 `SLOT_ORDER` is minimal** — only the slots Wave-1 ops use (`constitution`, `instructions`, `input`, `candidates`, `json-schema`). Grows per wave as builders migrate. Builders not yet migrated keep using `SectionAccumulator` unchanged.

**Wave 1 design notes:**
- **Dynamic labelled inputs** (today's `OneShotPromptBuilder.inputData` pattern with `input-<label>` slot names) use a **single `input` slot holding an array of `{label, body}`** — avoids polluting the `SectionSlot` union with template-literal slot names.
- **`composeSections.join()` reuses `SECTION_SEP`** from [src/prompts/core/wrappers.ts](../../src/prompts/core/wrappers.ts) and the empty-content filter logic from `SectionAccumulator.join()`. Single source of truth for separator + empty-section policy.
- **Wave 2/3 coexistence pattern for legacy-builder-backed ops:** wrap the builder's string output in a single-slot `ComposeInput` (`{ slots: { role_task: body } }`). Wave 3 collapses this when builders expose slot methods.

```typescript
// src/prompts/core/types.ts — extend existing type
export interface PromptSection {
  readonly id: string;
  readonly content: string;
  readonly overridable: boolean;
  readonly slot: SectionSlot;  // NEW
}

// Wave 1 minimal set — grows per wave as builders migrate
export type SectionSlot =
  | "constitution" | "instructions" | "input" | "candidates" | "json-schema";

// Wave 3 adds: "role", "context", "static-rules", "monorepo-hints",
//              "task", "previous-attempts", "examples", "output-format"
export const SLOT_ORDER: readonly SectionSlot[] = [
  "constitution", "instructions", "input", "candidates", "json-schema",
];

// src/prompts/compose.ts (new, ~80 lines — ships in Wave 1)
export interface ComposeInput {
  readonly role: PromptSection;
  readonly task: PromptSection;
  readonly context?: ContextBundle;
  readonly constitution?: string;
  readonly staticRules?: readonly StaticRule[];
  readonly previousAttempts?: readonly RetryAttempt<unknown>[];
  readonly examples?: PromptSection;
  readonly outputFormat?: PromptSection;
  readonly packageView: PackageView;
}

export function composeSections(input: ComposeInput): readonly PromptSection[] { /* ... */ }
export function join(sections: readonly PromptSection[]): string { /* ... */ }
```

Builders each expose slot-specific methods (`role(input) → PromptSection`, `task(input) → PromptSection`, etc.). The rectifier builder drops from 720 → ~200 lines.

**No prompt middleware chain.** `composeSections` is a total function. Op-specific augmentations live in the op's `build()` body.

**CI-enforced forbidden imports inside `src/prompts/builders/**`:**

| Forbidden | Why |
|:---|:---|
| `ContextBundle`, `IContextEngine` | Context enters via `ComposeInput.context` only |
| `loadConstitution`, `Constitution` | Constitution enters via `ComposeInput.constitution` only |
| `loadStaticRules` | Static rules enter via `ComposeInput.staticRules` only |
| `process.cwd`, `detectLanguage`, `resolveTestFilePatterns` | Monorepo data enters via `ComposeInput.packageView` only |

---

## 8. Unified `RetryInput<TFailure, TResult>`

```typescript
// src/verification/shared-rectification-loop.ts — amend existing
export interface RetryInput<TFailure, TResult> {
  readonly stage: PipelineStage;
  readonly storyId: string;
  readonly packageDir: string;
  readonly maxAttempts: number;
  readonly failure: TFailure;
  readonly previousAttempts: ReadonlyArray<RetryAttempt<TResult>>;
  readonly buildPrompt: (failure: TFailure, previous: readonly RetryAttempt<TResult>[]) => string;
  readonly execute: (prompt: string) => Promise<TResult>;
  readonly verify: (result: TResult) => Promise<VerifyOutcome<TFailure>>;
}

export async function runRetryLoop<TFailure, TResult>(
  input: RetryInput<TFailure, TResult>,
): Promise<RetryOutcome<TResult>>;
```

Five callers ([verification/rectification-loop.ts:136](../../src/verification/rectification-loop.ts#L136), [tdd/rectification-gate.ts:199](../../src/tdd/rectification-gate.ts#L199), [pipeline/stages/autofix.ts:34](../../src/pipeline/stages/autofix.ts#L34), [pipeline/stages/rectify.ts:72](../../src/pipeline/stages/rectify.ts#L72), [execution/lifecycle/run-regression.ts:277](../../src/execution/lifecycle/run-regression.ts#L277)) migrate to one input shape.

Progressive composition is the `buildPrompt(failure, previous)` callback — callers invoke `composeSections({ ..., previousAttempts: previous })` inside. No separate mechanism.

**Escalation stays at [src/execution/escalation/](../../src/execution/escalation/).** No `src/control/` directory; layering is already clear:

```
Stage invocation
  │
  ├─ on failure → runRetryLoop (same tier, N attempts)
  │               returns { outcome: "fixed" | "exhausted" }
  │
  └─ on "exhausted" → escalation decides next-tier action
                       mutates story.modelTier; runner re-invokes stage
```

---

## 9. CI lint + `SessionRole` tightening + `PackageRegistry`

### 9.1 Lint rules

**Rule A — `process.cwd()` outside CLI entry points is an error.**

- Permitted: `src/cli/**`, `src/commands/**`, `src/config/loader.ts` (bootstrap default).
- Banned: [src/debate/session.ts:44](../../src/debate/session.ts#L44), [src/agents/acp/adapter.ts:884,895](../../src/agents/acp/adapter.ts#L884), [src/precheck/index.ts:239](../../src/precheck/index.ts#L239), [src/commands/common.ts:82,85,98](../../src/commands/common.ts#L82).

**Rule B — prompt builders' forbidden imports.** Listed in §7 above.

### 9.2 `SessionRole` template-literal union

```typescript
export type SessionRole =
  | "main" | "test-writer" | "implementer" | "verifier"
  | "plan" | "decompose" | "acceptance-gen" | "refine" | "fix-gen"
  | "auto" | "diagnose" | "source-fix"
  | "reviewer-semantic" | "reviewer-adversarial"
  | `debate-${string}`          // debate-proposal-0, debate-critique-1, debate-fallback
  | `plan-${number}`;           // plan-0, plan-1, ...
```

`AgentRunOptions.sessionRole?: string` tightens to `sessionRole?: SessionRole`. Debate/plan inline string construction becomes type-checked.

### 9.3 `PackageRegistry` + `PackageView`

```typescript
// src/runtime/packages.ts (new, ~100 lines)
export interface PackageRegistry {
  all(): readonly PackageView[];
  /**
   * Resolve a PackageView for the given packageDir. When packageDir is undefined
   * or there is no per-package override, returns a root-equivalent view
   * (view.config === configLoader.current()). Never throws; never returns null.
   * Cached per packageDir for runtime lifetime.
   */
  resolve(packageDir?: string): PackageView;
  /** Alias for resolve(undefined). */
  repo(): PackageView;
}

export interface PackageView {
  readonly packageDir: string;                    // "" for repo/root-equivalent view
  readonly relativeFromRoot: string;
  readonly config: NaxConfig;                     // root, merged with .nax/mono/<pkg>/config.json when applicable
  readonly testPatterns: ResolvedTestPatterns;
  readonly language: DetectedLanguage;
  readonly framework: TestFramework | null;
  /**
   * Apply a ConfigSelector against this view's config.
   * Memoized per selector.name, per PackageView instance.
   * This is the canonical config-access path for all ops — callOp routes here.
   */
  select<C>(selector: ConfigSelector<C>): C;
}
```

**Always resolvable:** `PackageRegistry.resolve(undefined)` (or when `packageDir` isn't under `.nax/mono/<pkg>/`) returns a root-equivalent view. Pre-story ops, single-package runs, and no-workdir runs all get a valid `PackageView` whose `.config` equals `configLoader.current()`. No null checks; no scope field.

**Polyglot-monorepo correctness by construction:** `mergePackageConfig` is a one-way merge — whitelisted sections (agent, models, routing, execution, review, acceptance, quality, context, project) get package overrides when present; root-only sections (autoMode, generate, tdd, decompose, plan, constitution, interaction) pass through unchanged. A selector over a root-only section gets the root value via `packageView.config.plan`; a selector over a whitelisted section gets the package-specific override. One code path.

**Caching:** `PackageView.select<C>()` maintains its own memoization cache keyed on `selector.name` — separate from `ConfigLoader.select()`'s root cache. Same invalidation rules on future hot-reload: `ConfigLoader.reload()` → clears root cache → `PackageRegistry.clear()` → all `PackageView` caches invalidate. Documented now; not implemented today.

Backed by existing detectors (`discoverWorkspacePackages`, `findPackageDir`, `detectLanguage`, `detectTestFramework`, `resolveTestFilePatterns`, `loadConfigForWorkdir`). Cache valid for runtime lifetime (config is frozen). Threaded into `ComposeInput`; closes #533–#536 plus the ≥5 additional sites.

**Wave-3 migration task — grep audit of `rootConfig.*` reads:** today's [pipeline/types.ts:69-72](../../src/pipeline/types.ts#L69-L72) notes that `ctx.rootConfig` is read for `agent.default`, `models`, and `autoMode.escalation`. When those ops migrate, classify each read as (a) defensive legacy — safe to migrate; per-package overrides start applying (which was arguably always correct), or (b) semantically root-required — document and keep an explicit `configLoader.current()` access in that specific op. Expected hits: <10. Estimate: ~45 minutes plus ~30 minutes per semantic-root-required site.

---

## Architecture After ADR-018

```
NaxRuntime (per run / plan / standalone CLI invocation)
  ├─ configLoader: ConfigLoader               // NEW — current()/select(); future hot-reload seam; OFF-LIMITS inside ops
  ├─ workdir, projectDir, signal
  ├─ agentManager: IAgentManager              // Layer 1 envelope lives on runAs()/completeAs() + middleware chain
  ├─ sessionManager: ISessionManager          // Layer 2 primitive — runInSession() preserved (#596)
  ├─ costAggregator: ICostAggregator          // NEW — middleware-owned sink; drains on close
  ├─ promptAuditor: IPromptAuditor            // NEW — middleware-owned sink; flushes on close
  ├─ packages: PackageRegistry                // NEW — always resolvable; root-equiv view when no workdir
  └─ logger: Logger

Config layer (src/config/)
  ├─ ConfigLoader — current() + select<C>(selector) memoized per selector.name
  │                 — ONLY used by run-level setup; NOT by ops
  └─ ConfigSelector<C> interface — named registry in selectors.ts
        reviewConfigSelector, planConfigSelector, rectifyConfigSelector, ...

Operations (Layer 4 — src/operations/)
  ├─ Operation<I, O, C> typed spec (no scope field — always packageView-scoped)
  ├─ RunOperation adds { session: { role, lifetime } }
  ├─ CompleteOperation adds { jsonMode? }
  └─ callOp(ctx, op, input)
       ├─ slices config via ctx.packageView.select(op.config) — one dispatch path
       ├─ runs op.build → composeSections → join
       ├─ kind:"run"      → SingleSessionRunner → runInSession → runAs (+ middleware)
       └─ kind:"complete" → completeAs directly (+ middleware)

Domain orchestrators (live next to their domain, not in src/operations/)
  ├─ src/tdd/orchestrator.ts :: runThreeSessionTdd
  │    sequences three callOps (writeTestOp → implementOp → verifyOp) through SingleSessionRunner
  │    closes #589, #590 by construction (all three use runInSession via SingleSessionRunner)
  └─ src/debate/runner.ts :: DebateRunner
       dispatches on mode; oneshot = N parallel complete-kind callOps;
       stateful/hybrid = N parallel run-kind callOps through SingleSessionRunner
       NOT an ISessionRunner — domain orchestrator, not a session runner

Session runner (Layer 3 — src/session/runners/)
  └─ SingleSessionRunner    (#596 — the only ISessionRunner implementation)
     supports noFallback: true for TDD per-role sessions
     delegates to SessionManager.runInSession

Session primitive (Layer 2)
  └─ SessionManager.runInSession(sessionId, runFn, options)
       • CREATED → RUNNING  •  runFn  •  bindHandle  •  COMPLETED/FAILED

Per-call cross-cutting (Layer 1)
  └─ AgentManager.runAs / .completeAs / .runWithFallback
       • resolvePermissions (pre-chain, once)
       • observer middleware chain (frozen at runtime construction):
           audit → cost → cancellation → logging
       • error wrap  •  fallback on failure

Prompt composition
  ├─ Builders own slot-specific sections: role, task, examples, output-format
  └─ composeSections(input) → readonly PromptSection[]
       materializes: constitution, context, static rules, monorepo hints, previous attempts

Retry loop (unchanged location)
  └─ src/verification/shared-rectification-loop.ts :: runRetryLoop<TFailure, TResult>
       buildPrompt / execute / verify callbacks provided by caller

Escalation (unchanged location)
  └─ src/execution/escalation/ — runs between stage retries, not inside the loop

Adapter surface (2 methods, permanently)
  ├─ AgentAdapter.run(options)
  └─ AgentAdapter.complete(prompt, options)

Plugin extensions (unchanged — 7 types)
  └─ optimizer, router, agent, reviewer, context-provider, reporter, post-run-action
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 closes** | One `AgentManager` per run via `NaxRuntime`. Uniform fallback, cost, audit. |
| **#589, #590, #591 close by construction** | Every runner routes through `SessionManager.runInSession`. The next per-session concern lands once, not twice. |
| **Four reasons to change, four layers** | Adding an op → Layer 4. New topology → Layer 3. New per-session concern → Layer 2. New per-call concern → Layer 1. No cross-layer bleed. |
| **Adapter surface shrinks permanently** | `run` + `complete`. Prompt-building cannot leak back. |
| **Cross-cutting uniform** | Permissions/cost/audit/error wrapping happen once in `runAs()`. Three `resolvePermissions()` calls in ACP adapter delete. |
| **Operations have a standard shape** | `Operation<I, O, C>` + `callOp` + `ConfigSelector<C>`. One file per op, compiler-checked config slice. |
| **Prompt composition uniform** | `composeSections()` as a total function. Rectifier builder drops 720 → ~200 lines. |
| **Monorepo violations close structurally** | `PackageView` in `ComposeInput` + `process.cwd()` lint. #533–#536 plus ≥5 additional sites fixed. |
| **Retry inputs unify** | Five callers → one `RetryInput` shape. Progressive composition is a callback. |
| **Minimal concept surface** | ~12 new types (`NaxRuntime`, `ConfigLoader`, `ConfigSelector`, `Operation`, `RunOperation`, `CompleteOperation`, `ICostAggregator`, `IPromptAuditor`, `AgentMiddleware`, `RetryInput`, `ComposeInput`, `SessionRunnerContext`) vs ADR-014/015/016's ~24. Observer middleware ported whole from ADR-014 §2.8 — pattern survives the RunScope rejection. |
| **Structural audit/cost uniformity** | Observer middleware in `runAs()` fires for every run/complete call across every adapter, including session-internal calls. No adapter-specific "remember to call the helper." Session-internal calls covered by construction via ADR-013 Phase 5 (everything through IAgentManager). |
| **Config dependency graph is one file** | `src/config/selectors.ts` lists every subsystem's slice as a named selector. Refactoring `config.*` surfaces every dependent via the compiler. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `NaxRuntime` owns 5+ services | Admission criteria documented: scope-bound lifecycle + ≥2 consumers. Revisit if field count >8. |
| Middleware chain adds one indirection | Observer-only in Phase 1; frozen at runtime construction; three invariants documented (§3.1). Third-party mid-call transformer middleware explicitly out of scope. |
| `ISessionRunner` adds one layer vs raw `runAs()` | Required by #596. Without it, cross-cutting per-session concerns re-land twice. Interface is kept tight — one impl (`SingleSessionRunner`). |
| Operations are internal — no plugin registration | Plugins extend via the existing 7 types. Revisit when a third-party concrete case surfaces. |
| `SectionSlot` enum constrains ordering | Minimal in Wave 1; grows per wave. Non-canonical ordering requires amending `SLOT_ORDER` + review. |
| Migration spans 5 waves | Each wave ~1–2 days (Wave 2 grows to ~4 days for middleware infra), independently shippable. |

---

## Migration Plan

Five waves. Each independently shippable and revertible.

### Wave 1 — `NaxRuntime` + `ConfigLoader`/`ConfigSelector` + `composeSections` + orphan consolidation

- Introduce `src/runtime/index.ts` (`NaxRuntime` + `createRuntime`).
- Introduce `src/config/loader-runtime.ts` (`ConfigLoader` + `createConfigLoader`) — §2.1.
- Introduce `src/config/selector.ts` (`ConfigSelector` interface, `pickSelector`, `reshapeSelector`) and `src/config/selectors.ts` (named registry) — §4.2.1. Seed with the selectors for operations migrated in Wave 3; add more as ops land.
- Introduce `PackageRegistry` + `PackageView` in `src/runtime/packages.ts` with `resolve(undefined)` returning root-equivalent view — §9.3.
- Introduce `ICostAggregator` + `IPromptAuditor` placeholder implementations (middleware fires them no-op in Wave 1; real middleware wires them in Wave 2).
- Move `createAgentManager` from `src/agents/index.ts:29` to `src/runtime/internal/`.
- Migrate the 3 real orphan instantiations to `createRuntime`; other sites swap `createManager` dep for `runtime`.
- Runner constructs runtime in `runSetupPhase()`, closes in `runCompletionPhase()`.
- Thread `ctx.runtime: NaxRuntime` and `ctx.packageView: PackageView` through `PipelineContext`.
- **Introduce `Operation<I, O, C>` types + `callOp()` — delegate `kind:"run"` to the existing `SingleSessionRunner` (#596). `callOp` routes config through `ctx.packageView.select(op.config)`.**
- **Introduce `src/prompts/compose.ts`** (`ComposeInput`, `composeSections`, `join`) — Wave 1 ships the total function; builder migrations stay in Wave 3. Add minimal `SectionSlot` + `SLOT_ORDER` to `src/prompts/core/types.ts` (5 slots for Wave-1 ops only).
- **Publish `test/helpers/runtime.ts` with `makeTestRuntime(opts)` fixture** (Gap 7 resolution). Opts permit overriding individual runtime services (agentManager, sessionManager, configLoader, middleware, costAggregator, promptAuditor) so tests can inject mocks without constructing the full runtime. Default middleware chain is empty (observable behaviour matches today's pre-middleware adapter path).
- Prove on one op — `classifyRoute` (`kind: "complete"`, uses `routingConfigSelector`).
- **Exit criteria:** zero `createAgentManager` imports outside `src/runtime/`; `#523` reproducer green; one operation end-to-end through `callOp` + `composeSections`; `ConfigLoader`/`PackageView` memoization verified in unit tests; `makeTestRuntime()` published and used by new op tests.
- **Risk:** Low. Purely additive.

### Wave 2 — `runAs()` cross-cutting envelope + middleware chain + adapter simplification

- Amend `runAs()` / `completeAs()` / `runWithFallback()`: permissions pre-chain, middleware chain wraps the terminal dispatch (§3).
- Introduce `src/runtime/agent-middleware.ts` (`AgentMiddleware` + `MiddlewareContext`) — §3.1.
- Implement Phase 1 middleware: `audit`, `cost`, `cancellation`, `logging`. Observer-only; each resilient to the terminal throwing.
- Wire `createRuntime()` to compose the production chain and pass it to `createAgentManager(config, { middleware })`.
- Add `AgentRunOptions.resolvedPermissions?: ResolvedPermissions`.
- Delete three `resolvePermissions()` calls in [src/agents/acp/adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593).
- Delete inline `writePromptAudit` call in [src/agents/acp/adapter.ts:651-666](../../src/agents/acp/adapter.ts#L651-L666) — the `audit` middleware writes uniformly for every adapter.
- **Exit criteria:** zero `resolvePermissions()` calls inside the ACP adapter; `CostAggregator.snapshot()` reflects all calls including nested and session-internal; `PromptAuditor` flushes to `.nax/audit/<runId>.jsonl` on runtime close.
- **Risk:** Low–Medium. Middleware adds ~200 lines of infra; sinks are bounded-scope.
- **Budget:** ~4 days (from original ~2): middleware infra (~1 day) + sinks (~0.5 day) + per-middleware impl (~1 day) + adapter migration + tests (~1.5 days).

### Wave 3 — Extract operations + TDD orchestrator rewire + `DebateRunner`

- Migrate operation candidates (lowest blast radius first):
  1. `classifyRoute` — proved in Wave 1
  2. `acceptance-generate`, `acceptance-refine`, `acceptance-diagnose`, `acceptance-fix`
  3. `semantic-review`, `adversarial-review`
  4. `plan`, `decompose` (adapter-removal set) — see deprecation-window bullet below
  5. `rectify` (per-attempt op for Wave 4's `runRetryLoop`)
  6. `write-test`, `implement`, `verify` — **extract `src/tdd/session-op.ts :: runTddSessionOp(role, input, ctx)` shared helper from today's `runTddSession`; rewire `runThreeSessionTdd` to call `callOp(ctx, op, input)` for each role; delete `ThreeSessionRunner` class. Closes #589, #590 by construction (each op routes through `SingleSessionRunner` → `runInSession`).**
  7. `debate-propose`, `debate-rebut`, `debate-rank` (kind:"complete"), `debate-session` (kind:"run") — **land `src/debate/runner.ts :: DebateRunner` class; `src/debate/session-*.ts` mode-specific files collapse into the orchestrator's body.** `DebateRunner` does NOT implement `ISessionRunner`.
- Migrate builders to expose slot methods (Wave-1 `composeSections` already in place), in order:
  1. `rectifier-builder.ts` (720 → ~200 lines)
  2. `review-builder.ts`, `adversarial-review-builder.ts`
  3. `tdd-builder.ts`
  4. `acceptance-builder.ts`
  5. `debate-builder.ts`
  6. `plan-builder.ts`, `decompose-builder.ts`
  7. `one-shot-builder.ts` — also migrate the labelled-input pattern to single `input` slot with array value
- Grow `SLOT_ORDER` per builder migration (append new slots as they land).
- Update `nax plan` CLI and decompose callers to `callOp(...)`.
- **Deprecate `.plan()` / `.decompose()` with a one-release window (Gap 8 resolution):** `AgentAdapter.plan()` / `.decompose()` throw `NaxError ADAPTER_METHOD_DEPRECATED` with a migration pointer to the replacement ops. `IAgentManager.planAs()` / `.decomposeAs()` similarly throw. Full deletion lands in the release following Wave 3.
- Grep audit of existing `rootConfig.*` reads (§9.3 migration task). Classify each hit as defensive-legacy (safe to migrate) or semantically-root-required (document + keep `configLoader.current()` access). Expected <10 hits.
- Keep existing `_deps.createManager` factory sites as legacy wrappers (Gap 7 resolution) — each wrapper's body becomes `(opts) => { const runtime = makeTestRuntime(opts); return runtime.agentManager; }`. Call sites migrate opportunistically; delete aliases in the cleanup pass.
- Add CI lint rule for forbidden imports in `src/prompts/builders/**`; add lint for `configLoader.current()` / `configLoader.select(...)` inside `src/operations/**`.
- **Exit criteria:** `AgentAdapter.plan()` / `.decompose()` throw deprecation `NaxError`; TDD goes through the orchestrator-sequenced path (`runThreeSessionTdd` → three `callOp`s); debate goes through `DebateRunner` (no `ISessionRunner` conformance); `ISessionRunner` has exactly one implementation (`SingleSessionRunner`); no builder imports `ContextBundle`/`loadConstitution`/`loadStaticRules`; no op touches `configLoader.*` directly.
- **Risk:** Medium. Broad touch; each op + builder migration lands independently.

### Wave 3.5 — Adapter method deletion (release gate after Wave 3)

- Delete `AgentAdapter.plan()`, `AgentAdapter.decompose()`, `IAgentManager.planAs()`, `IAgentManager.decomposeAs()`.
- Delete `_deps.createManager` legacy wrappers (Gap 7 cleanup) once all tests have migrated to `makeTestRuntime()`.
- **Exit criteria:** `AgentAdapter` has only `run` and `complete`, permanently.
- **Risk:** Low. Compiler-enforced.

### Wave 4 — `RetryInput` unification

- Amend `runSharedRectificationLoop` to accept `RetryInput<TFailure, TResult>`; migrate 5 callers.
- Delete per-caller wrappers (`runRectificationLoopFromCtx`, TDD's local `runRectificationLoop`).
- **Exit criteria:** one retry-loop input shape across all callers.
- **Risk:** Low–Medium.

### Wave 5 — Monorepo lint + `SessionRole` tightening

- Add CI lint rule for `process.cwd()` outside permitted paths.
- Fix flagged sites (≥5 beyond #533–#536): `src/debate/session.ts:44`, `src/agents/acp/adapter.ts:884,895`, `src/precheck/index.ts:239`, `src/commands/common.ts:82,85,98`.
- Tighten `SessionRole` template-literal union; update debate files.
- **Exit criteria:** zero `process.cwd()` outside CLI; `SessionRole` admits debate/plan forms by type; #533–#536 closed.
- **Risk:** Low. Mechanical.

**Rollback plan:** every wave independently revertible. Waves 1–3 preserve backwards-compatible adapter surface during the window (deprecation path). Waves 4–5 touch retry and monorepo sites; each site small and individually reviewable.

---

## Rejected Alternatives

### A. ADR-017's rejection of `ISessionRunner` (§E)

**Rejected — this is the amendment.** ADR-017 §E argued `ISessionRunner` was ceremony over `scope.invoke`. That framing misreads #596: the runner is not a topology abstraction, it is the **shared call site for `SessionManager.runInSession`** so per-session bookkeeping concerns (state transitions, bindHandle, token propagation, protocolIds, abort plumbing) land once. Removing it re-opens the six drift paths enumerated in #596's PR description. This ADR reinstates `ISessionRunner` as Layer 3.

### B. ADR-014/015/016 proposal

**Rejected — see ADR-017 Context.** Summary: ~24 new types, three new directories, plugin API deferred three times, three interlocking ADRs. The codebase already contains partial forms (`PromptSection`, `shared-rectification-loop`, 7-type plugin system, `SessionManager.runInSession` + `SingleSessionRunner`) that reach the same outcome with ~9 new types.

### C. `RunScope` composite with `scope.invoke()` 9-step envelope

**Rejected.** ADR-017's reasoning stands. `NaxRuntime` (flat 5-service container) + `callOp()` (~70 lines) + layered Layer-1/2/3 responsibilities subsume the envelope without a god method.

### D. Transformer middleware chain

**Rejected — but observer middleware accepted.** ADR-017 rejected "middleware chains" as a blanket; gap-review analysis (Gap 5) re-opened the question and found observer middleware is the right tool for structurally uniform audit + cost across adapters and session-internal calls. **Transformer** middleware (mutating prompt/response/options) stays rejected — Phase 1 invariant is observer-only. If a concrete transformer case ever emerges, it opens with justification and defines ordering semantics then; today's concerns (audit, cost, cancellation, logging) are all observers. Sketch contract lives in §3.1.

### D.1 Cost/audit as `AgentManager` fields (Option A during gap review)

**Rejected.** Growing `createAgentManager(config)` to `createAgentManager(config, { costTracker, promptAuditor, logger, signal })` couples observability to agent lifecycle. Manager class inflates with unrelated concerns; every new observability concern (budget enforcement, rate tracking) requires a new manager field + constructor parameter. Observer middleware (§3.1) solves the same problem with one extensible pattern.

### D.2 Cost pass-through + shared audit helper (Option F during gap review)

**Rejected.** Keeping `createAgentManager(config)` untouched and adding a `maybeAuditPrompt()` helper that each adapter calls works today but relies on "every adapter author remembers to call the helper" — code-review discipline, not structural correctness. First forgotten call site = silent audit miss. Observer middleware wraps at the manager envelope; adapter authors cannot bypass it.

### E. Prompt middleware chain with ownership registry

**Rejected.** `composeSections()` is a total function with a `const readonly SLOT_ORDER`. Op-specific additions live in `op.build()` body. Same outcome, no runtime conflict resolution.

### F. `src/control/` directory for escalation + retry + iteration

**Rejected.** Layering already exists implicitly in the current tree. Moving modules into `src/control/` + adding an `IAgent`-import lint rule is taxonomy. Fix the input shapes; leave placement.

### G. `IPermissionTranslator` + `IPermissionTranslatorRegistry`

**Rejected.** ACP is the only transport. When a second transport arrives, add `toWirePolicy(resolved)` to `AgentAdapter`. Registry middleman ships ceremony for no benefit today.

### H. Plugin API v2 with operation registration

**Rejected.** The 7 existing plugin types cover today's use cases. Operations are internal convention. Revisit when a concrete third-party case surfaces.

### I. `IAgent` as a new third type

**Rejected.** `AgentAdapter` + `IAgentManager` already cover the space. Three `getAgent()` methods with three return types is a readability trap.

### J. Free functions (`runPlan(runtime, input)`) instead of `Operation` specs

**Rejected (per ADR-017 §K).** Free functions give a pattern to follow, not a type-enforced shape. The `Operation` spec form makes missing `stage`/`config`/`parse` a type error; makes unauthorized config reach a type error; puts every op in one discoverable directory.

### K. Prompt caching / `cache_control`

**Rejected as out of scope.** Section-based composition makes caching *possible* (stable prefix = constitution + role + context + static-rules) but shipping markers requires ACP wire support, model-specific tokenizers, and measurement infrastructure not prioritized today. Design does not preclude future addition.

### L. Topology as runner-class proliferation (`StatefulDebateRunner` / `OneShotDebateRunner` / `HybridDebateRunner`)

**Rejected (per ADR-015 §F).** The three debate modes differ in topology details but share debater vocabulary, per-debater abort isolation, and ranking. One `DebateRunner` class with mode dispatch (§5.4) keeps cohesion. Splitting triples the surface without simplifying any call site.

### M. `CompositeRunOperation` with `subOps: readonly RunOperation[]` (Gap 1 Option B)

**Rejected.** Proposed for TDD three-session: introduce a composite op kind whose runner sequences sub-ops internally. Analysis showed between-session logic (greenfield detection, `runFullSuiteGate`, `readVerdict`, `executeWithTimeout` post-verify, `rollbackToRef`) cannot be expressed as a sub-op sequence — the composite abstraction would need escape hatches for all of it, earning no duplication savings. Instead, TDD orchestration stays a plain function in [src/tdd/orchestrator.ts](../../src/tdd/orchestrator.ts) that sequences three `callOp` calls — matches how the code is already shaped today.

### N. `Operation.scope: "package" | "repo"` field (Gap 4 Option B)

**Rejected.** Proposed: each op declares whether its config selector slices against root or packageView. Analysis showed `mergePackageConfig` is a one-way merge — `packageView.config` is always a safe base because whitelisted sections apply package overrides when present and root-only sections pass through unchanged. A scope field would have every op author declare information that is redundant with the selector's target section. Instead, `callOp` always reads through `ctx.packageView.select(op.config)` — one dispatch path, no field, polyglot-correct by construction.

### O. Selector-owned scope (Gap 4 Option C)

**Rejected for the same reason as N.** Moving the `scope` declaration from op to selector (`ConfigSelector.scope: "package" | "repo"`) is strictly better than op-scoped declaration (fewer sites, better cohesion) — but it still solves a problem that doesn't exist. `packageView.config` is always correct; no scope flag needed anywhere.

### P. Renaming `SessionManager.runInSession` to `runInTopology` / `runWithRunner` (Gap 6)

**Rejected.** Proposed rename to reconcile `DebateSessionRunner.runOneShot` being session-less. `SessionManager.runInSession` is a per-session lifecycle primitive — the name describes exactly what it does. The real problem was forcing `DebateRunner` to implement `ISessionRunner` when its oneshot mode has no session. Fixed by dropping the interface conformance (§5.4), not by renaming the primitive.

---

## Open Questions

1. **`Operation.validate(input)` hook.** If pre-execution input validation proves repetitive, add `validate?: (input: I) => void | NaxError`. Leaning toward caller's responsibility (Zod at the boundary); revisit after Wave 3.

2. **Composite operations.** Expressible today as an op whose `build()` or caller invokes `callOp()` on sub-ops — no framework support. If a canonical pattern emerges (e.g. `review` as `semantic + adversarial`), add a thin `composite()` helper. Not a blocker.

3. **Runner selection override at call time.** `op.session.topology` declares the default; `CallContext` could grow a `topologyOverride` field for edge cases (e.g. a stage wants to force single-session debate for cost reasons). Not needed today; revisit on concrete request.

4. **Token budget enforcement.** Trivial once `CostAggregator.snapshot()` exposes a running total. Alternatively, add a `budget` middleware that inspects the chain's cost accumulator and aborts via `signal` when exhausted. `runRetryLoop`'s `verify` callback can return `{ success: false, reason: "budget-exhausted" }`.

5. **Session resume across runtime restarts.** A crashed run's `NaxRuntime` is gone; its persisted session descriptors can be reattached via `SessionManager.resume(descriptors)`. Inherits ADR-008's open question.

6. **`CostAggregator` + `PromptAuditor` disk schema.** `.nax/audit/<runId>.jsonl` and `.nax/cost/<runId>.jsonl` formats. Specified in Wave 2 implementation.

7. **`nax ops list` introspection.** A CLI showing every registered `Operation` + its `config` slice — useful for config-refactor audits. Nice-to-have.

---

## References

- **Supersedes:** ADR-017 (Incremental Consolidation — amended here at §E)
- **Also superseded:** ADR-014 (RunScope and Middleware), ADR-015 (Operation Contract), ADR-016 (Prompt Composition and PackageView) — rejected in ADR-017; this ADR inherits those rejections
- **Partial revival of ADR-014:** observer middleware chain (ADR-014 §2.8 + §3 + §4) is ported whole into §3.1/§3.2 of this ADR. The RunScope composite stays rejected; the middleware pattern is not.
- **Pre-implementation review:** [ADR-018-gap-review.md](./ADR-018-gap-review.md) — 8 gaps surfaced and resolved during review. Resolutions inform most of the non-trivial design choices above (no `scope` field, observer middleware, DebateRunner cohesion, TDD orchestrator sequential callOps, `composeSections` in Wave 1).
- **Preserved invariants from:** ADR-008 (session lifecycle), ADR-011 (SessionManager ownership), ADR-012 (AgentManager ownership), ADR-013 (SessionManager → AgentManager hierarchy), ADR-009 (test-file pattern SSOT)
- **Preserved architecture from:** [#596](https://github.com/nathapp-io/nax/pull/596) (`SessionManager.runInSession` + `ISessionRunner` Phase 1) — load-bearing; `SingleSessionRunner` stays the only `ISessionRunner` implementation under this ADR
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (amended to 2-method surface in Wave 3)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention (tightened by Wave 3)
- `.claude/rules/monorepo-awareness.md` — rules made structural by Wave 5
- Issues: [#523](https://github.com/nathapp-io/nax/issues/523), [#533](https://github.com/nathapp-io/nax/issues/533)–[#536](https://github.com/nathapp-io/nax/issues/536), [#589](https://github.com/nathapp-io/nax/issues/589), [#590](https://github.com/nathapp-io/nax/issues/590), [#591](https://github.com/nathapp-io/nax/issues/591), [#522](https://github.com/nathapp-io/nax/issues/522), [#541](https://github.com/nathapp-io/nax/issues/541), [#585](https://github.com/nathapp-io/nax/issues/585), [#593](https://github.com/nathapp-io/nax/issues/593)
