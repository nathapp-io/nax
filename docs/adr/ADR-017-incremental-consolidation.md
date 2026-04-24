# ADR-017: Incremental Consolidation — NaxRuntime, Adapter Shrink, Prompt Composition Helper, Unified Retry

**Status:** Reviewing
**Date:** 2026-04-24
**Author:** William Khoo, Claude
**Supersedes:** ADR-014 (RunScope and Middleware), ADR-015 (Operation Contract), ADR-016 (Prompt Composition and PackageView)
**Extends:** ADR-011 (SessionManager Ownership), ADR-012 (AgentManager Ownership), ADR-013 (SessionManager → AgentManager Hierarchy), ADR-009 (Test-File Pattern SSOT), ADR-008 (Session Lifecycle)
**Related:** #523 (fallback state divergence across orphan AgentManagers), #533–#536 (monorepo awareness violations)

---

## Context

ADR-014/015/016 identified four real problems: orphan `AgentManager` instances, `.plan()`/`.decompose()` on the adapter, retry-loop input divergence, and hand-wired prompt composition. Each of those problems is real and verified in the code. The proposed solutions in that trio — `RunScope`, agent middleware, `Operation<I, O, C>`, `ISessionRunner`, `src/control/`, prompt middleware, `PackageRegistry` — collectively introduce 24+ new types across three new directories, defer the plugin extension surface three times, and sequence awkwardly across three interdependent ADRs.

A codebase review turned up six facts that reshape the solution space:

