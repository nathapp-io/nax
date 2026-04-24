# ADR-015: Operation Contract, SessionRunners, and Control-Flow Layer

**Status:** Reject
**Date:** 2026-04-23
**Author:** William Khoo, Claude
**Extends:** ADR-014 (RunScope & Middleware); ADR-013 (SessionManager → AgentManager Hierarchy); ADR-012 (AgentManager Ownership)
**Followed-by:** ADR-016 (Prompt Composition & PackageView)
**Depends-on:** ADR-014 must land first — `RunScope` and agent middleware are preconditions for this ADR.

---

## Context

ADR-014 introduced `RunScope`, agent middleware, and collapsed the 8 orphan `createAgentManager` sites into one scope-owned manager. Cost and audit became uniform. `IAgent` can only be obtained via `scope.getAgent()`, so every LLM call is middleware-wrapped.

With that foundation in place, three remaining problems surface:

### Problem 1 — Operations have no standard shape

Every agent-using subsystem invents its own ceremony on top of `scope.getAgent()`: construct prompt via builder, resolve permissions, tag logs, wrap errors, attribute cost, thread `signal`. The middleware from ADR-014 covers the side effects (cost, audit), but each call site still writes ~15 lines of shape: which agent, which builder, which config slice, which permission stage, which error envelope.

Plugins that want to add a new review pass, a new analysis operation, or a new generator must copy this shape and hope they get it right. There is no declarative contract.

### Problem 2 — `.plan()` and `.decompose()` conflate transport with domain

ADR-013 restricted `IAgentManager` to `run()` + `complete()`, but `AgentAdapter.plan()` and `AgentAdapter.decompose()` still exist as manager-internal methods. These are not transport primitives:

- `decompose` is 100% prompt composition: build prompt → `complete()` with `jsonMode: true` → parse JSON.
- `plan` is `run()` with a `mode` option and specific permissions.

Keeping them on the adapter forces every new agent (codex, gemini, future) to implement both, bloats the adapter surface, and pins prompt-building inside the adapter layer — a direct violation of the Prompt Builder Convention (`forbidden-patterns.md`).

### Problem 3 — Retry loops and topologies are indistinguishable from operations today

Rectification, debate, and the execution runner itself each reinvent their own loop: iterate, call agent, check result, maybe escalate, maybe retry. Some live inside a stage (`verification/rectification-loop.ts`), some inside helpers (`debate/session-helpers.ts`), some inside the runner (`execution/runner.ts` iteration).

The boundary between "a single semantic call" and "a loop that invokes many calls" has never been drawn. Callers can't reuse rectification across stages (acceptance has its own, review has its own, smart-runner has its own). Escalation — which decides the tier of the **next** call, not the current one — is mixed into the same files as the calls themselves.

---

## Decision

Three pieces:

1. **`Operation<I, O, C>`** — standardized semantic call unit. Declarative `requires`. Invoked via `scope.invoke()`. Each operation is one or more LLM calls with a defined prompt shape and result.
2. **`ISessionRunner` implementations** — topology unit (ADR-013). Decides "how many sessions in what arrangement." Invokes operations.
3. **Control-flow layer** — named non-operations: escalation, rectification loop, runner iteration. They invoke operations; they are not operations.

`.plan()` and `.decompose()` are deleted from the adapter and become operations.

---

### 1. `Operation<I, O, C>` contract

The semantic unit above `ISessionRunner`. Where `ISessionRunner` answers "how many sessions and in what topology", `Operation` answers "what am I trying to accomplish semantically, with what config, at what permission level."

```typescript
// src/operations/types.ts
export interface Operation<I, O, C = NaxConfig> {
  readonly name: string;                     // "plan" | "decompose" | "review" | "rectify" | ...
  readonly requires: OperationRequires<C>;
  execute(ctx: OperationContext<C>, input: I): Promise<O>;
}

export interface OperationRequires<C> {
  readonly session: boolean;                 // if true, scope provides ISession in ctx
  readonly sessionRole?: SessionRole;        // required iff session === true; default role (runner may override via InvokeOptions.sessionRole)
  readonly sessionLifetime?: "fresh" | "warm"; // default "fresh"; "warm" = keepOpen:true per ADR-008 matrix
  readonly scope: "package" | "cross-package" | "repo";
  readonly permissions: PipelineStage;       // drives resolvePermissions()
  readonly config: ConfigSelector<C>;        // narrows NaxConfig → C
}

export type ConfigSelector<C> =
  | ((config: NaxConfig) => C)
  | readonly (keyof NaxConfig)[];            // sugar: ["review", "debate"] → pick those keys

export interface OperationContext<C> {
  readonly scope: RunScope;
  readonly agent: IAgent;                    // already middleware-wrapped by ADR-014
  readonly session?: ISession;               // present iff requires.session
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly story?: UserStory;
  readonly repoRoot: string;
  readonly packageDir: string;               // required for package-scoped ops
  readonly config: C;                        // pre-sliced by requires.config
  readonly signal: AbortSignal;
  readonly logger: Logger;                   // pre-scoped { storyId, packageDir, op: name }
}
```

#### 1.1 Config slicing — selector forms

Two equivalent forms. The keyof-array form is sugar for the 95% case that just picks top-level keys:

