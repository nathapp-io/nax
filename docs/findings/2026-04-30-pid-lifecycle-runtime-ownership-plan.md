# Plan — Move PID lifecycle into the runtime/managers, eliminate caller threading

**Branch:** `fix/pid-registry-unregister-and-safer-kill` (already has commit `7e246103` — see "Prerequisite" below)
**Hand-off:** intended for Sonnet to execute end-to-end
**Estimated scope:** ~12 files modified, net diff likely smaller than the prerequisite commit (we delete more than we add)

---

## 1. Context (read this first — no prior conversation needed)

### What just shipped (commit `7e246103`)

The prerequisite commit reintroduces symmetric register/unregister to `PidRegistry` and hardens the kill path. It does so by adding an `onPidExited?: (pid: number) => void` callback alongside `onPidSpawned` and threading both through ~12 call sites. That commit is correct and stays — but the *shape* it preserves is fragile: every future caller must remember to pass both halves, or the registry leaks dead PIDs again.

Read the commit message of `7e246103` for the failure history (ADR-013 Phase 3 introduced the imbalance; PR #793 amplified it; the worst-case symptom was Ctrl+C signaling unrelated process groups, which from the user's perspective looked like the Linux desktop session crashing). That context informs why we want a stronger guarantee here.

### What this plan changes

PID lifecycle is a **runtime-shared resource concern**, not a caller concern. The runtime already owns `agentManager` + `sessionManager` (per ADR-018). It should also own `PidRegistry`, and the two managers should attach lifecycle callbacks to adapter calls **transparently**. Callers stop threading the callbacks at all — the public-facing options types lose `onPidSpawned` and `onPidExited` entirely. The fields survive only at the adapter primitive boundary, where the wiring layer attaches them.

This aligns with two existing rules the codebase already enforces:

- **ADR-018 §2** — one runtime per run, single owner of shared run state.
- **ADR-019 Rule 3 / `.claude/rules/adapter-wiring.md`** — adapter primitives (`openSession` / `sendTurn` / `closeSession` / `complete`) are wiring-layer-only. The wiring layer is the right place to attach lifecycle hooks.

### Architecture target

```
                 NaxRuntime                                     ← owns pidRegistry
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  SessionManager       AgentManager                             ← receive pidRegistry at configureRuntime()
   .openSession()        .completeAs()
        │                   │
        ▼                   ▼
  adapter.openSession  adapter.complete                         ← managers attach onPidSpawned/onPidExited here
  (with lifecycle      (with lifecycle
   attached)            attached)

  Callers (op, pipeline stage, cli/plan, rectification, autofix, ...)
                                                                ← pass NOTHING. Lifecycle is invisible.
```

---

## 2. Acceptance criteria

The refactor is done when **all** of these hold:

1. `runtime.pidRegistry` is the single instance per run, set up by `createRuntime()`. `runtime.onPidSpawned` and `runtime.onPidExited` are removed from the `NaxRuntime` interface.
2. `SessionManager.openSession()` automatically passes `onPidSpawned` and `onPidExited` to `adapter.openSession()` when its configured `pidRegistry` is present. Callers do not pass them.
3. `AgentManager.completeAs()` automatically passes `onPidSpawned` and `onPidExited` to `adapter.complete()` when its configured `pidRegistry` is present. Callers do not pass them.
4. `AgentRunOptions`, `PlanOptions`, and `OpenSessionInternalOpts` no longer expose `onPidSpawned` / `onPidExited` fields. The fields remain on `OpenSessionOpts` and `CompleteOptions` (the two adapter primitive surfaces) where the wiring layer attaches them. See §3 Step 4 for the precise boundary.
5. Every `onPidSpawned` / `onPidExited` reference outside the four allowed locations is deleted. Allowed locations after the refactor:
   - `src/agents/types.ts` — interface declarations on `OpenSessionOpts` and `CompleteOptions` only
   - `src/agents/manager.ts` — the attach inside `completeWithFallback`
   - `src/agents/acp/**` — adapter primitives + spawn-client (where the adapter actually fires the callbacks)
   - `src/session/manager.ts` — the attach inside `openSession`

   Specifically, `src/runtime/` should have **zero** matches after the refactor — including `session-run-hop.ts` and `index.ts`.
6. `cli/plan.ts` no longer constructs its own `PidRegistry` — it uses the runtime's. (Closes a related crash-handler-visibility gap: the cli/plan-owned registry was previously invisible to the run-level signal handlers.)
7. `bun run typecheck` clean.
8. `bun run lint` clean.
9. Targeted unit suites pass: `bun test test/unit/runtime/ test/unit/agents/ test/unit/session/ test/unit/execution/ test/unit/operations/ test/unit/pipeline/ test/unit/cli/ test/unit/verification/ test/unit/tdd/ --timeout=10000`.
10. Adapter-boundary integration test still passes: `bun test test/integration/cli/adapter-boundary.test.ts --timeout=10000`.
11. The "I forgot to add `onPidExited:`" failure mode is **not reachable** from a caller — that is, there should be no callable API surface where a caller can pass `onPidSpawned` without `onPidExited` (other than directly constructing an adapter, which is already forbidden by the wiring-layer rule and enforced by `scripts/check-no-adapter-wrap.sh` + the adapter-boundary integration test).
12. The kill-path safety hardening from `7e246103` (`pid <= 1` rejection, single-PID kill, `cleanupStale()` no-signal) is **untouched** — that's defense-in-depth in case anyone ever does construct an adapter directly.

---

## 3. Step-by-step

### Step 0 — sanity check the starting state

```bash
git log --oneline -3
# Expect: 7e246103 fix(pid-registry): restore unregister symmetry...

bun run typecheck
bun run lint
# Both must be clean before you start. If they are not, stop and reconcile first.
```

### Step 1 — `NaxRuntime` owns `PidRegistry`

**File:** `src/runtime/index.ts`

- Add `import { PidRegistry } from "../execution/pid-registry";` (value import, not type-only — `createRuntime` may construct a default). Confirm no import cycle: `src/execution/pid-registry.ts` currently imports only from `node:fs`, `node:fs/promises`, and `../logger` — safe.
- Add to the `NaxRuntime` interface (in this same file):
  ```ts
  readonly pidRegistry: PidRegistry;
  ```
  Make it required, not optional, so callers can rely on `runtime.pidRegistry` without nullable checks downstream.
- **Remove** these fields from `NaxRuntime` (added by `7e246103`):
  ```ts
  readonly onPidSpawned?: (pid: number) => void;
  readonly onPidExited?: (pid: number) => void;
  ```
- Add `pidRegistry?: PidRegistry` to `CreateRuntimeOptions` (still optional here — caller can supply a pre-built one for tests, but if absent `createRuntime` constructs one). **Remove** `onPidSpawned` and `onPidExited` from `CreateRuntimeOptions`.
- Inside `createRuntime()`:
  - `const pidRegistry = opts?.pidRegistry ?? new PidRegistry(workdir);`
  - Store on the returned object: `pidRegistry,`
  - Pass `pidRegistry` into the SessionManager and AgentManager `configureRuntime` opts at lines 154 and 169 (see Step 2 and Step 3).
  - In the `createAgentManager(...)` else-branch at line 172, the registry needs to flow through too. `createAgentManager` is defined in `src/agents/factory.ts:25` (re-exported from `src/runtime/internal/agent-manager-factory.ts`). Either extend `CreateAgentManagerOpts` (in `src/agents/factory.ts`) to carry `pidRegistry?: PidRegistry`, or — simpler — call `agentManager.configureRuntime({ pidRegistry })` from `runtime/index.ts` immediately after the factory returns. Prefer the second: keeps the factory signature unchanged and matches the if-branch behavior.

### Step 2 — `SessionManager` attaches the lifecycle

**File:** `src/session/manager.ts`

- `SessionManager` is declared at line 63. Add a private `_pidRegistry?: PidRegistry` field.
- Extend `configureRuntime()` (line 85) opts to accept `pidRegistry?: PidRegistry`. The current opts shape is `{ getAdapter?, config?, dispatchEvents?, defaultAgent? }` — add `pidRegistry?` and store via `if (opts.pidRegistry) this._pidRegistry = opts.pidRegistry`.
- The single `adapter.openSession` call is at line 379 (the only one in this file — line 563 is `this.openSession(...)` recursing into the public method). At line 379, **always** include both callbacks in the adapter call:
  ```ts
  onPidSpawned: this._pidRegistry ? (pid) => this._pidRegistry!.register(pid) : undefined,
  onPidExited: this._pidRegistry ? (pid) => this._pidRegistry!.unregister(pid) : undefined,
  ```
  These overrides are unconditional — do not honor any caller-supplied values, because callers will no longer be able to supply them once the type changes (Step 5).
- **Remove** `onPidSpawned` and `onPidExited` from `OpenSessionInternalOpts` in `src/session/types.ts` (added by `7e246103`).

### Step 3 — `AgentManager` attaches the lifecycle for `complete()`

**File:** `src/agents/manager.ts`

- Add a private `_pidRegistry?: PidRegistry` field on `AgentManager` (class declared at line 64).
- Extend `configureRuntime()` (line 105) opts to accept `pidRegistry?: PidRegistry`. The current opts shape is `{ middleware?, runId?, sendPrompt?, runHop?, dispatchEvents? }` — add `pidRegistry?` and store via `if (opts.pidRegistry) this._pidRegistry = opts.pidRegistry`.
- The `complete()` call chain is:
  ```
  complete(prompt, options)         → completeAs(default, prompt, options)         (line 467)
  completeAs(agentName, prompt, options) → completeWithFallback(prompt, augmented)  (line 571 → line 585)
  completeWithFallback(prompt, options) → adapter.complete(prompt, options)         (line 356 → line 385)
  ```
  There is **exactly one** `adapter.complete` call site in this file: line 385, inside the `completeWithFallback` while-loop. **Attach the lifecycle there**, not in `completeAs`.
- Replace the bare `result = await adapter.complete(prompt, options)` (line 385) with:
  ```ts
  const optionsWithLifecycle: CompleteOptions = this._pidRegistry
    ? {
        ...options,
        onPidSpawned: (pid: number) => this._pidRegistry!.register(pid),
        onPidExited: (pid: number) => this._pidRegistry!.unregister(pid),
      }
    : options;
  result = await adapter.complete(prompt, optionsWithLifecycle);
  ```
- This is the *one* place in the codebase that should construct these callbacks for `complete()`. The same applies to `openSession()` in `SessionManager` (Step 2) for the run path. No other production code should reference `pidRegistry.register` / `.unregister` directly after this refactor.

### Step 4 — Trim the public-facing options types

The two callbacks should live **only** on the adapter primitive surfaces:
- `OpenSessionOpts` (in `src/agents/types.ts`) — kept, because the adapter primitive consumes them.
- `CompleteOptions` (in `src/agents/types.ts`) — **kept**, because `adapter.complete()` consumes them. But the `completeAs` flow attaches them inside the manager, so callers don't need to provide them. Mark them `@internal` in JSDoc and document that callers should not pass them — `AgentManager` overrides any caller-supplied values.

**Remove** the fields from these higher-level shapes:

| File | Type | Action |
|:---|:---|:---|
| `src/agents/types.ts` | `AgentRunOptions` | Remove `onPidSpawned` and `onPidExited`. |
| `src/agents/shared/types-extended.ts` | `PlanOptions` | Remove `onPidSpawned` and `onPidExited`. |
| `src/session/types.ts` | `OpenSessionInternalOpts` | Remove `onPidSpawned` and `onPidExited`. |

Note `CompleteOptions` is retained because the manager-attach happens *during* the `completeAs` → `adapter.complete` boundary, and the field needs to survive that hand-off. Add a JSDoc note saying "set by `AgentManager.completeAs`; callers must not pass this — it will be overwritten." `OpenSessionOpts` likewise stays.

### Step 5 — Delete the now-dead caller threading

For each of these files, delete the `onPidSpawned: …` and `onPidExited: …` lines that I added in `7e246103`:

| File | Lines to delete |
|:---|:---|
| `src/operations/call.ts` | The `onPidSpawned: ctx.runtime.onPidSpawned` and `onPidExited: ctx.runtime.onPidExited` from the `completeAs` call. |
| `src/runtime/session-run-hop.ts` | `onPidSpawned: options.onPidSpawned` and `onPidExited: options.onPidExited`. |
| `src/pipeline/stages/execution.ts` | Delete the `const pidRegistry = ctx.pidRegistry;` at line 160 (becomes unused) **and** the `onPidSpawned`/`onPidExited` registry-callback lines in `baseRunOptions`. |
| `src/pipeline/stages/autofix-agent.ts` | The `onPidSpawned`/`onPidExited` lines in the `runtime.openSession` call. |
| `src/verification/rectification-loop.ts` | Same. |
| `src/tdd/rectification-gate.ts` | Same. |
| `src/cli/plan.ts` | Three touches: **(a)** delete `onPidSpawned`/`onPidExited` lines in the `agentManager.runAs(...)` call (interactive plan path, around line 270 area). **(b)** delete the standalone `const pidRegistry = new PidRegistry(workdir);` at line 245. **(c)** replace `pidRegistry.killAll()` at line 283 with `rt.pidRegistry.killAll()`. The `auto` path (line 188 `callOp(...)`) does not need editing — `callOp` already routes through `agentManager.completeAs`, which will get the lifecycle attached automatically per Step 3. Detail in Step 6. |
| `src/execution/lifecycle/run-setup.ts` | Multiple touches: **(a)** delete `const pidRegistry = new PidRegistry(workdir);` (line 170 — runtime constructs its own now). **(b)** Delete the `onPidSpawned`/`onPidExited` opts in the `createRuntime({ ... })` call (lines 187–188 — those keys are removed from `CreateRuntimeOptions` in Step 1). **(c)** Replace the `await pidRegistry.cleanupStale();` call (line 191) with `await runtime.pidRegistry.cleanupStale();`. **(d)** Replace the `pidRegistry,` reference inside the `installCrashHandlers({ ... })` call (line 199 area) with `pidRegistry: runtime.pidRegistry`. The construction order is already correct — `createRuntime` at line 182 runs before both `cleanupStale` and `installCrashHandlers`. |

After this step, `grep -rn 'onPidSpawned\|onPidExited' src/` should return matches only in:
- `src/agents/types.ts` (interface declarations on `OpenSessionOpts` and `CompleteOptions`)
- `src/agents/manager.ts` (Step 3 attach-site)
- `src/agents/acp/**` (adapter primitives + spawn-client where the adapter actually fires the callbacks)
- `src/session/manager.ts` (Step 2 attach-site)

If anything else lights up, you missed a deletion.

### Step 6 — `cli/plan.ts` migration detail

`cli/plan.ts` does NOT call `createRuntime` directly; it uses the helper `createPlanRuntime(config, workdir, options.feature)` from `src/cli/plan-runtime.ts` (called at lines 128, 175, 231 of plan.ts). The bare `pidRegistry` is constructed at line 245, *after* `createPlanRuntime`, and is currently invisible to crash-signal handlers.

After Step 1, `createRuntime` constructs a default `PidRegistry(workdir)` whenever opts don't supply one. `createPlanRuntime` already routes through `createRuntime` (see `src/cli/plan-runtime.ts:34-41`) — its returned runtime will therefore automatically carry a `pidRegistry`. **No signature change to `createPlanRuntime` is required.**

Migration steps:

1. In `cli/plan.ts`, **delete line 245** (`const pidRegistry = new PidRegistry(workdir);`).

2. Replace the cleanup call at line 283 (`await pidRegistry.killAll().catch(() => {})`) with `await rt.pidRegistry.killAll().catch(() => {})`. (Note: required field, no `?.` needed after Step 1.)

3. Verify the unused import: remove `PidRegistry` from the imports at the top of `cli/plan.ts` if no other reference remains.

4. Confirm there are no other `PidRegistry` constructors anywhere outside `src/runtime/` after the refactor: `grep -rn "new PidRegistry" src/` should match only `src/runtime/index.ts` and (untouched) `src/execution/pid-registry.ts` self-references and tests.

5. **Other `createPlanRuntime` callers:** `src/cli/plan-decompose.ts:71` also calls `createPlanRuntime`. It does not currently construct a separate `PidRegistry` — and after Step 1 it will inherit one for free. Verify nothing else there needs changing.

### Step 7 — Tests

- **`test/unit/agents/acp/spawn-client-pid-callback.test.ts`** stays — it tests the adapter primitive, which still exposes the callbacks. No change needed.
- **`test/unit/execution/pid-registry.test.ts`** stays — tests the registry directly. No change needed.
- **Add `test/unit/session/manager-pid-lifecycle.test.ts`** with these cases (mirror the existing `test/unit/session/` naming convention; if the directory has a different convention, follow it):
  - When `SessionManager` is configured with a `pidRegistry`, calling `openSession()` results in `adapter.openSession` receiving an `onPidSpawned` AND `onPidExited` that, when invoked, route to the registry's `register` / `unregister`. Use `makeAgentAdapter` from `test/helpers/`.
  - When `SessionManager` has no `pidRegistry`, the adapter receives `undefined` for both callbacks (opt-out is allowed).
  - The type system prevents passing `onPidSpawned` / `onPidExited` through `OpenSessionInternalOpts` (verify with a `// @ts-expect-error` assertion).
- **Add complete-path lifecycle tests to `test/unit/agents/manager-complete.test.ts`** (existing file — extend it; do not create a separate `manager-pid-lifecycle.test.ts` for AgentManager, the convention is to group by manager method). Same three cases for `AgentManager` against `adapter.complete`.
- **Update existing call-site tests** that previously asserted the caller passed callbacks. Most were testing object identity (`expect(opts.onPidSpawned).toBe(...)`); rewrite them to assert behavior — that the registry's `register` was called when the adapter fired the callback.
- Use `test/helpers/` factories per `.claude/rules/test-helpers.md` — do not inline mocks.

### Step 8 — Verify and commit

```bash
bun run typecheck
bun run lint
timeout 120 bun test test/unit/runtime/ test/unit/agents/ test/unit/session/ test/unit/execution/ test/unit/operations/ test/unit/pipeline/ test/unit/cli/ test/unit/verification/ test/unit/tdd/ --timeout=10000
timeout 60 bun test test/integration/cli/adapter-boundary.test.ts --timeout=15000
```

All must be green. Then commit on the same branch:

```
refactor(runtime): runtime owns PidRegistry; managers attach lifecycle automatically

Eliminates the entire class of "caller forgot to pass onPidExited" bugs by
removing the caller-threading entirely. PidRegistry now lives on NaxRuntime;
SessionManager.openSession and AgentManager.completeAs attach the
register/unregister callbacks to adapter primitive calls automatically. The
public-facing options types (AgentRunOptions, PlanOptions,
OpenSessionInternalOpts) no longer expose onPidSpawned/onPidExited; the
fields survive only at the adapter primitive boundary where the wiring
layer attaches them.

Aligns with ADR-018 (runtime owns shared run state) and ADR-019 (managers
own dispatch + middleware; adapter primitives are wiring-layer-only).

Side-effect: closes a related gap where cli/plan constructed its own
PidRegistry that was invisible to crash-signal handlers.
```

---

## 4. Things that are NOT in scope

- Do not modify `src/execution/pid-registry.ts` — its safety hardening from `7e246103` is independent and final.
- Do not modify `SpawnAcpSession.prompt()` finally-block — `notifyExit()` stays. The change is *who attaches the callback*, not *whether the adapter fires it*.
- Do not touch `crash-signals.ts` — it already reads `pidRegistry` from its own `SignalHandlerContext`, which is wired separately in `run-setup.ts`. (Verify this still works after the run-setup migration in Step 6 — but no code change should be needed in `crash-signals.ts`.)

---

## 5. Watchpoints / known traps

1. **Import cycle risk on `src/runtime/index.ts` ↔ `src/execution/pid-registry.ts`.** `runtime/` already imports from `agents/`, `session/`, `config/`. Adding `execution/pid-registry.ts` to the runtime should be safe (one-way), but verify with `bun run typecheck` — if it complains, fall back to a structural `IPidRegistry` interface declared in `src/runtime/pid-registry-types.ts`.

2. **`AgentManager.completeAs` is called from many places, but none of them need to pass lifecycle callbacks.** After Step 5 the field is removed from `AgentRunOptions`/`PlanOptions` consumers; the type-system catches stragglers. `CompleteOptions` keeps the fields (adapter consumes them) but they're marked `@internal`/"set by manager".

3. **There is exactly ONE `adapter.complete` call site in `agents/manager.ts`** — line 385, inside `completeWithFallback`'s while-loop. There is no separate retry-branch site. Verify with `grep -n "adapter\.complete" src/agents/manager.ts` (expect 1 match).

4. **`cli/plan.ts` uses `createPlanRuntime`, not `createRuntime` directly.** See Step 6 — the wrapper helper needs to route the `pidRegistry` through to `createRuntime` so it lands on `rt.pidRegistry`.

5. **Tests that assert "the caller passed `onPidSpawned`"** — those are testing the wrong thing under the new model. Rewrite them to assert behavior at the adapter boundary or at the registry, not at the options-object level.

6. **`fakeAgentManager` test helper** (`test/helpers/fake-agent-manager.ts`) wraps a single adapter without going through the manager attach path. After this refactor, tests that use it to exercise complete-path behavior do *not* automatically get lifecycle attached. That's fine — those are unit tests of the adapter primitive, not the manager — but if any test relied on the registry being touched via `fakeAgentManager`, update it to use a real `AgentManager` (or pass `pidRegistry` directly via the test helper if you extend it).

7. **Backward compat of `OpenSessionOpts.onPidSpawned`** — keep this exposed on the adapter primitive (`adapter.openSession`). Callers above the adapter boundary go through `SessionManager.openSession`, which has its own (different) options type without these fields. Don't conflate the two.

8. **`AgentManager.configureRuntime` and `SessionManager.configureRuntime`** are both **idempotent merges** — they only assign fields that are present in the opts object. So passing `{ pidRegistry }` from `runtime/index.ts` won't clobber existing fields. Follow the existing `if (opts.X) this._X = opts.X` pattern.

9. **`PipelineContext.pidRegistry` becomes dead** after Step 5 (the only production consumer was the deleted `const pidRegistry = ctx.pidRegistry;` at `src/pipeline/stages/execution.ts:160`). Cleanup chain — these are **recommended** for a clean refactor, but not strictly required for the bug fix:
   - `src/pipeline/types.ts:114` — `pidRegistry?: PidRegistry` field
   - `src/execution/runner-execution.ts:52` (declaration) and line 166 (propagation)
   - `src/execution/executor-types.ts:50` — `pidRegistry?: PidRegistry` field
   - `src/execution/unified-executor.ts:252` — `pidRegistry: ctx.pidRegistry,` propagation

   Don't conflate with `SignalHandlerContext.pidRegistry` in `src/execution/crash-signals.ts` — that's a different type carrying the same registry, wired by `installCrashHandlers` in `run-setup.ts`. It stays. If you skip the cleanup, leave a `// TODO(post-refactor): unused — remove when no consumers` comment on each dead field; if you do the cleanup, make sure typecheck stays green and that no test reads `ctx.pidRegistry`.

10. **The `crash-signals.ts` `ctx.pidRegistry` reads (lines 89/97-98/138/144-145/188/194-195)** are reading `SignalHandlerContext.pidRegistry`, not `PipelineContext.pidRegistry`. They continue to work as-is — `installCrashHandlers` is called from `run-setup.ts` and gets `runtime.pidRegistry` after Step 5(d). No change to `crash-signals.ts`.

---

## 6. Rollback plan

If something goes wrong, the prerequisite commit `7e246103` is fully self-sufficient — the codebase is safe with that commit alone (kill path is hardened, lifecycle is symmetric). You can `git reset --hard 7e246103` and abandon this refactor without losing the bug fix. Only do this if you've verified the `7e246103` state is green first.

---

## 7. Done definition

- All 12 acceptance criteria in §2 satisfied.
- Two commits on the branch: `7e246103` (the prerequisite) + the new refactor commit from Step 8.
- A grep-sweep proving §5: `grep -rn 'onPidSpawned\|onPidExited' src/` returns matches only in the four sanctioned locations listed in Step 5.
- PR description references this plan file and explains both commits' roles (defense-in-depth + structural prevention).
