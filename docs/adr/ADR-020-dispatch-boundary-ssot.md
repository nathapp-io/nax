# ADR-020: Dispatch Boundary as SSOT — Typed Dispatch Events, Manager-Only Entry, Side-Effect-Aware Operations

**Status:** Proposed
**Date:** 2026-04-28
**Author:** William Khoo, Claude
**Supersedes:** ADR-018 §3 (the "middleware envelope wraps `runAs`" claim — middleware moves to the concrete dispatch boundary)
**Amends:**
- ADR-018 §4 (`Operation` contract gains optional `verify` / `recover` hooks)
- ADR-019 §1 (the "all dispatch goes through manager" rule is now structurally enforced — no adapter-wrapping escape hatch in production code)
**Preserves:** ADR-018 §2 (`NaxRuntime`), §5 (TDD/debate orchestrators as plain functions), §7 (`composeSections`); ADR-019 §2–§3 (SessionManager ownership of session lifecycle, permissions resolution at resource-opener)
**Closes:** [#773](https://github.com/nathapp-io/nax/issues/773)
**Resolves findings:** [docs/findings/2026-04-28-prompt-audit-dispatch-boundary.md](../findings/2026-04-28-prompt-audit-dispatch-boundary.md)
**Related PRs:** #771 (prompt-audit duplication tactical fix), #772 (cost duplication tactical fix), #774 (acceptance-setup ACP recovery), #783 (TDD audit gap)

---

## Context

ADR-018 declared "every agent dispatch flows through one `IAgentManager` → middleware chain → `SessionManager`/adapter, so audit, cost, cancellation, and logging are uniform." ADR-019 reinforced this with adapter primitives and the manager/session peer boundary. The primitives are correct. The **enforcement is not** — three classes of regressions, summarised below, all trace to one missing concept: ADR-018 never defined **what counts as a dispatch event**, only what plumbing exists.

### The four reactive PRs

| PR / Issue | Symptom | Tactical fix | Underlying class |
|:---|:---|:---|:---|
| #771 | Prompt audit wrote duplicate files (`run-run-US-001.txt` next to session-style entry) for every `executeHop` run | Skip outer `runAs()` audit when `executeHop` is set on the request | A. Middleware fires on two layers |
| #772 | Cost was double-counted on the same boundary; outer entry lost `exactCostUsd` | Same guard pattern; preserve `exactCostUsd` through result conversion | A. Middleware fires on two layers |
| #783 | TDD `test-writer`/`implementer`/`verifier` and rectification hops were absent from prompt audit | Thread `ctx.agentManager` into `getTddSessionBinding` and `runFullSuiteGate` instead of falling back to `wrapAdapterAsManager(agent)` | B. Manager-shaped wrappers bypass middleware |
| #774 | `acceptance-setup` migration to `callOp + acceptanceGenerateOp` lost ACP disk-recovery; skeleton fallback overwrote the file the agent had already written | Re-add Tier-1/2/3 recovery (extract from disk, heuristic match, skeleton) inside the stage | C. `Operation.parse` is stdout-only; agent side-effects invisible |

Each fix is correct as a tactical guard. None addresses the cause. Without an ADR, the next subsystem migrated to `callOp` will hit the same class of bug — and the fifth PR will look exactly like #774.

### The three structural gaps

#### Gap A — Middleware fires on both the envelope and the concrete dispatch

`AgentManager` invokes `_middleware.runBefore`/`runAfter` at three sites:

| Site | File:line | Role |
|:---|:---|:---|
| `runAs()` | `src/agents/manager.ts:417,434` | **Envelope** — wraps the entire fallback loop |
| `runAsSession()` | `src/agents/manager.ts:470,473` | **Concrete dispatch** — the actual `SessionManager.sendPrompt` call |
| `completeAs()` | `src/agents/manager.ts:388` (approx.) | **Concrete dispatch** — one-shot adapter `complete` |

For an `executeHop`-style run (Operation → `callOp` → `runWithFallback` → hop callback → `runAsSession`), one logical agent prompt **crosses two middleware boundaries**: the outer envelope and the inner concrete dispatch. Audit and cost middleware can't tell which is "the real one," so they sniff the context:

```typescript
// src/runtime/middleware/audit.ts:30
if (ctx.kind === "run" && ctx.sessionHandle === undefined && ctx.request?.executeHop) return;

// src/runtime/middleware/cost.ts:34 — identical
if (ctx.kind === "run" && ctx.sessionHandle === undefined && ctx.request?.executeHop) return;
```

These guards work today. They are fragile because:
- They encode the "outer call has `executeHop` set, inner call has `sessionHandle` set" invariant in **every** middleware that needs it. Any new middleware author is one missed guard away from a duplicate-record bug.
- The invariant is implicit. There is no `DispatchEvent` type, no method named "this-is-the-one-that-counts," no test that asserts "exactly N middleware firings per N agent prompts."
- Pure middleware that wants envelope-level telemetry (e.g. fallback hop count) and dispatch-level telemetry (e.g. wire cost) cannot get both without doing the inverse guard.

#### Gap B — `wrapAdapterAsManager` produces a manager-shaped object with no middleware

`src/agents/utils.ts:25-142` exports `wrapAdapterAsManager(adapter): IAgentManager`. The returned object satisfies the interface via no-op stubs and direct adapter calls. **No middleware chain is attached. There is no API to attach one.**

Five production sites use it as a fallback:

| Site | File:line | Has `IAgentManager` available? |
|:---|:---|:---|
| Pipeline stage execution | `src/pipeline/stages/execution.ts:190` | Yes (`ctx.agentManager`) |
| TDD orchestrator hop | `src/tdd/orchestrator.ts:264` | Yes (parameter) |
| TDD session runner | `src/tdd/session-runner.ts:253` | Yes (`sessionBinding?.agentManager`) |
| TDD rectification gate | `src/tdd/rectification-gate.ts:92` | Yes (parameter, post-#783) |
| (acceptance was a sixth, fixed in #783) | — | — |

Every site has a real manager reachable. The wrapper exists only because earlier code wrote `?? wrapAdapterAsManager(agent)` as a defensive fallback. The result: any subsystem that fails to thread `ctx.agentManager` silently downgrades to a no-middleware manager — audit, cost, cancellation, and logging all disappear without error.

#### Gap C — `Operation.parse` is contractually stdout-only

`src/operations/types.ts:40-57` defines:

```typescript
interface OperationBase<I, O, C> {
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;
  // parse must remain side-effect-free: no I/O, no agent calls, no runtime mutation.
}
```

This is the right contract for ops where the agent's deliverable is its stdout (router decisions, decompose JSON, lint summaries). It is the **wrong** contract for ops where the agent's deliverable is a **filesystem artifact** and stdout is conversational.

ACP-mode agents (Claude Code via `acpx`, the production default) reply in natural language and write files via tool calls. `acceptanceGenerateOp.parse(output)` calls `extractTestCode(output)` which scans stdout for code fences / `func Test` / `def test_` / `describe(`. The agent wrote the test file to disk; stdout has none of those markers; `parse` returns `{ testCode: null }`; the caller's skeleton fallback **overwrites the file the agent already wrote**. The stub-detection loop then triggers retries until exhausted.

PR #774 patched this in the stage: a Tier-1/2/3 ladder reads the on-disk file, tries `extractTestCode` against it, falls back to a heuristic content match, then to a skeleton. This is the right behaviour but in the wrong layer. **Every other op whose agent writes files** (TDD test-writer, implementer, future codegen ops) will need its own copy of the same ladder, in its own caller, with its own bugs.

### Why ADR-018's gap review missed this

[ADR-018-gap-review.md](./ADR-018-gap-review.md) §Gap 5 acknowledged that `runAs()` cost/audit wiring was unspecified and resolved it via "Option G (middleware)." That decision is correct in the small. It did not specify **at which boundary** the middleware fires, did not type the dispatch event, and did not constrain the operation contract. ADR-020 fills those three gaps in one stroke.

---

## Decision

Three coordinated changes, all under one principle: **the dispatch boundary is the SSOT for cross-cutting concerns.**

### D1. Typed dispatch events emitted at the **three** concrete boundaries

Introduce `DispatchEvent`, a discriminated union emitted by exactly **three** methods — never by `runAs()` / `runWithFallback()`.

| Boundary | File | Owns | Emits `DispatchEvent` carrying |
|:---|:---|:---|:---|
| `AgentManager.runAsSession(agent, handle, prompt, opts)` | `src/agents/manager.ts:442` | live `handle` | `sessionName = handle.id`, `sessionRole = handle.role` |
| `SessionManager.runTrackedSession(id, manager, req)` | `src/session/manager-run.ts:36` | session **descriptor** (role + computed name) | `sessionName = nameFor(descriptor)`, `sessionRole = descriptor.role` |
| `AgentManager.completeAs(agent, prompt, opts)` | `src/agents/manager.ts:~388` | `completeOptions` (role, name) | `sessionName = formatSessionName(opts)`, `sessionRole = opts.sessionRole` |

**The third boundary (`runTrackedSession`) is the one ADR-020 originally missed.** Discovered by the post-#783 audit-naming bug: TDD's `runTddSession` calls `sessionManager.runInSession(sessionId, manager, req)` (runner-form overload, `manager.ts:513`), which routes to `runTrackedSession`, which calls `runner.run(req)` blindly — bypassing `runAsSession`. The descriptor in `state.sessions.get(id)` has the correct role (`"implementer"`, etc.) and computes the correct sessionName via `nameFor()`, but none of it propagates into the middleware ctx that fires at `runAs`. Result: TDD audit files named `1777371175083-run-run-US-001.txt` instead of `*-implementer.txt`. The owner of the descriptor IS the session-aware boundary; it must emit.

```typescript
// src/runtime/dispatch-events.ts
export type DispatchEvent =
  | {
      kind: "session-turn";
      sessionName: string;
      sessionRole: SessionRole;          // typed union — see D6
      turn: number;
      prompt: string;
      agentName: string;
      stage: PipelineStage;
      featureName?: string;
      storyId?: string;
      protocolIds: { sessionId?: string; turnId?: string };
      usage?: TokenUsage;
      exactCostUsd?: number;
      timestamp: number;
      origin: "runAsSession" | "runTrackedSession";   // for diagnostics; not for routing
    }
  | {
      kind: "complete";
      sessionName: string;
      sessionRole: SessionRole;
      prompt: string;
      agentName: string;
      stage: PipelineStage;
      featureName?: string;
      storyId?: string;
      usage?: TokenUsage;
      exactCostUsd?: number;
      timestamp: number;
    };
```

`AgentManager.runAs()` and `AgentManager.runWithFallback()` are **envelope** methods. They orchestrate fallback, retry, and permissions but **emit no `DispatchEvent`**. They emit `OperationCompletedEvent` (D5) for envelope telemetry only.

**Single-emission invariant per logical dispatch:**
- A single-session callOp dispatch → `runAsSession` emits once.
- A TDD per-role dispatch → `runTrackedSession` emits once. `runAsSession` is **not** invoked from this path; double-emission impossible.
- A one-shot completeAs dispatch → `completeAs` emits once.

Audit, cost, and any future cross-cutting subscribers consume `DispatchEvent` only. They **never** scrape `ctx.request.runOptions`, `ctx.completeOptions`, or `ctx.sessionHandle`. The `executeHop` / `sessionHandle` guards in `audit.ts:30` and `cost.ts:34` are deleted.

### D2. Audit and cost middleware become event subscribers, not context sniffers

`PromptAuditor.record(event)` and `CostAggregator.record(event)` already exist. The middleware files become thin subscribers:

```typescript
// src/runtime/middleware/audit.ts (rewritten)
export function attachAuditMiddleware(rt: NaxRuntime, auditor: PromptAuditor): void {
  rt.events.on("dispatch", (event) => {
    auditor.record(toAuditEntry(event));
  });
}
```

The `executeHop` / `sessionHandle` guards are deleted. Single emission is **structurally guaranteed** by single-emitter, not policed by every middleware.

### D3. `DispatchContext` base interface; `wrapAdapterAsManager` gated inside `SingleSessionRunner`

**Audit finding driving this decision:** `grep agentManager src/` returned ~30 declaration sites across **~10 parallel context types** — `PipelineContext`, `OperationContext`, `AcceptanceLoopOptions`, `RunCompletionOptions`, `DebateRunnerCtx` (3 modes), `ReviewCtx`, `RoutingCtx`, `PlanCtx`, `SessionRunnerContext`, `AcceptanceContext`. Roughly **half declare `agentManager?: IAgentManager`** (optional). Every `?` is one place a `??` fallback can grow into a `wrapAdapterAsManager(agent)` and silently bypass middleware. #783 is one instance; the pattern exists in ~15 declarations across 10 files.

The intervention is **not** a parallel `OrchestratorContext` (rejected, see §A5). It is a single base interface that the ~10 existing context types **extend** — deduplication, not parallel hierarchy.

```typescript
// src/runtime/dispatch-context.ts (~15 lines, ONE base type)

/**
 * Base contract for any context that dispatches agent work. Required fields
 * mean every consumer (pipeline stage, operation, lifecycle, CLI command,
 * routing, debate, review, acceptance, plan) must thread these by
 * construction. Closes the wrapAdapterAsManager-fallback class structurally:
 * there is nowhere a nullable agentManager exists in code that dispatches.
 */
export interface DispatchContext {
  readonly agentManager: IAgentManager;        // required — closes Gap B
  readonly sessionManager: ISessionManager;    // required
  readonly runtime: NaxRuntime;                // for events, packageView, config loader
  readonly abortSignal: AbortSignal;           // uniform cancellation
}
```

Every existing context type extends it:

```typescript
interface PipelineContext extends DispatchContext { /* pipeline-specific fields */ }
interface OperationContext<C> extends DispatchContext { packageView: PackageView<C>; ... }
interface AcceptanceLoopOptions extends DispatchContext { /* loop-specific */ }
interface DebateRunnerCtx extends DispatchContext { rounds: number; ... }
interface PlanCtx extends DispatchContext { planFile: string; ... }
// ... 5 more
```

`wrapAdapterAsManager` moves from `src/agents/utils.ts` (public export) into `src/session/runners/single-session-runner.ts` as a **private helper**, called only on the `noFallback: true` path that ADR-018 §5.2 already established. The public export is deleted. Production code that needs an `IAgentManager` cannot construct a no-middleware one; it must receive the real manager through its `DispatchContext`.

A grep gate (`scripts/check-no-adapter-wrap.sh`) runs in pre-commit and CI to prevent reintroduction.

**Why a base interface, not a parallel `OrchestratorContext`:** The earlier rejection of parallel hierarchies (ADR-014/015/016, ADR-018 §B) stands. `DispatchContext` adds **1 type and removes** an existing 10-way duplication of the same 4 fields — strictly subtractive on conceptual surface. Compare with the rejected ADRs' ~24 new types and three new directories. Future cross-cutting fields (e.g. `traceId`, `permissionsContext` slice from ADR-019) are added to `DispatchContext` once; the compiler then surfaces every consumer that must thread them.

### D4. `Operation` contract gains optional `verify` and `recover`

```typescript
// src/operations/types.ts (extended)
interface OperationBase<I, O, C> {
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;
  readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;
  readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
}

interface VerifyContext<C> extends BuildContext<C> {
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  // No agent calls. No writes. Read-only filesystem access.
}
```

`callOp` extends its post-parse pipeline:

1. Run `parse(output)` → `parsed`.
2. If op has `verify`: run `verify(parsed, input, ctx)`. Non-null result wins.
3. If still null/invalid and op has `recover`: run `recover(input, ctx)`.
4. Return whichever produced a non-null result, or null if all failed.

`acceptanceGenerateOp` declares `verify` (re-extract from on-disk test file) and `recover` (read disk + heuristic match). The Tier-1/2/3 ladder leaves `acceptance-setup.ts` and lives in the op alongside its prompt builder. Other side-effect ops (TDD test-writer, implementer) get the same treatment in the same wave.

### D6. `SessionRole` as a typed SSOT — kills role-string drift

**Audit finding driving this decision:** the post-#783 acceptance audit file is named `1777370981867-nax-51a4d03c-tdd-calc-us-001-acceptance-complete.txt` (note: `-acceptance-complete`, not `-acceptance-gen-complete`). Yet `src/acceptance/generator.ts:181,472` passes `sessionRole: "acceptance-gen"`. Some path along the way drops `-gen` because `sessionRole` is a free-form string at every call site — descriptor creation, `completeOptions`, `nameFor()`, `formatSessionName()` — and they disagree. Today that drift is silent: the audit file looks plausible, the test passes, the on-disk artifact is wrong.

`adapter-wiring.md` Rule 2 already declares the role registry, and ADR-018 §9 already declared `SessionRole` as a template-literal union. They are not consistently used at call sites. D6 promotes `SessionRole` to the single source of truth and tightens every consumer.

```typescript
// src/runtime/session-role.ts (new, ~25 LOC)
export type SessionRole =
  | "main"
  | "test-writer" | "implementer" | "verifier"
  | "diagnose" | "source-fix" | "test-fix"
  | "reviewer-semantic" | "reviewer-adversarial"
  | "plan" | "decompose"
  | "acceptance-gen" | "refine" | "fix-gen"
  | "auto" | "synthesis" | "judge"
  | `debate-${string}`;

export const KNOWN_SESSION_ROLES = [...] as const;
export function isSessionRole(s: string): s is SessionRole { /* ... */ }
```

Tighten every consumer that today accepts a free-form string:

| Consumer | Today | After D6 |
|:---|:---|:---|
| `SessionDescriptor.role` | `string` | `SessionRole` |
| `SessionHandle.role` | `string \| undefined` | `SessionRole` (required) |
| `AgentRunOptions.sessionRole` | `string \| undefined` | `SessionRole` (required when in story context) |
| `AgentCompleteOptions.sessionRole` | `string \| undefined` | `SessionRole` (required when in story context) |
| `formatSessionName({ role })` | `role?: string` | `role: SessionRole` |
| `DispatchEvent.sessionRole` (D1) | — | `SessionRole` |

The `"acceptance"` vs `"acceptance-gen"` drift becomes a compile error at the descriptor-creation site. Every existing free-form literal gets type-checked at the call site; Wave 1 fixes whichever ones drift.

### D5. Envelope telemetry via `OperationCompletedEvent` (open question resolved)

To preserve fallback observability after stripping middleware from `runWithFallback`, introduce a second, separate event:

```typescript
export interface OperationCompletedEvent {
  kind: "operation-completed";
  operation: string;          // e.g. "run-with-fallback", "complete-with-fallback"
  agentChain: string[];       // every agent attempted, in order
  hopCount: number;
  fallbackTriggered: boolean;
  totalElapsedMs: number;
  finalStatus: "ok" | "exhausted" | "cancelled" | "error";
  storyId?: string;
  stage: PipelineStage;
}
```

Emitted once per `runWithFallback` / `completeWithFallback` invocation, regardless of hop count. **Audit and cost subscribers ignore this event** — they only consume `DispatchEvent`. Logging and metrics subscribers consume both. This separation makes "how many real prompts did we send?" (count `DispatchEvent`) and "how often did fallback fire?" (count `OperationCompletedEvent` with `fallbackTriggered=true`) two trivially different queries instead of two interpretations of the same stream.

---

## Consequences

### Positive

- **#771, #772, #774, #783, and #773 are all closed by the same coherent change.** Future subsystems migrated to `callOp` cannot reintroduce these classes.
- **Single-emission is structural, not enforced per-middleware.** New middleware authors don't need to know the `executeHop`/`sessionHandle` lore.
- **TDD, debate, review, and any future orchestrator** automatically get full audit/cost coverage as long as they accept `IAgentManager` (D3 makes this mandatory).
- **Side-effect ops are first-class.** ACP-mode agents that write files are no longer second-class compared to stdout-mode agents.
- **Envelope telemetry is preserved and improved.** `OperationCompletedEvent` makes fallback observability explicit instead of buried in middleware logs.

### Negative / Costs

- **One canary release with deprecation shims.** Wave 1 keeps the `executeHop` guard with a debug log when `ctx.dispatch` is unset, in case a third-party plugin middleware exists. Drop in the following release.
- **`MiddlewareContext` shape changes.** Plugins that wrote custom middleware see one new optional field (`dispatch?: DispatchEvent`) and one deprecation warning if they read `request.executeHop`. The four in-repo middleware are updated in the same PR.
- **Operation authors must opt into `verify`/`recover` for side-effect ops.** Until they do, those ops behave as today (parse-only). Wave 3 ships the migration for the three known side-effect ops (acceptance-generate, tdd-test-writer, tdd-implementer) so the rollout is complete on landing.
- **`wrapAdapterAsManager` removal is a breaking change for any out-of-tree code.** The function moves to `test/helpers/`. Documented in the changelog and in `forbidden-patterns.md`.

### Neutral

- ADR-019's permissions-at-resource-opener rule is unchanged.
- ADR-018's `NaxRuntime` and `Operation` core shapes are preserved; `Operation` only gains optional fields.
- The fallback policy logic in `runWithFallback` is unchanged; only its telemetry surface changes.

---

## Implementation Plan

Four waves, sequenced so each is independently shippable and reversible.

### Wave 1 — Typed dispatch events at three boundaries + `SessionRole` SSOT (closes Gap A, D6)

| File | Change | Approx. LOC |
|:---|:---|:---|
| `src/runtime/session-role.ts` | New: `SessionRole` template-literal union + `KNOWN_SESSION_ROLES` const + `isSessionRole()` guard (D6) | +25 |
| `src/runtime/dispatch-events.ts` | New: `DispatchEvent` + `OperationCompletedEvent` types + `DispatchEventBus` class | +70 |
| `src/agents/manager.ts` | Strip `_middleware.runBefore/After` from `runAs()`. `runAsSession()` and `completeAs()` emit `DispatchEvent`. `runWithFallback()` emits `OperationCompletedEvent` once at the end. | edit ~50 |
| **`src/session/manager-run.ts`** | **`runTrackedSession` emits `DispatchEvent` (kind:"session-turn", origin:"runTrackedSession") with `sessionName` and `sessionRole` from the descriptor before `runner.run()`. This is the third boundary and the one that fixes TDD audit naming.** | edit ~25 |
| `src/agents/types.ts` | Tighten `AgentRunOptions.sessionRole` and `AgentCompleteOptions.sessionRole` to `SessionRole`. Tighten `SessionHandle.role` to required `SessionRole` (D6) | edit ~15 |
| `src/session/types.ts` | Tighten `SessionDescriptor.role` to `SessionRole` (D6) | edit ~5 |
| `src/runtime/session-name.ts` | `formatSessionName` accepts `role: SessionRole` (no longer optional/free-form) (D6) | edit ~10 |
| `src/runtime/agent-middleware.ts` | Mark `request.executeHop` and `completeOptions` deprecated for middleware reads. Document: subscribers consume events only. | edit ~10 |
| `src/runtime/middleware/audit.ts` | Rewrite as `DispatchEvent` subscriber. Delete `executeHop` guard and `sessionNameFromCompleteOptions` scrape. | rewrite ~80 |
| `src/runtime/middleware/cost.ts` | Rewrite as subscriber. Delete `executeHop` guard. Subscribe to `DispatchEvent` for per-dispatch cost; subscribe to `OperationCompletedEvent` for fallback metrics. | rewrite ~70 |
| `src/runtime/middleware/logging.ts` | Subscribe to both events. | edit ~20 |
| `src/acceptance/generator.ts:181,472` and ~6 other call sites | Tighten free-form `sessionRole: "..."` literals against `SessionRole`. Compile errors surface the `"acceptance"` vs `"acceptance-gen"` drift; fix in the same PR. | edit ~15 |
| `test/unit/runtime/dispatch-events.test.ts` | New: assert one `executeHop` run = one `session-turn` event from `runAsSession`; one TDD per-role dispatch = one `session-turn` event from `runTrackedSession`; one `complete` call = one `complete` event; two-hop fallback = two `session-turn` events + one `OperationCompletedEvent` with `fallbackTriggered=true` | +150 |
| `test/integration/tdd/audit-naming.test.ts` | New: TDD three-session run produces audit files named `*-test-writer.txt`, `*-implementer.txt`, `*-verifier.txt` (not `run-run-US-001.txt`) | +60 |
| `test/integration/acceptance/audit-naming.test.ts` | New: acceptance-gen produces files named `*-acceptance-gen-complete.txt` (not `*-acceptance-complete.txt`) | +40 |
| `test/unit/runtime/middleware/audit.test.ts` | Delete guard-based cases; replace with subscriber assertions | edit ~50 |
| `test/unit/runtime/middleware/cost.test.ts` | Same | edit ~50 |

**Validation:**
1. Re-run the hello-lint dogfood (`68d35d37-…`) that produced #771/#772 — assert exactly N entries for N dispatches, zero `run-run-US-001*` files.
2. Re-run the `tdd-calc` dogfood (`/home/williamkhoo/Desktop/projects/nathapp/nax-dogfood/fixtures/tdd-calc/`) — assert per-role audit files (`*-test-writer.txt`, `*-implementer.txt`, `*-verifier.txt`).
3. Assert acceptance audit file is `*-acceptance-gen-complete.txt` (D6 role-drift fix).

### Wave 2 — `DispatchContext` base + `wrapAdapterAsManager` gated (closes Gap B)

**Sub-wave 2a — Add the base interface**

| File | Change | LOC |
|:---|:---|:---|
| `src/runtime/dispatch-context.ts` | New: `DispatchContext` interface (4 required fields: `agentManager`, `sessionManager`, `runtime`, `abortSignal`) | +15 |
| `src/runtime/index.ts` | Export `DispatchContext` from the runtime barrel | +1 |

**Sub-wave 2b — Make existing context types extend `DispatchContext`**

Each edit drops the `?` from `agentManager` / `sessionManager` where they were optional. Every resulting compile error is a real `??` fallback site that gets fixed in the same PR.

| File | Type | Change |
|:---|:---|:---|
| `src/pipeline/types.ts:60` | `PipelineContext` | extends `DispatchContext`; drop `?` on `agentManager` (line 145) and `sessionManager` (line 139); rename `abortSignal?` → `abortSignal` (line 119) |
| `src/operations/types.ts` | `OperationContext<C>` | extends `DispatchContext` |
| `src/execution/lifecycle/acceptance-loop.ts:61` | `AcceptanceLoopOptions` | extends `DispatchContext`; drop `?` on `agentManager` |
| `src/execution/lifecycle/run-completion.ts:57` | `RunCompletionOptions` | extends `DispatchContext`; drop `?` |
| `src/debate/runner-stateful.ts:35`, `runner-hybrid.ts:41`, `runner-plan.ts:33` | `DebateRunnerCtx` (3 modes) | extend `DispatchContext`; drop `?` |
| `src/debate/session-helpers.ts:76` | `DebateSessionCtx` | extends `DispatchContext`; drop `?` |
| `src/review/semantic-debate.ts:30`, `runner.ts`, `dialogue.ts` | `ReviewCtx`, `SemanticDebateCtx` | extend `DispatchContext` |
| `src/routing/router.ts:29` | `RoutingCtx` | extends `DispatchContext`; drop `?` |
| `src/cli/plan-runtime.ts` | `PlanCtx` | extends `DispatchContext` |
| `src/session/session-runner.ts:63` | `SessionRunnerContext` | extends `DispatchContext`; drop `?` |
| `src/acceptance/types.ts:55,117`, `hardening.ts:41` | `AcceptanceContext`, `HardeningCtx` | extend `DispatchContext`; drop `?` |

**Sub-wave 2c — Audit helper signatures still taking raw `IAgentAdapter`**

The #783 root was helpers like `runFullSuiteGate(agent: IAgentAdapter)` — they took an adapter directly, side-stepping the manager entirely.

| File | Helper | Change |
|:---|:---|:---|
| `src/tdd/rectification-gate.ts` | `runFullSuiteGate` | Accept `agentManager: IAgentManager` instead of `agent: IAgentAdapter` |
| `src/tdd/orchestrator-ctx.ts` | `getTddSessionBinding` | Same — manager-typed parameter, drop adapter |
| `src/tdd/session-runner.ts:253` | session-runner internals | Same |
| `src/acceptance/fix-executor.ts`, `fix-generator.ts`, `fix-diagnosis.ts`, `generator.ts` | Already manager-typed (verified via grep) — no change | — |

**Sub-wave 2d — Gate `wrapAdapterAsManager` and prevent reintroduction**

| File | Change |
|:---|:---|
| `src/agents/utils.ts` | Delete `wrapAdapterAsManager` and `NO_OP_INTERACTION_HANDLER` exports |
| `src/session/runners/single-session-runner.ts` | Move `wrapAdapterAsManager` here as a **private** helper. Caller-visible only via the `noFallback: true` path that ADR-018 §5.2 line 716 already established |
| `test/helpers/fake-agent-manager.ts` | New: a test-only fake manager for unit tests that don't want a full runtime. Distinct from production `wrapAdapterAsManager` — clearly named, lives only in `test/helpers/` |
| `scripts/check-no-adapter-wrap.sh` | New: `rg "wrapAdapterAsManager" src/ \| grep -v "src/session/runners/single-session-runner.ts"` returns zero |
| `.husky/pre-commit` | Wire the script in |
| `test/unit/agents/no-adapter-wrap.test.ts` | New: import-time assertion that `src/agents/utils.ts` does not export `wrapAdapterAsManager` |
| `test/integration/tdd/audit-coverage.test.ts` | New: TDD session run produces audit entries for `test-writer`, `implementer`, `verifier`, `rectifier` |

**Wave 2 totals:** ~165 LOC source change, +1 small base-type file, 0 new directories, 1 new CI script, 2 new tests.

### Wave 3 — Side-effect-aware Operation contract (closes Gap C)

| File | Change |
|:---|:---|
| `src/operations/types.ts` | Extend `OperationBase` with optional `verify` and `recover`; define `VerifyContext<C>` |
| `src/operations/call.ts` | Post-parse: run `verify`, then `recover`; bubble result |
| `src/operations/acceptance-generate.ts` | Add `verify` (extract from on-disk file) + `recover` (heuristic disk read). Move the corresponding helpers from `acceptance-setup.ts`. |
| `src/operations/tdd-test-writer.ts`, `src/operations/tdd-implementer.ts` | Same pattern: add `verify` + `recover` for the on-disk files the agent produced |
| `src/pipeline/stages/acceptance-setup.ts` | Delete the Tier-1/2/3 ladder (lines 350-441). Skeleton fallback (the stage's decision) stays. |
| `test/unit/operations/verify-recover.test.ts` | New: parse-null + verify-non-null wins; both null + recover-non-null wins; all null returns null |
| `test/unit/pipeline/stages/acceptance-setup-agent-file.test.ts` | Rewrite the post-#774 cases to assert the **op** (not the stage) handles recovery |

### Wave 4 — Documentation and guardrails

| File | Change |
|:---|:---|
| `docs/adr/ADR-020-dispatch-boundary-ssot.md` | This document — accept on landing |
| `.claude/rules/forbidden-patterns.md` | Add: `wrapAdapterAsManager` outside `test/helpers/`; reading `request.executeHop` inside middleware; manual disk-recovery ladders inside pipeline stages for ops that should declare `verify`/`recover` |
| `docs/architecture/subsystems.md` §34–§37 | Update runtime-layering section. Diagram: stage → callOp → manager.runWithFallback (envelope, emits `OperationCompletedEvent`) → executeHop → manager.runAsSession (concrete, emits `DispatchEvent`) |
| `docs/findings/2026-04-28-prompt-audit-dispatch-boundary.md` | Mark resolved by ADR-020 |
| Issue [#773](https://github.com/nathapp-io/nax/issues/773) | Close as completed in Wave 1 |
| `CHANGELOG.md` | Note the breaking removal of `wrapAdapterAsManager` from `src/agents/utils.ts` |

---

## Sequencing & Risk

Run waves **in order**. Each is independently shippable:

- **Wave 1** alone closes #771, #772, and #773. Symptoms disappear; no new APIs required by callers.
- **Wave 2** prevents future TDD-style audit gaps. Breaking change scoped to one helper; grep gate prevents regression.
- **Wave 3** closes #774 and the latent equivalents in TDD ops. Optional fields, so existing ops are unaffected until migrated.
- **Wave 4** is documentation-only and can land alongside any of the above.

**Estimated total:** ~600 LOC source change, ~400 LOC test additions, 1 new ADR, 1 new pre-commit script. Two engineer-weeks if executed together.

**Rollback strategy:** Each wave is a single PR. Reverting Wave 1 reinstates the `executeHop` guards (still in git). Reverting Wave 2 restores the wrapper from `test/helpers/`. Reverting Wave 3 restores the stage-side ladder and removes the optional `verify`/`recover` fields (no callers depend on them being absent).

---

## Alternatives Considered

### A1. Keep middleware on both layers; standardise the guards

Move the `executeHop` / `sessionHandle` checks into a shared helper (`isInnerDispatch(ctx)`) and require all middleware to call it. **Rejected.** Still policed per-middleware, still implicit, still fragile. The structural fix (single-emitter) is the same effort and removes the entire failure class.

### A2. Make `wrapAdapterAsManager` attach a default middleware chain

Inject the runtime's middleware into the wrapper. **Rejected.** Hides the dependency on a runtime-bound chain inside a "wrapper" helper, which then needs the full `NaxRuntime` to construct — at which point the caller could just use `runtime.agentManager` directly. The wrapper exists to avoid passing a runtime; making it depend on a runtime defeats its only purpose.

### A3. Make `Operation.parse` async and pass `VerifyContext`

Merge `parse` and `verify` into a single async method with filesystem access. **Rejected.** `parse` is intentionally sync and pure for unit-testability. Most ops don't need disk access; making the contract async penalises 90% of call sites for the sake of 10%. Optional `verify` + `recover` keeps the simple case simple.

### A4. Defer to a future "Effects" subsystem

Wait for a broader effects-tracking system that models filesystem writes, network calls, and subprocess spawns uniformly. **Rejected.** That work is unscoped and unscheduled. The three concrete bugs need closing now, and the proposed surface is small enough to be incremental — it does not preclude a future Effects ADR.

### A5. Parallel `OrchestratorContext` type and `Orchestrator<I, O>` type alias

Initial drafts of D3 proposed adding `OrchestratorContext` (a context shape every orchestrator receives) and `Orchestrator<I, O>` (a type alias documenting `(input, ctx) => Promise<O>`). The intent was "give orchestrators a base contract so future cross-cutting concerns are added once."

**Rejected** for three converging reasons:

1. **Duplicate of `PipelineContext`.** A field-level comparison showed `OrchestratorContext` would re-declare `agentManager`, `sessionManager`, `config`, `story`, `workdir`, `signal` — every field already on `PipelineContext` (`src/pipeline/types.ts:60`). This is exactly the partial-form duplication ADR-018 §B rejected for ADR-014/015/016.
2. **Doesn't catch the actual bugs.** A type alias on the orchestrator's top-level entry signature does not propagate to internal helpers. The #783 bug locations (`src/tdd/orchestrator.ts:264`, `src/tdd/session-runner.ts:253`, `src/tdd/rectification-gate.ts`) are internal helpers that take their own param lists; they would still typecheck against `?? wrapAdapterAsManager(agent)` regardless of the entry-point alias.
3. **Architectural placement is wrong.** `adapter-wiring.md` and ADR-018 §1 deliberately model orchestrators as **consumers of Layer 4** (composers of multiple `callOp` invocations), not as a peer layer to managers. ADR-018 §5.3 / §5.4 made TDD's three-session orchestrator a plain function and `DebateRunner` a class without `ISessionRunner` precisely to avoid creating an orchestrator hierarchy. `Orchestrator<I, O>` would re-create the rejected layer.

**Accepted instead:** `DispatchContext` as a single base interface that the **already-existing** ~10 context types extend (D3). This is strictly subtractive on conceptual surface — adds 1 type, removes the 10-way duplication of the same 4 fields, and forces non-nullability everywhere by construction. Future cross-cutting fields go into `DispatchContext` once; the compiler then surfaces every consumer that must thread them. Same extensibility benefit, no parallel hierarchy.

### A6. Make `PipelineContext.agentManager` required, no base type

A YAGNI variant of D3: just drop the `?` from `PipelineContext.agentManager` and audit each compile error. **Rejected** after the audit found the issue is broader than `PipelineContext` — ~10 distinct context types declare `agentManager`, half optional. Fixing only `PipelineContext` would close the bug class for pipeline stages but leave it open for `AcceptanceLoopOptions`, `DebateRunnerCtx`, `RoutingCtx`, `PlanCtx`, lifecycle options, and the rest. `DispatchContext` (D3) closes all of them in one structural pass.

---

## Open Questions

1. Should `OperationCompletedEvent` carry per-hop cost (sum of `DispatchEvent.exactCostUsd` across the chain) for convenience, or should subscribers join the two streams themselves? **Recommendation:** carry it, computed inside `runWithFallback` from the dispatch events it just emitted. Cheap, eliminates a join.
2. Do plugin authors writing custom middleware need a stable subscription API beyond `runtime.events.on("dispatch", …)`? **Recommendation:** document `runtime.events` as the public API in `docs/architecture/plugins.md`; no separate registration helper unless a real plugin asks for one.
3. Should `verify` / `recover` be allowed to call back into the agent (e.g. "ask the agent to repair its own output")? **Recommendation:** no in this ADR. Keep `VerifyContext` filesystem-read-only. Agent re-prompting is a rectification concern and lives in the rectifier, not the op contract. Revisit if a real use case appears.

---

## References

- ADR-018: Runtime Layering with Session Runners — `docs/adr/ADR-018-runtime-layering-with-session-runners.md`
- ADR-018 Gap Review — `docs/adr/ADR-018-gap-review.md`
- ADR-019: Adapter Primitives & Session Ownership — `docs/adr/ADR-019-adapter-primitives-and-session-ownership.md`
- Finding: Prompt-audit dispatch boundary — `docs/findings/2026-04-28-prompt-audit-dispatch-boundary.md`
- Issue #773 — Make prompt/cost audit dispatch-boundary explicit
- PR #771 — Restore prompt audit filename consistency
- PR #772 — Cost audit follow-up (companion to #771)
- PR #774 — Restore ACP agent-written file recovery in acceptance-setup
- PR #783 — Thread `ctx.agentManager` into TDD dispatch path
