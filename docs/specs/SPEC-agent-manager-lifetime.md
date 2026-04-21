# SPEC — AgentManager Lifetime & Factory (ADR-013 Phase 6)

**Status:** Draft
**Date:** 2026-04-21
**Tracking issue:** TBD
**Parent ADR:** `docs/adr/ADR-013-session-manager-agent-manager-hierarchy.md`

---

## 1. Problem

`AgentManager` accumulates run-scoped state:

- `_unavailable: Map<string, AdapterFailure>` — agents that hit auth/rate-limit and should be skipped
- `_prunedFallback: Set<string>` — fallback chain entries already exhausted
- `_emitter: EventEmitter` — subscribers to `agentUnavailable`, `fallbackTriggered`, etc.

Seven `new AgentManager(config)` sites exist outside the canonical one in `src/execution/runner.ts`. Two run **mid-story**:

| Site | When it runs | Risk |
|:---|:---|:---|
| `src/verification/rectification-loop.ts:128` | During story execution, after verify fails | **High** — re-tries agents the main runner already marked unavailable |
| `src/debate/session-helpers.ts:81` | During debate stage within a story | **High** — same state leak |
| `src/acceptance/refinement.ts:25`, `src/acceptance/generator.ts:75` | Planning / acceptance setup | **Medium** — runs before story execution but during the same `nax` invocation |
| `src/routing/router.ts:271` | Pre-run classify phase | **Low** — before any story has touched state |
| `src/cli/plan.ts:62` | CLI entry (`nax plan`) | **None** — no active run |
| `src/execution/runner.ts:116` | Canonical — SSOT threaded via `ctx.agentManager` | **None** |

**Concrete failure mode:**

1. Story A runs. Main runner's `AgentManager` calls `adapter.run()` via `runAs("claude", …)`.
2. Claude returns 401 (expired token). Main manager calls `markUnavailable("claude", authFailure)`.
3. Fallback fires: codex runs, succeeds. Story A passes.
4. Story A enters rectification (verify caught an issue). `rectification-loop.ts` does `_deps.createManager(config)` — a fresh `AgentManager` with empty `_unavailable`.
5. Rectification calls `runAs("claude", …)`. New manager doesn't know claude is 401'd. Hits 401 again.
6. User sees two auth errors for the same story; log line "fallback triggered" appears twice; cost tracking double-counts the failed call.

**Factory concern (secondary):**

Six of the seven sites already use `_deps.createManager(config)` for testability, but each site defines its own factory inline:

```typescript
// Repeated in 6 files:
createManager: (config: NaxConfig): IAgentManager => new AgentManager(config),
```

If `AgentManager` constructor signature changes (e.g. takes a `SessionManager` or telemetry sink), all six factories break simultaneously. One centralized factory would mean one edit.

---

## 2. Design

### 2.1 Rule — one AgentManager per run

| Context | Source of `IAgentManager` |
|:---|:---|
| Inside a pipeline stage | `ctx.agentManager` (threaded from `runner.ts`) — no creation |
| Inside a module called from a pipeline stage | Receive as parameter or read from `ctx.agentManager` passed in |
| Pre-run / CLI entry point (no ctx) | Call factory `createAgentManager(config)` |
| Tests | `makeMockAgentManager(overrides?)` from `test/helpers` |

**Mid-story code must not create `new AgentManager`.** This is enforced by the boundary test (see §2.4).

### 2.2 Centralized factory

Create `src/agents/factory.ts`:

```typescript
import type { NaxConfig } from "../config";
import { AgentManager } from "./manager";
import type { IAgentManager } from "./manager-types";

/**
 * Single construction point for AgentManager. All code that must create a
 * new manager (pre-run phases, CLI entry points) goes through here so the
 * constructor signature can evolve without touching every call site.
 *
 * Mid-run code must receive an IAgentManager via context/DI — it must NOT
 * call this factory. See SPEC-agent-manager-lifetime.md §2.1.
 */
export function createAgentManager(config: NaxConfig): IAgentManager {
  return new AgentManager(config);
}
```

Export from `src/agents/index.ts`. All six `_deps.createManager` sites delegate:

```typescript
// Before
createManager: (config: NaxConfig): IAgentManager => new AgentManager(config),

// After
import { createAgentManager } from "../agents/factory";
createManager: createAgentManager,
```

### 2.3 Mid-story migration

`rectification-loop.ts` and `debate/session-helpers.ts` receive `agentManager` from their caller instead of creating one.

**Pattern:** extend the function signature to accept `agentManager: IAgentManager`, then thread from the caller (pipeline stage, which has `ctx.agentManager`).

```typescript
// Before
export async function runRectificationLoop(config: NaxConfig, ...) {
  const agentManager = _deps.createManager(config);
  // ...
}

// After
export async function runRectificationLoop(
  agentManager: IAgentManager,
  config: NaxConfig,
  ...
) {
  // no creation
}
```

