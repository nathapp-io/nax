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

Five self-contained refactors, shipped in sequence. Each closes a named pain point with existing code. No new top-level directory outside `src/runtime/`. No middleware chain. No `Operation<I, O, C>` contract. No `ISessionRunner`.

1. **`NaxRuntime`** — single lifecycle container owning `AgentManager`, `SessionManager`, `CostTracker`, logger, signal. Threaded via existing `PipelineContext`. Replaces the 7 orphan `createAgentManager` call sites.

2. **Cross-cutting work in `AgentManager.runAs()`** — `resolvePermissions()`, cost tagging, audit, error wrapping become one method-local envelope in the manager. The ACP adapter's three `resolvePermissions()` calls collapse to zero.

3. **`.plan()` / `.decompose()` leave the adapter as plain functions** — `runPlan(runtime, input)` and `runDecompose(runtime, input)` replace the adapter methods. Adapter surface drops to 2 methods permanently.

4. **`composeSections()` helper + typed `PromptSection` slots** — one helper function assembles sections in canonical order. Builders produce slot-specific sections (role, task, examples, output-format); the helper materializes context, constitution, static rules, monorepo hints, previous attempts. No middleware chain.

5. **Unified `RetryInput<TFailure, TResult>` shape** — five callers of `runSharedRectificationLoop` migrate to one input shape. Progressive composition (previous attempts feeding the next prompt) is a callback parameter, not a prompt-middleware concern.

Three cross-cutting enforcements land alongside:

6. **CI lint rule — `process.cwd()` outside CLI entry points is an error.** Enforces the existing rule in `.claude/rules/monorepo-awareness.md`; closes #533–#536 plus the additional sites.

7. **`SessionRole` tightens to a template-literal union** admitting `debate-${string}`, `plan-${number}` — retires ad-hoc string construction in `src/debate/`.

8. **Plugin extension points extend by 1** — `IPromptSectionProvider` as an 8th plugin type. Plugins contribute sections for named slots; no operation-registration API, no middleware registration API.

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

### 3. `.plan()` / `.decompose()` off the adapter — plain functions