```typescript
// ✅ Sugar — select top-level keys
requires: { ..., config: ["review", "debate"] }
// type C inferred as Pick<NaxConfig, "review" | "debate">

// ✅ Selector — reshape, narrow nested fields
requires: { ..., config: (c) => ({
  review: c.review,
  debateReview: c.debate.stages.review,
})}
// type C inferred from the return type
```

Enforcement: operations reading `ctx.scope.config.*` outside the declared slice is a type error (Pick/projected types guide it) and a CI lint rule.

#### 1.2 `scope.invoke()` — the envelope

```typescript
// On RunScope (added by this ADR)
invoke<I, O, C>(op: Operation<I, O, C>, input: I, opts: InvokeOptions): Promise<O>;

export interface InvokeOptions {
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly story?: UserStory;
  readonly packageDir: string;
  readonly agentName?: string;              // override default agent (used by DebateSessionRunner)
  readonly signal?: AbortSignal;            // override scope-level signal
  readonly logger?: Logger;                 // override scope-level logger (used for per-proposer attribution)
  readonly sessionRole?: SessionRole;       // override op's declared role (e.g. runner stamps "debate-hybrid" / "plan-i")
  readonly discriminator?: string | number; // N-sibling disambiguator (debater index, proposal slot)
  readonly sessionHandle?: string;          // full ACP wire handle override — matches existing AgentRunOptions.sessionHandle escape hatch
}
```

What `scope.invoke()` does, per call:

1. Validate `opts` against `op.requires.scope` (package-scoped op with no `packageDir` → `NaxError`; cross-package op called with a single `packageDir` → `NaxError`).
2. Resolve the agent: `opts.agentName ?? scope.agentManager.getDefault()`. Obtain middleware-wrapped `IAgent` via `scope.getAgent(agentName)`.
3. Slice config: `ctx.config = resolveSlice(op.requires.config, scope.config)`.
   > **Forward-reference:** after ADR-016 introduces `PackageView`, slicing is applied to `ctx.package.config` (per-package-merged) instead of `scope.config` (root). Behavior is identical for single-package repos; polyglot monorepos gain per-package override support automatically.