1. **`PromptSection` + `SectionAccumulator` already exist.** [src/prompts/core/types.ts:19](../../src/prompts/core/types.ts#L19) defines `PromptSection`; [src/prompts/core/section-accumulator.ts](../../src/prompts/core/section-accumulator.ts) composes in insertion order; [src/prompts/core/universal-sections.ts](../../src/prompts/core/universal-sections.ts) exports `universalConstitutionSection()` and `universalContextSection()`. Prompt composition is partially abstracted; the gap is that builders hand-wire which sections to include.

2. **A shared rectification driver already exists.** [src/verification/shared-rectification-loop.ts](../../src/verification/shared-rectification-loop.ts) is consumed by five callers; the divergence is in the input shape each caller passes, not in the driver.

3. **Orphan `AgentManager` count is 7, not 8.** `src/review/semantic.ts:35` listed in ADR-014 §Problem 1 does not call `createAgentManager`. The actual sites are `routing/router.ts:271`, `cli/plan.ts:61`, `debate/session-helpers.ts:83`, `verification/rectification-loop.ts:129`, `acceptance/refinement.ts:25`, `acceptance/generator.ts:75`, plus the canonical `execution/runner.ts:117`.

4. **`IAgent` does not exist.** [src/agents/types.ts](../../src/agents/types.ts) exposes `AgentAdapter` (transport); [src/agents/manager-types.ts](../../src/agents/manager-types.ts) exposes `IAgentManager` (fallback aggregator). Three different `getAgent()` methods already exist on the registry, the manager, and wrapper utilities.

5. **A plugin system with 7 extension types already exists.** [src/plugins/types.ts](../../src/plugins/types.ts): `optimizer`, `router`, `agent`, `reviewer`, `context-provider`, `reporter`, `post-run-action`. New extension concerns should join this list, not spawn a parallel registration surface.

6. **`process.cwd()` violations extend well beyond the 4 tracked issues.** Grep surfaces ≥5 additional sites in `debate/session.ts:44`, `acp/adapter.ts:884,895`, `precheck/index.ts:239`, `commands/common.ts:82,85,98`, plus hardcoded test patterns in `context/greenfield.ts:21-27`.

The common thread: **the codebase already contains the abstractions the ADR trio proposes to introduce**, in partial form. The right refactor extends existing abstractions rather than replacing them.

---

## Decision

Six self-contained refactors, shipped in sequence. Each closes a named pain point with existing code. No new top-level directory outside `src/runtime/` and `src/operations/`. No middleware chain. No `RunScope` composite. No `ISessionRunner`. No `scope.invoke()` envelope. No third-party plugin composability surface (explicitly out of scope).

1. **`NaxRuntime`** — single lifecycle container owning `AgentManager`, `SessionManager`, `CostTracker`, `PromptAuditor`, `PackageRegistry`, logger, signal. Threaded via existing `PipelineContext`. Replaces the 7 orphan `createAgentManager` call sites.

2. **Cross-cutting work in `AgentManager.runAs()`** — `resolvePermissions()`, cost tagging, audit, error wrapping become one method-local envelope in the manager. The ACP adapter's three `resolvePermissions()` calls collapse to zero.

3. **`Operation<I, O, C>` spec + `callOp()` helper — the standard shape for internal extensibility.** Every named agent-using operation (`plan`, `decompose`, `rectify`, `review`, new `plan-refine`, …) is a typed `Operation` value with declared `config` slice, session topology, prompt builder, and response parser. `callOp(ctx, op, input)` is the helper that runs it. Not a plugin API; an internal convention that makes adding new operations mechanical and type-checked.

4. **`.plan()` / `.decompose()` leave the adapter** — they become `Operation` specs under `src/operations/`. Adapter surface drops to `run` + `complete` (2 methods, permanently).

5. **`composeSections()` helper + typed `PromptSection` slots** — one helper function assembles sections in canonical order. Builders produce slot-specific sections (role, task, examples, output-format); the helper materializes context, constitution, static rules, monorepo hints, previous attempts. No middleware chain.

6. **Unified `RetryInput<TFailure, TResult>` shape** — five callers of `runSharedRectificationLoop` migrate to one input shape. Progressive composition (previous attempts feeding the next prompt) is a callback parameter, not a prompt-middleware concern.

Two cross-cutting enforcements land alongside:

7. **CI lint rules** — `process.cwd()` outside CLI entry points is an error; `src/prompts/builders/**` may not import context/constitution/rules readers. Enforces existing conventions from `.claude/rules/monorepo-awareness.md` and `.claude/rules/forbidden-patterns.md`.

8. **`SessionRole` tightens to a template-literal union** admitting `debate-${string}`, `plan-${number}` — retires ad-hoc string construction in `src/debate/`.

**Explicitly out of scope:** prompt caching / Anthropic `cache_control` (not prioritized today), third-party plugin composability for cross-cutting concerns (not needed — consolidation in `runAs()` is sufficient), plugin operation registration API (operations are internal; plugins extend via the existing 7 types).

---

### 1. `NaxRuntime` — single lifecycle container

```typescript
// src/runtime/index.ts (new, ~80 lines)
export interface NaxRuntime {
  readonly config: NaxConfig;
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

**Contract:**

- `createRuntime()` is the only public constructor for `AgentManager` and `SessionManager`. `createAgentManager` leaves the public barrel (`src/agents/index.ts:29`) and moves to `src/runtime/internal/agent-manager-factory.ts`.
- `close()` is idempotent and cascades: `signal.abort()` → `sessionManager.sweepAll()` → `promptAuditor.flush()` → `costTracker.drain()` → `agentManager.dispose()`. Order is explicit, not left to a service-drain loop.
- `signal` is a scope-internal `AbortController`; `opts.parentSignal` (e.g. CLI SIGINT) is linked in via `AbortSignal.any()`.
- `config` is frozen at construction. Configuration changes require a new runtime — there is no hot reload.
- `NaxRuntime` is threaded through existing `PipelineContext`. No new `ctx.scope` field; use `ctx.runtime`.

**Explicit non-goals compared to ADR-014's `RunScope`:**

- **No `getAgent(name)` method.** Callers use `runtime.agentManager.runAs(agentName, request)` or `runtime.agentManager.completeAs(agentName, prompt, opts)` — today's shape.
- **No `invoke(op, input, opts)` method.** Call sites are plain function calls; see §3.
- **No `services` sub-object.** Five fields at the top level (`costTracker`, `promptAuditor`, `packages`, `logger`, plus managers) — flat, readable.
- **No `child()` or nested runtime.** Per-call isolation (debate proposers, rectification attempts) is already expressed via per-call `signal`, `logger` overrides on `AgentRunOptions`.

**Orphan consolidation — mechanical migration:**

| Site | Today | After |
|:---|:---|:---|
| [src/routing/router.ts:271](../../src/routing/router.ts#L271) | `createManager: createAgentManager` | `_deps.runtime` threaded from caller |
| [src/cli/plan.ts:61](../../src/cli/plan.ts#L61) | `createManager: createAgentManager` | `const runtime = createRuntime(config, workdir)` in the CLI entry point |
| [src/debate/session-helpers.ts:83](../../src/debate/session-helpers.ts#L83) | `createManager: createAgentManager` | `_debateSessionDeps.runtime` |
| [src/verification/rectification-loop.ts:129](../../src/verification/rectification-loop.ts#L129) | `createManager: createAgentManager` | `_rectificationDeps.runtime` |
| [src/acceptance/refinement.ts:25](../../src/acceptance/refinement.ts#L25) | `createManager: (config) => createAgentManager(config)` | `_refinementDeps.runtime` |
| [src/acceptance/generator.ts:75](../../src/acceptance/generator.ts#L75) | `createManager: (config) => createAgentManager(config)` | `_generatorDeps.runtime` |
| [src/execution/runner.ts:117](../../src/execution/runner.ts#L117) | `const agentManager = createAgentManager(config)` | `const runtime = createRuntime(config, workdir)` |

**Why this works for #523:** one `AgentManager` per run, so routing's 401 falls into the same fallback chain execution uses. Cost events from rectification and debate proposers roll into one `CostTracker`. No new middleware required.

**Existing `_deps` pattern preserved.** The codebase's DI convention ([src/pipeline/stages/rectify.ts:126](../../src/pipeline/stages/rectify.ts#L126), `_unifiedExecutorDeps`, etc.) continues — the single change is that each `createManager` field becomes `runtime`.

---

### 2. `AgentManager.runAs()` becomes the cross-cutting envelope

**Problem:** the ACP adapter calls `resolvePermissions()` three times — [adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593). Every orphan call site tags costs and logs differently. Prompt audit is inconsistent across session-less calls.

**Fix:** one place where cross-cutting work happens — `AgentManager.runAs()` and its sibling `completeAs()`:

```typescript
// src/agents/manager.ts — amend existing runAs()
async runAs(agentName: string, request: AgentRunRequest): Promise<AgentResult> {
  const permissions = resolvePermissions(request.runOptions.config, request.runOptions.pipelineStage);
  const logger = this._logger.child({
    storyId: request.runOptions.storyId,
    stage: request.runOptions.pipelineStage,
    agent: agentName,
  });
  const started = Date.now();

  try {
    const result = await this._dispatch(agentName, {
      ...request,
      runOptions: {
        ...request.runOptions,
        resolvedPermissions: permissions,  // adapter reads this, no longer resolves itself
      },
    });

    this._costTracker.record({
      agentName,
      stage: request.runOptions.pipelineStage,
      storyId: request.runOptions.storyId,
      tokens: result.tokenUsage,
      costUsd: result.estimatedCost,
      durationMs: Date.now() - started,
    });
    this._promptAuditor.record({ /* prompt hash, response hash, etc. */ });

    return result;
  } catch (err) {
    this._costTracker.recordError({
      agentName,
      stage: request.runOptions.pipelineStage,
      errorCode: extractErrorCode(err),
      durationMs: Date.now() - started,
    });
    this._promptAuditor.recordError({ /* ... */ });
    throw wrapNaxError(err, { stage: request.runOptions.pipelineStage, agentName });
  }
}
```

**Adapter simplification:** the three `resolvePermissions()` calls at [adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593) delete. The adapter reads `request.runOptions.resolvedPermissions` (pre-resolved by the manager). `AgentRunOptions.resolvedPermissions?: ResolvedPermissions` is added; `AgentRunOptions.pipelineStage` stays (still used for audit/log correlation).

**ACP wire mapping stays where it already is.** Today, `resolvePermissions()` returns `{ mode: "approve-all" | "approve-reads" | "default", skipPermissions, allowedTools? }` — ACP's wire shape. Future second-transport integration adds a `toWirePolicy(resolved): W` method to the `AgentAdapter` interface; no registry needed until there is more than one transport. (Rejected Alternatives §B.)

**Why no middleware chain:**

- Method-local ordering is readable and testable. A three-line try-catch with cost-on-success and cost-on-error is easier to reason about than a middleware chain with observer-only invariants.
- No chain ordering questions. No per-middleware resilience rules. No "transformer vs observer" tax.
- Testing: `_agentManagerDeps.costTracker = mockTracker` via existing DI.
- Extension: budget enforcement, rate limiting, etc. add as method branches or as subscribers to `CostTracker` / `PromptAuditor`. Nobody has asked for mid-call interception.

---

### 3. `Operation<I, O, C>` spec + `callOp()` helper — the standard shape

**Problem:** every agent-using subsystem reinvents its own ceremony on top of `AgentManager.runAs()`: compose prompt, wire stage/mode/session, tag storyId, thread config, parse output. Adding a new operation like `plan-refine` today is "copy-paste from `plan`, pray" — there's no type-enforced convention, and `config: NaxConfig` is passed around without any declaration of which fields the op actually uses.

**Fix:** declare each operation as a typed `Operation<I, O, C>` value. The generic parameter `C` is the **declared config slice** — an op reading `config.rectification` must declare it in `config: ["rectification"]`, or the compiler rejects the access.

```typescript
// src/operations/types.ts (new)
export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C>;

interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C>;                          // declared slice — see §3.1
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string) => O;
}

