---
paths:
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

## Rule 1: Adapter has 4 primitives

`adapter.run` / `plan` / `decompose` and `agentManager.planAs` / `decomposeAs` no longer exist. Plan and decompose are `kind:"complete"` ops (`planOp`, `decomposeOp`).

## Rule 2: Session naming

`SessionManager.nameFor(req)` is the SSOT. Format: `nax-<hash8>-<feature>-<storyId>-<sessionRole>`. Pass `storyId` whenever in story context; pass `sessionRole` for non-default sessions. Adapters never compute names.

### Session role registry

| Role | Dispatch |
|:---|:---|
| `main` *(default)*, `test-writer`, `verifier`, `implementer`, `diagnose`, `source-fix`, `test-fix`, `reviewer-semantic`, `reviewer-adversarial` | `callOp` run-kind |
| `plan`, `decompose`, `acceptance-gen`, `refine`, `fix-gen` | `callOp` complete-kind |
| `auto`, `synthesis`, `judge` | `agentManager.completeAs` |
| `` debate-${string} `` | `agentManager.runAsSession` |

## Rule 3: Adapter primitives stay inside the wiring layer

Allowed callers of `adapter.openSession` / `sendTurn` / `closeSession` / `complete`:
`src/agents/manager.ts`, `src/agents/utils.ts`, `src/session/manager.ts`.

Everywhere else: go through `IAgentManager` / `ISessionManager`. Enforced by `test/integration/cli/adapter-boundary.test.ts`.

## Rule 4: Agent resolution

- Pipeline / op code: `ctx.agentManager?.getDefault() ?? "claude"` (or `ctx.agentName` inside an op).
- Standalone: `resolveDefaultAgent(config)` from `src/agents`.
- Never read `config.autoMode.defaultAgent` (rejected at load time).
- Never import from `src/agents/registry.ts` (Phase-4 boundary; not exported from the barrel).

## Rule 5: Permissions resolve at the resource opener

Only `SessionManager.openSession` and `AgentManager.completeAs` call `resolvePermissions`. Everyone above passes `pipelineStage` upward; never resolve in middle layers, never hardcode `dangerouslySkipPermissions`.
