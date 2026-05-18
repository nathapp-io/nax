# SPEC: StoryOrchestrator — Unified Execution Path Consolidation

**Issues:** #1058 (session keep-open fix), orchestration refactor  
**Branch:** `refactor/story-orchestrator`  
**Phases:** Phase 1 (shared helpers + op upgrades), Phase 2 (StoryOrchestratorBuilder)

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
  stage: "execution",
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
  stage: "execution",
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
  stage: "execution",
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
phases for one story execution, then runs them in order.

```typescript
export interface OrchestratorSlot {
  readonly op: RunOperation<unknown, unknown, unknown>;
  readonly input: unknown;
}

export class StoryOrchestratorBuilder {
  addImplementer(input: ImplementerInput): this;
  addTestWriter(input: TestWriterInput): this;   // TDD only
  addVerifier(input: VerifierInput): this;        // TDD only
  addSemanticReview(input: SemanticReviewInput): this;    // if review.semantic enabled
  addAdversarialReview(input: AdversarialReviewInput): this; // if review.adversarial enabled
  /**
   * Enable rectification. No role is pre-declared — the rectification phase
   * uses the existing FixStrategy resolution from findings/cycle.ts to determine
   * at runtime which op runs (implementerRectifyOp, testWriterRectifyOp, or both
   * in sequence) based on the actual failure type in each iteration.
   */
  addRectification(): this;
  build(ctx: CallContext): ExecutionPlan;
}

export interface ExecutionPlan {
  /** Run all slots in order, returning results per phase. */
  run(): Promise<StoryOrchestratorResult>;
}
```

`execution.ts`'s TDD-path branch and `tdd/orchestrator.ts` become thin callers that configure
the builder based on `config` flags and `routing.testStrategy`, then call `plan.run()`.

**Scope boundary — what stays outside the builder:**  
The builder owns phase sequencing, session management (via `SessionKeeper`), and cost
accumulation. The following TDD-specific behaviours remain in `tdd/orchestrator.ts` as a thin
wrapper around `plan.run()`:

- **Rollback** — `config.tdd.rollbackOnFailure`: git reset to `initialRef` on failure. The
  wrapper reads `StoryOrchestratorResult.success` and calls `rollback()` when needed.
- **Verdict reading** — `readVerdict()` + `categorizeVerdict()`: parsing the verifier's output
  file after the verifier slot completes. The wrapper receives the verifier's `VerifierOutput`
  from `StoryOrchestratorResult.phaseOutputs["verifier"]` and processes it.
- **Isolation surfacing** — `IsolationCheck` per session: the wrapper collects these from
  `StoryOrchestratorResult.phaseOutputs` and populates `ThreeSessionTddResult.sessions`.

To support this, `StoryOrchestratorResult` adds:

```typescript
export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  /** Per-phase parsed outputs, keyed by op name. Wrappers read these for post-processing. */
  readonly phaseOutputs: Record<string, unknown>;
}
```

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

Create `src/execution/story-orchestrator.ts` with `StoryOrchestratorBuilder` and `ExecutionPlan`.
Refactor `src/pipeline/stages/execution.ts` and `src/tdd/orchestrator.ts` to configure and run
the builder instead of branching internally.

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

- `StoryOrchestratorBuilder.build(ctx)` throws `NaxError` with code `"ORCHESTRATOR_NO_IMPLEMENTER"` when `addImplementer` was not called
- `ExecutionPlan.run()` executes slots in declaration order: test-writer (if added) → implementer → verifier (if added) → semantic review (if added) → rectification (if added)
- `ExecutionPlan.run()` skips any slot that was not declared via the corresponding `add*` method
- `StoryOrchestratorResult` captures per-slot costs in `phaseCosts` (keyed by op name), their sum as `totalCostUsd`, and parsed phase outputs in `phaseOutputs` (keyed by op name)
- Both `execution.ts` and `tdd/orchestrator.ts` replace their internal session loops with `StoryOrchestratorBuilder` — no residual `if (isTddStrategy)` branch that duplicates session management
- `tdd/orchestrator.ts` reads `StoryOrchestratorResult.phaseOutputs["verifier"]` to run `readVerdict()` / `categorizeVerdict()` post-processing
- `tdd/orchestrator.ts` reads `StoryOrchestratorResult.success` and triggers git rollback (reset to `initialRef`) when `config.tdd.rollbackOnFailure` is `true`