export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  readonly mode?: string;                                      // agent mode ("plan" | "implement" | ...)
  readonly session: {
    readonly role: SessionRole;
    readonly lifetime: "fresh" | "warm";                       // "warm" = keepOpen: true
  };
}

export interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
  readonly jsonMode?: boolean;
}

export interface BuildContext<C> {
  readonly packageView: PackageView;
  readonly config: C;                                          // pre-sliced, typed to the declared slice
}

export interface CallContext {
  readonly runtime: NaxRuntime;
  readonly packageDir: string;
  readonly storyId?: string;
  readonly agentName: string;
  readonly sessionOverride?: {                                 // optional — used by debate/plan orchestrators
    readonly role?: SessionRole;
    readonly discriminator?: string | number;                  // appended to role: "plan-0", "debate-proposal-1"
  };
}
```

#### 3.1 `ConfigSelector<C>` — declaring config dependency

Two equivalent forms. The keyof-array form is sugar for the 95% case that just picks top-level keys:

```typescript
export type ConfigSelector<C> =
  | ((config: NaxConfig) => C)
  | readonly (keyof NaxConfig)[];

// ✅ Sugar — select top-level keys. Type of ctx.config is Pick<NaxConfig, "review" | "debate">.
config: ["review", "debate"]

// ✅ Selector — reshape or narrow nested fields. Type of ctx.config is the return type.
config: (c) => ({
  review: c.review,
  debateReview: c.debate.stages.review,
})
```

**What this buys:**

- **Dependency graph.** Grepping `config.rectification` shows exactly which operations declare it. No silent drift.
- **Refactor safety.** Renaming `config.rectification.maxRetries` breaks only ops that declare `["rectification"]` — the compiler identifies them.
- **Test fixture shrink.** Each operation tests with its declared slice (~3 fields), not a full `NaxConfig`.

Enforcement: operations reading `ctx.config.*` outside their declared slice is a type error. Runtime slicing inside `callOp()` uses the same selector.

#### 3.2 `callOp()` — the thin helper

```typescript
// src/operations/call.ts (new, ~50 lines)
export async function callOp<I, O, C>(
  ctx: CallContext,
  op: Operation<I, O, C>,
  input: I,
): Promise<O> {
  const slicedConfig = resolveSlice(op.config, ctx.runtime.config);
  const packageView  = ctx.runtime.packages.get(ctx.packageDir);
  const buildCtx: BuildContext<C> = { packageView, config: slicedConfig };
  const sections = composeSections(op.build(input, buildCtx));

  if (op.kind === "run") {
    const sessionRole = resolveSessionRole(op.session.role, ctx.sessionOverride);
    const result = await ctx.runtime.agentManager.runAs(ctx.agentName, {
      runOptions: {
        prompt: join(sections),
        workdir: ctx.packageDir,
        pipelineStage: op.stage,
        mode: op.mode,
        config: ctx.runtime.config,
        storyId: ctx.storyId,
        sessionRole,
        keepOpen: op.session.lifetime === "warm",
      },
    });
    return op.parse(result.output);
  }

  const response = await ctx.runtime.agentManager.completeAs(ctx.agentName, join(sections), {
    jsonMode: op.jsonMode ?? false,
    pipelineStage: op.stage,
    config: ctx.runtime.config,
  });
  return op.parse(response);
}
```

**What `callOp` does NOT do** (compared to ADR-015's `scope.invoke()`):

- Does not resolve permissions — `AgentManager.runAs()` owns that (§2).
- Does not build a god `OperationContext<C>` — just a 2-field `BuildContext<C>`.
- Does not validate `requires.scope` (no such field — package-scoped is the default; rare repo-scoped ops handle this themselves).
- Does not wrap errors — propagates `AgentManager.runAs()`'s wrapped errors as-is.
- Does not mint sessionIds — `SessionManager` + `computeAcpHandle` still own that per ADR-011/ADR-008.

`callOp` is a helper, not an envelope. ~50 lines. One file.

#### 3.3 Adding `plan-refine` — your P2 example in full

```typescript
// src/operations/plan-refine.ts (new, ~30 lines including types)
export interface PlanRefineInput {
  readonly story: UserStory;
  readonly previousPlan: PlanResult;
  readonly feedback: string;
  readonly previousTs: number;
}

export const planRefine: RunOperation<PlanRefineInput, PlanResult, Pick<NaxConfig, "planner" | "debate">> = {
  kind: "run",
  name: "plan-refine",
  stage: "plan",
  mode: "plan",
  session: { role: "plan", lifetime: "warm" },                 // reuses the plan session
  config: ["planner", "debate"],
  build: (input, ctx) => ({
    role: planBuilder.refineRole(input.story),
    task: planBuilder.refineTask(input, ctx.config.planner.refinementDepth),
    previousAttempts: [{ result: input.previousPlan, ts: input.previousTs, verification: { success: false, reason: input.feedback } }],
    packageView: ctx.packageView,
    outputFormat: planBuilder.outputFormat(),
  }),
  parse: planBuilder.parse,
};

