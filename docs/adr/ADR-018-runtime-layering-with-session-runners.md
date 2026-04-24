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
| 3 — Session topology & bookkeeping | `ISessionRunner` impls | new session topology, new per-session cross-cutting concern |
| 2 — Per-session lifecycle | `SessionManager.runInSession()` | lifecycle primitive (CREATED→RUNNING→COMPLETED/FAILED, bindHandle) — rarely changes |
| 1 — Per-call cross-cutting | `AgentManager.runAs()` | new per-call concern (permissions, cost, audit, fallback) |

Nine self-contained refactors, shipped in sequence.

1. **`NaxRuntime`** — single lifecycle container owning `AgentManager`, `SessionManager`, `ConfigLoader`, `CostTracker`, `PromptAuditor`, `PackageRegistry`, logger, signal. Replaces 3 orphan `createAgentManager` instantiations and threads through existing `PipelineContext`.
2. **`ConfigLoader` + `ConfigSelector` interface** — loader caches config in memory with a future hot-reload seam; named selectors (`reviewConfigSelector`, `planConfigSelector`, …) in one registry file declare each subsystem's config slice. Memoized per selector name.
3. **Cross-cutting in `AgentManager.runAs()`** — `resolvePermissions()`, cost tagging, audit, error wrapping, fallback all land method-local. Three `resolvePermissions()` calls in the ACP adapter delete.
4. **`Operation<I, O, C>` spec + `callOp()` helper** — typed shape for internal extensibility; each op declares its `ConfigSelector<C>`. `callOp()` routes `kind: "run"` ops through Layer 3, `kind: "complete"` ops straight to Layer 1.
5. **`ISessionRunner` family expands** — `SingleSessionRunner` (#596, already shipped) + `ThreeSessionRunner` (#596 Phase 2) + `DebateSessionRunner` (new, absorbs `src/debate/session.ts` mode dispatch). All three delegate to `SessionManager.runInSession()` so per-session bookkeeping lands once.
6. **`.plan()` / `.decompose()` leave the adapter** — become `Operation` specs under `src/operations/`. Adapter shrinks to `run` + `complete` permanently.
7. **`composeSections()` + typed `PromptSection` slots** — one helper, canonical `SLOT_ORDER`. Builders expose slot-specific methods; no middleware chain.
8. **Unified `RetryInput<TFailure, TResult>`** — five callers of `runSharedRectificationLoop` normalize on one shape. Progressive composition is a `buildPrompt(failure, previous)` callback, not middleware.
9. **CI lint + `SessionRole` tightening** — `process.cwd()` outside CLI banned; prompt builders' forbidden imports enforced; `SessionRole` admits `debate-${string}` / `plan-${number}`.

**Explicitly out of scope:** prompt caching / `cache_control`, third-party plugin composability for cross-cutting concerns, plugin operation registration API.

---

## 1. Four-layer architecture — the load-bearing insight

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4 — Operation semantic envelope                                │
│   callOp(ctx, op, input)                                             │
│     • slices config per op.config (ConfigSelector<C>)                │
│     • op.build → composeSections → join                              │
│     • op.parse                                                       │
│     • routes kind:"run" → Layer 3, kind:"complete" → Layer 1         │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                ┌──────────────────┴──────────────────┐
                ▼                                     ▼
┌──────────────────────────────────┐   ┌─────────────────────────────┐
│ Layer 3 — Session topology       │   │                             │
│   ISessionRunner implementations │   │                             │
│    • SingleSessionRunner (#596)  │   │                             │
│    • ThreeSessionRunner (TDD)    │   │                             │
│    • DebateSessionRunner         │   │                             │
│   owns "how many sessions, in    │   │                             │
│   what order, with what policy"  │   │                             │
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
│   land HERE, once                 │   │                             │
└──────────────────────────────────┘   │                             │
                │                      │                             │
                ▼                      ▼                             │
┌──────────────────────────────────────────────────────────────────┐ │
│ Layer 1 — Per-call cross-cutting                                 │ │
│   AgentManager.runAs / runWithFallback / completeAs              │ │
│     • resolvePermissions (once, pre-dispatch)                    │ │
│     • cost tag                                                   │ │
│     • prompt audit                                               │ │
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
  readonly costTracker: CostTracker;
  readonly promptAuditor: IPromptAuditor;
  readonly packages: PackageRegistry;
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
- `close()` is idempotent and cascades in explicit order: `signal.abort()` → `sessionManager.sweepAll()` → `promptAuditor.flush()` → `costTracker.drain()` → `agentManager.dispose()`.
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

**Why this closes #523:** one `AgentManager` per run, so a 401 on routing falls into the same fallback chain as execution. Cost events from rectification and debate proposers roll into one `CostTracker`.

---

## 3. `AgentManager.runAs()` — Layer 1 cross-cutting envelope

**Problem:** [src/agents/acp/adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593) calls `resolvePermissions()` three times. Cost tagging and audit are inconsistent across orphan call sites.

**Fix:** one place — `AgentManager.runAs()` (and siblings `completeAs()`, `runWithFallback()`):

```typescript
// src/agents/manager.ts — amend existing runAs()
async runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult> {
  const permissions = resolvePermissions(
    request.runOptions.config,
    request.runOptions.pipelineStage,
  );
  const logger = this._logger.child({
    storyId: request.runOptions.storyId,
    stage:   request.runOptions.pipelineStage,
    agent:   agentName,
  });
  const started = Date.now();

  try {
    const result = await this._dispatch(agentName, {
      ...request,
      runOptions: { ...request.runOptions, resolvedPermissions: permissions },
    });
    this._costTracker.record({
      agentName,
      stage: request.runOptions.pipelineStage,
      storyId: request.runOptions.storyId,
      tokens: result.tokenUsage,
      costUsd: result.estimatedCost,
      durationMs: Date.now() - started,
    });
    this._promptAuditor.record({ /* prompt hash, response hash, ... */ });
    return result;
  } catch (err) {
    this._costTracker.recordError({
      agentName, stage: request.runOptions.pipelineStage,
      errorCode: extractErrorCode(err), durationMs: Date.now() - started,
    });
    this._promptAuditor.recordError({ /* ... */ });
    throw wrapNaxError(err, { stage: request.runOptions.pipelineStage, agentName });
  }
}
```

**Adapter simplification:** the three `resolvePermissions()` calls delete. The adapter reads `request.runOptions.resolvedPermissions` (pre-resolved by the manager).

**Wire mapping stays in the adapter's folder.** No `IPermissionTranslatorRegistry`. When a second transport arrives, add `toWirePolicy(resolved)` to `AgentAdapter`.

**No middleware chain.** Method-local ordering is readable and testable. Extension via internal method branches or subscribers to `CostTracker` / `PromptAuditor`.

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
    readonly topology?: "single" | "three" | "debate";  // default "single"
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
  readonly packageDir: string;
  readonly storyId?: string;
  readonly agentName: string;
  readonly sessionOverride?: {
    readonly role?: SessionRole;
    readonly discriminator?: string | number;
  };
}
```

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

**4. `current()` is public but off-limits inside operations.**

Three legitimate uses of `configLoader.current()`:

- `AgentManager.runAs()` threading the full config into `AgentRunOptions` (session-handle derivation, adapter internals).
- CLI commands that display config (`nax config show`).
- Wave-1 bridge code while ops migrate to selectors.

Inside `src/operations/**` and inside prompt builders, `configLoader.current()` is a lint error. The sliced `ctx.config` (selector output) is the only allowed path. Enforced by the same forbidden-import pattern as the Prompt Builder Convention.

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
// src/operations/call.ts (new, ~70 lines)
export async function callOp<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): Promise<O> {
  // Config slicing goes through the loader — memoized per selector name.
  const slicedConfig = ctx.runtime.configLoader.select(normalizeSelector(op.config, op.name));
  const packageView  = ctx.runtime.packages.get(ctx.packageDir);
  const buildCtx: BuildContext<C> = { packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));
  const prompt   = join(sections);

  if (op.kind === "complete") {
    // Session-less path → straight to Layer 1
    const raw = await ctx.runtime.agentManager.completeAs(ctx.agentName, prompt, {
      jsonMode: op.jsonMode ?? false,
      pipelineStage: op.stage,
      config: ctx.runtime.configLoader.current(),
    });
    return op.parse(raw);
  }

  // kind:"run" → Layer 3 (ISessionRunner) → Layer 2 (runInSession) → Layer 1 (runAs)
  const runner = selectSessionRunner(op.session.topology ?? "single");
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

`callOp` is ~70 lines. It does not mint sessionIds, does not resolve permissions, does not wrap errors redundantly — those are Layer 2, Layer 1, and Layer 1 respectively.

### 4.4 Operation directory as discovery surface

```
src/operations/
├── types.ts             — Operation, RunOperation, CompleteOperation, ConfigSelector, ...
├── call.ts              — callOp() + resolveSlice + selectSessionRunner
├── index.ts             — barrel
├── plan.ts              — replaces AgentAdapter.plan()
├── decompose.ts         — replaces AgentAdapter.decompose()
├── rectify.ts           — per-attempt op used by runRetryLoop
├── classify-route.ts    — replaces routing LLM classifier
├── acceptance-generate.ts
├── acceptance-refine.ts
├── acceptance-diagnose.ts
├── acceptance-fix.ts
├── semantic-review.ts
├── adversarial-review.ts
├── write-test.ts        — TDD: test-writer op
├── implement.ts         — shared by single-session stage and ThreeSessionRunner
├── verify.ts            — TDD: verifier op
├── debate-propose.ts
├── debate-rebut.ts
├── debate-rank.ts
└── README.md            — standard shape, when to add a new op, migration checklist
```

`ls src/operations/` answers "what operations does nax have?" No hunting through subsystems.

---

## 5. `ISessionRunner` — Layer 3 bookkeeping surface

### 5.1 The interface (preserved from #596)

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
}

export interface SessionRunnerOutcome {
  readonly primaryResult: AgentResult;
  readonly fallbacks: readonly AgentResult[];  // for swap-metrics attribution
}
```

### 5.2 `SingleSessionRunner` (already shipped in #596)

One session per story. Migration from #596's code is the existing implementation at [src/session/runners/single-session-runner.ts](../../src/session/runners/single-session-runner.ts); signature aligns to the new `SessionRunnerContext` (swapping `_executionDeps`-shaped fields for `runtime`-sourced ones).

```typescript
export class SingleSessionRunner implements ISessionRunner {
  readonly name = "single-session";
  async run(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome> {
    const sessionId = deriveSessionId(ctx);     // via SessionManager factory
    const result = await ctx.runtime.sessionManager.runInSession(
      sessionId,
      async (options) => ctx.runtime.agentManager.runWithFallback(ctx.agentName, {
        runOptions: {
          prompt: ctx.prompt,
          workdir: ctx.packageDir,
          pipelineStage: ctx.op.stage,
          mode: ctx.op.mode,
          storyId: ctx.storyId,
          sessionRole: resolveSessionRole(ctx.op.session.role, ctx.sessionOverride),
          keepOpen: ctx.op.session.lifetime === "warm",
          config: ctx.runtime.config,
          ...options,
        },
      }),
      { sessionRole: ctx.op.session.role },
    );
    return { primaryResult: result.primary, fallbacks: result.fallbacks };
  }
}
```

### 5.3 `ThreeSessionRunner` (Phase 2 of #596 — NEW in this ADR's migration)

Three sessions — test-writer → implementer → verifier — each in its own session for isolation (ADR-007). Each session goes through `runInSession` so state transitions, bindHandle, token propagation, and future per-session concerns land once.

```typescript
export class ThreeSessionRunner implements ISessionRunner {
  readonly name = "three-session";
  async run(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome> {
    // TDD input carries sub-operation references; the runner sequences the three sessions.
    const input = ctx.op.input as TddInput;   // op.build produced a TDD composite

    const tests = await runOne(ctx, writeTest, input, "test-writer");
    const impl  = await runOne(ctx, implement, { ...input, tests }, "implementer");
    const vrf   = await runOne(ctx, verify,    { ...input, tests, impl }, "verifier");
    return { primaryResult: vrf.primary, fallbacks: [] };
  }
}
// runOne() invokes callOp with a session-override role, which routes back through
// SingleSessionRunner → runInSession. Bookkeeping applies uniformly per session.
```

**This is what closes #589, #590, #591 "by construction":** every runner that goes through `runInSession` inherits state transitions, token passthrough, and early protocolIds capture. Adding the seventh cross-cutting concern from #596's table requires editing `runInSession` once, not editing both `execution.ts` and `tdd/session-runner.ts`.

### 5.4 `DebateSessionRunner` — absorbs mode dispatch

Today [src/debate/session.ts:24-174](../../src/debate/session.ts#L24-L174) dispatches between `one-shot`, `stateful`, and `hybrid` modes. That dispatch moves into `DebateSessionRunner`. The runner owns topology; the ops own content.

| Mode | Topology | Used by |
|:---|:---|:---|
| `one-shot` | N × `complete()`, no sessions | review with `sessionMode: "one-shot"` |
| `stateful` | N debater sessions, warm across rounds | review with `sessionMode: "stateful"` |
| `hybrid` | N stateful debaters + reviewer-dialogue across rounds | plan stage; hybrid review |

```typescript
export class DebateSessionRunner implements ISessionRunner {
  readonly name = "debate-session";
  async run(ctx: SessionRunnerContext): Promise<SessionRunnerOutcome> {
    const input = ctx.op.input as DebateInput;
    switch (input.mode) {
      case "one-shot": return this.runOneShot(ctx, input);
      case "stateful": return this.runStateful(ctx, input);
      case "hybrid":   return this.runHybrid(ctx, input);
    }
  }
  // Each mode invokes callOp on debate-propose / debate-rebut / debate-rank with
  // sessionOverride: { role: "debate", discriminator: i } — derived sessionHandle
  // is the existing deterministic formula (computeAcpHandle).
}
```

Per-debater isolation: `Promise.allSettled` + per-debater `AbortController`. A 401 on debater 0 is visibly distinct from a 401 on debater 2 (Layer-1 audit tags each).

**`src/debate/session-*.ts` mode-specific files collapse into methods on the runner.** `_debateSessionDeps.createManager` is removed by the Wave-1 orphan consolidation.

### 5.5 Runner selection in `callOp()`

```typescript
function selectSessionRunner(topology: "single" | "three" | "debate"): ISessionRunner {
  switch (topology) {
    case "single": return new SingleSessionRunner();
    case "three":  return new ThreeSessionRunner();
    case "debate": return new DebateSessionRunner();
  }
}
```

Declared on the op as `session.topology`; defaults to `"single"`. Orchestrators that need finer control (e.g. the plan stage toggling debate on/off) invoke `callOp` with the appropriate op variant; they do not instantiate runners directly.

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

## 7. `composeSections()` + typed `PromptSection` slots

```typescript
// src/prompts/core/types.ts — extend existing type
export interface PromptSection {
  readonly id: string;
  readonly content: string;
  readonly overridable: boolean;
  readonly slot: SectionSlot;  // NEW
}

export type SectionSlot =
  | "constitution" | "role" | "context" | "static-rules" | "monorepo-hints"
  | "task" | "previous-attempts" | "examples" | "output-format";

export const SLOT_ORDER: readonly SectionSlot[] = [
  "constitution", "role", "context", "static-rules", "monorepo-hints",
  "task", "previous-attempts", "examples", "output-format",
];

// src/prompts/compose.ts (new, ~100 lines)
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

### 9.3 `PackageRegistry`

```typescript
// src/runtime/packages.ts (new, ~60 lines)
export interface PackageRegistry {
  all(): readonly PackageView[];
  get(packageDir: string): PackageView;
  repo(): PackageView;
}

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  readonly config: NaxConfig;                     // merged with .nax/mono/<pkg>/config.json
  readonly testPatterns: ResolvedTestPatterns;
  readonly language: DetectedLanguage;
  readonly framework: TestFramework | null;
}
```

Backed by existing detectors (`discoverWorkspacePackages`, `findPackageDir`, `detectLanguage`, `detectTestFramework`, `resolveTestFilePatterns`). Cache valid for runtime lifetime (config is frozen). Threaded into `ComposeInput`; closes #533–#536 plus the ≥5 additional sites.

---

## Architecture After ADR-018

```
NaxRuntime (per run / plan / standalone CLI invocation)
  ├─ configLoader: ConfigLoader               // NEW — current()/select(); future hot-reload seam
  ├─ workdir, projectDir, signal
  ├─ agentManager: IAgentManager              // Layer 1 envelope lives on runAs()/completeAs()
  ├─ sessionManager: ISessionManager          // Layer 2 primitive — runInSession() preserved (#596)
  ├─ costTracker: CostTracker                 // NEW — one per runtime
  ├─ promptAuditor: IPromptAuditor            // NEW — flushes on close()
  ├─ packages: PackageRegistry                // NEW — cached per-package views
  └─ logger: Logger

Config layer (src/config/)
  ├─ ConfigLoader — current() + select<C>(selector) memoized per selector.name
  └─ ConfigSelector<C> interface — named registry in selectors.ts
        reviewConfigSelector, planConfigSelector, rectifyConfigSelector, ...

Operations (Layer 4 — src/operations/)
  ├─ Operation<I, O, C> typed spec
  ├─ RunOperation adds { session: { role, lifetime, topology? } }
  ├─ CompleteOperation adds { jsonMode? }
  └─ callOp(ctx, op, input)
       ├─ slices config per op.config
       ├─ runs op.build → composeSections → join
       ├─ kind:"run"      → ISessionRunner → runInSession → runAs
       └─ kind:"complete" → completeAs directly

Session runners (Layer 3 — src/session/runners/)
  ├─ SingleSessionRunner    (#596)
  ├─ ThreeSessionRunner     (#596 Phase 2 — closes #589, #590 by construction)
  └─ DebateSessionRunner    (absorbs src/debate/session.ts mode dispatch)
     each delegates to SessionManager.runInSession per session

Session primitive (Layer 2)
  └─ SessionManager.runInSession(sessionId, runFn, options)
       • CREATED → RUNNING  •  runFn  •  bindHandle  •  COMPLETED/FAILED

Per-call cross-cutting (Layer 1)
  └─ AgentManager.runAs / .completeAs / .runWithFallback
       • resolvePermissions (once)  •  cost tag  •  audit  •  error wrap  •  fallback

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
| **Minimal concept surface** | ~10 new types (`NaxRuntime`, `ConfigLoader`, `ConfigSelector`, `Operation`, `RunOperation`, `CompleteOperation`, `CostTracker`, `RetryInput`, `ComposeInput`, `SessionRunnerContext`) vs ADR-014/015/016's ~24. |
| **Config dependency graph is one file** | `src/config/selectors.ts` lists every subsystem's slice as a named selector. Refactoring `config.*` surfaces every dependent via the compiler. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `NaxRuntime` owns 5+ services | Admission criteria documented: scope-bound lifecycle + ≥2 consumers. Revisit if field count >8. |
| Method-local envelope in `runAs()` | Extension via method branches or subscribers. Third-party mid-call interception explicitly out of scope. |
| `ISessionRunner` adds one layer vs raw `runAs()` | Required by #596. Without it, cross-cutting per-session concerns re-land twice. |
| Operations are internal — no plugin registration | Plugins extend via the existing 7 types. Revisit when a third-party concrete case surfaces. |
| `SectionSlot` enum constrains ordering | Canonical; non-canonical ordering requires amending `SLOT_ORDER` + review. |
| Migration spans 5 waves | Each wave ~1–2 days, independently shippable. Total ~1700 LOC vs ~3000 LOC for ADR-014/015/016. |

---

## Migration Plan

Five waves. Each independently shippable and revertible.

### Wave 1 — `NaxRuntime` + `ConfigLoader`/`ConfigSelector` + orphan consolidation

- Introduce `src/runtime/index.ts` (`NaxRuntime` + `createRuntime`).
- Introduce `src/config/loader-runtime.ts` (`ConfigLoader` + `createConfigLoader`) — §2.1.
- Introduce `src/config/selector.ts` (`ConfigSelector` interface, `pickSelector`, `reshapeSelector`) and `src/config/selectors.ts` (named registry) — §4.2.1. Seed with the selectors for operations migrated in Wave 3; add more as ops land.
- Introduce `CostTracker`, `PromptAuditor`, `PackageRegistry` as plain classes in `src/runtime/`.
- Move `createAgentManager` from `src/agents/index.ts:29` to `src/runtime/internal/`.
- Migrate the 3 real orphan instantiations to `createRuntime`; other sites swap `createManager` dep for `runtime`.
- Runner constructs runtime in `runSetupPhase()`, closes in `runCompletionPhase()`.
- Thread `ctx.runtime: NaxRuntime` through `PipelineContext`.
- **Introduce `Operation<I, O, C>` types + `callOp()` — delegate `kind:"run"` to the existing `SingleSessionRunner` (#596). `callOp` goes through `runtime.configLoader.select(op.config)`.**
- Prove on one op — `classifyRoute` (`kind: "complete"`, uses `routingConfigSelector`).
- **Exit criteria:** zero `createAgentManager` imports outside `src/runtime/`; `#523` reproducer green; one operation end-to-end through `callOp`; `ConfigLoader` memoization verified in unit tests.
- **Risk:** Low. Purely additive.

### Wave 2 — `runAs()` cross-cutting envelope + adapter simplification

- Amend `runAs()` / `completeAs()` / `runWithFallback()` to resolve permissions, tag cost, emit audit, wrap errors.
- Add `AgentRunOptions.resolvedPermissions?: ResolvedPermissions`.
- Delete three `resolvePermissions()` calls in [src/agents/acp/adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593).
- **Exit criteria:** zero `resolvePermissions()` calls inside the ACP adapter; `CostTracker.snapshot()` reflects all calls including nested.
- **Risk:** Low.

### Wave 3 — Extract operations + `ThreeSessionRunner` + `DebateSessionRunner`

- Migrate operation candidates (lowest blast radius first):
  1. `classifyRoute` — proved in Wave 1
  2. `acceptance-generate`, `acceptance-refine`, `acceptance-diagnose`, `acceptance-fix`
  3. `semantic-review`, `adversarial-review`
  4. `plan`, `decompose` (adapter-removal set)
  5. `rectify` (per-attempt op for Wave 4's `runRetryLoop`)
  6. `write-test`, `implement`, `verify` — **land `ThreeSessionRunner` here; closes #589, #590 by construction**
  7. `debate-propose`, `debate-rebut`, `debate-rank` — **land `DebateSessionRunner` here; `src/debate/session-*.ts` mode-specific files collapse into runner methods**
- Introduce `src/prompts/compose.ts` (`ComposeInput`, `composeSections`, `join`, slot helpers).
- Add `SectionSlot` + `SLOT_ORDER` to `src/prompts/core/types.ts`.
- Migrate builders to expose slot methods, in order:
  1. `rectifier-builder.ts` (720 → ~200 lines)
  2. `review-builder.ts`, `adversarial-review-builder.ts`
  3. `tdd-builder.ts`
  4. `acceptance-builder.ts`
  5. `debate-builder.ts`
  6. `plan-builder.ts`, `decompose-builder.ts`
  7. `one-shot-builder.ts`
- Update `nax plan` CLI and decompose callers to `callOp(...)`.
- Delete `AgentAdapter.plan()`, `AgentAdapter.decompose()`, `IAgentManager.planAs()`, `IAgentManager.decomposeAs()`.
- Add CI lint rule for forbidden imports in `src/prompts/builders/**`.
- **Exit criteria:** `AgentAdapter` has only `run` and `complete`; TDD goes through `ThreeSessionRunner`; debate goes through `DebateSessionRunner`; every runner delegates to `SessionManager.runInSession`; no builder imports `ContextBundle`/`loadConstitution`/`loadStaticRules`.
- **Risk:** Medium. Broad touch; each op + builder + runner migration lands independently.

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

### D. Agent middleware chain

**Rejected.** Method-local cross-cutting in `AgentManager.runAs()` solves the same problems without observer-vs-transformer invariants, per-middleware resilience rules, or chain ordering. If mid-call interception becomes concrete, a single extension callback on the manager method suffices.

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

**Rejected (per ADR-015 §F).** The three debate modes differ in topology details but share debater vocabulary, per-debater abort isolation, and ranking. One `DebateSessionRunner` with a mode parameter matches today's [src/debate/session.ts](../../src/debate/session.ts) dispatch. Splitting triples the surface without simplifying any call site.

---

## Open Questions

1. **`Operation.validate(input)` hook.** If pre-execution input validation proves repetitive, add `validate?: (input: I) => void | NaxError`. Leaning toward caller's responsibility (Zod at the boundary); revisit after Wave 3.

2. **Composite operations.** Expressible today as an op whose `build()` or caller invokes `callOp()` on sub-ops — no framework support. If a canonical pattern emerges (e.g. `review` as `semantic + adversarial`), add a thin `composite()` helper. Not a blocker.

3. **Runner selection override at call time.** `op.session.topology` declares the default; `CallContext` could grow a `topologyOverride` field for edge cases (e.g. a stage wants to force single-session debate for cost reasons). Not needed today; revisit on concrete request.

4. **Token budget enforcement.** Trivial once `CostTracker` exposes `currentTotal()`. `runRetryLoop`'s `verify` callback can return `{ success: false, reason: "budget-exhausted" }`.

5. **Session resume across runtime restarts.** A crashed run's `NaxRuntime` is gone; its persisted session descriptors can be reattached via `SessionManager.resume(descriptors)`. Inherits ADR-008's open question.

6. **CostTracker + PromptAuditor disk schema.** `.nax/audit/<runId>.jsonl` and `.nax/cost/<runId>.jsonl` formats. Specified in Wave 2 implementation.

7. **`nax ops list` introspection.** A CLI showing every registered `Operation` + its `config` slice — useful for config-refactor audits. Nice-to-have.

---

## References

- **Supersedes:** ADR-017 (Incremental Consolidation — amended here at §E)
- **Also superseded:** ADR-014 (RunScope and Middleware), ADR-015 (Operation Contract), ADR-016 (Prompt Composition and PackageView) — rejected in ADR-017; this ADR inherits those rejections
- **Preserved invariants from:** ADR-008 (session lifecycle), ADR-011 (SessionManager ownership), ADR-012 (AgentManager ownership), ADR-013 (SessionManager → AgentManager hierarchy), ADR-009 (test-file pattern SSOT)
- **Preserved architecture from:** [#596](https://github.com/nathapp-io/nax/pull/596) (`SessionManager.runInSession` + `ISessionRunner` Phase 1) — load-bearing; Phase 2 (`ThreeSessionRunner`) lands in Wave 3 of this ADR's migration
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (amended to 2-method surface in Wave 3)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention (tightened by Wave 3)
- `.claude/rules/monorepo-awareness.md` — rules made structural by Wave 5
- Issues: [#523](https://github.com/nathapp-io/nax/issues/523), [#533](https://github.com/nathapp-io/nax/issues/533)–[#536](https://github.com/nathapp-io/nax/issues/536), [#589](https://github.com/nathapp-io/nax/issues/589), [#590](https://github.com/nathapp-io/nax/issues/590), [#591](https://github.com/nathapp-io/nax/issues/591), [#522](https://github.com/nathapp-io/nax/issues/522), [#541](https://github.com/nathapp-io/nax/issues/541), [#585](https://github.com/nathapp-io/nax/issues/585), [#593](https://github.com/nathapp-io/nax/issues/593)