For `acceptance/*` sites: audit whether they run inside a story context. If yes → migrate like rectification. If no (run during planning) → keep factory usage, but switch to the centralized `createAgentManager`.

### 2.4 Enforcement

Extend `test/integration/cli/adapter-boundary.test.ts` with a second test:

```typescript
test("no `new AgentManager(` outside agents/ and execution/runner.ts", async () => {
  const ALLOWED = new Set([
    "agents/manager.ts",      // the class definition
    "agents/factory.ts",      // the single factory
    "execution/runner.ts",    // the canonical per-run creation
  ]);
  // scan src/, fail if `new AgentManager(` appears elsewhere
});
```

---

## 3. Migration plan (per site)

| File | Category | Action |
|:---|:---|:---|
| `src/execution/runner.ts:116` | SSOT | Keep; migrate to `createAgentManager(config)` |
| `src/routing/router.ts:271` | Pre-run factory | Migrate `_deps.createManager` to delegate to `createAgentManager` |
| `src/cli/plan.ts:62` | CLI factory | Same — delegate |
| `src/acceptance/refinement.ts:25` | Audit needed | If run in-story → accept `agentManager` param; else delegate |
| `src/acceptance/generator.ts:75` | Audit needed | Same |
| `src/verification/rectification-loop.ts:128` | **Mid-story** | Accept `agentManager: IAgentManager` parameter; remove factory |
| `src/debate/session-helpers.ts:81` | **Mid-story** | Accept `agentManager: IAgentManager` parameter; remove factory |

Each migration gets its own commit. Verify with targeted tests + the new boundary test.

---

## 4. Acceptance criteria

- [ ] `src/agents/factory.ts` exists, exports `createAgentManager(config: NaxConfig): IAgentManager`
- [ ] `createAgentManager` exported from `src/agents/index.ts`
- [ ] `grep -rn "new AgentManager(" src/` outside `src/agents/manager.ts`, `src/agents/factory.ts`, `src/execution/runner.ts` → **0 hits**
- [ ] `rectification-loop.ts` and `debate/session-helpers.ts` accept `agentManager: IAgentManager` as a parameter; no internal factory
- [ ] `acceptance/refinement.ts` and `acceptance/generator.ts` audited and migrated per §3
- [ ] Boundary test `adapter-boundary.test.ts` extended with the `new AgentManager` check
- [ ] `bun run typecheck && bun run lint && bun run test:bail` all green
- [ ] Integration test demonstrates unavailability state survives a rectification loop (new test)

---

## 5. Test strategy

**Unit:** each migrated module receives `agentManager` via parameter — existing tests update to use `makeMockAgentManager()` from `test/helpers`.

**Integration (new):** `test/integration/agents/manager-lifetime.test.ts`:

1. Scenario: a run where agent claude is marked unavailable, then rectification fires.
2. Before fix: rectification re-hits claude 401.
3. After fix: rectification goes straight to the fallback agent.

**Boundary:** extend `adapter-boundary.test.ts` as in §2.4.

---

## 6. Rollback

Pure refactor — no behavior change visible to end-users beyond the bug fix. If the migration causes test regressions we couldn't resolve:

- `createAgentManager` factory stays (no risk)
- Revert the specific mid-story site migration commit
- The state leak resumes but nothing else is affected

Each commit is independent; git revert a single site's migration without touching others.

---

## 7. Open questions

- **Q1:** Should `acceptance/*` sites count as "mid-story" or "pre-run"? They run during the acceptance pipeline stage, which is inside the run but before story execution. The answer determines whether they need parameter threading (§2.3) or just factory delegation (§2.2). **To be decided during implementation — audit call chain.**
- **Q2:** Does `routing/router.ts` share any state across stories within a single run? If so, upgrade to mid-run pattern. Current read says no — router runs once in the classify phase. **Audit needed.**
- **Q3:** Do we also want to gate `new AgentManager` via a biome rule, or is the boundary test sufficient? **Defer — boundary test is the pattern used for Phase 5 and caught all violations there.**

---

## 8. Non-goals

- **Singleton pattern.** Not a singleton — that breaks parallel-story runs that need per-run isolation. Rule is "one per run," not "one per process."
- **Dependency injection framework.** Simple parameter threading is enough. No need for a DI container.
- **AgentManager API changes.** This SPEC does not alter the `IAgentManager` interface. Pure lifetime management.

---

## 9. References

- `docs/adr/ADR-013-session-manager-agent-manager-hierarchy.md` — parent ADR, Phases 1-5
- `.claude/rules/adapter-wiring.md` — Rule 3 (Agent Resolution)
- PR #614 — Phase 5 migration (where the state-leak was latent)
- PR #617 — Phase 5 follow-ups (where the review surfaced this gap)