// Call site (inside the plan stage or an orchestrator):
const refined = await callOp(
  { runtime, packageDir, storyId, agentName },
  planRefine,
  { story, previousPlan, feedback, previousTs },
);
```

That's the whole "add a new operation" workflow. One file under `src/operations/`, one call site. The type checker enforces: stage set, session declared, config declared, `build` returns `ComposeInput`, `parse` typed to the result. If the author tries to access `ctx.config.rectification` from inside `build`, the compiler says no.

#### 3.4 Operation directory as discovery surface

```
src/operations/
├── types.ts                  — Operation, RunOperation, CompleteOperation, ConfigSelector, CallContext
├── call.ts                   — callOp() helper + resolveSlice + resolveSessionRole
├── index.ts                  — barrel
├── plan.ts                   — replaces AgentAdapter.plan()
├── plan-refine.ts            — NEW
├── decompose.ts              — replaces AgentAdapter.decompose()
├── rectify.ts                — per-attempt op used by runRetryLoop (§6)
├── classify-route.ts         — replaces routing/router.ts LLM classifier
├── acceptance-generate.ts
├── acceptance-refine.ts
├── acceptance-diagnose.ts
├── acceptance-fix.ts
├── semantic-review.ts
├── adversarial-review.ts
├── debate-propose.ts
├── debate-rebut.ts
├── debate-rank.ts
└── README.md                 — the standard shape, when to add a new op, migration checklist
```

`ls src/operations/` is the "what operations does nax have?" answer. No hunting through pipeline stages and subsystems.

#### 3.5 What this rejects from ADR-015

- `requires: { session, scope, permissions, config }` object — flattened onto the op (no wrapper), `scope` field dropped entirely, `permissions` derived from `stage`.
- `scope.invoke(op, input, opts)` 9-step envelope — replaced by `callOp()` helper; cross-cutting stays in `runAs()`.
- `OperationContext<C>` 13-field god context — replaced by `BuildContext<C>` (2 fields) + `CallContext` (4 fields + optional override).
- Composite operations as first-class — a composite is just an op whose `build` or caller invokes `callOp()` on sub-ops. No special case in `callOp` itself.
- Session-minting inside `invoke()` — preserved in `SessionManager` + `computeAcpHandle`.

What remains of ADR-015: **the typed shape** (name, stage, config, build, parse) and **`ConfigSelector<C>`**. Those are load-bearing for internal extensibility; everything else was ceremony.

---

### 4. `.plan()` / `.decompose()` off the adapter → `Operation` specs

**Problem:** [src/agents/types.ts:322,325](../../src/agents/types.ts#L322) — `AgentAdapter.plan()` and `.decompose()` are prompt-composition-plus-one-call. Every new agent implements 4 methods. Prompt-building is pinned to the adapter layer, violating the Prompt Builder Convention.

**Fix:** they become `Operation` specs under `src/operations/`, using the shape from §3.

```typescript
// src/operations/plan.ts (replaces AgentAdapter.plan)
export const plan: RunOperation<PlanInput, PlanResult, Pick<NaxConfig, "planner" | "debate">> = {
  kind: "run",
  name: "plan",
  stage: "plan",
  mode: "plan",
  session: { role: "plan", lifetime: "fresh" },
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

// src/operations/decompose.ts (replaces AgentAdapter.decompose)
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

**Migration:**

1. Copy `adapter.plan()` body into `plan.build()` + `plan.parse()`.
2. Copy `adapter.decompose()` body into `decompose.build()` + `decompose.parse()`.
3. Update `nax plan` CLI ([src/cli/plan.ts](../../src/cli/plan.ts)) to call `callOp({ runtime, packageDir, storyId, agentName }, plan, input)`.
4. Update decompose callers ([src/commands/decompose.ts](../../src/commands/decompose.ts), batch routing) to call `callOp({ runtime, packageDir: ROOT, agentName }, decompose, input)`.
5. Delete `AgentAdapter.plan()` and `AgentAdapter.decompose()` from [src/agents/types.ts:322,325](../../src/agents/types.ts#L322).
6. Delete `IAgentManager.planAs()` and `IAgentManager.decomposeAs()` from [src/agents/manager-types.ts](../../src/agents/manager-types.ts).
7. Update `IAgentManager.plan()` and `.decompose()` to throw a deprecation `NaxError` with a one-release window, then delete.

**Final adapter surface:** `run(options)` and `complete(prompt, options)` — 2 methods, permanently.

---

### 5. `composeSections()` helper + typed `PromptSection` slots

**Problem:** builders today each hand-wire which of (constitution, context, static rules, role, task, examples, output format) to include. [rectifier-builder.ts](../../src/prompts/builders/rectifier-builder.ts) is 720 lines partly because of this drift. Progressive composition (previous attempts feeding the next prompt) has no primitive.

**Fix:** keep `PromptSection` as it is today; add one helper function:

```typescript
// src/prompts/core/types.ts — extend existing type
export interface PromptSection {
  readonly id: string;
  readonly content: string;
  readonly overridable: boolean;
  readonly slot: SectionSlot;  // NEW — canonical position
}

export type SectionSlot =
  | "constitution"
  | "role"
  | "context"
  | "static-rules"
  | "monorepo-hints"
  | "task"
  | "previous-attempts"
  | "examples"
  | "output-format";

// Canonical slot order — the single source of truth for section ordering.
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

export function composeSections(input: ComposeInput): readonly PromptSection[] {
  const sections: PromptSection[] = [];
  if (input.constitution) sections.push(universalConstitutionSection(input.constitution));
  sections.push(input.role);
  if (input.context)       sections.push(universalContextSection(renderContext(input.context)));
  if (input.staticRules?.length) sections.push(renderStaticRulesSection(input.staticRules));
  sections.push(packageHintsSection(input.packageView));
  sections.push(input.task);
  if (input.previousAttempts?.length) sections.push(previousAttemptsSection(input.previousAttempts));
  if (input.examples)     sections.push(input.examples);
  if (input.outputFormat) sections.push(input.outputFormat);

  return sortBySlot(sections, SLOT_ORDER);
}

export function join(sections: readonly PromptSection[]): string {
  return sections.filter((s) => s.content.length > 0).map((s) => s.content).join(SECTION_SEP);
}
```

**Builder simplification:** each builder exposes slot-specific methods (`role(input) → PromptSection`, `task(input) → PromptSection`, etc.) and leaves composition to `composeSections()`. The rectifier builder drops from 720 lines to ~200.

**Progressive composition:** `RetryInput.previousAttempts` (§5) flows through `ComposeInput.previousAttempts` — materialized by `previousAttemptsSection()`. No middleware required.

**CI-enforced forbidden imports inside `src/prompts/builders/**`:**

| Forbidden | Module | Why |
|:---|:---|:---|
| `ContextBundle`, `IContextEngine` | `src/context` | Context enters via `ComposeInput.context` only |
| `loadConstitution`, `Constitution` | `src/constitution` | Constitution enters via `ComposeInput.constitution` only |
| `loadStaticRules` | `src/rules` | Static rules enter via `ComposeInput.staticRules` only |
| `process.cwd`, `detectLanguage`, `resolveTestFilePatterns` | globals / detectors | Monorepo data enters via `ComposeInput.packageView` only |

Violations are CI errors, not warnings.

**Why no middleware chain:**

- `composeSections()` is a total function: inputs → ordered sections. No ordering registry, no "who owns what" conflict errors at runtime.
- Section ordering is a `const readonly` array — the single source of truth, greppable.
- Testing: builders test with fixed `ComposeInput`; `composeSections()` tests order. No middleware chain fixtures.
- Operation-specific prompt augmentations live in the op's `build()` body where they belong — e.g. `rectify` injects `previousAttempts`, debate ops add a `debaters` summary to `task`. Nothing cross-cutting across operations.

---

### 6. Unified `RetryInput<TFailure, TResult>` for the rectification driver

**Problem:** [shared-rectification-loop.ts](../../src/verification/shared-rectification-loop.ts) already exists as a shared driver. The divergence is in what each caller hands in — `buildPrompt`, `canContinue`, per-stage state shapes.

**Fix:** standardize the input; keep the driver.

```typescript
// src/verification/shared-rectification-loop.ts — amend existing exports
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

export interface RetryAttempt<TResult> {
  readonly result: TResult;
  readonly verification: VerifyOutcome<unknown>;
  readonly ts: number;
}

export type VerifyOutcome<TFailure> =
  | { readonly success: true }
  | { readonly success: false; readonly reason: string; readonly remaining?: TFailure };

export interface RetryOutcome<TResult> {
  readonly outcome: "fixed" | "exhausted";
  readonly attempts: readonly RetryAttempt<TResult>[];
  readonly finalResult?: TResult;
}

export async function runRetryLoop<TFailure, TResult>(
  input: RetryInput<TFailure, TResult>,
): Promise<RetryOutcome<TResult>>;
```

**Migration — the 5 callers:**

| Caller | Today | After |
|:---|:---|:---|
| [src/verification/rectification-loop.ts:136](../../src/verification/rectification-loop.ts#L136) | `runRectificationLoop(...)` wraps shared driver w/ escalation | `runRetryLoop<TestFailure, RectifyResult>({...})` + escalation remains in caller |
| [src/tdd/rectification-gate.ts:199](../../src/tdd/rectification-gate.ts#L199) | local `runRectificationLoop` wrapper | deletes; calls `runRetryLoop` directly |
| [src/pipeline/stages/autofix.ts:34](../../src/pipeline/stages/autofix.ts#L34) | direct import | `runRetryLoop<ReviewFindings, AutofixResult>({...})` |
| [src/pipeline/stages/rectify.ts:72](../../src/pipeline/stages/rectify.ts#L72) | uses `runRectificationLoopFromCtx` | calls `runRetryLoop` directly; `runRectificationLoopFromCtx` retires |
| [src/execution/lifecycle/run-regression.ts:277](../../src/execution/lifecycle/run-regression.ts#L277) | direct import | `runRetryLoop<RegressionFailure, RegressionResult>({...})` |

**Progressive composition:** the `buildPrompt(failure, previous)` callback is the single place where "previous attempts" are rendered into the next prompt. Callers use `composeSections({ ..., previousAttempts: previous })` inside `buildPrompt`. No separate mechanism.

**Escalation stays where it is.** `src/execution/escalation/` is unchanged; it runs between stage retries (outside the retry loop), not inside. The layering is:

```
Stage invocation (e.g. src/pipeline/stages/implement.ts)
  │
  ├─ on failure → runRetryLoop (same tier, N attempts via buildPrompt+execute+verify)
  │               returns { outcome: "fixed" | "exhausted" }
  │
  └─ on "exhausted" → escalation module decides next-tier action
                       escalation mutates story.modelTier; runner re-invokes stage
```

No `src/control/` directory. Escalation and retry live where they are today; only their I/O shapes normalize.

---

### 7. CI lint rules

Two lint rules enforced at `bun run lint`:

**Rule A — `process.cwd()` outside CLI entry points is an error.**

- Permitted paths: `src/cli/**`, `src/commands/**`, `src/config/loader.ts` (bootstrap default).
- Banned everywhere else, including `src/debate/session.ts:44`, `src/agents/acp/adapter.ts:884,895`, `src/precheck/index.ts:239`.
- Fix in each site: require `workdir: string` as a parameter. Thread from `NaxRuntime.workdir` or `ctx.packageDir`.

**Rule B — prompt builders' forbidden imports.**

- `src/prompts/builders/**` may not import `ContextBundle`, `IContextEngine`, `loadConstitution`, `loadStaticRules`, `detectLanguage`, `resolveTestFilePatterns`, `process.cwd`, `Bun.cwd`.
- Fix: add the field to `ComposeInput`; consume through the helper only.

---

### 8. `SessionRole` tightens to a template-literal union

```typescript
// src/session/types.ts — amend existing union
export type SessionRole =
  | "main" | "test-writer" | "implementer" | "verifier"
  | "plan" | "decompose" | "acceptance-gen" | "refine" | "fix-gen"
  | "auto" | "diagnose" | "source-fix"
  | "reviewer-semantic" | "reviewer-adversarial"
  // Dynamic roles — admitted via template literals
  | `debate-${string}`          // debate-proposal-0, debate-critique-1, debate-fallback
  | `plan-${number}`;           // plan-0, plan-1, ...
```

And tighten `AgentRunOptions.sessionRole?: string` to `AgentRunOptions.sessionRole?: SessionRole`. Debate files ([session-one-shot.ts:85,159,209](../../src/debate/session-one-shot.ts#L85), [session-plan.ts:102](../../src/debate/session-plan.ts#L102), [session-helpers.ts:329,374](../../src/debate/session-helpers.ts#L329)) continue to construct strings inline — but now they're type-checked against the union. Introduce `deriveSessionRole()` helpers where the inline construction is noisy (e.g. `deriveDebateRole({ kind: "proposal", index: i })`).

---

### 9. `PackageRegistry` — thin per-package cache

`NaxRuntime.packages` is a minimal cache:

```typescript
// src/runtime/packages.ts (new, ~60 lines)
export interface PackageRegistry {
  all(): readonly PackageView[];
  get(packageDir: string): PackageView;
  repo(): PackageView;  // fallback for cross-package operations
}

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  readonly config: NaxConfig;                          // merged with .nax/mono/<pkg>/config.json
  readonly testPatterns: ResolvedTestPatterns;
  readonly language: DetectedLanguage;
  readonly framework: TestFramework | null;
}
```

Backed by existing detectors (`discoverWorkspacePackages`, `findPackageDir`, `detectLanguage`, `detectTestFramework`, `resolveTestFilePatterns`). Cache valid for the runtime's lifetime (config is frozen).

`PackageView` threaded into `ComposeInput`; that closes #533 (`ctx.package.testPatterns.testDirs`), #534 (`ctx.package.testPatterns.globs`), #535 (`ctx.packageDir` required, no fallback), #536 (`ctx.package.language` enum).

---

## Architecture After ADR-017

```
NaxRuntime (per run / plan / standalone CLI invocation)
  ├─ config, workdir, projectDir, signal
  ├─ agentManager: IAgentManager        // ADR-012, ADR-013 — unchanged public interface;
  │                                     //  runAs()/completeAs() gain internal envelope (permissions, cost, audit, error)
  ├─ sessionManager: ISessionManager    // ADR-011 — unchanged
  ├─ costTracker: CostTracker           // NEW — one per runtime
  ├─ promptAuditor: IPromptAuditor      // NEW — flushes on close()
  ├─ packages: PackageRegistry          // NEW — cached per-package views
  └─ logger: Logger

Operations (internal extensibility surface — src/operations/)
  ├─ Operation<I, O, C> typed spec — declares name, stage, config slice, build, parse
  ├─ RunOperation adds { session: { role, lifetime }, mode? }
  ├─ CompleteOperation adds { jsonMode? }
  └─ callOp(ctx, op, input) → Promise<O>
       ├─ slices config per op.config declaration
       ├─ runs op.build → composeSections → join
       └─ dispatches to runtime.agentManager.runAs/completeAs

Prompt composition
  ├─ Builders own slot-specific sections: role, task, examples, output-format
  └─ composeSections(input) → readonly PromptSection[]
       └─ Materializes: constitution, context, static rules, monorepo hints, previous attempts

Retry loop
  └─ runRetryLoop<TFailure, TResult>(RetryInput) → RetryOutcome
       ├─ buildPrompt(failure, previous) — caller-provided; typically callOp on rectify op
       ├─ execute(prompt)                — caller-provided, typically runtime.agentManager.runAs
       └─ verify(result)                 — caller-provided, stage-specific

Escalation (unchanged location)
  └─ src/execution/escalation/ — runs between stage retries, not inside retry loop

Adapter surface (2 methods, permanently)
  ├─ AgentAdapter.run(options)
  └─ AgentAdapter.complete(prompt, options)
     // .plan() and .decompose() REMOVED — now Operation specs under src/operations/

Plugin extensions (unchanged — 7 types)
  └─ optimizer, router, agent, reviewer, context-provider, reporter, post-run-action
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 closes** | One `AgentManager` per run via `NaxRuntime`. Fallback, cost, audit uniform across routing → execution → rectification → debate. |
| **Adapter surface shrinks permanently** | `run` + `complete`. New agents implement 2 methods. `.plan()` / `.decompose()` cannot leak back. |
| **Cross-cutting uniform** | Permissions, cost, audit, error wrapping happen once in `AgentManager.runAs()`. The ACP adapter's three `resolvePermissions()` calls delete. |
| **Operations have a standard shape** | `Operation<I, O, C>` + `callOp` give a type-enforced convention for adding a new op (e.g. `plan-refine`). One file under `src/operations/`, compiler-checked config slice, no boilerplate copying. |
| **Config coupling controlled** | `ConfigSelector<C>` declares each operation's config dependency. Refactors to one config field surface only the ops that declared it. Test fixtures shrink from full `NaxConfig` to the declared slice. |
| **Prompt composition uniform** | `composeSections()` is the single assembly point. Constitution/context/static-rules injection consolidates. Rectifier builder drops from 720 → ~200 lines. |
| **Monorepo violations close structurally** | `PackageView` threaded into `ComposeInput`. CI lint catches `process.cwd()` leaks. #533–#536 plus ≥5 additional sites fixed in one pass. |
| **Retry inputs unify** | Five callers of `runSharedRectificationLoop` migrate to one `RetryInput` shape. Progressive composition is a callback parameter, not a new abstraction. |
| **Minimal concept surface** | ~8 new types (`NaxRuntime`, `Operation`, `RunOperation`, `CompleteOperation`, `ConfigSelector`, `CostTracker`, `RetryInput`, `ComposeInput`) vs ADR-014/015/016's ~24. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `NaxRuntime` owns 5+ services — admission criteria informal | Explicitly documented: scope-bound lifecycle + used by ≥2 subsystems. Revisit if the field count exceeds ~8. |
| Method-local envelope in `AgentManager.runAs()` — extension requires amending the method | Acceptable today. Cross-cutting extensions (budget, rate-limiting) add as internal method branches. Third-party composability is explicitly out of scope (per the Decision section). |
| Operations are internal — no plugin registration API | Plugins extend via the existing 7 types (`agent`, `reviewer`, `context-provider`, `reporter`, `router`, `optimizer`, `post-run-action`). A plugin wanting a wholly new operation shape forks or files a concrete request; plugin API v2 stays rejected until that happens. |
| `SectionSlot` enum constrains ordering | Canonical — same slot model every builder uses. Non-canonical ordering cases require amending `SLOT_ORDER` + review. |
| `ConfigSelector<C>` adds a new type concept | Pays for itself: refactor safety, test-fixture shrink, explicit dependency graph. The two-form (keyof-array vs lambda) sugar covers 95% of cases with zero ceremony. |
| Migration spans 6 phases | Each phase is ~1–2 days of work, independently shippable, no inter-phase breakage. Total ~1500 LOC vs ~3000 LOC for ADR-014/015/016. |

---

## Migration Plan

Six phases, each independently shippable and revertible.

### Phase 1 — `NaxRuntime` + orphan consolidation

- Introduce `src/runtime/index.ts` (`NaxRuntime` interface + `createRuntime` factory).
- Introduce `CostTracker`, `PromptAuditor`, `PackageRegistry` as plain classes in `src/runtime/`.
- Move `createAgentManager` from `src/agents/index.ts:29` to `src/runtime/internal/agent-manager-factory.ts`.
- Migrate 7 orphan call sites: `_deps.createManager` fields → `_deps.runtime`.
- Runner constructs runtime in `runSetupPhase()`, closes in `runCompletionPhase()`.
- Thread `ctx.runtime: NaxRuntime` through `PipelineContext`.
- **Exit criteria:** zero `createAgentManager` imports outside `src/runtime/`. `#523` reproducer: 401 on routing hits the same fallback chain as execution.
- **Risk:** Low. Purely additive.

### Phase 2 — `AgentManager.runAs()` envelope + adapter simplification

- Amend `AgentManager.runAs()` / `completeAs()` to resolve permissions, tag cost, emit audit, wrap errors.
- Add `AgentRunOptions.resolvedPermissions?: ResolvedPermissions`.
- Delete the three `resolvePermissions()` calls in [src/agents/acp/adapter.ts:593,847,1036](../../src/agents/acp/adapter.ts#L593). Adapter reads `request.runOptions.resolvedPermissions`.
- **Exit criteria:** zero `resolvePermissions()` calls inside `src/agents/acp/adapter.ts`. `CostTracker.snapshot()` reflects all agent calls including nested (rectification, debate proposers).
- **Risk:** Low. Internal to the manager and adapter.

### Phase 3 — `Operation` shape + `callOp()` + `src/operations/` skeleton

- Introduce `src/operations/types.ts` (`Operation`, `RunOperation`, `CompleteOperation`, `ConfigSelector`, `BuildContext`, `CallContext`).
- Introduce `src/operations/call.ts` with `callOp()`, `resolveSlice()`, `resolveSessionRole()`.
- Introduce `src/operations/README.md` — the standard shape, when to add a new op, migration checklist.
- Ship one converted operation end-to-end as proof (recommend `classify-route` — the simplest leaf; zero session, single-field config slice).
- **Exit criteria:** one operation calls through `callOp`; contract is compiler-enforced on that operation's tests.
- **Risk:** Low. Additive.

### Phase 4 — `.plan()` / `.decompose()` → `Operation` specs + builder migration

- Create `src/operations/plan.ts` and `src/operations/decompose.ts` (specs use §4 shape).
- Migrate remaining operation candidates into specs, lowest blast radius first:
  1. `classify-route` (routing — already proved in Phase 3)
  2. `acceptance-generate`, `acceptance-refine`, `acceptance-diagnose`, `acceptance-fix`
  3. `semantic-review`, `adversarial-review`
  4. `plan`, `decompose` (the adapter-removal set)
  5. `rectify` (becomes the per-attempt op for Phase 6's `runRetryLoop`)
  6. `debate-propose`, `debate-rebut`, `debate-rank` (if debate-stage migration is in scope; otherwise defer to a follow-up)
- Introduce `src/prompts/compose.ts` (`ComposeInput`, `composeSections`, `join`, slot helpers).
- Add `SectionSlot` + `SLOT_ORDER` to `src/prompts/core/types.ts`.
- Migrate prompt builders so each exposes slot-specific methods (`role`, `task`, `examples`, `outputFormat`):
  1. `rectifier-builder.ts` (biggest payoff — 720 → ~200 lines)
  2. `review-builder.ts`, `adversarial-review-builder.ts`
  3. `tdd-builder.ts`
  4. `acceptance-builder.ts`
  5. `debate-builder.ts`
  6. `plan-builder.ts`, `decompose-builder.ts`
  7. `one-shot-builder.ts`
- Update `nax plan` CLI and decompose callers to `callOp(...)`.
- Delete `AgentAdapter.plan()`, `AgentAdapter.decompose()`, `IAgentManager.planAs()`, `IAgentManager.decomposeAs()`.
- Update adapter-boundary integration test to enforce 2-method surface.
- Add CI lint rule for forbidden imports in `src/prompts/builders/**`.
- **Exit criteria:** `AgentAdapter` has only `run` and `complete`; `nax plan` works end-to-end; all builders produce slot-specific sections; no builder imports `ContextBundle`, `loadConstitution`, `loadStaticRules`.
- **Risk:** Medium. Broad touch; each operation + builder migration lands independently.

### Phase 5 — Internal extensibility checkpoint: `plan-refine` as validation

- Before locking Phase 4, add one genuinely new operation not present today: `plan-refine` (or equivalent).
- Confirm the workflow is one file under `src/operations/`, one call site, zero changes elsewhere.
- Use `plan-refine` as the smoke test that the operation shape actually works for the "add a new op" use case (P2's original ask).
- **Exit criteria:** `plan-refine` ships behind a config flag and a single end-to-end test passes.
- **Risk:** Low. Additive; flag-gated.

### Phase 6 — `RetryInput` unification + monorepo lint + SessionRole tightening

- Amend `runSharedRectificationLoop` to accept `RetryInput<TFailure, TResult>`; migrate 5 callers.
- Delete per-caller wrappers (`runRectificationLoopFromCtx`, TDD's local `runRectificationLoop`).
- Add CI lint rule for `process.cwd()` outside permitted paths.
- Fix all flagged sites (≥5 beyond #533–#536): `src/debate/session.ts:44`, `src/agents/acp/adapter.ts:884,895`, `src/precheck/index.ts:239`, `src/commands/common.ts:82,85,98`.
- Tighten `SessionRole` template-literal union; update debate files.
- **Exit criteria:** one retry-loop input shape. Zero `process.cwd()` outside CLI. `SessionRole` admits debate/plan forms by type.
- **Risk:** Low–Medium. Mechanical migrations; each site is small.

**Rollback plan:** every phase is independently revertible. Phases 1–4 leave the adapter surface backwards-compatible during the window (deprecation path). Phase 5's `plan-refine` is flag-gated. Phase 6 touches retry and monorepo sites; each site's change is small and individually reviewable.

---

## Rejected Alternatives

### A. Introduce `RunScope` + agent middleware chain + `Operation<I, O, C>` + `ISessionRunner` + `src/control/` + prompt middleware

**Rejected — see ADR-014/015/016 for the full proposal; see this ADR's §Context for the review.** Summary: ~24 new types, three new directories, plugin API deferred three times, three interlocking ADRs with sequencing fragility. The pain points it addresses are real, but the codebase already contains partial forms (`PromptSection`, `shared-rectification-loop`, 7-type plugin system) that reach the same outcome with ~5 new types instead of 24.

### B. Introduce `IPermissionTranslator` + `IPermissionTranslatorRegistry`

**Rejected.** With ACP as the only transport today, the registry middleman buys test-injection and a plugin seam for translators that nobody is asking for. The adapter's wire mapping lives inside the adapter's own folder (where it already is). When a second transport arrives, add a `toWirePolicy(resolved)` method to `AgentAdapter`; the registry is one small refactor away if plugin-contributed translators materialize — but shipping it preemptively adds ceremony.

### C. Prompt middleware chain with `PromptMiddleware.apply(sections) → sections`

**Rejected.** Functional transformers over `readonly PromptSection[]` are elegant but the ownership registry, conflict errors at runtime, and phase-ordering invariants add operational complexity without concrete payoff. `composeSections()` as a total function is readable and testable; operation-specific section additions live in the op's `build()` body (e.g. `rectify` injects `previousAttempts`). Third-party plugin composability is explicitly out of scope (see Decision section).

### D. Agent middleware chain with `AgentMiddleware.run(ctx, next)`

**Rejected.** Method-local cross-cutting work in `AgentManager.runAs()` solves the same problems (uniform permissions, cost, audit) without a chain. Observer-vs-transformer invariants, per-middleware resilience rules, and chain ordering are complexity the codebase does not need. If a plugin needs mid-call interception one day, the manager method accepts an extension callback — one hook point, not a chain.

### E. `ISessionRunner` abstraction over stages

**Rejected.** Today's pipeline stages *are* the session-topology unit. `implement` stage opens one session; TDD is three related stages; debate is a multi-session loop in [src/debate/session.ts](../../src/debate/session.ts). Wrapping them in an `ISessionRunner` hierarchy and introducing `SingleSessionRunner` (a one-liner over `scope.invoke`) adds indirection for no gain. The multi-session cases (TDD, debate) stay where they are and keep their direct control over session choreography.

### F. Full ADR-015 `Operation<I, O, C>` contract with `requires` + `scope.invoke()` envelope

**Partially accepted, partially rejected.** ADR-017 accepts the typed operation shape (name, stage, config, build, parse) and `ConfigSelector<C>` — those are load-bearing for internal extensibility and config-coupling control (see §3). The ADR-015-specific wrappers are rejected:

- **`requires: { session, scope, permissions, config }` block** — rejected. Fields are flattened onto the op. `scope: "package" | "cross-package" | "repo"` drops entirely (no cross-package ops exist today; add when needed). `permissions` derives from `stage`.
- **`scope.invoke(op, input, opts)` 9-step envelope** — rejected. Replaced by `callOp()` helper (~50 lines). Cross-cutting (permissions, cost, audit, errors) lives in `AgentManager.runAs()` per §2, not in the operation call site.
- **`OperationContext<C>` 13-field god context** — rejected. Replaced by `BuildContext<C>` (packageView + sliced config) + `CallContext` (runtime + packageDir + storyId + agentName + optional sessionOverride).
- **Composite operations as first-class** — rejected. A composite is just an op whose `build()` or caller invokes `callOp()` on sub-ops. No special case in `callOp()`.
- **Session minting inside `invoke()`** — rejected. `SessionManager` + `computeAcpHandle` keep ownership per ADR-011/ADR-008.
- **Plugin operation registration** — rejected (see §H).

### G. `src/control/` directory for escalation + retry + iteration

**Rejected.** The layering already exists implicitly: `runner-execution.ts` iterates stages; `shared-rectification-loop` runs attempts within a stage; `src/execution/escalation/` decides between stages. Moving them into `src/control/` and adding an `IAgent`-import lint rule is pure taxonomy. Keep them where they live; fix the input shapes (Phase 6); done.

### H. Plugin API v2 with operation registration

**Rejected.** The 7 existing plugin types cover: custom agents (`agent`), reviewers (`reviewer`), context providers (`context-provider`), reporters (`reporter`), routers (`router`), optimizers (`optimizer`), post-run actions (`post-run-action`). Third-party plugin composability is explicitly out of scope today. Operations (`src/operations/`) are internal — the `Operation<I, O, C>` shape is a convention for the Nax team, not a plugin registration surface. When a third-party plugin use case for new operation types surfaces, revisit with a concrete example; don't pre-build a versioning system.

### I. `IAgent` as a new type distinct from `AgentAdapter`

**Rejected.** `AgentAdapter` + `IAgentManager` already cover the space. Callers use `runtime.agentManager.runAs(name, request)`. Introducing a third agent-like type (`IAgent`) to sit between them creates three `getAgent()` methods with three return types — readability trap. Keep two types; don't add a third.

### J. `scope.invoke(op, input, opts)` envelope

**Rejected.** The envelope's nine internal steps (validate, resolve agent, slice config, resolve permissions, thread session identity, build logger, thread signal, execute, wrap errors) collapse into three places: `AgentManager.runAs()` (permissions/cost/audit/errors), `callOp()` (config slicing, prompt composition, session-role resolution), and `SessionManager`/`computeAcpHandle` (session identity — already owns it). No single envelope method is needed.

### K. Free functions (`runPlan(runtime, input) → Promise<PlanResult>`) instead of `Operation` specs

**Rejected.** An earlier draft of this ADR proposed plain free functions for each operation. They gave you a *pattern* to follow but not a *type-enforced shape*. Adding a new op like `plan-refine` was "look at `runPlan`, copy the layout, don't forget anything" — drift-prone. The `Operation` spec form makes missing `stage`, `config`, or `parse` a type error; it makes unauthorized config reach (`ctx.config.rectification` from an op that declared `["planner"]`) a type error; and it puts every operation in one discoverable directory. Free functions shipped none of those.

### L. `IPromptSectionProvider` as an 8th plugin type

**Rejected.** An earlier draft added a plugin type for third-party prompt section contributions. The user confirmed third-party composability is not a priority today — the consolidation goal is internal (one place where sections compose: `composeSections()`). Adding a plugin type preemptively ships ceremony for an unstated need. If a concrete plugin use case surfaces later, adding a 9th extension type is a one-liner.

### M. Caching / `cache_control` markers in prompt sections

**Rejected as out of scope.** Section-based composition makes stable-prefix caching *possible* (constitution + role + context + static-rules form a natural cacheable prefix) but shipping `cache_control` markers requires ACP wire support, model-specific tokenizers, and measurement infrastructure that the codebase doesn't have today and the user confirmed is not prioritized. The design does not preclude future caching — a `CachePolicy` input could be added to `ComposeInput` later — but no current work pays for it.

---

## Open Questions

1. **`PromptSection.overridable` field.** Today's type has it; the new `SectionSlot` does not replace it. Keep as-is; no migration needed. Disk overrides remain a separate concern from slot composition.

2. **`Operation.validate(input)` hook.** Not in the initial shape. If pre-execution input validation proves repetitive across ops, add `validate?: (input: I) => void | NaxError` as an optional field. Leaning toward caller's responsibility (Zod at the boundary) — revisit after Phase 4 lands.

3. **Composite operations.** Today expressible as an op whose `build()` calls `callOp()` on sub-ops — no framework support. If a canonical pattern emerges (e.g. `review` as `semantic + adversarial`), consider a thin `composite()` helper. Not a blocker.

4. **Token budget enforcement.** Adding a per-run token budget that hard-aborts mid-rectification is trivial once `CostTracker` exposes a `currentTotal()` method. Not in scope for this ADR; `runRetryLoop`'s `verify` callback can return `{ success: false, reason: "budget-exhausted" }` when the caller detects budget overflow. No new abstraction required.

5. **Session resume across runtime restarts.** A crashed run's `NaxRuntime` is gone; its persisted session descriptors can be reattached on next startup via `SessionManager.resume(descriptors)`. Exact contract inherits ADR-008's open question — unchanged by this ADR.

6. **CostTracker + PromptAuditor disk schema.** `.nax/audit/<runId>.jsonl` and `.nax/cost/<runId>.jsonl` formats. Specified in Phase 2 implementation; not a blocker for ADR approval.

7. **`Operation` discovery for CLI introspection.** A `nax ops list` command showing every registered `Operation` + its declared `config` slice is useful for debugging and config-refactor audits. Nice-to-have; not in scope.

---

## References

- **Superseded:** ADR-014 (RunScope and Middleware), ADR-015 (Operation Contract), ADR-016 (Prompt Composition and PackageView)
- **Preserved invariants from:** ADR-008 (session lifecycle), ADR-011 (SessionManager ownership), ADR-012 (AgentManager ownership), ADR-013 (SessionManager → AgentManager hierarchy), ADR-009 (test-file pattern SSOT)
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (amended to 2-method surface in Phase 3)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention (tightened by Phase 4)
- `.claude/rules/monorepo-awareness.md` — rules made structural by Phase 6
- Issues: [#523](https://github.com/nathapp-io/nax/issues/523) (fallback state divergence), [#533](https://github.com/nathapp-io/nax/issues/533)–[#536](https://github.com/nathapp-io/nax/issues/536) (monorepo violations)
