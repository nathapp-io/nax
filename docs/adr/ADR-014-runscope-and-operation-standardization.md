# ADR-014: RunScope Composition, Operation Standardization, and Prompt Middleware

**Status:** Reject
**Date:** 2026-04-23
**Author:** William Khoo, Claude
**Extends:** ADR-013 (SessionManager → AgentManager Hierarchy); ADR-012 (AgentManager Ownership); ADR-011 (SessionManager Ownership); ADR-010 (Context Engine)
**Related:** #523 (fallback state divergence across orphan AgentManagers — unblocked by this ADR)

---

## Context

ADR-011, ADR-012, and ADR-013 established the hierarchy: `SessionManager.runInSession()` orchestrates `IAgentManager.run()` / `IAgentManager.complete()`, and adapter methods are manager-internal. That work resolved retry/fallback correctness for the execution path.

Five architectural problems remain, each visible today as either a concrete bug or as a repeated pattern that blocks extension:

### Problem 1 — Orphan AgentManager instances (#523)

`createAgentManager(config)` is called from **eight** locations outside the Runner's owned instance:

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

### Problem 2 — Operations have no standard shape

Every agent-using subsystem invents its own ceremony: logging, cost tagging, cancellation propagation, permission resolution, prompt audit, error wrapping. The result is ~20 lines of boilerplate per stage and drift in what gets captured. Plugins that want to add a new operation (a new review mode, a new analysis pass) must copy the boilerplate and hope they get it right.

### Problem 3 — Prompt composition is not uniform

`src/prompts/builders/` is the designated home for LLM prompt text (`forbidden-patterns.md` → Prompt Builder Convention), but how builders access context is ad-hoc:

- Some builders receive a `ContextBundle` as a parameter; some reach for a per-stage singleton.
- Constitution injection is hand-wired in ~5 builders, missing in others.
- `.claude/rules/*.md` content is spliced into prompts inconsistently.
- Prompt caching (Anthropic `cache_control`) is impossible because prompts are opaque strings — the stable prefix (role, constitution, context) cannot be separated from per-call tail (task, inputs).

### Problem 4 — Cross-cutting concerns are not composable

Cost aggregation, prompt audit, cancellation, permission resolution, and cancellation-on-abort are hand-wired at each call site. Adding a new concern (e.g. rate limiting across ops, response caching, token-budget enforcement) requires editing every call site. There is no interception point.

### Problem 5 — Monorepo awareness is convention, not structure