**Problem:** [src/agents/types.ts:322,325](../../src/agents/types.ts#L322) — `AgentAdapter.plan()` and `.decompose()` are prompt-composition-plus-one-call. Every new agent implements 4 methods. Prompt-building is pinned to the adapter layer, violating the Prompt Builder Convention.

**Fix:** pull them out as plain functions that live with their callers:

```typescript
// src/pipeline/plan/run-plan.ts (new)
export async function runPlan(runtime: NaxRuntime, input: PlanInput): Promise<PlanResult> {
  const prompt = composeSections({
    role: planBuilder.role(input),
    task: planBuilder.task(input),
    context: input.context,
    constitution: input.constitution,
    packageView: runtime.packages.get(input.packageDir),
    outputFormat: planBuilder.outputFormat(),
  });

  const result = await runtime.agentManager.runAs(input.agentName, {
    runOptions: {
      prompt: join(prompt),
      workdir: input.packageDir,
      pipelineStage: "plan",
      mode: "plan",
      config: runtime.config,
      storyId: input.storyId,
      sessionRole: "plan",
      keepOpen: false,
    },
  });

  return planBuilder.parse(result.output);
}

// src/pipeline/decompose/run-decompose.ts (new)
export async function runDecompose(runtime: NaxRuntime, input: DecomposeInput): Promise<DecomposeResult> {
  const prompt = composeSections({
    role: decomposeBuilder.role(input),
    task: decomposeBuilder.task(input),
    constitution: input.constitution,
    outputFormat: decomposeBuilder.outputFormat(),
    packageView: runtime.packages.repo(),
  });

  const response = await runtime.agentManager.completeAs(input.agentName, join(prompt), {
    jsonMode: true,
    pipelineStage: "complete",
    config: runtime.config,
  });

  return decomposeBuilder.parse(response);
}
```

**Migration:**

1. Copy `adapter.plan()` body into `runPlan()`; replace `this.run(...)` with `runtime.agentManager.runAs(...)`.
2. Copy `adapter.decompose()` body into `runDecompose()`; replace `this.complete(...)` with `runtime.agentManager.completeAs(...)`.
3. Update `nax plan` CLI ([src/cli/plan.ts](../../src/cli/plan.ts)) to call `runPlan(runtime, input)`.
4. Update decompose callers ([src/commands/decompose.ts](../../src/commands/decompose.ts), batch routing, etc.) to call `runDecompose(runtime, input)`.
5. Delete `AgentAdapter.plan()` and `AgentAdapter.decompose()` from [src/agents/types.ts:322,325](../../src/agents/types.ts#L322).
6. Delete `IAgentManager.planAs()` and `IAgentManager.decomposeAs()` from [src/agents/manager-types.ts](../../src/agents/manager-types.ts).
7. Update `IAgentManager.plan()` and `.decompose()` to throw a deprecation `NaxError` with a one-release window, then delete.

**Final adapter surface:** `run(options)` and `complete(prompt, options)` — 2 methods, permanently. Same outcome as ADR-015 §4 without `Operation<I, O, C>`.

**Why no `Operation<I, O, C>`:** the declarative contract's only concrete benefit is plugin operation registration. Plugins contribute to the existing 7 types (`agent`, `reviewer`, `context-provider`, etc.) — they've never asked for a "new operation" primitive. When they do, wrap the function shape then; don't ship the type gymnastics preemptively.

---

### 4. `composeSections()` helper + typed `PromptSection` slots

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
  | "output-format"
  | "extension";  // plugin-contributed sections

// Canonical slot order — the single source of truth for section ordering.
export const SLOT_ORDER: readonly SectionSlot[] = [
  "constitution", "role", "context", "static-rules", "monorepo-hints",
  "task", "previous-attempts", "examples", "output-format", "extension",
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
  readonly extensions?: readonly PromptSection[];  // from IPromptSectionProvider plugins
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
  if (input.extensions?.length) sections.push(...input.extensions);

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
- Plugin contributions enter through one typed input (`ComposeInput.extensions`). See §6 below.
- Section ordering is a `const readonly` array — the single source of truth, greppable.
- Testing: builders test with fixed `ComposeInput`; `composeSections()` tests order. No middleware chain fixtures.

---

### 5. Unified `RetryInput<TFailure, TResult>` for the rectification driver

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

### 6. Plugin extension: `IPromptSectionProvider`

**Problem:** when a plugin wants to inject a "security warning" section or a "compliance header," today it must fork the builder. No extension seam.

**Fix:** add one plugin type — the 8th in the existing plugin system:

```typescript
// src/plugins/extensions.ts — extend existing file
export interface IPromptSectionProvider {
  readonly slot: "extension";  // plugins always contribute to the "extension" slot
  readonly stages: readonly PipelineStage[];  // when to apply
  provide(ctx: SectionProvideContext): Promise<readonly PromptSection[]>;
}

export interface SectionProvideContext {
  readonly stage: PipelineStage;
  readonly story?: UserStory;
  readonly packageView: PackageView;
  readonly runtime: NaxRuntime;  // read-only access for inspection
}
```

**Plugin registration:** existing [src/plugins/types.ts:PluginType](../../src/plugins/types.ts) union gains `"prompt-section"`. The plugin loader ([src/plugins/loader.ts](../../src/plugins/loader.ts)) instantiates providers; `composeSections()` consumes them via `ComposeInput.extensions`.

**Why this is enough:**

- Section slot is fixed at `"extension"` — plugins cannot replace `role`, `task`, etc. No ordering wars with built-in sections.
- Plugins with cross-cutting needs beyond prompts use the existing `IReporter`, `IContextProvider`, `IReviewPlugin`, or `IPostRunAction`. Nothing new required for observability, reporting, or review.
- Full plugin API v2 (operation registration, middleware registration, etc.) is **not deferred** — it is explicitly **rejected** as speculative. If a concrete plugin use case surfaces that cannot be served by the 8 extension points, add a 9th. Don't pre-build a versioning system.

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

### 8. `SessionRole` tightens

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

### 9. `PackageRegistry` (thin)

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

Prompt composition
  ├─ Builders own slot-specific sections: role, task, examples, output-format
  └─ composeSections(input) → readonly PromptSection[]
       ├─ Materializes: constitution, context, static rules, monorepo hints, previous attempts
       └─ Integrates: plugin-contributed "extension" slot sections

Retry loop
  └─ runRetryLoop<TFailure, TResult>(RetryInput) → RetryOutcome
       ├─ buildPrompt(failure, previous) — caller-provided, uses composeSections
       ├─ execute(prompt)                — caller-provided, typically runtime.agentManager.runAs
       └─ verify(result)                 — caller-provided, stage-specific

Escalation (unchanged location)
  └─ src/execution/escalation/ — runs between stage retries, not inside retry loop

Adapter surface
  ├─ AgentAdapter.run(options)
  └─ AgentAdapter.complete(prompt, options)
     // .plan() and .decompose() REMOVED — now runPlan()/runDecompose() functions

Plugin extensions (8 types)
  ├─ optimizer, router, agent, reviewer, context-provider, reporter, post-run-action
  └─ prompt-section  // NEW — contributes sections to ComposeInput.extensions
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **#523 closes** | One `AgentManager` per run via `NaxRuntime`. Fallback, cost, audit uniform across routing → execution → rectification → debate. |
| **Adapter surface shrinks permanently** | `run` + `complete`. New agents implement 2 methods. `.plan()` / `.decompose()` cannot leak back. |
| **Cross-cutting uniform** | Permissions, cost, audit, error wrapping happen once in `AgentManager.runAs()`. The ACP adapter's three `resolvePermissions()` calls delete. |
| **Prompt composition uniform** | `composeSections()` is the single assembly point. Constitution/context/static-rules injection consolidates. Rectifier builder drops from 720 → ~200 lines. |
| **Monorepo violations close structurally** | `PackageView` threaded into `ComposeInput`. CI lint catches `process.cwd()` leaks. #533–#536 plus ≥5 additional sites fixed in one pass. |
| **Retry inputs unify** | Five callers of `runSharedRectificationLoop` migrate to one `RetryInput` shape. Progressive composition is a callback parameter, not a new abstraction. |
| **Plugin seam extends** | One new extension type (`prompt-section`) joins the existing 7. No plugin API v2 needed. |
| **Zero new concept surface beyond needs** | ~5 new types (`NaxRuntime`, `CostTracker`, `RetryInput`, `RetryAttempt`, `ComposeInput`) vs ADR-014/015/016's ~24. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| `NaxRuntime` owns 5+ services — admission criteria informal | Explicitly documented: scope-bound lifecycle + used by ≥2 subsystems. Revisit if the field count exceeds ~8. |
| Method-local envelope in `AgentManager.runAs()` — extension requires amending the method | Acceptable today. Cross-cutting extensions (budget, rate-limiting) add as internal method branches. Third parties extend via subscribers on `CostTracker` / `PromptAuditor`. |
| No declarative `Operation` contract for plugins | Plugins extend via the existing 7 types (+ `prompt-section`). Contribute `AgentAdapter` implementations for new agents, `IReviewPlugin` for new reviewers, `IContextProvider` for context, `IPromptSectionProvider` for prompt sections. |
| `SectionSlot` enum constrains ordering | Canonical — same slot model every builder uses. Non-canonical ordering cases require amending `SLOT_ORDER` + review. |
| Migration spans 5 phases | Each phase is ~1–2 days of work, independently shippable, no inter-phase breakage. Total ~1200 LOC vs ~3000 LOC for ADR-014/015/016. |

---

## Migration Plan

Five phases, each independently shippable and revertible.

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

### Phase 3 — `.plan()` / `.decompose()` → functions

- Create `src/pipeline/plan/run-plan.ts` and `src/pipeline/decompose/run-decompose.ts`.
- Migrate `nax plan` CLI and decompose callers.
- Delete `AgentAdapter.plan()`, `AgentAdapter.decompose()`, `IAgentManager.planAs()`, `IAgentManager.decomposeAs()`.
- Update adapter-boundary integration test to enforce 2-method surface.
- **Exit criteria:** `AgentAdapter` has only `run` and `complete`. `nax plan` works end-to-end against existing fixtures.
- **Risk:** Medium. Touches `nax plan` CLI; behavior parity required.

### Phase 4 — `composeSections()` + builder migration

- Introduce `src/prompts/compose.ts` (`ComposeInput`, `composeSections`, `join`, slot helpers).
- Add `SectionSlot` + `SLOT_ORDER` to `src/prompts/core/types.ts`.
- Migrate builders in impact-first order:
  1. `rectifier-builder.ts` (biggest payoff — 720 → ~200 lines)
  2. `review-builder.ts`, `adversarial-review-builder.ts`
  3. `tdd-builder.ts`
  4. `acceptance-builder.ts`
  5. `debate-builder.ts`
  6. `plan-builder.ts`, `decompose-builder.ts` (integrate with Phase 3's `runPlan`/`runDecompose`)
  7. `one-shot-builder.ts`
- Add CI lint rule for forbidden imports in `src/prompts/builders/**`.
- **Exit criteria:** all builders produce slot-specific sections; no builder imports `ContextBundle`, `loadConstitution`, `loadStaticRules`.
- **Risk:** Medium. Broad touch; each builder is independent.

### Phase 5 — `RetryInput` unification + monorepo lint

- Amend `runSharedRectificationLoop` to accept `RetryInput<TFailure, TResult>`; migrate 5 callers.
- Delete per-caller wrappers (`runRectificationLoopFromCtx`, TDD's local `runRectificationLoop`).
- Add CI lint rule for `process.cwd()` outside permitted paths.
- Fix all flagged sites (≥5 beyond #533–#536): `src/debate/session.ts:44`, `src/agents/acp/adapter.ts:884,895`, `src/precheck/index.ts:239`, `src/commands/common.ts:82,85,98`.
- Tighten `SessionRole` template-literal union; update debate files.
- Add `IPromptSectionProvider` plugin type; loader wiring.
- **Exit criteria:** one retry-loop input shape. Zero `process.cwd()` outside CLI. `SessionRole` admits debate/plan forms by type.
- **Risk:** Low–Medium. Mechanical migrations; each site is small.

**Rollback plan:** every phase is independently revertible. Phases 1–3 leave the adapter surface backwards-compatible during the window (deprecation path). Phases 4–5 touch production prompts; each builder PR lands independently so rollback is per-builder.

---

## Rejected Alternatives

### A. Introduce `RunScope` + agent middleware chain + `Operation<I, O, C>` + `ISessionRunner` + `src/control/` + prompt middleware

**Rejected — see ADR-014/015/016 for the full proposal; see this ADR's §Context for the review.** Summary: ~24 new types, three new directories, plugin API deferred three times, three interlocking ADRs with sequencing fragility. The pain points it addresses are real, but the codebase already contains partial forms (`PromptSection`, `shared-rectification-loop`, 7-type plugin system) that reach the same outcome with ~5 new types instead of 24.

### B. Introduce `IPermissionTranslator` + `IPermissionTranslatorRegistry`

**Rejected.** With ACP as the only transport today, the registry middleman buys test-injection and a plugin seam for translators that nobody is asking for. The adapter's wire mapping lives inside the adapter's own folder (where it already is). When a second transport arrives, add a `toWirePolicy(resolved)` method to `AgentAdapter`; the registry is one small refactor away if plugin-contributed translators materialize — but shipping it preemptively adds ceremony.

### C. Prompt middleware chain with `PromptMiddleware.apply(sections) → sections`

**Rejected.** Functional transformers over `readonly PromptSection[]` are elegant but the ownership registry, conflict errors at runtime, and phase-ordering invariants add operational complexity without concrete payoff. `composeSections()` as a total function is readable, testable, and extensible via one typed input (`extensions: readonly PromptSection[]`). Plugin contributions enter through `IPromptSectionProvider`.

### D. Agent middleware chain with `AgentMiddleware.run(ctx, next)`

**Rejected.** Method-local cross-cutting work in `AgentManager.runAs()` solves the same problems (uniform permissions, cost, audit) without a chain. Observer-vs-transformer invariants, per-middleware resilience rules, and chain ordering are complexity the codebase does not need. If a plugin needs mid-call interception one day, the manager method accepts an extension callback — one hook point, not a chain.

### E. `ISessionRunner` abstraction over stages

**Rejected.** Today's pipeline stages *are* the session-topology unit. `implement` stage opens one session; TDD is three related stages; debate is a multi-session loop in [src/debate/session.ts](../../src/debate/session.ts). Wrapping them in an `ISessionRunner` hierarchy and introducing `SingleSessionRunner` (a one-liner over `scope.invoke`) adds indirection for no gain. The multi-session cases (TDD, debate) stay where they are and keep their direct control over session choreography.

### F. `Operation<I, O, C>` declarative contract

**Rejected.** The contract's only concrete benefit is plugin operation registration — which is deferred three times across ADR-014/015/016 anyway. Plugins extend via the existing 7 types (+ the new `prompt-section`). Functions with parameters express the same semantics as `requires` + `execute` with less ceremony and less type gymnastics (no `ConfigSelector<C>`, no `OperationContext<C>` god context, no `scope.invoke()` envelope).

### G. `src/control/` directory for escalation + retry + iteration

**Rejected.** The layering already exists implicitly: `runner-execution.ts` iterates stages; `shared-rectification-loop` runs attempts within a stage; `src/execution/escalation/` decides between stages. Moving them into `src/control/` and adding an `IAgent`-import lint rule is pure taxonomy. Keep them where they live; fix the input shapes (Phase 5); done.

### H. Plugin API v2 with operation registration

**Rejected.** The 7 existing plugin types cover: custom agents (`agent`), reviewers (`reviewer`), context providers (`context-provider`), reporters (`reporter`), routers (`router`), optimizers (`optimizer`), post-run actions (`post-run-action`). One addition (`prompt-section`) covers prompt extensions. No concrete plugin need sits outside this set today. Build plugin API v2 when a third-party plugin author surfaces a use case that cannot fit — not speculatively.

### I. `IAgent` as a new type distinct from `AgentAdapter`

**Rejected.** `AgentAdapter` + `IAgentManager` already cover the space. Callers use `runtime.agentManager.runAs(name, request)`. Introducing a third agent-like type (`IAgent`) to sit between them creates three `getAgent()` methods with three return types — readability trap. Keep two types; don't add a third.

### J. `scope.invoke(op, input, opts)` envelope

**Rejected.** The envelope's nine internal steps (validate, resolve agent, slice config, resolve permissions, thread session identity, build logger, thread signal, execute, wrap errors) collapse into the body of `runPlan`, `runDecompose`, and similar plain functions. Each function's body is three to eight lines because the cross-cutting work already happens inside `AgentManager.runAs()`. A single envelope method forces every call site into the same mold; plain functions let each operation express its actual shape.

---

## Open Questions

1. **`PromptSection.overridable` field.** Today's type has it; the new `SectionSlot` does not replace it. Keep as-is; no migration needed. Disk overrides remain a separate concern from slot composition.

2. **Token budget enforcement.** Adding a per-run token budget that hard-aborts mid-rectification is trivial once `CostTracker` exposes a `currentTotal()` method. Not in scope for this ADR; `runRetryLoop`'s `verify` callback can return `{ success: false, reason: "budget-exhausted" }` when the caller detects budget overflow. No new abstraction required.

3. **Session resume across runtime restarts.** A crashed run's `NaxRuntime` is gone; its persisted session descriptors can be reattached on next startup via `SessionManager.resume(descriptors)`. Exact contract inherits ADR-008's open question — unchanged by this ADR.

4. **CostTracker + PromptAuditor disk schema.** `.nax/audit/<runId>.jsonl` and `.nax/cost/<runId>.jsonl` formats. Specified in Phase 2 implementation; not a blocker for ADR approval.

5. **Plugin API versioning.** Explicitly deferred to "when a concrete use case surfaces." Not a 4th open question — a rejection (§H).

---

## References

- **Superseded:** ADR-014 (RunScope and Middleware), ADR-015 (Operation Contract), ADR-016 (Prompt Composition and PackageView)
- **Preserved invariants from:** ADR-008 (session lifecycle), ADR-011 (SessionManager ownership), ADR-012 (AgentManager ownership), ADR-013 (SessionManager → AgentManager hierarchy), ADR-009 (test-file pattern SSOT)
- `docs/architecture/ARCHITECTURE.md` — subsystem index
- `docs/architecture/agent-adapters.md` — adapter protocol (amended to 2-method surface in Phase 3)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention (tightened by Phase 4)
- `.claude/rules/monorepo-awareness.md` — rules made structural by Phase 5
- Issues: [#523](https://github.com/nathapp-io/nax/issues/523) (fallback state divergence), [#533](https://github.com/nathapp-io/nax/issues/533)–[#536](https://github.com/nathapp-io/nax/issues/536) (monorepo violations)