4. Resolve permissions: `resolvePermissions(ctx.config, op.requires.permissions)` and set on the `IAgent` options for downstream calls.
5. If `op.requires.session`, thread session identity onto `AgentRunOptions` via `{ featureName, storyId, sessionRole: opts.sessionRole ?? op.sessionRole, discriminator: opts.discriminator, keepOpen: op.requires.sessionLifetime === "warm" }`. `scope.invoke()` does **not** mint sessionIds — the two-level ID model is preserved intact:
   - **SessionManager owns `descriptor.id` = `sess-<uuid>`** — the nax-internal state machine key. Minted by SessionManager, opaque to callers; used as the first argument to `runInSession()` (ADR-013).
   - **Adapter owns `descriptor.handle` = `nax-<hash8>-<feature>-<storyId>-<role>[-<discriminator>]`** — the ACP wire name, derived by `computeAcpHandle()` in [src/agents/acp/adapter.ts:175-193](src/agents/acp/adapter.ts#L175-L193) from the `AgentRunOptions` fields above. Deterministic: same role + storyId + feature + workdir → same handle → adapter's `loadSession` resumes automatically. This is how rectification's "reuse the implementer session" already works today ([src/verification/rectification-loop.ts:167](src/verification/rectification-loop.ts#L167)) and it survives unchanged.

   Ephemerality for reviewer "fresh-per-round" (ADR-008) is expressed via `keepOpen: false` on the relevant call, not via a separate flag — closing the session makes the next deterministic-handle derivation hit a fresh ACP session. If `op.requires.session` is false, `ctx.session = undefined`.
6. Build pre-scoped logger: `opts.logger ?? scope.services.logger.child({ storyId, packageDir, op: op.name })`.
7. Thread `opts.signal ?? scope.signal` through as `ctx.signal`.
8. Call `op.execute(ctx, input)`.
9. Wrap thrown errors as `NaxError` with `{ stage, operation: op.name, storyId, packageDir }` and `cause`.

No cost/audit logic lives here — it's all in ADR-014 middleware, on the `IAgent`. The envelope is purely shape (permissions + session + slicing + logger + error).

#### 1.3 Operation granularity — split rule

Make it an independent operation when **any** of the following differ:

- prompt builder (role, task framing, output format)
- result type
- declared config slice
- the call can legitimately run in isolation (e.g. semantic-only review with adversarial disabled)

Keep as one operation when variants differ only in internal strategy — same prompt shape, same result, config picks the strategy internally. Routing's keyword / LLM / plugin-chain classifiers are one `classifyRoute` operation; they produce the same `RouteResult` from the same inputs.

Compose via a thin composite operation that calls `scope.invoke()` on its parts. Never compose via a god-orchestrator class or by hardcoding sub-calls inside a single `execute()`. A composite operation is itself an `Operation<I, O, C>` and goes through the same envelope.

**Split decisions across the codebase:**

| Today | After — operations | Topology (ADR-013) |
|:---|:---|:---|
| `review/` semantic + adversarial | `semanticReview`, `adversarialReview`, `review` (composite, optional) | N/A (session-less) |
| `tdd/` writer + implementer + verifier | `writeTest`, `implement`, `verify` | `ThreeSessionRunner` invokes each in its session |
| `acceptance/` generate + refine + diagnose + fix | `generateAcceptance`, `refineAcceptance`, `diagnoseAcceptance`, `fixAcceptance` | `fixAcceptance` may use `SingleSessionRunner` |
| `debate/` one-shot + stateful + hybrid | `proposeCandidate`, `rebutCandidate`, `reviewDialogue`, `rankCandidates` | `DebateSessionRunner` (three internal modes) — used by both plan and review stages |
| `routing/` keyword + LLM + plugin-chain | One `classifyRoute` op; strategies are internal | N/A |
| `verification/` rectification-loop | `rectify` is an operation (one attempt); the loop is **control-flow** | N/A |
| Adapter `.plan()` | `plan` operation | N/A (wraps `agent.run()` internally) |
| Adapter `.decompose()` | `decompose` operation | N/A (wraps `agent.complete()` internally) |

**Composite example — `review`:**

```typescript
// src/operations/review.ts
export const review: Operation<ReviewInput, CombinedReviewResult, ReviewConfig> = {
  name: "review",
  requires: {
    session: false,
    scope: "package",
    permissions: "review",
    config: ["review", "debate"],
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

- Each sub-operation gets its own middleware envelope (one audit entry per leaf, one cost event per leaf) — so a 401 on `semanticReview` is visibly distinct from a 401 on `adversarialReview`.
- Composite operations are type-checked against `Operation<I, O, C>` exactly like leaves. No special case in `scope.invoke()`.
- Stages may invoke either the composite or the leaves depending on whether they want pre-merged results or to control aggregation themselves (e.g. short-circuit on any adversarial critical finding without waiting for semantic).
- **Cost note:** composite operations pay the envelope twice (once on composite, once per leaf). Per-call overhead is small (logger scoping + permission resolution); audit/cost are per-call by design. Stages that want a single envelope should invoke leaves directly or skip the composite.

---

### 2. `ISessionRunner` implementations

`ISessionRunner` is the abstraction for **session topologies** — how many sessions a logical unit of work opens, how they are sequenced, when they stay warm, when they close. It is not TDD-specific, and `SingleSessionRunner` is not the canonical form. Each concrete runner captures a distinct topology that may be reused across stages.

Runners invoke operations via `scope.invoke()`; they do not invoke `IAgent` directly. **Topology is the runner's concern; content is the op's.** The same op composes into different runners when the topology differs; the same runner orchestrates different ops when the stage differs (e.g. `DebateSessionRunner` orchestrates plan-specific ops in the plan stage and review-specific ops in the review stage).

```typescript
// src/sessions/runners/types.ts (ADR-013, re-referenced)
export interface ISessionRunner<I, O> {
  run(scope: RunScope, input: I, opts: RunnerOptions): Promise<O>;
}

export interface RunnerOptions {
  readonly stage: PipelineStage;
  readonly storyId: string;
  readonly packageDir: string;
  readonly signal: AbortSignal;
}
```

**Three implementations in scope for this ADR:**

#### 2.1 `SingleSessionRunner`

One session, one operation. Used by the main `implement` stage, `fixAcceptance`, `diagnoseAcceptance`.

```typescript
export class SingleSessionRunner<I, O> implements ISessionRunner<I, O> {
  constructor(private readonly op: Operation<I, O, unknown>) {}
  async run(scope: RunScope, input: I, opts: RunnerOptions): Promise<O> {
    return scope.invoke(this.op, input, opts);
  }
}
```

**When to use a runner vs. direct `scope.invoke()`:** `SingleSessionRunner` (and its siblings) wraps operations with `requires.session: true` — the name describes the session topology. Session-less operations (routing, decompose, refinement) are invoked directly via `scope.invoke(op, ...)` from the stage without a runner. There is no topology to describe, so there is no runner to wrap them in.

#### 2.2 `ThreeSessionRunner` (TDD)

Three sessions, three operations in order: `writeTest` → `implement` → `verify`. Each in its own session for isolation (ADR-007).

```typescript
export class ThreeSessionRunner implements ISessionRunner<TddInput, TddResult> {
  async run(scope: RunScope, input: TddInput, opts: RunnerOptions): Promise<TddResult> {
    const tests = await scope.invoke(writeTest, input, opts);
    const impl = await scope.invoke(implement, { ...input, tests }, opts);
    const verdict = await scope.invoke(verify, { ...input, tests, impl }, opts);
    return { tests, impl, verdict };
  }
}
```

#### 2.3 `DebateSessionRunner`

The third topology: N debater sessions (± a reviewer-dialogue session) across M rounds. Used by **both the plan stage and the review stage** — same runner, different ops plugged in.

Reflects three internal modes already present in today's [src/debate/session.ts:24-174](src/debate/session.ts#L24-L174). The runner absorbs the mode dispatch:

| Mode | Topology | Current file | Used by |
|:---|:---|:---|:---|
| `one-shot` | N × `complete()`, no sessions | [src/debate/session-one-shot.ts](src/debate/session-one-shot.ts) | panel review with `sessionMode: "one-shot"` |
| `stateful` | N debater sessions, kept warm across proposal → critique rounds | [src/debate/session-stateful.ts](src/debate/session-stateful.ts) | panel review with `sessionMode: "stateful"` |
| `hybrid` | N stateful debaters + reviewer-dialogue session across proposal + rebuttal rounds | [src/debate/session-hybrid.ts](src/debate/session-hybrid.ts) | plan stage; review with hybrid mode |

**Decomposition — debate is ops inside a topology runner.** The runner owns *topology* (how many sessions, keep-open boundaries, round sequencing, abort isolation). The ops own *content* (prompt building, response parsing, validation). Four ops cover all three modes:

| Op | What it does | Used in mode(s) |
|:---|:---|:---|
| `proposeCandidate` | One debater's proposal (plan draft or review verdict) | all three |
| `rebutCandidate` | Debater refines under critique | stateful, hybrid |
| `reviewDialogue` | Reviewer critiques / synthesizes across rounds | hybrid |
| `rankCandidates` | Pick winner from the N debaters | all three |

The same `proposeCandidate` op runs whether the stage is `plan` or `review` — the builder and config slice differ, but the contract is identical. That is the point of making debate ops-based.

```typescript
export class DebateSessionRunner<I, O> implements ISessionRunner<DebateInput<I>, DebateResult<O>> {
  async run(scope: RunScope, input: DebateInput<I>, opts: RunnerOptions): Promise<DebateResult<O>> {
    switch (input.mode) {
      case "one-shot": return this.runOneShot(scope, input, opts);
      case "stateful": return this.runStateful(scope, input, opts);
      case "hybrid":   return this.runHybrid(scope, input, opts);
    }
  }

  private async runOneShot(scope, input, opts) {
    const proposals = await Promise.allSettled(
      input.debaters.map((debater, i) =>
        scope.invoke(input.proposeOp, { debater, prompt: input.prompt }, {
          ...opts,
          agentName: debater.agent,
          sessionRole: `debate-${opts.stage}`,        // e.g. "debate-plan", "debate-review"
          discriminator: i,
          signal: linkAbortSignals(opts.signal),
          logger: scope.services.logger.child({ storyId: opts.storyId, debater: debater.agent }),
        }),
      ),
    );
    return scope.invoke(input.rankOp, { proposals: proposals.filter(isFulfilled).map(p => p.value) }, opts);
  }

  private async runStateful(scope, input, opts)  { /* proposals kept warm across critique round */ }
  private async runHybrid(scope, input, opts)    { /* proposals + reviewDialogue interleaved across rounds */ }
}
```

Key properties:

- Each debater's middleware envelope fires independently → N audit entries, N cost events, each tagged with `agentName` + `sessionRole`. A 401 on debater 0 is visibly distinct from a 401 on debater 2.
- One debater's timeout/error does not kill siblings (`Promise.allSettled` + per-debater `AbortController`).
- Per-debater sessionId is derived by `computeAcpHandle` from `{ sessionRole, discriminator }` — so `debate-review-0`, `debate-review-1`, `debate-hybrid-0`, `plan-0` all emerge from the same derivation rule. No inline string construction.
- The runner does **not** construct an `AgentManager`, does **not** build prompts, does **not** resolve permissions — all of that is inside `scope.invoke()`.
- `src/debate/session-helpers.ts` collapses: mode-specific topology logic moves into the runner; `_debateSessionDeps.createManager` and the orphan `createAgentManager` import are already removed by ADR-014 Phase 2. Files under `src/debate/` become thin strategy methods on the runner (or move to `src/sessions/runners/debate/*`).

#### 2.4 What this ADR does NOT change

The session primitives from ADR-007/008/011/013 are preserved intact. `ISessionRunner` is a topology abstraction *over* them, not a replacement:

| Primitive | Owner | Preserved as-is |
|:---|:---|:---|
| `sess-<uuid>` descriptor ID | SessionManager | Yes — `runInSession(id, ...)` signature unchanged |
| `nax-<hash8>-<feature>-<storyId>-<role>` wire handle | `computeAcpHandle()` in adapter | Yes — still the single place that builds the name |
| `keepSessionOpen` per-role policy (ADR-008 matrix) | Caller of `agent.run()` | Yes — ops pass `keepOpen` on `AgentRunOptions` |
| `sweepFeatureSessions` at story completion | SessionManager | Yes — still the single cleanup point |
| `AgentRunOptions.sessionHandle` override | Adapter | Yes — exposed through `InvokeOptions.sessionHandle` for dialogue-style per-generation names |
| Implementer session continuity across rectification | `computeAcpHandle` determinism | Yes — same role → same handle → automatic resume |
| Fresh sessionId per reviewer round | `keepOpen: false` + deterministic handle | Yes — next round's `loadSession` creates fresh ACP session |

What changes is the *path* by which operations reach these primitives: via `scope.invoke()` threading `AgentRunOptions` from `op.requires` + `InvokeOptions`, instead of each subsystem assembling the request by hand.

**SessionRole latent bug fix.** Debate roles today (`debate-review-0`, `debate-hybrid-1`, `debate-hybrid-fallback`) bypass the `SessionRole` union at [src/session/types.ts:56-70](src/session/types.ts#L56-L70) and are constructed inline as strings ([src/debate/session-stateful.ts:160](src/debate/session-stateful.ts#L160), [src/debate/session-hybrid.ts:169](src/debate/session-hybrid.ts#L169)). Phase 2 of this ADR extends the union:

```typescript
export type SessionRole =
  | /* existing 14 fixed roles */
  | `debate-${string}`
  | `debate-${string}-fallback`
  | `plan-${number}`;
```

Runners generate these via `{ sessionRole, discriminator }` passed through `InvokeOptions` — no more inline string building at call sites.

---

### 3. Control-flow layer

Named non-operations. They invoke operations; they are not operations. Middleware envelope does **not** fire at this layer — only on the operations they invoke.

Lives in `src/control/` (new directory). Siblings of `src/operations/`. Making the boundary visible in the tree is part of the point.

| Module | Today | Role after ADR-015 |
|:---|:---|:---|
| `src/control/escalation.ts` | `src/execution/escalation/` | Decides the **tier** of the next iteration; mutates story `modelTier`; no LLM calls |
| `src/control/rectification-loop.ts` | `src/verification/rectification-loop.ts` | Retry driver: invokes `rectify` op N times with verify callback; no LLM calls |
| `src/control/runner-iteration.ts` | `src/execution/runner-execution.ts` loop | Iterates stages per story; invokes `ISessionRunner`s; no LLM calls |

#### 3.1 `rectify` operation + loop separation

**Operation — one attempt:**

```typescript
// src/operations/rectify.ts
export const rectify: Operation<RectifyInput, RectifyResult, RectifyConfig> = {
  name: "rectify",
  requires: {
    session: true,
    scope: "package",
    permissions: "run",
    config: ["rectification"],
  },
  async execute(ctx, input) {
    const prompt = await ctx.scope.promptComposer.compose(rectifierBuilder, input, {
      stage: ctx.stage,
      storyId: ctx.storyId,
      packageDir: ctx.packageDir,
    });
    const response = await ctx.agent.run(prompt, { mode: "implement" });
    return parseRectifyResult(response);
  },
};

export interface RectifyInput {
  readonly failure: StructuredFailure;
  readonly previousAttempts: RectifyAttempt[];   // progressive prompt composition — ADR-016 middleware renders these
  readonly targetFiles: string[];
  readonly hint?: string;
}
```

> **ADR-015 interim note:** `rectify.execute()` above references `scope.promptComposer` — that composer lands in ADR-016. Until ADR-016 Phase 1 lands, `rectify` uses the legacy builder directly: `const prompt = rectifierBuilder.build(input)`. The `Operation<RectifyInput, RectifyResult, RectifyConfig>` signature is stable across both versions — only the body of `execute()` changes. Same pattern applies to the `plan` and `decompose` operations in §4.

**Loop — control-flow driver:**

```typescript
// src/control/rectification-loop.ts
export async function runRectificationLoop(
  scope: RunScope,
  input: RectifyInput,
  opts: RectifyLoopOptions,
): Promise<RectifyOutcome> {
  const attempts: RectifyAttempt[] = [];
  for (let i = 0; i < opts.maxAttempts; i++) {
    const result = await scope.invoke(rectify, { ...input, previousAttempts: attempts }, {
      stage: opts.stage,
      storyId: opts.storyId,
      packageDir: opts.packageDir,
    });
    const verified = await opts.verify(result);
    if (verified.success) return { outcome: "fixed", result, attempts: i + 1 };
    attempts.push({ result, verification: verified });
  }
  return { outcome: "exhausted", attempts };
}
```

Callers (acceptance, smart-runner, review autofix) pass a stage-specific `verify` callback. Today's four separate retry loops collapse to this one driver.

#### 3.2 Escalation as control-flow

Escalation decides which tier the **next** iteration uses. It mutates story `modelTier`; the next operation invocation picks it up via `scope.agentManager` routing. Escalation does not make LLM calls and is not an operation.

Placement and shape unchanged from today's `src/execution/escalation/` — the module simply moves under `src/control/` and loses its orphan `createAgentManager` dependency (already removed by ADR-014). `tryLlmBatchRoute` becomes `scope.invoke(classifyRoute, ...)`.

#### 3.3 `runner-iteration` — top-level story iteration

The outermost control-flow layer. Today implemented inline in `src/execution/runner-execution.ts`; after this ADR it's a named module in `src/control/`.

Responsibilities:

- Iterate stories (sequential or parallel, per config).
- For each story, iterate pipeline stages in the configured order.
- Invoke each stage's `ISessionRunner` or direct operation via `scope.invoke()`.
- On stage failure, consult escalation (§3.2) for the next-iteration decision.
- Persist per-story state to the PRD at phase boundaries.
- Fire lifecycle hooks (pre-story, post-story, pre-stage, post-stage).

Non-responsibilities: does not build prompts, does not hold `IAgent` refs, does not resolve permissions, does not tag cost events. All of those live in operations or middleware.

The same CI lint rule applies: `src/control/runner-iteration.ts` cannot import `IAgent` or `AgentAdapter`.

#### 3.4 Control-flow stack ordering

Control-flow modules are **layered**. From outermost to innermost:

```
runner-iteration (per story, per stage — ADR-015 §3.3)
  │
  ├─ on stage failure ──→ escalation (tier decision — ADR-015 §3.2)
  │                         │
  │                         └─ returns: { action: "retry" | "pause" | "fail", nextTier?: string }
  │
  └─ invokes stage's runner or direct operation
       │
       └─ rectification-loop (where applicable — ADR-015 §3.1)
            │
            └─ invokes rectify operation N times, each with verify callback
                 │
                 └─ rectify operation (one attempt — single LLM call via scope.invoke)
```

**Who calls whom (contract):**

1. `runner-iteration` owns the outer loop and decides when a stage is "done" (success) vs "exhausted" (failed after the inner retry loop gave up).
2. On exhausted, `runner-iteration` consults `escalation` with the failure category and current tier. Escalation returns an action.
3. On `{ action: "retry" }`, `runner-iteration` re-invokes the stage with the new tier (and tier-specific attempt budget reset).
4. On `{ action: "pause" | "fail" }`, `runner-iteration` halts or fails the story.
5. The inner `rectification-loop` is scoped **per stage invocation** — it runs N attempts at the **current tier**, then returns `{ outcome: "exhausted" }` which bubbles up for escalation to handle.

**Why this layering matters:** it fixes the today-bug where tier escalation and per-tier retry budget tracking are mixed into the same files as the LLM calls. After this ADR:

- Adding a new stage needs only an `ISessionRunner` (topology) + `verify` callback. Retry and escalation fall out.
- Testing rectification-loop needs a stub `rectify` operation + a verify callback. No tier/PRD/hook machinery.
- Testing escalation needs only the failure signal + tier config. No LLM mocking.

#### 3.5 Rule for identifying control-flow modules

Any module that:

- iterates, branches, or decides **which** operation to invoke next,
- does not itself send a prompt to an LLM,
- holds no reference to `IAgent`,

is control-flow. It lives in `src/control/`. It imports `RunScope` and `Operation` types but never `IAgent`.

**CI lint rule:** files in `src/control/` importing `IAgent` (or `AgentAdapter`) are an error. This keeps the boundary enforceable.

---

### 4. Remove `.plan()` and `.decompose()` from the adapter

#### 4.1 `plan` operation

Two shapes, selected by the plan stage based on `config.debate.stages.plan.enabled`:

**Shape A — simple `plan` op (debate disabled):** single `agent.run()` call.

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
```

**Shape B — debated plan (debate enabled):** plan stage invokes `DebateSessionRunner` with plan-specific ops. The stage module picks the shape; both paths produce a `PlanResult`:

```typescript
// src/pipeline/stages/plan.ts (sketch)
async function planStage(scope, story, opts) {
  if (scope.config.debate.stages.plan.enabled) {
    return new DebateSessionRunner().run(scope, {
      mode: scope.config.debate.stages.plan.mode,  // "one-shot" | "stateful" | "hybrid"
      debaters: scope.config.debate.stages.plan.debaters,
      proposeOp: planProposeCandidate,             // plan-specific builder
      rebutOp:   planRebutCandidate,
      rankOp:    planRankCandidates,
      input: planInput,
    }, opts);
  }
  return scope.invoke(plan, planInput, opts);
}
```

Note: `proposeCandidate`, `rebutCandidate`, `rankCandidates` are the same ops used by the review stage's debated path (§2.3) — differing only in the builder and config slice passed to the op instance. Today's `plan-<i>` wire roles (ADR-008) fall out of the runner passing `sessionRole: "plan"` + `discriminator: i` through `InvokeOptions`.

#### 4.2 `decompose` operation

```typescript
// src/operations/decompose.ts
export const decompose: Operation<DecomposeInput, DecomposeResult, DecomposeConfig> = {
  name: "decompose",
  requires: {
    session: false,
    scope: "repo",
    permissions: "decompose",
    config: ["decomposer"],
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

#### 4.3 Adapter surface shrinks to 2 methods

After Phase 2 of this ADR:

- `AgentAdapter` has only `run()` and `complete()`.
- `IAgentManager` has only `runAs()` and `completeAs()` (the `planAs` and `decomposeAs` helpers are deleted from the interface in ADR-013 → remove now).
- `nax plan` CLI uses `RunScopeFactory.forPlan()` + `scope.invoke(plan, input, opts)`.
- `decompose` callers (runner setup, batch routing) use `scope.invoke(decompose, input, opts)`.

New agents (codex, gemini, future) implement 2 methods instead of 4. Prompt-building permanently lives in `src/prompts/builders/` — no escape hatch via `.plan()` / `.decompose()`.

---

## Architecture After ADR-015

```
RunScope (ADR-014)
  ├─ agentManager, sessionManager, services   // unchanged
  ├─ getAgent(name) → IAgent                  // ADR-014 — middleware-wrapped
  └─ invoke<I,O,C>(op, input, opts) → O       // NEW — operation envelope

Operation<I, O, C> (semantic unit)
  ├─ requires: { session, scope, permissions, config }
  └─ execute(ctx, input)

ISessionRunner<I, O> (topology, ADR-013 — reused across stages)
  ├─ SingleSessionRunner                      // implementer, rectifier, diagnose, source-fix
  ├─ ThreeSessionRunner                       // tdd (writer → implementer → verifier)
  └─ DebateSessionRunner                      // plan AND review stages
     ├─ mode: "one-shot"                      // N × complete(), no sessions
     ├─ mode: "stateful"                      // N debater sessions across rounds
     └─ mode: "hybrid"                        // N stateful debaters + reviewer-dialogue

Session primitives (ADR-007/008/011/013 — preserved)
  ├─ SessionManager.runInSession(sess-<uuid>, ...)       // unchanged
  ├─ computeAcpHandle(workdir, feature, storyId, role)   // unchanged — still in adapter
  └─ keepSessionOpen per-role matrix                     // unchanged

Control-flow (src/control/, non-operations)
  ├─ escalation                               // tier decisions
  ├─ rectification-loop                       // retry driver — verify callback
  └─ runner-iteration                         // story iteration

IAgent (ADR-013)
  ├─ run(prompt, opts): Promise<AgentResult>
  └─ complete(prompt, opts): Promise<CompleteResult>
     // .plan() and .decompose() REMOVED — now operations
```

---

## Consequences

### Positive

| Win | Mechanism |
|:---|:---|
| **Declarative operation shape** | `requires` + `execute` is the whole contract. Plugins export `Operation<I, O, C>` values and register. No adapter changes, no ceremony copy-paste. |
| **Adapter surface permanently shrinks** | 2 methods instead of 4. New agents are cheaper to integrate. Prompt-building cannot leak back into the adapter layer. |
| **One rectification loop instead of four** | `src/verification/`, `src/acceptance/`, `src/review/autofix/`, `src/tdd/` all call `runRectificationLoop()` with their verify callback. Bug fixes apply once. |
| **Control-flow is a first-class concept** | `src/control/` directory + lint rule makes loop-vs-op distinction enforceable, not aspirational. Escalation stops being mixed in with LLM-calling code. |
| **Debate without scope forks** | `DebateSessionRunner` uses `InvokeOptions.{agentName, signal, logger}`. Per-proposer attribution falls out of middleware naturally. No new lifecycle rules. |
| **`nax plan` shares scaffolding with Runner** | Both use `RunScopeFactory`. They differ in which operations they invoke, not in what they construct. |
| **Testing simplifies** | Operation tests construct only the config slice the op declares (small fixture). Runner tests use `makeTestScope()` + mock operations. |

### Negative / Tradeoffs

| Cost | Mitigation |
|:---|:---|
| Every call site migrates from ad-hoc ceremony to `scope.invoke(op, input, opts)` | Mechanical. The envelope replaces 10–20 lines of hand-written shape per site. |
| Composite operations pay envelope twice | By design — per-leaf attribution for audit/cost. Stages that want single-envelope call leaves directly. |
| `rectify.execute()` depends on ADR-016's `scope.promptComposer` | Interim: use legacy builder directly until ADR-016 lands. Operation signature does not change. |
| Plugin API needs to expose `Operation` registration | Deferred to ADR-017 (plugin API v2). For this ADR, operations are internal to nax. |
| Bigger concept surface for contributors | The split (operations vs runners vs control-flow) mirrors what's already implicit; naming it reduces friction, not adds it. |

---

## Migration Plan

Four phases. Phase 1 and Phase 2 are independent; Phase 3 and Phase 4 depend on Phase 1 + Phase 2.

### Phase 1 — `Operation` contract and `scope.invoke()`

- Introduce `src/operations/types.ts` with `Operation<I, O, C>`, `OperationContext`, `OperationRequires`, `InvokeOptions`.
- Implement `scope.invoke()` on `RunScope` (from ADR-014).
- Ship `SingleSessionRunner` and validate against one migrated stage (`implement` is the simplest proof).
- **Exit criteria:** One stage uses `scope.invoke()` end-to-end. Others still use today's ad-hoc paths.
- **Risk:** Low. Additive.

### Phase 2 — Migrate leaf operations

- Convert subsystems to operation form, in this order (lowest blast radius first):
  1. `classifyRoute` (routing)
  2. `generateAcceptance`, `refineAcceptance`, `diagnoseAcceptance`, `fixAcceptance`
  3. `semanticReview`, `adversarialReview` (and optional `review` composite)
  4. `writeTest`, `implement`, `verify` (TDD — behind `ThreeSessionRunner`)
  5. `proposeCandidate`, `rebutCandidate`, `reviewDialogue`, `rankCandidates` — the debate ops. Simultaneously extend `SessionRole` union to admit `debate-*` / `plan-<n>` forms (§2.3). Ship `DebateSessionRunner` with all three modes; switch plan stage and review stage to use it.
  6. `rectify`
- Each migration ships independently and uses the middleware envelope from ADR-014.
- **Exit criteria:** All subsystems invoke through `scope.invoke()`. No stage constructs ad-hoc prompt-permission-session ceremony.
- **Risk:** Medium. Mechanical but broad.

### Phase 3 — Extract control-flow layer

- Create `src/control/` directory.
- Move `src/execution/escalation/` → `src/control/escalation.ts`.
- Collapse `src/verification/rectification-loop.ts` + `src/acceptance/` retry + `src/review/autofix/` retry + TDD retry into `src/control/rectification-loop.ts`.
- Each former caller becomes a one-liner: `runRectificationLoop(scope, input, { verify: ..., maxAttempts: ... })`.
- Add CI lint: `src/control/**` may not import `IAgent` or `AgentAdapter`.
- **Exit criteria:** Four retry loops collapse to one. Escalation lives in `src/control/` with no LLM imports.
- **Risk:** Medium. Retry semantics must be preserved across stages (test suite is the gate).

### Phase 4 — Remove `.plan()` and `.decompose()` from adapter

- Convert to `plan` and `decompose` operations.
- Migrate `nax plan` CLI to `RunScopeFactory.forPlan()` + `scope.invoke(plan, input, opts)`.
- Delete `AgentAdapter.plan()` and `AgentAdapter.decompose()`.
- Delete `IAgentManager.planAs()` and `IAgentManager.decomposeAs()`.
- Update adapter-boundary integration test to enforce the 2-method surface.
- **Exit criteria:** Adapter interface is 2 methods. `nax plan` shares scaffolding with Runner.
- **Risk:** Medium. `nax plan` is the single largest call site; behavior parity required.

**Rollback plan:** Phases 1 and 2 are additive (new paths alongside old). Phases 3 and 4 are the removal phases — each revert is a single-commit revert of the removal + restoring the old path, which is still in git history.

---

## Rejected Alternatives

### A. Free-function operations without `scope.invoke()` envelope

**Rejected.** Free functions (`plan(agent, input)`) solve the "remove from adapter" problem but leave every operation reinventing shape (permissions, session resolution, config slicing, logger scoping, error wrapping). The envelope is what makes shape uniform. Operations stay thin — the envelope is hoisted.

### B. Operations as methods on a god `OperationRunner` class

**Rejected.** Relocates the current `AgentManager.plan()` / `.decompose()` bloat to a new class. Free `Operation<I, O, C>` values registered by the module system are more extensible and keep adapter-style growth off the runner.

### C. Keep `.plan()` and `.decompose()` on the adapter as "privileged internal operations"

**Rejected.** They are not transport primitives. `decompose` is 100% prompt composition; `plan` is `run()` with a mode option. Keeping them on the adapter forces every new agent to implement both, and pins prompt-building inside the adapter layer (a direct violation of the Prompt Builder Convention). Removing them shrinks the adapter interface to 2 methods, permanently.

### D. Rectification as one big operation (loop included)

**Rejected.** Putting the retry loop inside `rectify.execute()` means the middleware envelope fires once for N LLM calls — audit captures only the last attempt, cost shows one event for N calls. Breaks per-attempt attribution. The loop must be outside the operation for middleware to see each attempt.

### E. `DebateSessionRunner` creates a child `RunScope` per proposer

**Rejected** (ADR-014 §C already rejected `child()` generally). Per-proposer isolation is a per-call concern (own signal, own logger), not a scope-level concern. `InvokeOptions.{agentName, signal, logger}` covers it. Introducing child scopes re-raises all the lifecycle questions (who closes what, does child inherit or own) for no gain.

### F. Separate `StatefulDebateRunner` / `OneShotDebateRunner` / `HybridDebateRunner`

**Rejected.** The three modes differ in topology details (keep-open policy, round count, whether a reviewer-dialogue participates) but share debater vocabulary, per-debater abort isolation, and ranking. A mode parameter on one runner matches how today's [src/debate/session.ts](src/debate/session.ts) already dispatches; splitting into three runners triples the surface without simplifying any call site. The stages still have to choose a mode — choosing it on the runner input vs choosing which runner class to instantiate is the same decision, and input-choice keeps `ISessionRunner` a small enumerable set.

### G. Mint sessionIds inside `scope.invoke()`

**Rejected.** There are already two sessionIds in the stack (`sess-<uuid>` owned by SessionManager; ACP wire handle owned by adapter's `computeAcpHandle`) and both have correct owners per ADR-007/008/011/013. Moving mint logic into `scope.invoke()` would duplicate one of them or conflict with deterministic handle derivation (which is what makes rectification's automatic session-resume work). `scope.invoke()` threads `AgentRunOptions`; SessionManager and the adapter do what they already do.

### H. `ConfigSelector<C>` is lambda-only (no keyof-array sugar)

**Rejected.** 95% of operations want to pick top-level keys. Writing `(c) => ({ review: c.review })` for every op is noise. Keyof-array covers the common case; lambda covers reshape. Both are type-checked.

---

## Open Questions

1. **Plugin API for operation registration.** Plugins contributing new operations need a registration surface. Deferred to ADR-017 (plugin API v2).

2. **Operation discovery for CLI introspection.** `nax ops list` showing all registered operations + their `requires` is useful for debugging. Nice-to-have, not in scope.

3. **Budget enforcement middleware.** Adding a `token-budget` middleware that hard-caps per-op spend is trivial once operations carry `op.name` in `MiddlewareContext`. Not in scope for this ADR; explicitly enabled by it.

4. **Cross-operation caching.** Response caching keyed on `(op.name, input hash, config slice hash)` becomes possible once operations are declarative. Not in scope; motivation for a future ADR.

---

## References

- ADR-011 — SessionManager ownership
- ADR-012 — AgentManager ownership
- ADR-013 — SessionManager → AgentManager hierarchy (defines `ISessionRunner`)
- ADR-014 — RunScope & Middleware (precondition for this ADR)
- ADR-016 — Prompt Composition & PackageView (follow-up — `scope.promptComposer` referenced here lands there)
- `.claude/rules/forbidden-patterns.md` — Prompt Builder Convention
- `.claude/rules/adapter-wiring.md` — adapter method selection (will be updated to 2-method adapter)
- `docs/architecture/agent-adapters.md` — adapter protocol