`monorepo-awareness.md` documents the contract: use `packageDir`, not `workdir`; route through `resolveTestFilePatterns()`, not inline regex; never `process.cwd()` outside CLI. Enforcement is by vigilance. Four active violations are tracked (#533, #534, #535, #536) and new code regresses against the rule regularly. The failure mode is silent: polyglot monorepos break with no error, falling back to TS-centric defaults.

### Problem 6 — `.plan()` and `.decompose()` conflate transport with domain

ADR-013 restricted `IAgentManager` to `run()` + `complete()`, but `AgentAdapter.plan()` and `AgentAdapter.decompose()` still exist as manager-internal methods. These are not transport primitives — `decompose` is 100% prompt composition (build prompt → `complete()` → parse JSON), and `plan` is `run()` with a mode/permissions option. Keeping them on the adapter forces every new agent to implement both, bloats the interface, and keeps prompt-building inside the adapter layer — a direct violation of the prompt-builder convention.

---

## Decision

We introduce four structural pieces, each extending ADR-013's foundation without contradicting it:

1. **RunScope** — composite lifecycle owner for one run / plan / ephemeral unit. Wraps SessionManager + AgentManager with scope-level services.
2. **Operation<I, O, C>** — standardized semantic call unit. Declarative `requires`. Invoked via `scope.invoke()`.
3. **Middleware chains** — one for agent calls (on the wrapped `IAgent`), one for prompt composition (on `IPromptBuilder` sections).
4. **PackageView** — per-package resolved config, test patterns, language, and framework. Bakes monorepo awareness into the operation context.

These changes preserve every ADR-013 invariant (adapter methods manager-internal, single `runInSession`, `ISessionRunner` for topology) and add the layer above.

---

### 1. RunScope

The composite owner for one logical execution unit. Exactly one `RunScope` per `nax run`, per `nax plan`, per standalone CLI invocation that touches agents.

```typescript
// src/runtime/scope.ts
export interface RunScope {
  readonly id: RunScopeId;
  readonly kind: "run" | "plan" | "ephemeral";
  readonly repoRoot: string;
  readonly parent?: RunScope;

  // Managers (ADR-011, ADR-012, ADR-013)
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;

  // Subsystems
  readonly contextEngine: IContextEngine;
  readonly promptComposer: IPromptComposer;
  readonly packages: PackageRegistry;

  // Services (scope-level, middleware-drained)
  readonly services: {
    readonly costAggregator: ICostAggregator;
    readonly promptAuditor: IPromptAuditor;
    readonly permissionResolver: IPermissionResolver;
    readonly logger: Logger;
  };

  // Per-package views — cached after first access
  forPackage(packageDir: string): PackageView;

  // Canonical operation entry point
  invoke<I, O, C>(op: Operation<I, O, C>, input: I, opts: InvokeOptions): Promise<O>;

  // Nested scope for rectification / debate proposers — inherits parent services
  child(label: string): RunScope;

  // Cleanup — cascades to sessions, flushes auditor, drains aggregator
  close(): Promise<void>;
}
```

**Ownership contract:**

- `RunScope` **owns** the lifecycle of `agentManager`, `sessionManager`, and the services. Constructed once, disposed once.
- Child scopes **inherit** their parent's `agentManager` (so fallback state and cost events aggregate upward) but get their own `logger` and optionally their own `sessionManager` view.
- `RunScope.close()` cascades: sessions close → services flush → agent manager disposes. Idempotent.

**Construction — single factory, not ad-hoc:**

```typescript
// src/runtime/scope-factory.ts
export interface IRunScopeFactory {
  forRun(config: NaxConfig, workdir: string, hooks: HookRegistry): Promise<RunScope>;
  forPlan(config: NaxConfig, workdir: string): Promise<RunScope>;
  forEphemeral(config: NaxConfig, workdir: string, label: string): Promise<RunScope>;
}
```

Every `createAgentManager(config)` call outside this factory becomes an error. The symbol is removed from the public barrel and relocated to `src/runtime/internal/` where only the factory may call it.

---

### 2. Operation<I, O, C> contract

The unit above ISessionRunner. Where ISessionRunner answers "how many sessions in what topology", Operation answers "what am I trying to accomplish semantically".

```typescript
// src/operations/types.ts
export interface Operation<I, O, C = NaxConfig> {
  readonly name: string;                    // "plan" | "decompose" | "review" | ...
  readonly requires: OperationRequires<C>;
  execute(ctx: OperationContext<C>, input: I): Promise<O>;
}

export interface OperationRequires<C> {
  readonly session: boolean;                // if true, scope provides ISession in ctx
  readonly scope: "package" | "cross-package" | "repo";
  readonly permissions: PipelineStage;      // drives resolvePermissions()
  readonly config: ConfigSelector<C>;       // narrows NaxConfig → C
}

export type ConfigSelector<C> = (config: NaxConfig) => C;

export interface OperationContext<C> {
  readonly scope: RunScope;
  readonly agent: IAgent;                   // already middleware-wrapped
  readonly session?: ISession;              // present iff requires.session
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly story?: UserStory;
  readonly repoRoot: string;
  readonly packageDir: string;              // required for package-scoped ops
  readonly packages?: PackageView[];        // present for cross-package ops
  readonly config: C;                       // pre-sliced by requires.config
  readonly testPatterns: ResolvedTestPatterns;
  readonly language: DetectedLanguage;
  readonly signal: AbortSignal;
  readonly logger: Logger;                  // pre-scoped { storyId, packageDir, op: name }
}
```

**Example operation (`plan`, formerly `AgentAdapter.plan`):**

```typescript
// src/operations/plan.ts
export const plan: Operation<PlanInput, PlanResult, PlanConfig> = {
  name: "plan",
  requires: {
    session: false,
    scope: "package",
    permissions: "plan",
    config: (c) => ({ debate: c.debate, planner: c.planner }),
  },
  async execute(ctx, input) {
    const prompt = await ctx.scope.promptComposer.compose(planBuilder, input, {
      stage: "plan",
      storyId: ctx.storyId,
      packageDir: ctx.packageDir,
    });
    const response = await ctx.agent.run(prompt, { mode: "plan" });
    return parsePlanResult(response);
  },
};

type PlanConfig = {
  debate: NaxConfig["debate"];
  planner: NaxConfig["planner"];
};
```

**Example operation (`decompose`, formerly `AgentAdapter.decompose`):**

```typescript
// src/operations/decompose.ts
export const decompose: Operation<DecomposeInput, DecomposeResult, DecomposeConfig> = {
  name: "decompose",
  requires: {
    session: false,
    scope: "repo",
    permissions: "decompose",
    config: (c) => ({ decomposer: c.decomposer }),
  },
  async execute(ctx, input) {
    const prompt = await ctx.scope.promptComposer.compose(decomposeBuilder, input, {
      stage: "decompose",
      packageDir: ctx.packageDir,
    });
    const response = await ctx.agent.complete(prompt, { jsonMode: true });
    return parseDecomposeResult(response);
  },
};
```

**Canonical call site:**

```typescript
const result = await scope.invoke(plan, input, {
  stage: "plan",
  storyId: story.id,
  packageDir,
});
```

**What `scope.invoke()` does** — the **envelope** that was previously hand-written at every call site:

1. Validate `opts` against `op.requires.scope` (package-scoped op with no `packageDir` → `NaxError`).
2. Resolve `PackageView` via `scope.forPackage(packageDir)`.
3. Slice config: `ctx.config = op.requires.config(packageView.config)`.
4. Resolve permissions: `resolvePermissions(packageView.config, op.requires.permissions)`.
5. If `op.requires.session`, create/reuse session via `scope.sessionManager`; otherwise get raw `IAgent` via `scope.agentManager`.
6. Apply middleware chain to the `IAgent`: permissions → audit → cost → cancellation → logging.
7. Build pre-scoped logger with `{ storyId, packageDir, op: op.name }`.
8. Emit `op.start` event, call `op.execute(ctx, input)`, emit `op.end` / `op.error`.
9. Wrap thrown errors as `NaxError` with `{ stage, operation, storyId, packageDir }` and `cause`.

#### 2.1 Operation granularity

When is a unit of work one operation versus several? The refactor exposes this question — today it's answered by "whatever file already exists". Going forward it needs a rule, because every operation splits the middleware envelope (separate audit entry, separate cost event, separate logger scope) and every compose incurs one extra `scope.invoke()` call.

**Split rule:** make it an independent operation when **any** of the following differ:

- prompt builder (role, task framing, output format)
- result type
- declared config slice
- the call can legitimately run in isolation (e.g. semantic-only review with adversarial disabled)

**Keep as one operation** when variants differ only in internal strategy — same prompt shape, same result, config picks the strategy at the bottom. Routing's keyword / LLM / plugin-chain classifiers are one `classifyRoute` operation; they produce the same `RouteResult` from the same inputs.

**Compose via a thin composite operation** that calls `scope.invoke()` on its parts. Never compose via a god-orchestrator class or by hardcoding sub-calls inside a single `execute()`. A composite operation is itself a normal `Operation<I, O, C>` and goes through the same envelope as its leaves.

**Split decisions across the codebase:**

| Today | After — operations | Topology (ADR-013) |
|:---|:---|:---|
| `review/` semantic + adversarial | `semanticReview`, `adversarialReview`, `review` (composite) | N/A (session-less) |
| `tdd/` writer + implementer + verifier | `writeTest`, `implement`, `verify` | `ThreeSessionRunner` invokes each in its session |
| `acceptance/` generate + refine + diagnose + fix | `generateAcceptance`, `refineAcceptance`, `diagnoseAcceptance`, `fixAcceptance` | `fixAcceptance` may use `SingleSessionRunner` |
| `debate/` one-shot + stateful + plan | `debateOneShot`, `debateStateful`, `debatePlan` | `DebateSessionRunner` for stateful variants |
| `routing/` keyword + LLM + plugin-chain | One `classifyRoute` op; strategies are internal | N/A |
| `verification/` rectification-loop | Not an operation — a **control-flow loop** that invokes `rectify` (or `autofix`) each iteration | N/A |

**Compositional pattern (worked example — review):**

```typescript
// src/operations/review.ts
export const review: Operation<ReviewInput, CombinedReviewResult, ReviewConfig> = {
  name: "review",
  requires: {
    session: false,
    scope: "package",
    permissions: "review",
    config: (c) => ({ review: c.review, debate: c.debate }),
  },
  async execute(ctx, input) {
    const invokeOpts = { stage: ctx.stage, storyId: ctx.storyId, packageDir: ctx.packageDir };
    const tasks: Promise<ReviewPart>[] = [];
    if (ctx.config.review.semantic.enabled)
      tasks.push(ctx.scope.invoke(semanticReview, input, invokeOpts));
    if (ctx.config.review.adversarial.enabled)
      tasks.push(ctx.scope.invoke(adversarialReview, input, invokeOpts));
    return mergeReviewResults(await Promise.all(tasks));
  },
};
```

Three properties this preserves:

- Each sub-operation gets its own middleware envelope. Audit logs, cost events, and logger scopes are per-leaf, not merged — so a 401 on `semanticReview` is visibly distinct from a 401 on `adversarialReview`.
- Composite operations are type-checked against the `Operation<I, O, C>` contract exactly like leaf ops. No special case in `scope.invoke()`.
- Stages may invoke either the composite or the leaves depending on whether they want pre-merged results or to control aggregation themselves (e.g. a review stage that short-circuits on any `adversarialReview` critical finding without waiting for `semanticReview`).

**Non-operations (reminder):** rectification loops, retry backoff, escalation tiers, and topology orchestration are **not** operations. They are control flow that invokes operations. The distinction matters because only operations carry the middleware envelope — loops and topologies do not. Putting a loop inside `execute()` is a smell; it means the middleware boundary is wrong.

---

### 3. Middleware chains

Two chains, composed at scope construction, identical in shape but applied at different layers.

#### 3.1 Agent middleware (transport layer)

Wraps every `IAgent` returned by `scope.agentManager` and every agent used inside a session. Intercepts `run()` and `complete()`.

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
  readonly operationName?: string;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
}
```

**Canonical chain order** (outermost first):

```
permissions  →  audit  →  cost  →  cancellation  →  logging  →  rawAgent
```

| Middleware | Concern |
|:---|:---|
| `permissions` | Resolve and apply permission mode from stage + config. Replaces hand-called `resolvePermissions()`. |
| `audit` | Capture prompt + response via `IPromptAuditor`. Records hashed previews, token usage. |
| `cost` | Emit `CostEvent` to `ICostAggregator` tagged with `{ op, stage, storyId, packageDir }`. |
| `cancellation` | Thread `signal` into adapter call; handle `AbortError` cleanly. |
| `logging` | Structured JSONL with `storyId` first (per `project-conventions.md`). |

Middleware is registered at scope construction and frozen for the scope's lifetime. New middleware (rate limiting, response caching, budget enforcement) slots in without touching call sites.

#### 3.2 Prompt middleware (composition layer)

Wraps every call to `scope.promptComposer.compose(builder, input, buildCtx)`. Phases: `pre-build`, `post-build`, `finalize`.

```typescript
// src/runtime/prompt-middleware.ts
export interface PromptMiddleware {
  readonly name: string;
  readonly phase: "pre-build" | "post-build" | "finalize";
  apply(ctx: PromptMiddlewareContext): Promise<void>;
}

