# SPEC: StoryOrchestrator — Unified Execution Path Consolidation

> ℹ️ **PARTIALLY AMENDED (2026-05-23)** by [SPEC-execution-unification.md](./SPEC-execution-unification.md) and [ADR-023](../adr/ADR-023-execution-unification.md).
>
> **Specifically amended:** §2B `CANONICAL_ORDER` is extended with check phases (`lint-check`, `typecheck-check`, `format-check`, optionally `plugin-reviews`, `verify-scoped`) between `verifier` and `semantic-review`. The original order — `test-writer → greenfield-gate → implementer → full-suite-gate → verifier → semantic-review → adversarial-review` — is preserved as the LLM-phase sequence; the new check phases interleave before semantic-review per ADR-023 §1.
>
> **Still authoritative:** US-001..US-004 (which all landed), the `StoryOrchestratorBuilder` API, `OrchestratorSlot` shape, `phaseOutputs` contract, `SessionKeeper` semantics, and the broader phase-and-output design. ADR-023 builds on this foundation; it does not redesign the builder.

---

**Issues:** #1058 (session keep-open fix), orchestration refactor  
**Branch:** `refactor/story-orchestrator`  
**Phases:** Phase 1 (shared helpers + op upgrades), Phase 2 (StoryOrchestratorBuilder)
**Status:** Phase 1 + Phase 2 landed. §2B CANONICAL_ORDER amended by SPEC-execution-unification (see banner above).

---

## Summary

nax currently maintains two parallel execution paths that duplicate session management,
rectification loops, config-gate checks, and transport-retry logic:

- **TDD path** — `src/tdd/orchestrator.ts` + `session-runner.ts` + `rectification-gate.ts`
- **Single-session path** — `src/pipeline/stages/execution.ts` + `src/verification/rectification-loop.ts`

Both paths share the same conceptual slots (implementer, test-writer, verifier, semantic review,
adversarial review, rectification) but implement them independently, causing ~400 lines of
duplication and subtle divergence (e.g. `keepOpen` computed differently in each path).

This spec introduces a unified `StoryOrchestratorBuilder` that both paths configure from a
single builder API. Phase 1 extracts shared helpers and upgrades TDD role tags to full
`RunOperation` shapes. Phase 2 replaces both path entry points with the builder.

---

## Motivation

