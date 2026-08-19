---
priority: 35
appliesTo:
  - "src/agents/**/*.ts"
  - "src/operations/**/*.ts"
  - "src/pipeline/**/*.ts"
  - "src/execution/**/*.ts"
  - "src/tdd/**/*.ts"
  - "src/acceptance/**/*.ts"
  - "src/review/**/*.ts"
  - "src/debate/**/*.ts"
  - "src/routing/**/*.ts"
  - "src/cli/**/*.ts"
  - "src/verification/**/*.ts"
  - "src/runtime/**/*.ts"
  - "src/session/**/*.ts"
stages:
  - "context"
  - "execution"
  - "tdd-implementer"
  - "rectify"
  - "autofix"
  - "single-session"
  - "tdd-simple"
  - "no-test"
  - "batch"
  - "review-adversarial"
---

# Adapter Wiring

> Spec: `docs/architecture/subsystems.md` §34–§37, `docs/architecture/agent-adapters.md` §14–§16. ADRs: 018, 019.

## Pick the highest layer that fits

| Layer | Entry point | Use when |
|:---|:---|:---|
| 4 — Operation | `callOp(ctx, op, input)` | Default. Op spec carries config slice + builder + parser. |
| 3 — Manager API | `agentManager.completeAs` / `runAsSession` / `runWithFallback` | Behavior outside an `Operation`. |
| 2 — Session | `sessionManager.openSession` / `sendPrompt` / `closeSession` / `runInSession` / `handoff` | Ad-hoc session work. |
| 1 — Adapter primitive | `adapter.openSession` / `sendTurn` / `closeSession` / `complete` | **Wiring layer only** — see Rule 3. |

## Rule 1: Adapter has 4 primitives; no cost-reporting surface

`adapter.run` / `plan` / `decompose` and `agentManager.planAs` / `decomposeAs` no longer exist. Plan and decompose are `kind:"complete"` ops (`planOp`, `decomposeOp`).

The agent adapter exposes exactly 4 primitives: `openSession`, `sendTurn`, `closeSession`, `complete`. The adapter is **cost-blind**. Cost recording is handled exclusively by the cost middleware layer (`DispatchEvent` → `CostAggregator`). Do not add cost-reporting fields or methods to the adapter interface — all cost attribution flows through orchestration layers via `CallContext.scopeId` and `costAggregator.openScope()`.

## Rule 2: Session naming

`SessionManager.nameFor(req)` is the SSOT. Format: `nax-<hash8>-<feature>-<storyId>-<sessionRole>`. Pass `storyId` whenever in story context; pass `sessionRole` for non-default sessions. Adapters never compute names.

### Session role registry

| Role | Dispatch |
|:---|:---|
| `main` *(default)*, `test-writer`, `verifier`, `implementer`, `diagnose`, `source-fix`, `test-fix`, `reviewer-semantic`, `reviewer-adversarial`, `acceptance-gen`, `plan`, `plan-draft`, `plan-revise`, `plan-critic`, `plan-refine`, `setup`, `debate-stateful`, `debate-hybrid`, `debate-plan`, `finish-review-spec`, `finish-review-quality`, `finish-fix`, `finish-narrative` | `callOp` run-kind |
| `decompose`, `refine`, `fix-gen`, `auto`, `synthesis`, `judge` | `callOp` complete-kind |

## Rule 3: Adapter primitives stay inside the wiring layer

Allowed callers of `adapter.openSession` / `sendTurn` / `closeSession` / `complete`:
`src/agents/manager.ts`, `src/agents/utils.ts`, `src/session/manager.ts`.

Everywhere else: go through `IAgentManager` / `ISessionManager`. Enforced by `test/integration/cli/adapter-boundary.test.ts`.

**Layer 3 (Manager API) is the intentional escape hatch for parallel fan-out and plugin contracts** — not a generic "behavior outside an Operation." Reach for it only when the dispatch shape cannot be expressed as a single `callOp` call. The only sanctioned `agentManager.completeAs` consumers are:

- Debate fan-out (`src/debate/`) — parallel multi-agent debater invocations with dynamic agent names that preclude a static op config. (#855 Phase 1 + Phase 2 have landed: resolver selectors — `synthesis` and `judge` — dispatch via `callOp` complete-kind; debater session roles — `debate-stateful`, `debate-hybrid`, `debate-plan` — dispatch via `callOp` run-kind. The `` debate-${string} `` template-literal carve-out is retired; all debate roles now flow through `callOp`.)
- `AgentManager`'s own internal dispatch (`src/agents/manager.ts`).

New code goes through `callOp`. If you think you need Layer 3, check with the team first.

## Rule 4: Agent resolution

- Pipeline / op code: `ctx.agentManager?.getDefault() ?? "claude"` (or `ctx.agentName` inside an op).
- Standalone: `resolveDefaultAgent(config)` from `src/agents`.
- Never read `config.autoMode.defaultAgent` (rejected at load time).
- Never import from `src/agents/registry.ts` (Phase-4 boundary; not exported from the barrel).

## Rule 5: Permissions resolve at the resource opener

Only `SessionManager.openSession` and `AgentManager.completeAs` call `resolvePermissions`. Everyone above passes `pipelineStage` upward; never resolve in middle layers, never hardcode `dangerouslySkipPermissions`.

## Rule 6: CallContext fields — input only, no result-side data

`CallContext` carries **input-side** information: `scopeId` (for cost attribution), stage, story metadata, runtime references. Explicitly forbid adding new `CallContext` fields whose purpose is to surface result-side data (cost, stats, agent output, turn metadata). 

Result-side data flows through:
- `TurnResult` (turnId, estimatedCostUsd, etc.)
- `DispatchEvent` (middleware observation, not CallContext)
- `CostAggregator` (scope-aggregated totals, not CallContext)

If you need to thread result data backwards to a caller, the result is already in `O` or a sibling return value — never extend `CallContext` as a back-channel. This prevents callsite confusion (is this field for sending to the agent, or reporting back to the caller?) and keeps the adapter boundary clean.

## Rule 7: Leaf code must stay cost-blind

Selectors, debater closures, and helper functions that influence routing or execution decisions **must not** read cost data or make decisions based on cost. Cost is an orchestration concern, not a local decision concern.

- Selectors (`synthesisOp`, `judgeOp` resolvers) cannot reference cost aggregators or turn results.
- Debater closures (`debate/debater-selector.ts`) cannot introspect `CostAggregator` or `TurnResult.estimatedCostUsd`.
- Leaf helpers (e.g. quality thresholds, routing heuristics) must declare their inputs explicitly — no implicit dependency-injection of cost.

Cost attribution belongs to **orchestration layers** that wire `costAggregator.openScope()` and pass `scopeId` downward through `CallContext`. Leaf code sees neither `CostAggregator` nor `DispatchEvent` — it receives only structured input and returns structured output.