export interface PromptMiddlewareContext {
  readonly buildCtx: PromptBuildContext;
  readonly sections: PromptSection[];      // mutable during post-build
  readonly operation?: string;
  readonly stage: PipelineStage;
  readonly scope: RunScope;
}
```

**Canonical middleware:**

| Name | Phase | Role |
|:---|:---|:---|
| `context-inject` | pre-build | Materialize `ContextBundle` from `scope.contextEngine`, make available to builder |
| `constitution-inject` | post-build | Prepend agent-type-specific constitution as `role` section |
| `static-rules-inject` | post-build | Append relevant `.claude/rules/*.md` content |
| `monorepo-hints` | post-build | Add `packageDir`, detected language, test framework as a section |
| `cache-markers` | finalize | Mark `cacheable: true` sections with Anthropic `cache_control` |
| `budget-truncate` | finalize | Truncate to configured token budget, log drops |

---

### 4. IPromptBuilder and composition

```typescript
// src/prompts/types.ts
export interface IPromptBuilder<I> {
  readonly name: string;
  readonly stage: PipelineStage;
  sections(input: I, ctx: PromptBuildContext): PromptSection[];
}

export interface PromptSection {
  readonly id: string;                     // "role" | "task" | "context" | "examples" | "output-format" | ...
  readonly order: number;                  // canonical: role=0, context=100, task=200, examples=300, output=400
  readonly content: string;
  readonly cacheable: boolean;             // stable across calls → Anthropic cache_control
}

export interface PromptBuildContext {
  readonly contextBundle?: ContextBundle;  // populated by context-inject middleware
  readonly constitution?: string;          // populated by constitution-inject middleware
  readonly staticRules?: string;           // populated by static-rules-inject middleware
  readonly story?: UserStory;
  readonly packageDir: string;
  readonly language: DetectedLanguage;
  readonly stage: PipelineStage;
  readonly storyId?: string;
}

export interface IPromptComposer {
  compose<I>(builder: IPromptBuilder<I>, input: I, opts: ComposeOptions): Promise<ComposedPrompt>;
}

export interface ComposedPrompt {
  readonly text: string;                   // final concatenated prompt
  readonly sections: PromptSection[];      // for debugging / audit
  readonly cacheableBoundary?: number;     // byte offset where cacheable prefix ends
}
```

**What changes for existing builders:**

Every builder in `src/prompts/builders/` converts from `build(input): string` to `sections(input, ctx): PromptSection[]`. Builders no longer import `ContextBundle`, constitution loaders, or static-rules loaders — those flow in via middleware. Builders author only operation-specific sections (`task`, `examples`, `output-format`, sometimes `previous-attempt` for retry ops).

**Why sections, not strings:**

- **Prompt caching becomes possible.** The `role` + `context` + `constitution` sections are stable across calls in a session — they can carry `cache_control`. The `task` section changes per call. Today, prompts are opaque strings and the boundary is invisible.
- **Composition is uniform.** Context injection happens exactly once, in middleware. Builders cannot forget or get it wrong.
- **Progressive injection is native.** Rectification retries add a `previous-attempt` section on each iteration via middleware; no hand-wired retry prompt stitching.

---

### 5. Config slicing

Every operation declares the config slice it needs. Scope narrows before calling `execute`.

```typescript
// ✅ Clear surface
const review: Operation<ReviewInput, ReviewResult, ReviewConfig> = {
  name: "review",
  requires: {
    session: false,
    scope: "package",
    permissions: "review",
    config: (c) => ({
      review: c.review,
      debate: { enabled: c.debate.enabled, stages: { review: c.debate.stages.review } },
    }),
  },
  async execute(ctx, input) {
    // ctx.config typed as ReviewConfig — ctx.config.autoMode is a compile error
  },
};
```

**Benefits:**

- Operation config surface is documented by the type signature. Review can see at a glance which fields an op reads.
- Testing: construct only the slice, not a full `NaxConfig` fixture.
- Future: cache-bust op-level caches when its slice changes, not on any config edit.
- Enforcement starts as convention (types guide), graduates to a lint rule: "operation accessed `ctx.scope.config.*` outside its declared slice" is a CI error.

The selector receives the **package-merged** config (from `PackageView`, §6), not raw `NaxConfig`. Per-package overrides flow through automatically.

---

### 6. Monorepo: PackageView and PackageRegistry

Bakes `monorepo-awareness.md` into the operation context by making per-package resolution the only way to reach config and test patterns within an operation.

```typescript
// src/runtime/packages.ts
export interface PackageRegistry {
  all(): PackageView[];                              // from discoverWorkspacePackages()
  findForFile(absPath: string): PackageView | null;  // wraps findPackageDir()
  get(packageDir: string): PackageView;              // cached, constructs on demand
}

export interface PackageView {
  readonly packageDir: string;                       // absolute
  readonly relativeFromRoot: string;                 // e.g. "packages/api"
  readonly config: NaxConfig;                        // merged with .nax/mono/<pkg>/config.json
  readonly testPatterns: ResolvedTestPatterns;       // from resolveTestFilePatterns()
  readonly language: DetectedLanguage;               // from detectLanguage()
  readonly framework: TestFramework | null;          // from detectTestFramework()
}
```

**What this closes:**

| Violation tracked in `monorepo-awareness.md` | Fix after this ADR |
|:---|:---|
| [#533](https://github.com/nathapp-io/nax/issues/533) — `COMMON_TEST_DIRS` in `test-scanner.ts` | Reads `ctx.testPatterns.testDirs` |
| [#534](https://github.com/nathapp-io/nax/issues/534) — hardcoded `test/unit/` in `smart-runner.ts` | Reads `ctx.testPatterns.globs` |
| [#535](https://github.com/nathapp-io/nax/issues/535) — `workdir \|\| process.cwd()` in `builder.ts` | Reads `ctx.packageDir` (required, no fallback) |
| [#536](https://github.com/nathapp-io/nax/issues/536) — `cmd.startsWith("bun test")` in `role-task.ts` | Reads `ctx.language` (typed enum) |

**Cross-package operations** declare `requires.scope: "cross-package"` and receive `ctx.packages: PackageView[]` instead of a single `packageDir`. `scope.invoke()` refuses to invoke a package-scoped op without a `packageDir` and vice versa — same type-level guard as `requires.session`.

---

### 7. CostAggregator

Single sink for cost events across the run. Drained by the `cost` agent middleware. Replaces the per-`AgentManager` internal counter, which is lost to orphan instances today.

```typescript
// src/runtime/cost-aggregator.ts
export interface ICostAggregator {
  record(event: CostEvent): void;
  snapshot(): CostSnapshot;                          // aggregate view
  byOperation(): Record<string, CostSnapshot>;       // per-op breakdown
  byPackage(): Record<string, CostSnapshot>;         // per-package breakdown
  byStory(): Record<string, CostSnapshot>;           // per-story breakdown
  drain(): Promise<void>;                            // flush to StoryMetrics on close
}

export interface CostEvent {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly agentName: string;
  readonly model: string;
  readonly operation?: string;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly costUsd: number;
  readonly durationMs: number;
}
```

Child scopes forward to parent: a rectification loop's costs bubble up to the parent run's aggregator so `StoryMetrics` sees the total, not just the top-level call.

---

### 8. IPromptAuditor

Separate service from SessionManager. Captures every prompt via agent middleware, so session-less calls (routing, decompose, refinement) are audited too.

**Explicitly rejected:** putting prompt audit on SessionManager. That would bypass session-less paths — the exact class of bug this ADR removes.

```typescript
// src/runtime/prompt-auditor.ts
export interface IPromptAuditor {
  record(entry: PromptAuditEntry): void;
  flush(): Promise<void>;                            // writes to .nax/audit/<runId>.jsonl
}

export interface PromptAuditEntry {
  readonly ts: number;
  readonly runId: RunScopeId;
  readonly operation?: string;
  readonly stage?: PipelineStage;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly agentName: string;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPreview: string;                    // first 500 chars
  readonly responseHash: string;
  readonly responsePreview: string;
  readonly tokens: { input: number; output: number };
  readonly durationMs: number;
  readonly sessionId?: string;                       // if session-ful
}
```

---

## Full Architecture After This ADR

```
RunScope (per run / plan / ephemeral)
  ├─ agentManager: IAgentManager                 // ADR-012, ADR-013 — run/complete only
  ├─ sessionManager: ISessionManager             // ADR-011, ADR-013 — single runInSession()
  ├─ contextEngine: IContextEngine               // ADR-010 — produces ContextBundle
  ├─ promptComposer: IPromptComposer             // NEW — composes IPromptBuilder sections
  ├─ packages: PackageRegistry                   // NEW — monorepo awareness
  ├─ services:
  │    ├─ costAggregator                         // NEW — drained by cost middleware
  │    ├─ promptAuditor                          // NEW — drained by audit middleware
  │    ├─ permissionResolver
  │    └─ logger
  ├─ forPackage(dir) → PackageView               // cached per-package view
  ├─ invoke<I,O,C>(op, input, opts) → O          // canonical operation entry
  ├─ child(label) → RunScope                     // nested scope, inherits services
  └─ close() → Promise<void>

Operation<I, O, C> (semantic unit)
  ├─ requires: { session, scope, permissions, config }
  └─ execute(ctx, input)
       where ctx: OperationContext<C> — middleware-wrapped agent, pre-sliced config,
                                         pre-resolved testPatterns/language, pre-scoped logger

ISessionRunner (topology unit, ADR-013)
  ├─ SingleSessionRunner                         // implement
  ├─ ThreeSessionRunner                          // tdd
  └─ DebateSessionRunner                         // debate
       all → sessionManager.runInSession() → agentManager.run()

Middleware chains
  ├─ Agent:   permissions → audit → cost → cancellation → logging → rawAgent
  └─ Prompt:  [pre-build: context-inject]
              [post-build: constitution-inject, static-rules-inject, monorepo-hints]
              [finalize: cache-markers, budget-truncate]

IAgent (ADR-013, unchanged)
  ├─ run(prompt, opts): Promise<AgentResult>     // streaming, tool-using
  └─ complete(prompt, opts): Promise<CompleteResult>  // one-shot
     — .plan() and .decompose() REMOVED (now operations)
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 unblocks** | `createAgentManager` removed from public barrel. One `AgentManager` per run. Fallback state survives across routing → execution → rectification → debate. |
| **Orphan-free by construction** | 8 orphan sites collapse to scope-owned access. `IAgent` can only be obtained via scope → guaranteed middleware-wrapped. |
| **Uniform cost attribution** | Every LLM call emits a `CostEvent` tagged with op/stage/story/package. `StoryMetrics` sees nested calls (rectification, debate proposers). Per-package cost reporting becomes possible. |
| **Uniform prompt audit** | Every LLM call — including session-less routing, decompose, refinement — is audited. Single JSONL per run. |
| **Operation extension is cheap** | Plugins export an `Operation<I, O, C>`. No adapter changes, no ceremony copy-paste. |
| **Prompt caching becomes possible** | Sections with `cacheable: true` carry Anthropic `cache_control` markers. Stable prefix (role, context, constitution) is cached across calls in a session; variable tail (task) is not. |
| **Monorepo is structural** | `process.cwd()`, inline test regex, and hardcoded `bun test` stop being convention violations and become type errors or missing context fields. The four tracked violations (#533–#536) collapse to one-line fixes. |
| **Adapter surface shrinks** | New agent implementations (codex, gemini, future) implement 2 methods (`run`, `complete`) instead of 4. `.plan()` and `.decompose()` move to operations. |
| **Testing simplifies** | Mock `IAgent` with 2 methods. Construct scope fixtures instead of threading individual mocks. Operation tests construct only the config slice the op declares. |
| **`nax plan` and Runner share scaffolding** | Both use `RunScopeFactory`. They differ only in which stages/operations they invoke, not in what they instantiate. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| Large refactor surface | Phased migration (see below). Each phase compiles and ships independently. |
| Every builder converts from `build(): string` to `sections(): PromptSection[]` | Mechanical. Builder's operation-specific sections stay unchanged; context/constitution/rules injection is removed. Net smaller builders. |
| Existing tests construct bare managers | Scope fixture (`makeTestScope(opts)`) covers 90% of cases. Tests that need isolated `AgentManager` can still construct via internal factory. |
| Scope-lifetime discipline required | `RunScope.close()` is idempotent and cascades. Linter rule: every scope construction must be followed by a `try/finally` close. |
| Plugin API change (`IReporter`, `IContextProvider`, etc.) | Plugins receive `RunScope` or narrow `PluginContext`. Versioned plugin API — accept `v1` (legacy fields) and `v2` (scope) during transition. |
| Middleware order is a new concept to reason about | Canonical order documented here; frozen at scope construction; cannot be reordered per-call. |

---

## Migration Plan

Six phases, each independently shippable. Each phase preserves all ADR-013 invariants.

### Phase 1 — RunScope shell (behavior-neutral)

- Introduce `src/runtime/scope.ts` with `RunScope` interface.
- `IRunScopeFactory.forRun()` wraps existing `AgentManager` + `SessionManager` + `PluginProviderCache` + `ContextOrchestrator`.
- `RunScope.invoke()` exists but is a thin pass-through (no middleware yet).
- Thread `scope: RunScope` through `PipelineContext` alongside existing fields. Stages opt-in.
- **Exit criteria:** Runner constructs scope; one stage migrated as proof.
- **Risk:** Low. No behavior change.

### Phase 2 — Agent middleware chain

- Implement `AgentMiddleware` interface.
- Move existing hand-wired concerns into middleware: permissions, logging, cost, cancellation.
- Wrap `IAgent` instances at scope construction.
- **Exit criteria:** Main execution path routes through the middleware chain; existing cost/audit behavior preserved.
- **Risk:** Medium. Middleware order bugs surface here.

### Phase 3 — CostAggregator and PromptAuditor

- Introduce `ICostAggregator` + `IPromptAuditor` as scope services.
- Wire `cost` and `audit` middleware to drain into them.
- `StoryMetrics` reads from `scope.services.costAggregator`.
- **Exit criteria:** Every LLM call in the run appears in `.nax/audit/<runId>.jsonl`; `StoryMetrics` cost totals match orphan-free ground truth.
- **Risk:** Low. Additive.

### Phase 4 — Operation contract + migrate leaf orphans

- Introduce `Operation<I, O, C>` types in `src/operations/types.ts`.
- `scope.invoke()` becomes the envelope (permissions + audit + cost + logging + error wrapping + session resolution).
- Migrate orphan call sites in this order (lowest blast radius first):
  1. `routing/router.ts` — becomes `scope.invoke(classifyRoute, input, opts)`
  2. `acceptance/refinement.ts`, `acceptance/generator.ts`
  3. `verification/rectification-loop.ts`
  4. `debate/session-helpers.ts`
  5. `review/semantic.ts`
- Delete `createAgentManager` from public barrel.
- **Exit criteria:** Zero `createAgentManager` imports outside `src/runtime/`. #523 verifiable: a 401 on routing activates the same fallback chain as execution.
- **Risk:** Medium. Each migration is mechanical but touches many files.

### Phase 5 — Remove `.plan()` and `.decompose()` from adapters

- Convert to `plan` and `decompose` operations in `src/operations/`.
- Adapter methods deleted. `AgentAdapter` has only `run()` and `complete()`.
- Migrate `nax plan` CLI to `RunScopeFactory.forPlan()` + `scope.invoke(plan, input, opts)`.
- **Exit criteria:** Adapter interface is 2 methods. `nax plan` shares scaffolding with Runner.
- **Risk:** Medium. `nax plan` is the largest single call site. Behavior parity required.

### Phase 6 — Prompt middleware + IPromptBuilder sections + PackageView enforcement

- Convert `src/prompts/builders/` to sections.
- Introduce `IPromptComposer` and prompt middleware.
- Introduce `PackageRegistry` + `PackageView`; `ctx.packageDir` becomes required in `OperationContext`.
- Close the four tracked monorepo violations (#533, #534, #535, #536).
- Enable Anthropic `cache_control` markers via `cache-markers` middleware.
- **Exit criteria:** No context/constitution/rules imports in `src/prompts/builders/`. Measurable prompt cache hit rate on main execution path.
- **Risk:** High. Broad touch. Split into sub-phases per builder if needed.

**Rollback plan:** every phase is gated behind the phase boundary — scope exists alongside legacy paths until Phase 4 removes the orphans. Any phase can revert independently without blocking forward phases on its content.

---

## Rejected Alternatives

### A. Make SessionManager fully own AgentManager

**Rejected.** SessionManager and AgentManager have different lifecycle scopes, and ~30% of agent calls are legitimately session-less (routing, pre-execution decompose, AC refinement). Forcing those through synthetic sessions is ceremony that produces exactly the kind of ad-hoc workarounds this ADR removes. The peer relationship (both owned by `RunScope`) is the correct model.

### B. Put prompt audit on SessionManager

**Rejected.** Would bypass session-less paths. Audit is cross-cutting; it belongs as middleware on the scope-owned `IAgent`, where no call can escape it. SessionManager stays focused on session lifecycle only.

### C. Free-function operations without `scope.invoke()` envelope

**Rejected.** Free functions (`plan(agent, input)`) solve the "remove from adapter" problem but leave every operation reinventing ceremony (logging, cost, cancellation, errors). The `scope.invoke()` envelope is what makes ceremony uniform. Operations stay thin — the envelope is hoisted.

### D. Operations as methods on a god `OperationRunner` class

**Rejected.** Relocates the current `AgentManager.plan()` / `.decompose()` bloat to a new class. Free `Operation<I, O, C>` values registered by the module system are more extensible and keep adapter-style growth off the runner.

### E. Context Engine injects into prompts directly, bypassing builders

**Rejected.** Loses the "all prompt text lives in `src/prompts/builders/`" invariant. Prompt middleware is the correct seam: context engine produces a `ContextBundle`; `context-inject` middleware materializes it into a `PromptSection`; builders never see the bundle directly.

### F. Keep `.plan()` and `.decompose()` on the adapter as "privileged internal operations"

**Rejected.** They are not transport primitives. `decompose` is 100% prompt composition; `plan` is `run()` with a mode option. Keeping them on the adapter forces every new agent to implement both, and pins prompt-building inside the adapter layer (a direct violation of the prompt-builder convention). Removing them shrinks the adapter interface to 2 methods, permanently.

---

## Open Questions

1. **Middleware reorder / opt-out per operation.** Should operations be able to declare "skip audit" or "reorder middleware" via `requires`? Default is no — middleware order is frozen at scope construction. Revisit if a concrete need surfaces.

2. **Plugin API versioning.** `IReporter`, `IContextProvider`, `IReviewPlugin` currently take loose refs. Proposed: expose narrow `PluginContext` views derived from `RunScope`, with `v1` legacy adapter during transition. Exact shape deferred to a follow-up ADR.

3. **Budget enforcement middleware.** Adding a `token-budget` middleware that hard-caps per-op spend is trivial once the chain exists. Not in scope for this ADR but explicitly enabled.

4. **Cross-scope cost roll-up for pipelined runs.** If `nax run` triggers a nested `nax plan` in future, should the plan scope's costs roll up into the parent run scope? Proposed default: yes, via `child()`. Flag if the user wants isolation.

5. **Session resume across scope restarts.** Scope lifecycle is per-invocation; session descriptors persist on disk. Resume semantics (a crashed run's scope is gone, but its sessions can be reattached) need a clear contract — likely "scope opens, discovers resumable descriptors via SessionManager, offers reattach." Deferred to ADR-008 follow-up.

---

## References

- ADR-008 — Session lifecycle
- ADR-010 — Context Engine
- ADR-011 — SessionManager ownership
- ADR-012 — AgentManager ownership
- ADR-013 — SessionManager → AgentManager hierarchy
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `.claude/rules/monorepo-awareness.md` — path/language rules this ADR makes structural
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention + Test-File Classification
- `docs/architecture/agent-adapters.md` — adapter protocol (unchanged by this ADR)