**Duplication causes bugs.** The `keepOpen` session flag was computed under different conditions
in `session-runner.ts` (TDD) vs `execution.ts` (single-session), causing session re-open bugs
that required a dedicated hotfix (PR #1058). Both rectification loops carry an identical ~75-line
`while` block for `getLiveHandle → openSession → transport-retry → bindHandle`. Any fix to that
pattern must be applied in two places.

**TDD ops are second-class.** `implement.ts`, `verify.ts`, `write-test.ts` re-export
`TddRunOp = { role: TddSessionRole }` — minimal role tags that cannot carry `op.retry`,
`op.recover`, or `op.hopBody`. Recovery logic lives inline in the orchestrator instead of on
the operation. This violates ADR-020 §D4.

**Test count is inflated.** 8 000+ tests include path-specific wiring tests (session lifecycle
in `rectification-gate-session.test.ts`, `session-runner-bindhandle.test.ts`, `session-op.test.ts`)
that test implementation details rather than behaviour. These will be deleted as the unified
path replaces the duplicated wiring.

---

## Design

### Phase 1 — Shared Helpers + Operation Upgrades

#### 1A. `ExecutionGates` — config gate SSOT

New file `src/operations/execution-gates.ts`. Single source of truth for all config-derived
boolean decisions. Replaces three divergent inline checks.

```typescript
import { executionGatesConfigSelector } from "../config";
import type { ExecutionGatesConfig } from "../config/selectors";
import type { SessionRole } from "../session/types";

export { executionGatesConfigSelector };

/** Returns true when the implementer session must stay open after the agent turn. */
export function shouldKeepSessionOpen(config: ExecutionGatesConfig, role: SessionRole): boolean;

/** Returns true when the review stage is enabled. */
export function shouldRunReview(config: ExecutionGatesConfig): boolean;

/** Returns true when the rectification stage is enabled. */
export function shouldRunRectification(config: ExecutionGatesConfig): boolean;
```

`shouldKeepSessionOpen` replaces:
- `session-runner.ts`: `role === "implementer" && (config.execution.rectification?.enabled ?? false)`
- `execution.ts`: `!!(ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true)`

Unified rule: **`role === "implementer" && (shouldRunReview(config) || shouldRunRectification(config))`**

`execution.ts` calls `shouldKeepSessionOpen(config, "implementer")` with a hardcoded role
literal — it manages a single implementer session and never varies the role. `session-runner.ts`
passes the `role` variable because it dispatches all three TDD roles through the same function.

#### 1B. `SessionKeeper` — session reuse + transport retry abstraction

New file `src/session/session-keeper.ts`. Encapsulates the `getLiveHandle → openSession →
try/catch transport retry → bindHandle` pattern duplicated in `rectification-loop.ts` and
`rectification-gate.ts`.

```typescript
import type { RetryStrategy } from "../agents/retry";
import type { IAgentManager } from "../agents/manager-types";
import type { SessionHandle, TurnResult } from "../agents/types";
import type { ModelDef } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ISessionManager, SessionRole } from "../session/types";

export interface SessionKeeperOptions {
  readonly sessionName: string;
  readonly defaultAgent: string;
  readonly role: SessionRole;
  readonly pipelineStage: PipelineStage;
  readonly storyId: string;
  readonly featureName: string;
  readonly workdir: string;
  readonly projectDir?: string;
  readonly modelDef: ModelDef;
  readonly timeoutSeconds: number;
  /**
   * Transport retry policy for retryable SessionTurnErrors.
   * Callers build this from resolveRetryPreset({ preset: "transient-network",
   * maxAttempts: config.execution.sessionErrorRetryableMaxRetries + 1, baseDelayMs: 0 }).
   * Defaults to no retries when absent.
   */
  readonly retryStrategy?: RetryStrategy;
  readonly signal?: AbortSignal;
  readonly maxTurns?: number;
}

export interface SessionKeeperSendOptions {
  readonly prompt: string;
}

/**
 * Manages a single held session handle across multiple send() calls.
 * On each send: reuses an existing live handle (getLiveHandle) if present,
 * or opens a new one (openSession). On SessionTurnError with retryable=true,
 * discards the stale handle and delegates to the injected `retryStrategy` for the retry decision.
 * Call close() in a finally block to ensure the handle is released.
 */
export class SessionKeeper {
  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly agentManager: IAgentManager,
    private readonly opts: SessionKeeperOptions,
  ) {}

  /** Send one turn. Reuses or opens the held handle. Retries on retryable transport errors. */
  async send(opts: SessionKeeperSendOptions): Promise<TurnResult>;

  /**
   * Bind protocolIds from the last turn to the session descriptor for the audit trail.
   * Always uses heldHandle.id as the descriptor key — this is the canonical form.
   * (rectification-loop.ts previously passed a separate `sessionId` variable as the
   * first arg to bindHandle; that was a divergence bug corrected as part of US-002.)
   */
  bindProtocolIds(): void;

  /** Close the held handle (best-effort). Safe to call when no handle is open. */
  async close(): Promise<void>;
}
```

Both `rectification-loop.ts` and `rectification-gate.ts` replace their ~75-line `while` blocks
with a `SessionKeeper` instance, constructed in the caller's scope and closed in `.finally()`.

`bindHandle` argument canonicalisation: `rectification-gate.ts` passes `heldHandle.id` as the
first arg to `bindHandle`; `rectification-loop.ts` incorrectly passes a separate `sessionId`
variable (the story descriptor ID). US-002 fixes the loop to also use `heldHandle.id`, making
`SessionKeeper.bindProtocolIds()` the single implementation that all callers delegate to.

#### 1C. Upgrade TDD role tags to full `RunOperation` shapes

`implement.ts`, `verify.ts`, `write-test.ts` are currently thin re-exports of `TddRunOp`
(a minimal `{ role: TddSessionRole }` tag). Each is upgraded to a standalone
`RunOperation<Input, Output, TddConfig>` per ADR-020 §D.

These roles are not TDD-specific — the implementer role is shared by both single-session and
TDD paths, and test-writer / verifier may be used outside TDD in the future. Input/output types
are therefore defined alongside their op in `src/operations/` (not in `src/tdd/types.ts`) and
named without a `Tdd` prefix.

**`src/operations/implement.ts`** — implementer input/output + op:

```typescript
export interface ImplementerInput {
  readonly story: UserStory;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
}

export const implementerOp: RunOperation<ImplementerInput, ImplementerOutput, TddConfig> = {
  kind: "run",
  name: "implementer",
  stage: "run", // PipelineStage — see src/config/permissions.ts:15
  session: { role: "implementer", lifetime: "warm" },
  config: tddConfigSelector,
  build(input, ctx): ComposeInput { ... },
  parse(output, input, ctx): ImplementerOutput { ... },
};
```

**`src/operations/write-test.ts`** — test-writer input/output + op:

```typescript
// Test-writer receives the same full context as the implementer.
export interface TestWriterInput {
  readonly story: UserStory;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface TestWriterOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
}

export const testWriterOp: RunOperation<TestWriterInput, TestWriterOutput, TddConfig> = {
  kind: "run",
  name: "test-writer",
  stage: "run",
  session: { role: "test-writer", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, ctx): ComposeInput { ... },
  parse(output, input, ctx): TestWriterOutput { ... },
};
```

**`src/operations/verify.ts`** — verifier input/output + op:

```typescript
// Verifier uses limited context — no feature context, no constitution.
// (verifierLimitedContext=true in the current session-op.ts role resolution.)
export interface VerifierInput {
  readonly story: UserStory;
}

export interface VerifierOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  /** Isolation check result, populated when isolation was run. */
  readonly isolation?: IsolationCheck;
}

export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify", // verifier runs after implementer — verify-stage permissions apply
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, ctx): ComposeInput { ... },
  parse(output, input, ctx): VerifierOutput { ... },
};
```

`runTddSessionOp` in `session-op.ts` is updated to call `callOp(ctx, op, input)` for these
three ops instead of calling `runTddSession()` directly. `TddRunOp` is retired and `session-op.ts`
is deleted (or kept as a thin re-export shim until all callers are updated).

**`CallContext` wiring:** `callOp` requires a `CallContext` that carries `runtime: NaxRuntime`,
`packageView: PackageView`, `agentName`, etc. `TddSessionOpOptions` gains a `runtime: NaxRuntime`
field so `runTddSessionOp` can construct the `CallContext` internally:

```typescript
// addition to TddSessionOpOptions in src/tdd/session-op.ts
runtime: NaxRuntime;

// inside runTddSessionOp, before calling callOp:
// Thread interactionBridge so multi-turn Q&A is preserved for implementer + test-writer.
// Verifier does not receive an interactionBridge (includeContext=false for that role).
const interactionBridge = includeContext && options.interactionChain
  ? buildInteractionBridge(options.interactionChain, {
      featureName: options.featureName,
      storyId: options.story.id,
      stage: "execution",
    })
  : undefined;

const ctx: CallContext = {
  runtime: options.runtime,
  packageView: options.runtime.packageView(options.story.workdir ?? ""),
  agentName: options.agentManager.getDefault() ?? "claude",
  storyId: options.story.id,
  featureName: options.featureName,
  story: options.story,
  ...(interactionBridge ? { interactionBridge } : {}),
};
```

`TddSessionOpOptions` already carries `interactionChain?: InteractionChain | null` — no new
field is needed. `includeContext` is already resolved per-role before this block runs
(verifier has `includeContext = false`, so its bridge is always omitted). All callers of
`runTddSessionOp` in `tdd/orchestrator.ts` pass `runtime` — `NaxRuntime` is already available
there via the orchestrator's construction-time dependency.

### Phase 2 — `StoryOrchestratorBuilder`

New file `src/execution/story-orchestrator.ts`. A builder that declaratively assembles the
phases for one story execution, then runs them in order. The builder is a **pure dispatcher
over ops** — every phase is a `callOp(ctx, op, input)` invocation. The builder does not own
session loops, does not catch exceptions for control flow, and does not let callers inject
ad-hoc closures.

#### 2A. Slot shape (generic, type-safe)

```typescript
export interface OrchestratorSlot<I, O, C> {
  readonly op: RunOperation<I, O, C>;
  readonly input: I;
}
```

`OrchestratorSlot` is generic so each `add*` method preserves the typed `RunOperation` it
receives. Internally the builder stores a heterogeneous list
(`OrchestratorSlot<unknown, unknown, unknown>[]`), but **callers never cast** — typed `add*`
methods accept the typed op + input.

#### 2B. Builder API

```typescript
export class StoryOrchestratorBuilder {
  addImplementer(input: ImplementerInput): this;
  addTestWriter(input: TestWriterInput): this;             // TDD only
  addVerifier(input: VerifierInput): this;                  // TDD only
  addSemanticReview(input: SemanticReviewInput): this;      // if review.semantic enabled
  addAdversarialReview(input: AdversarialReviewInput): this; // if review.adversarial enabled
  /** Enable the rectification phase. See §2D for contract. */
  addRectification(opts: RectificationPhaseOptions): this;
  build(ctx: CallContext): ExecutionPlan;
}

export interface ExecutionPlan {
  /** Run all configured phases in order. Returns aggregated results. */
  run(): Promise<StoryOrchestratorResult>;
}
```

**Review op provenance.** `addSemanticReview` and `addAdversarialReview` accept the existing
`SemanticReviewInput` and `AdversarialReviewInput` from `src/operations/semantic-review.ts:15`
and `src/operations/adversarial-review.ts:14` respectively. The builder dispatches
`semanticReviewOp` and `adversarialReviewOp` as-is — no new op definitions, no new input types.

**Phase ordering.** The canonical run order is:

```
test-writer (if added)
  → implementer
  → verifier (if added)
  → semantic review (if added)
  → adversarial review (if added)
  → rectification (if added)
```

Semantic runs before adversarial because adversarial is more expensive and is gated on
mechanical/semantic passing in the existing `ReviewConfig.gateLLMChecksOnMechanicalPass`
contract (`src/review/types.ts:202`). Rectification, when enabled, consumes failures from
**all** prior phases that ran (verifier, semantic, adversarial) — see §2D step 1.

#### 2C. Dispatch contract — `callOp` is mandatory (Layer 4)

Per `adapter-wiring.md` Rule 1, the builder dispatches **every** phase via `callOp(ctx, op, input)`.

- **No Layer 3 (`agentManager.runWithFallback`).** Layer 3 bypasses middleware, `op.retry`,
  `op.recover`, `interactionBridge`, `packageView.select`, and `DispatchEvent` cost
  attribution. Reaching for Layer 3 was the root cause of the failed US-004 attempt
  (archive tag `archive/story-orchestrator-us004-attempt`).
- **No per-slot `runner` closures.** `OrchestratorSlot` does NOT carry an `(ctx) => Promise`
  field. If a phase cannot be expressed as `callOp(ctx, op, input)`, the op itself must grow
  `hopBody`, `verify`, or `recover` — not the builder.
- **No outer-scope `sharedState`.** Phase outputs flow exclusively through
  `StoryOrchestratorResult.phaseOutputs[op.name]`. Subsequent phases that need a prior result
  read it from the result map at construction time (the wrapper) or via the phase's own input
  derivation (see §2D).
- **No exception-as-control-flow.** Ops return structured `{ success: false, … }` for
  expected failures. `ExecutionPlan.run()` catches only true thrown errors (not "early exit"
  exceptions) and logs them with `storyId` + phase name before propagating.

#### 2D. Rectification phase contract

`addRectification(opts)` enables a loop that resolves the failing op per-iteration via the
existing `FixStrategy` machinery in `findings/cycle.ts`.

```typescript
export interface RectificationPhaseOptions {
  /** Max rectification attempts. From config.execution.rectification.maxRetries. */
  readonly maxAttempts: number;
  /** Strategies in priority order. Built from existing implementerRectifyOp / testWriterRectifyOp ops. */
  readonly strategies: FixStrategy<ReviewCheckResult, unknown, unknown, AutofixConfig>[];
  /** Abort if failure count increases between iterations. From config.execution.rectification.abortOnIncreasingFailures. */
  readonly abortOnIncreasingFailures: boolean;
}
```

**Loop body, per iteration:**
1. Aggregate failures from every prior phase that ran: `phaseOutputs[verifierOp.name]`
   (TDD path), `phaseOutputs[semanticReviewOp.name]`, and
   `phaseOutputs[adversarialReviewOp.name]`. Failures are typed as `ReviewCheckResult[]`.
   When multiple phases produced failures, concatenate; `runFixCycle` handles strategy
   selection across the combined set.
2. Call `runFixCycle(strategies, failures, ctx)` from `findings/cycle.ts`. It picks the
   active strategy and returns the chosen op + input. The cycle is the single decision
   point — the builder does not introspect failure types itself.
3. Dispatch the chosen op via `callOp(ctx, chosenOp, chosenInput)`.
4. Re-run the verifier (`callOp(ctx, verifierOp, verifierInput)`) to capture fresh
   verdict + failures. Overwrite `phaseOutputs["verifier"]`.
5. Stop when verifier reports `success: true`, when `attempts >= maxAttempts`, when
   `abortOnIncreasingFailures && newFailureCount > prevFailureCount`, or when the abort
   signal fires.

**Session lifecycle:** implementer session reuse across rectification iterations is owned by
`callOp` middleware via `implementerOp.session.lifetime === "warm"`. The orchestrator does
**not** construct a `SessionKeeper` — adding one in the builder duplicates the warm-lifetime
contract already enforced at the operations layer and violates §2C ("builder is a pure
dispatcher over ops"). The verifier and test-writer ops are `fresh` and open/close their own
sessions per iteration via the same callOp middleware.

`SessionKeeper` remains the SSOT for the legacy `rectification-loop.ts` and
`rectification-gate.ts` call sites (per US-002). Those sites do not flow through `callOp` and
therefore manage their own handle lifecycle.

**Verdict consumption:** the rectification phase reads `phaseOutputs["verifier"]` for its
fix decision but does not call `readVerdict()` or `categorizeVerdict()` — those remain in
the `tdd/orchestrator.ts` wrapper (see §2F). The phase consumes the structured
`VerifierOutput`, not the raw verdict file.

#### 2E. Result shape and reader contract

```typescript
export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  /**
   * Per-phase parsed outputs, keyed by op.name. Stored as `unknown` because the map is
   * heterogeneous across phases. **Reader contract:** wrappers MUST narrow via a type
   * guard or cast adjacent to the known op (e.g. cast `phaseOutputs[verifierOp.name]` to
   * `VerifierOutput` immediately after confirming the verifier ran). Do not generic-cast
   * the whole map and pass it around — keep narrowing localised to the read site.
   */
  readonly phaseOutputs: Record<string, unknown>;
}
```

We deliberately keep `Record<string, unknown>` rather than a generic phase-name → output
map because the slot list is heterogeneous and the wrappers are the only readers. The
named-op-adjacent cast pattern (e.g. `phaseOutputs[verifierOp.name] as VerifierOutput`)
keeps the unsafe edge isolated.

#### 2F. Scope boundary — what stays in `tdd/orchestrator.ts`

The builder owns phase dispatch, session management (via `SessionKeeper`), and cost
aggregation. The TDD wrapper retains:

- **Rollback** — `config.tdd.rollbackOnFailure`: git reset to `initialRef` when
  `StoryOrchestratorResult.success === false`.
- **Verdict reading** — `readVerdict()` + `categorizeVerdict()` parse the verifier's
  on-disk verdict file. Wrapper reads `phaseOutputs[verifierOp.name]` and disk artifact.
- **Isolation surfacing** — collect `IsolationCheck` from `phaseOutputs` per session and
  populate `ThreeSessionTddResult.sessions`.
- **Greenfield-no-tests detection** — inspecting test-writer output to decide whether to
  skip the implementer/verifier slots entirely (current behaviour after `testWriterOp`).
- **`priorFailures` review-escalation skip** — skipping `addTestWriter` on a retry when
  `priorFailures.length > 0` so the wrapper varies the builder configuration per attempt.
- **Full-suite gate** — currently invoked between implementer and verifier in
  `tdd/rectification-gate.ts`. Stays in the wrapper; runs around `plan.run()` rather than
  inside it.

These are wrapper responsibilities. The builder must not learn about TDD-specific files,
verdict semantics, or test-skipping heuristics.

#### 2G. Forbidden patterns (from the failed attempt)

Based on commit `5d3dea52` (archive tag `archive/story-orchestrator-us004-attempt`):

| ❌ Forbidden | Why | ✅ Use Instead |
|:---|:---|:---|
| `OrchestratorSlot.runner?: (ctx) => Promise<…>` | Closures escape the contract; bypass `callOp` middleware | Grow `hopBody` / `verify` / `recover` on the op |
| `agentManager.runWithFallback` in builder code | Layer 3 bypasses `op.retry`, `interactionBridge`, `packageView.select`, `DispatchEvent` | `callOp(ctx, op, input)` per §2C |
| Outer-scope `let sharedState = {}` mutated by phase callbacks | Hides data flow; defeats `phaseOutputs` SSOT | Read prior outputs via `phaseOutputs[priorOp.name]` |
| `throw new NaxError("early exit", …)` to short-circuit `plan.run()` | Exceptions-as-control-flow obscures failure attribution | Return `{ success: false, … }` from the op; let `plan.run()` check and stop |
| `try { … } catch { success = false }` in `ExecutionPlan.run()` without logging | Silently swallows failures | Log with `{ storyId, phase: op.name, error: errorMessage(err) }` then propagate |
| Generic-casting `phaseOutputs as SomeShape` once at the top of the wrapper | Spreads unsafe assumptions through the file | Narrow at the read site, adjacent to the named op |

### Failure Handling

- `SessionKeeper.send()` — on non-retryable `SessionTurnError`, re-throws immediately. On retryable
  error, delegates to `retryStrategy.shouldRetry(err, attempt)` — re-throws when the strategy
  returns `{ retry: false }` or when no `retryStrategy` is provided.
- `ExecutionGates` functions — pure, no failure modes. Return `false` when config key is absent.
- Upgraded TDD ops — `parse()` returns a graceful degraded value (success=false, filesChanged=[])
  rather than throwing when agent output is unparseable; op-level `recover` re-reads disk artifacts.
- `StoryOrchestratorBuilder.build()` — throws `NaxError("ORCHESTRATOR_NO_IMPLEMENTER")` if
  `addImplementer` was never called (implementer is mandatory in all execution paths).

---

## Stories

### US-001: `ExecutionGates` — config gate SSOT  
**No dependencies**

Extract all config-gate boolean checks into `src/operations/execution-gates.ts`. Wire into
`session-runner.ts` (TDD keepOpen) and `execution.ts` (single-session keepOpen). Delete the
two divergent inline checks.

Delete path-specific test: `test/unit/tdd/session-runner-keep-open.test.ts` (tests the old
inline condition). Replace with a test on `ExecutionGates` directly.

#### Context Files
- `src/operations/execution-gates.ts` — new file (to be created)
- `src/config/selectors.ts` — add `executionGatesConfigSelector` and `ExecutionGatesConfig`
- `src/tdd/session-runner.ts` — line 213: `keepOpen` inline check to replace
- `src/pipeline/stages/execution.ts` — line 161: `keepOpen` inline check to replace
- `test/unit/tdd/session-runner-keep-open.test.ts` — to be deleted
- `test/unit/operations/autofix-implementer.test.ts` — follow test style

---

### US-002: `SessionKeeper` — session reuse + transport retry  
**No dependencies**

Create `src/session/session-keeper.ts` with the `SessionKeeper` class. Replace the `~75-line
while` blocks in `rectification-loop.ts` (the `while (true)` at line 321, outer scope from
line 308) and `rectification-gate.ts` (the `while (true)` at line 309, outer scope from
line 307) with `SessionKeeper` instances.

Delete path-specific tests:
- `test/unit/tdd/rectification-gate-session.test.ts` (all 9 tests — TDD session wiring)
- `test/unit/tdd/session-runner-bindhandle.test.ts` (~5 tests — TDD protocolId binding)

Keep behaviour tests:
- `test/unit/verification/rectification-loop.test.ts` — update mocks to go through `SessionKeeper`
- `test/unit/tdd/rectification-gate.test.ts` — keep gate pass/fail decision tests

#### Context Files
- `src/session/session-keeper.ts` — new file (to be created)
- `src/session/manager.ts` — `ISessionManager` interface, `getLiveHandle`, `openSession`, `bindHandle` signatures
- `src/verification/rectification-loop.ts` — `while (true)` at line 321 (outer scope line 308): exact block to replace
- `src/tdd/rectification-gate.ts` — `while (true)` at line 309 (outer scope line 307): exact block to replace
- `src/agents/types.ts` — `SessionTurnError`, `TurnResult`
- `test/unit/tdd/rectification-gate-session.test.ts` — to be deleted
- `test/unit/tdd/session-runner-bindhandle.test.ts` — to be deleted

---

### US-003: Upgrade TDD ops to full `RunOperation` shapes  
**No dependencies** (can run in parallel with US-001 and US-002)

Replace `TddRunOp` role tags in `implement.ts`, `verify.ts`, `write-test.ts` with full
`RunOperation<Input, Output, TddConfig>` definitions. Each op file owns its own Input/Output
types: `ImplementerInput` / `ImplementerOutput` in `src/operations/implement.ts`,
`TestWriterInput` / `TestWriterOutput` in `src/operations/write-test.ts`, `VerifierInput` /
`VerifierOutput` in `src/operations/verify.ts`. Update `session-op.ts`'s `runTddSessionOp` to
call `callOp` for the three ops — add `runtime: NaxRuntime` to `TddSessionOpOptions` so
`runTddSessionOp` can construct the required `CallContext` (see Design §1C). Delete `TddRunOp`
from `session-op.ts` and remove the interface from the exported barrel.

Delete path-specific tests:
- `test/unit/tdd/session-op.test.ts` — role-tag constants and prompt-limiting tests (obsolete after upgrade)

Keep behaviour tests:
- `test/integration/tdd/tdd-orchestrator-core.test.ts` — orchestration sequence
- `test/unit/operations/autofix-implementer.test.ts` — follow parse() style for new op parse tests

#### Context Files
- `src/operations/implement.ts` — current content (re-export to replace); owns `ImplementerInput` / `ImplementerOutput`
- `src/operations/verify.ts` — current content (re-export to replace); owns `VerifierInput` / `VerifierOutput`
- `src/operations/write-test.ts` — current content (re-export to replace); owns `TestWriterInput` / `TestWriterOutput`
- `src/tdd/session-op.ts` — `runTddSessionOp` to update; `TddRunOp` to retire
- `src/operations/types.ts` — `RunOperation<I,O,C>` and `CallContext` interfaces to implement
- `src/operations/autofix-implementer.ts` — reference implementation to follow
- `src/config/selectors.ts` — `tddConfigSelector` and `TddConfig` type
- `src/runtime/index.ts` — `NaxRuntime` type (add to `TddSessionOpOptions`)
- `src/tdd/orchestrator.ts` — callers of `runTddSessionOp` to update (pass `runtime`)

---

### US-004: `StoryOrchestratorBuilder` — unified builder  
**Depends on US-001, US-002, US-003**

Create `src/execution/story-orchestrator.ts` with `StoryOrchestratorBuilder` and `ExecutionPlan`
per Design §2A–§2G. Every phase dispatches via `callOp(ctx, op, input)` — no Layer 3, no
per-slot runner closures, no `sharedState`, no exception-as-control-flow (see §2G forbidden
patterns). Refactor `src/pipeline/stages/execution.ts` and `src/tdd/orchestrator.ts` to
configure and run the builder; the TDD wrapper retains rollback / verdict reading / isolation
surfacing / greenfield detection / priorFailures skip / full-suite gate per §2F.

**Reference (failed attempt):** archive tag `archive/story-orchestrator-us004-attempt`,
commit `5d3dea52`. The failures the new design prevents are enumerated in §2G.

Delete path-specific tests:
- `test/unit/pipeline/stages/execution-tdd-simple.test.ts` — tests routing between old separate paths
- `test/integration/tdd/rectification-gate-orchestrator.test.ts` — type signature tests for old API

Keep behaviour tests:
- `test/integration/tdd/tdd-orchestrator-core.test.ts` — verify three-session sequence still works
- `test/integration/tdd/tdd-orchestrator-verdict.test.ts` — verdict semantics
- `test/unit/verification/rectification-loop-escalation.test.ts` — escalation logic

#### Context Files
- `src/execution/story-orchestrator.ts` — new file (to be created)
- `src/pipeline/stages/execution.ts` — entry point to refactor
- `src/tdd/orchestrator.ts` — entry point to refactor
- `src/operations/execution-gates.ts` — from US-001
- `src/session/session-keeper.ts` — from US-002
- `src/operations/implement.ts` — from US-003
- `src/operations/verify.ts` — from US-003
- `src/operations/write-test.ts` — from US-003
- `src/operations/call.ts` — `callOp` call pattern to follow
- `src/operations/types.ts` — `CallContext` shape
- `src/tdd/verdict.ts` (or wherever `readVerdict`/`categorizeVerdict` live) — post-processing that stays in the `tdd/orchestrator.ts` wrapper
- `src/tdd/types.ts` — `FailureCategory`, `IsolationCheck` for wrapper post-processing

---

## Acceptance Criteria

### US-001: `ExecutionGates`

- `shouldKeepSessionOpen(config, "implementer")` returns `true` when `config.review.enabled` is `true`
- `shouldKeepSessionOpen(config, "implementer")` returns `true` when `config.execution.rectification.enabled` is `true`
- `shouldKeepSessionOpen(config, "implementer")` returns `false` when both `review.enabled` and `rectification.enabled` are absent or `false`
- `shouldKeepSessionOpen(config, "test-writer")` returns `false` regardless of review or rectification config
- `shouldKeepSessionOpen(config, "verifier")` returns `false` regardless of review or rectification config
- `shouldRunReview(config)` returns `true` when `config.review.enabled` is `true`
- `shouldRunReview(config)` returns `false` when `config.review` is absent
- `shouldRunRectification(config)` returns `true` when `config.execution.rectification.enabled` is `true`
- `shouldRunRectification(config)` returns `false` when `config.execution.rectification` is absent
- Both `session-runner.ts` and `execution.ts` replace their inline `keepOpen` expressions with calls to `shouldKeepSessionOpen`

### US-002: `SessionKeeper`

- `SessionKeeper.send()` returns the `TurnResult` from `agentManager.runAsSession` on success
- `SessionKeeper.send()` calls `sessionManager.getLiveHandle(sessionName)` first; if a live handle with a matching `agentName` exists it is reused; otherwise `openSession` is called
- When `agentManager.runAsSession` throws `SessionTurnError` with `retryable: true`, `send()` discards the held handle, calls `sessionManager.closeSession` on the stale handle, and delegates to `retryStrategy.shouldRetry` — retrying when the strategy permits and re-throwing when it doesn't or when no strategy is provided
- When `agentManager.runAsSession` throws `SessionTurnError` with `retryable: false`, `send()` re-throws immediately
- `SessionKeeper.bindProtocolIds()` calls `sessionManager.bindHandle(heldHandle.id, sessionName, protocolIds)` when the held handle has `protocolIds` defined
- `SessionKeeper.bindProtocolIds()` does nothing when the held handle has no `protocolIds`
- `SessionKeeper.close()` calls `sessionManager.closeSession` on the held handle when one is open, and is safe to call when no handle is held
- Both `rectification-loop.ts` and `rectification-gate.ts` replace their inline `while` blocks with a `SessionKeeper` instance constructed in the caller's scope and closed in `.finally()`

### US-003: TDD op upgrades

- `implementerOp.kind` equals `"run"`, `session.role` equals `"implementer"`, and `session.lifetime` equals `"warm"`
- `testWriterOp.session.role` equals `"test-writer"` and `session.lifetime` equals `"fresh"`
- `verifierOp.session.role` equals `"verifier"` and `session.lifetime` equals `"fresh"`
- `implementerOp.parse(output, input, ctx)` returns `ImplementerOutput` with `success: false` and `filesChanged: []` when `output` is empty or unparseable (graceful degradation — no throw)
- `runTddSessionOp` routes to the correct op via `callOp` based on `op.session.role` (`implementerOp`, `testWriterOp`, or `verifierOp`) without calling `runTddSession()` directly
- `TddRunOp` interface is not exported from `src/operations/index.ts` after the upgrade
- `test/unit/tdd/session-op.test.ts` is deleted

### US-004: `StoryOrchestratorBuilder`

- `OrchestratorSlot<I, O, C>` is generic; the typed `add*` methods accept the typed op + input without requiring callers to cast (no `as unknown as RunOperation<unknown, …>` at call sites)
- `StoryOrchestratorBuilder.build(ctx)` throws `NaxError` with code `"ORCHESTRATOR_NO_IMPLEMENTER"` when `addImplementer` was not called
- `ExecutionPlan.run()` executes slots in canonical order: test-writer (if added) → implementer → verifier (if added) → semantic review (if added) → adversarial review (if added) → rectification (if added); any slot not added is skipped. `addAdversarialReview` uses the existing `adversarialReviewOp` / `AdversarialReviewInput` from `src/operations/adversarial-review.ts`; `addSemanticReview` uses the existing `semanticReviewOp` / `SemanticReviewInput` from `src/operations/semantic-review.ts`
- `ExecutionPlan.run()` dispatches every phase via `callOp(ctx, slot.op, slot.input)` — no calls to `agentManager.runWithFallback`, no per-slot `runner` closures, no outer-scope `sharedState` mutation
- `ExecutionPlan.run()` returns `StoryOrchestratorResult.success === false` (no throw) when any op returns `{ success: false }`; thrown errors are logged with `{ storyId, phase: op.name, error }` and propagated
- `StoryOrchestratorResult` captures per-slot costs in `phaseCosts` (keyed by `op.name`), their sum as `totalCostUsd`, and parsed phase outputs in `phaseOutputs` (keyed by `op.name`, typed as `Record<string, unknown>` with read-site narrowing)
- `addRectification(opts)` loops per §2D: reads failures from `phaseOutputs[verifierOp.name]`, resolves the fix via `runFixCycle(opts.strategies, …)`, dispatches the chosen op via `callOp`, re-runs the verifier, and terminates on success / `maxAttempts` / `abortOnIncreasingFailures` / abort signal
- The rectification phase does **not** construct a `SessionKeeper`; implementer session reuse across iterations is owned by `callOp` middleware via `implementerOp.session.lifetime === "warm"` (see §2D Session lifecycle). `SessionKeeper` remains the SSOT for the legacy `rectification-loop.ts` / `rectification-gate.ts` call sites per US-002
- Both `execution.ts` (single-session) and `tdd/orchestrator.ts` (TDD) dispatch every agent phase through `StoryOrchestratorBuilder`. The `if (isTddStrategy)` branch in `pipeline/stages/execution.ts` is retained as a wrapper-selection switch — it routes to the appropriate wrapper, neither wrapper bypasses the builder. Eliminating the branch entirely is tracked separately as [SPEC-story-orchestrator-consolidation.md](./SPEC-story-orchestrator-consolidation.md) (US-005)
- `tdd/orchestrator.ts` retains rollback, verdict reading, isolation surfacing, greenfield-no-tests detection, `priorFailures` review-escalation skip, and the full-suite gate — none of these appear inside the builder or any op
