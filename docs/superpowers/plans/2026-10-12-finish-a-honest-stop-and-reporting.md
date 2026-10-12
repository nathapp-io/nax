# Finish A: Honest Stop and Reporting Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish stops when a time limit fires. A stopped fix session writes a handoff note in its own warm session, its edits are set aside (never committed) and offered to the next attempt, and the draft PR and `result.json` report every finding's state, every stop and real coverage.

**Architecture:**
- **Hard abort.** The call's abort signal finally reaches the agent turn (Task 1), and an aborted hop no longer swaps agents.
- **Soft interrupt.** Fix sessions are stopped by a soft interrupt that reuses the idle watchdog's cancel path, so the session stays warm (Tasks 2–3). The fix op then asks the same session for a handoff note (Task 6).
- **Fix sessions.** One wrapper, `runFixStep` (Task 8), runs every fix session. It owns the base snapshot, the commit guard, the set-aside (Task 7) and re-applying the previous handoff (Task 9).
- **Ledger.** A per-finding ledger (Task 10) feeds facts, reasons, checkpoints and the PR body (Tasks 11–13).

**Tech Stack:** TypeScript (strict), Bun 1.4 (`bun:test`), Biome. Package `packages/nax` in the nax monorepo.

**Spec:** `docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md` (read §3.2 and §4 before Tasks 2–9).

**Revision note:** rev 2 replaces rev 1 (`c5671e9c9`) after a read-only review found two blockers. Rev 1's in-session handoff after a hard abort could never run (`SESSION_CANCELLED`), and finalize could delete untracked files. Rev 2 also fixes 12 major issues. Do not consult rev 1.

## Global Constraints

- **Branch:** local `feat/finish-honest-stop`, no upstream. Never push to `main`.
- **Where to run:** commands run from `packages/nax` unless a step says otherwise (`../../` is the repo root).
- **Scoped tests:**
  - always `timeout 30 bun test <path> --timeout=5000`;
  - git-backed integration tests: `timeout -k 5s 60s bun test <path> --timeout=60000`;
  - never bare `bun test`, never `bun run nax`.
- **After every task:**
  - `timeout 30 bun test` on the touched test dirs;
  - `bun run typecheck`;
  - `bun run check:complexity` (cognitive-complexity limit 20 per function);
  - `bun run check:file-sizes`.
- **Before declaring done:** `bun run test`, `bun run check:all`, `bun run typecheck` and `bun run test:coverage` (package), plus `bun run check:all` at the repo root.
- **Time limits:** `reviewMs` default `900_000`, `fixMs` default `1_200_000`, `flowMs` default `10_800_000`. `acceptanceMs` (`600_000`) and `gateMs` (`900_000`) are unchanged. `stepMs` is removed by a shim.
- **Constants:**
  - `HANDOFF_TURN_MS = 120_000` (in `src/operations/finish-fix.ts`);
  - `STEP_TIMEOUT_MARGIN_MS = 60_000` (in `src/finish/step-signal.ts`);
  - `HANDOFF_MARKER = "<!-- nax-finish-handoff -->"` (in `src/finish/fix/handoff-note.ts`).
- **Stop latency:** a running review or fix turn ends within 30 s of its limit. The handoff turn is a separate step after it.
- **Git safety:** never `git clean`, never `git reset --hard`, never `git stash push/pop`. `git stash create` is allowed: it writes a commit object and does not touch the stash list or the tree.
- **Unchanged rules:** the ready/draft decision (`isClean`, `approvalFacts`, `resolve`), advisor callers, menus and ledger schemas.
- **`FinishState.version`** becomes `3`. `deserializeFinishState` accepts only `3`.
- **Frozen file:** `src/session/manager.ts` is grandfathered at 662 lines and may not grow (`scripts/baselines/file-sizes-baseline.json`).
- **Test rules** (`.claude/rules/`; `check:test-escape-hatches` counts casts per file. A new test file that needs a `SessionHandle` uses the same `{ id, agentName } as SessionHandle` shape the neighbouring session tests use; if the counter fails, reuse the neighbouring file's helper instead of adding casts):
  - no `as never`, no postfix `!` (use `assertDefined`), no `as unknown as`, no fixed sleeps;
  - temp dirs only through `withTempDir` / `makeTempDir` from `@test/helpers`;
  - shared mocks from `@test/helpers` (`makeAgentAdapter`, `makeTurnResult`, `makeSessionManager`, …);
  - unit tests mirror `src/`; real git only under `test/integration/`.
- **Source rules:**
  - no `console.log`;
  - `NaxError` with `stage`;
  - `_deps` seams for I/O;
  - every finish log has `storyId: "_run"` first;
  - prompts only in `src/prompts/builders/`;
  - LLM JSON only via `parseLLMJson` / `tryParseLLMJson`;
  - barrel imports in `src/`.
- **Commits:** conventional, one logical change each, no attribution lines.

## Review Focus

Most likely first. Each line names the task whose tests pin it.

1. **A soft interrupt that fires before the adapter registered the active call.** Expected: `interruptTurn` returns `false`, the turn runs to its own end, and the fix op's `timeoutMs` margin still bounds it. Pinned in Task 2 ("no active call") and Task 5 ("timeoutMs margin").
2. **A user's `.env`, or a pre-existing tracked edit (e.g. a gate's auto-fix), at fix-session start.** Expected: both survive a set-aside and a finalize. Pinned in Task 7 and Task 13.
3. **A flow deadline while a fix session is running.** Expected: an interrupt, then a handoff note, then a set-aside, then `FINISH_ABORTED`, then a draft with a `flow` stop. The handoff must survive the throw. Pinned in Task 8.
4. **A genuine idle-watchdog stall during a fix** (no interrupt fired). Expected: rethrown and stale-retried exactly as today; no handoff turn. Pinned in Task 6.
5. **A fixer reply with no `## DISPOSITIONS` section.** Expected: the findings stay `open`, never `fixed-unreviewed`. Pinned in Task 10.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/operations/call-run-options.ts` | modify | `abortSignal` on run options |
| `src/operations/call-dispatch-run.ts` | modify | pass `abortSignal`; widen hop-body `send` types |
| `src/agents/manager-run-fallback.ts` | modify | no swap after an aborted hop |
| `src/session/watchdog-cancel-tracker.ts` | modify | active calls per session; `interrupt()` |
| `src/session/watchdog-turn-classification.ts` | modify | `staleTurnFailure()` (moved out of `manager.ts`) |
| `src/session/manager.ts` | modify | `interruptTurn()`; net line count goes down |
| `src/session/types.ts` | modify | `ISessionManager.interruptTurn` |
| `test/helpers/mock-session-manager.ts` | modify | `interruptTurn` mock |
| `src/operations/send-interrupt.ts` | create | `withInterrupt()` |
| `src/operations/types.ts` | modify | `SendTurnOverrides`, `HopBodyContext.send(p, o?)` |
| `src/operations/build-hop-callback.ts`, `build-hop-callback-dispatch.ts` | modify | send honours `interrupt` |
| `src/config/finish-timeouts-shim.ts` | create | `stepMs` shim |
| `src/config/compat-shims.ts`, `schemas.ts`, `runtime-types-finish.ts`, `selectors.ts` | modify | timeouts |
| `src/finish/config.ts` | modify | `FinishSettings.timeouts` |
| `src/finish/step-signal.ts` | create | `stepSignal`, `STEP_TIMEOUT_MARGIN_MS` |
| `src/finish/ops.ts`, `ops-impl.ts`, `phase.ts` | modify | review limit, fix interrupt, run signal, margins |
| `src/finish/fix/handoff-note.ts`, `src/finish/fix/index.ts` | create / modify | `HANDOFF_MARKER`, `parseHandoffReply`, `isHandoffNote` |
| `src/operations/finish-fix.ts` | modify | `hopBody`, `parse`, `verify`, input fields |
| `src/prompts/builders/finish-review-builder.ts`, `src/prompts/index.ts` | modify | handoff and continuation prompts |
| `src/finish/set-aside.ts` | create | base, set-aside, restore, re-apply |
| `src/finish/fix-step.ts` | create | `runFixStep`, `consumeIfCommitted` |
| `src/finish/acceptance-loop.ts`, `gates-loop.ts`, `review-loop.ts`, `machine-deps.ts`, `machine.ts` | modify | use `runFixStep`; step tracking; stops |
| `src/finish/ledger.ts` | create | per-finding states |
| `src/finish/advise.ts` | modify | `JudgedResult.dropped` |
| `src/finish/state.ts`, `types.ts` | modify | v3 fields and types |
| `src/finish/checkpoint.ts` | create | atomic checkpoint |
| `src/finish/resolve.ts` | modify | facts from the ledger, reasons |
| `src/finish/pr/context.ts`, `pr/body.ts`, `commit.ts` | modify | table, Set aside, Stops; export `isDirty` |
| `../../docs/guides/configuration.md` | modify | timeouts |
| `test/helpers/finish-machine.ts` | modify | git model: stash, restore, diff, apply; `fixMs` / `flowMs` options |

---

### Task 1: The call's abort signal reaches the turn; an aborted hop never swaps

**Why:** `buildRunDispatchOptions` never sets `abortSignal`, so every hop sends its turn with `signal: resolvedRunOptions.abortSignal` = `undefined` (`build-hop-callback-dispatch.ts:143`). The abort is only checked after the hop returns (`call-dispatch-run.ts:191`).

Once the signal is threaded through, an aborted turn reads as `fail-adapter-error`. `decideSwap` can then swap agents when `fallback.onQualityFailure` is on (`manager-run-fallback.ts:164`, `swap-decision.ts:73-75`).

**Blast radius:**
- Every run-kind op now gets the call's signal in its turns. That is `ctx.signal ?? runtime.signal`, so Ctrl-C now interrupts in-flight turns, as `CallContext.signal`'s doc says it should.
- `openSession` receives it too (`build-hop-callback-hop.ts:418`). An ACP session opened under a call signal is closed when it aborts (`agents/acp/session.ts` `linkRunSignal`). That is correct for every op except the finish fix op, which Task 8 opens under the run signal only.

**Files:**
- Modify: `src/operations/call-run-options.ts`
- Modify: `src/operations/call-dispatch-run.ts` (`buildRunDispatchOptions(...)` call, ~L112)
- Modify: `src/agents/manager-run-fallback.ts` (before `decideSwap`, ~L164)
- Test: `test/unit/operations/call-run-options.test.ts`
- Test: the existing `runWithFallback` test file (`grep -rln "runWithFallback" test/unit/agents | head`)

**Interfaces:**
- Produces: `RunDispatchOptionsParams.abortSignal?: AbortSignal`; the returned options carry `abortSignal` when given.

- [ ] **Step 1: Write the failing run-options tests.** Append to `test/unit/operations/call-run-options.test.ts`, reusing its imports, `createdRuntimes` and the `afterEach`:

```ts
describe("buildRunDispatchOptions — abort signal (finish A, #2462)", () => {
  function ctxFor(): { ctx: CallContext; config: ReturnType<typeof makeNaxConfig> } {
    const config = makeNaxConfig();
    const runtime = makeTestRuntime({ config, workdir: "/repo" });
    createdRuntimes.push(runtime);
    return {
      config,
      ctx: { runtime, packageView: runtime.packages.resolve("packages/api"), packageDir: "packages/api", config, agentName: "claude" },
    };
  }
  const params = (config: ReturnType<typeof makeNaxConfig>) => ({
    prompt: "hi",
    effectiveTier: "balanced" as const,
    dispatchModelDef: { provider: "claude", model: "sonnet" },
    config,
    callId: "call-1",
    pipelineStage: "run" as const,
    declaredTools: ["Read" as const],
    keepOpen: false,
  });

  test("threads the call's abort signal onto the run options", () => {
    const { ctx, config } = ctxFor();
    const controller = new AbortController();
    const result = buildRunDispatchOptions(ctx, { ...params(config), abortSignal: controller.signal });
    expect(result.abortSignal).toBe(controller.signal);
  });

  test("omits abortSignal when none is given", () => {
    const { ctx, config } = ctxFor();
    expect("abortSignal" in buildRunDispatchOptions(ctx, params(config))).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing no-swap test.** In the `runWithFallback` test file, add a case using that file's existing manager and hop fixtures. If no such fixture exists, use `makeMockAgentManager` / `fakeAgentManager` from `@test/helpers` as the file's other cases do. The hop must abort the request's signal and return a result with `adapterFailure: { category: "quality", outcome: "fail-adapter-error", retriable: false, message: "aborted" }`, under a config whose `agent.fallback.onQualityFailure` is `true` and whose fallback map names a second agent. Assert that `executeHop` was called exactly once and that `outcome.fallbacks` is empty.

- [ ] **Step 3: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/operations/call-run-options.test.ts <runWithFallback test file> --timeout=5000`
Expected: FAIL.

- [ ] **Step 4: Implement.** In `call-run-options.ts`, add to `RunDispatchOptionsParams`:

```ts
  /**
   * The call's abort signal (`ctx.signal ?? ctx.runtime.signal`, from the dispatch
   * prologue). Each hop sends its turn with `resolvedRunOptions.abortSignal`; without
   * this a deadline only lands after the hop returns (#2462).
   */
  readonly abortSignal?: AbortSignal;
```

Destructure `abortSignal` with the other params, and add `...(abortSignal !== undefined ? { abortSignal } : {}),` as the last entry of the returned object. In `call-dispatch-run.ts`, add `abortSignal,` after `keepOpen,` in the `buildRunDispatchOptions(ctx, {...})` call.

In `manager-run-fallback.ts`, immediately before `const swap = decideSwap(...)`:

```ts
      // Finish A: an aborted call must not swap into a new agent with the same aborted signal.
      if (request.signal?.aborted) {
        finalStatus = "error";
        return { result, fallbacks, didSwap, finalBundle: updatedBundle, finalPrompt, finalAgent: currentAgent, finalTarget: currentTarget, finalDepth: hopsSoFar, dispatchesCompleted };
      }
```

Check the local variable names against the surrounding early returns (~L150-162). This must return the same object shape as they do.

- [ ] **Step 5: Run the operations, agents and session suites.**
Run: `timeout 60 bun test test/unit/operations/ test/unit/agents/ test/unit/session/ --timeout=5000`
Expected: PASS. Fix any existing assertion on the exact run-options shape by adding `abortSignal` where its context had a signal.

- [ ] **Step 6: Commit.**

```bash
git add src/operations/call-run-options.ts src/operations/call-dispatch-run.ts src/agents/manager-run-fallback.ts test/unit
git commit -m "fix(operations): thread the call's abort signal into each turn; no swap after abort (#2462)"
```

---

### Task 2: `SessionManager.interruptTurn`, a soft cancel that keeps the session

**Why:** spec §3.2. The idle watchdog's cancel is classified `fail-stale` and leaves the session warm (nax#2218). Finish needs the same cancel on demand.

**Files:**
- Modify: `src/session/watchdog-cancel-tracker.ts`
- Modify: `src/session/watchdog-turn-classification.ts`
- Modify: `src/session/manager.ts`. Net line count must go down: the stale classification block in `sendPrompt` (~L588-604) moves into `staleTurnFailure`.
- Modify: `src/session/types.ts` (`ISessionManager`)
- Modify: `test/helpers/mock-session-manager.ts`
- Test: `test/unit/session/manager-interrupt.test.ts` (create; split by concern from `manager-phase-b-prompt.test.ts`, which is at 785 lines)
- Test: `test/unit/session/watchdog-turn-classification.test.ts` (extend)

**Interfaces:**
- Produces:
  - `ISessionManager.interruptTurn(name: string): Promise<boolean>`;
  - `WatchdogCancelTracker.interrupt(sessionName, registry): Promise<boolean>`;
  - `WatchdogCancelTracker.wasInterrupted(sessionName): boolean`;
  - `staleTurnFailure(input: WatchdogTurnClassificationInput & { interrupted: boolean }): SessionFailureError | undefined`.
  - The resulting `SessionFailureError.adapterFailure.reason` is `"interrupted"` or `"idle-watchdog"`.

- [ ] **Step 1: Write the failing test.** Create `test/unit/session/manager-interrupt.test.ts`. It copies the setup pattern of the native fail-stale case in `manager-phase-b-prompt.test.ts` (~L176-226):

```ts
import { describe, expect, mock, test } from "bun:test";
import { assertCaughtInstanceOf, assertDefined, makeAgentAdapter } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionFailureError } from "@/agents/types";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

const TURN: TurnResult = { output: "ok", tokenUsage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0, internalRoundTrips: 1 };
const REQUEST: OpenSessionRequest = {
  agentName: "claude",
  workdir: "/tmp/nax-interrupt-test",
  pipelineStage: "run",
  modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
  timeoutSeconds: 30,
};

/** An adapter whose first turn blocks until its registered cancel runs, then throws an AbortError like native does. */
function blockingAdapter() {
  let onActiveCall: OpenSessionOpts["onActiveCall"];
  let turns = 0;
  let started: () => void = () => {};
  const startedP = new Promise<void>((r) => {
    started = r;
  });
  const adapter = makeAgentAdapter({
    openSession: mock(async (name: string, opts: OpenSessionOpts) => {
      onActiveCall = opts.onActiveCall;
      return { id: name, agentName: "claude" } as SessionHandle;
    }),
    sendTurn: mock(async () => {
      turns += 1;
      if (turns > 1) return TURN;
      return new Promise<TurnResult>((_resolve, reject) => {
        assertDefined(onActiveCall, "onActiveCall")("call-1", async () => {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
        started();
      });
    }),
  });
  return { adapter, startedP };
}

describe("SessionManager.interruptTurn (finish A)", () => {
  test("ends the running turn as fail-stale 'interrupted' and keeps the session usable", async () => {
    const { adapter, startedP } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    const handle = await sm.openSession("nax-interrupt", REQUEST);
    const first = sm.sendPrompt(handle, "work");
    await startedP;
    expect(await sm.interruptTurn("nax-interrupt")).toBe(true);
    let caught: unknown;
    try {
      await first;
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, SessionFailureError, "interrupted turn");
    expect(caught.adapterFailure.outcome).toBe("fail-stale");
    expect(caught.adapterFailure.reason).toBe("interrupted");
    expect(sm.isCancelled("nax-interrupt")).toBe(false);
    expect((await sm.sendPrompt(handle, "handoff")).output).toBe("ok");
  });

  test("returns false when the session has no active call", async () => {
    const { adapter } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ watchdogControllerRegistry: new Map() });
    await sm.openSession("nax-idle", REQUEST);
    expect(await sm.interruptTurn("nax-idle")).toBe(false);
  });

  test("returns false without a watchdog registry", async () => {
    const { adapter } = blockingAdapter();
    const sm = new SessionManager({ getAdapter: () => adapter });
    await sm.openSession("nax-noreg", REQUEST);
    expect(await sm.interruptTurn("nax-noreg")).toBe(false);
  });
});
```

Add to `test/unit/session/watchdog-turn-classification.test.ts`:

```ts
describe("staleTurnFailure (finish A)", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  test("watchdog cancel -> fail-stale idle-watchdog", () => {
    expect(staleTurnFailure({ watchdogFired: true, interrupted: false, err: abort, signalAborted: false })?.adapterFailure.reason).toBe("idle-watchdog");
  });
  test("interrupt -> fail-stale interrupted", () => {
    expect(staleTurnFailure({ watchdogFired: true, interrupted: true, err: abort, signalAborted: false })?.adapterFailure.reason).toBe("interrupted");
  });
  test("a caller-signalled abort is never stale", () => {
    expect(staleTurnFailure({ watchdogFired: true, interrupted: true, err: abort, signalAborted: true })).toBeUndefined();
  });
});
```

Import `staleTurnFailure` from `@/session/watchdog-turn-classification`.

- [ ] **Step 2: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/session/manager-interrupt.test.ts test/unit/session/watchdog-turn-classification.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement the tracker.** In `watchdog-cancel-tracker.ts`, add two maps and record each active call inside `buildOnActiveCall`'s returned callback (before `registry.set`):

```ts
  private readonly _activeCallsBySession = new Map<string, Set<string>>();
  private readonly _interruptedSessions = new Set<string>();
```

```ts
    return (callId, cancel) => {
      const active = this._activeCallsBySession.get(sessionName) ?? new Set<string>();
      active.add(callId);
      this._activeCallsBySession.set(sessionName, active);
      registry.set(callId, async () => {
        // ...existing body unchanged
      });
    };
```

Add the methods:

```ts
  /**
   * Finish A: soft-cancel every active call of a session through the same registered
   * cancel the watchdog uses, so the turn ends fail-stale and the session stays warm.
   * False when there is no registry or no live registered call.
   */
  async interrupt(sessionName: string, registry: Map<string, () => Promise<void>> | undefined): Promise<boolean> {
    if (!registry) return false;
    const cancels = [...(this._activeCallsBySession.get(sessionName) ?? [])]
      .map((callId) => registry.get(callId))
      .filter((c): c is () => Promise<void> => c !== undefined);
    if (cancels.length === 0) return false;
    this._interruptedSessions.add(sessionName);
    await Promise.all(cancels.map((c) => c()));
    return true;
  }

  wasInterrupted(sessionName: string): boolean {
    return this._interruptedSessions.has(sessionName);
  }
```

Extend `clear(sessionName)` to also delete from `_activeCallsBySession` and `_interruptedSessions`.

- [ ] **Step 4: Implement the classifier.** In `watchdog-turn-classification.ts`, add (import `SessionFailureError` next to `SessionTurnError` from `../agents/types`):

```ts
/** The fail-stale error sendPrompt throws for a watchdog cancel or a finish interrupt; undefined otherwise. */
export function staleTurnFailure(
  input: WatchdogTurnClassificationInput & { interrupted: boolean },
): SessionFailureError | undefined {
  if (!isWatchdogCancelledTurn(input)) return undefined;
  const reason = input.interrupted ? "interrupted" : "idle-watchdog";
  const message = input.interrupted
    ? "finish interrupted the turn — session kept warm"
    : "idle watchdog cancelled session — no stream activity";
  return new SessionFailureError(message, {
    category: "availability",
    outcome: "fail-stale",
    retriable: true,
    message,
    reason,
  });
}
```

If `adapterFailure.reason` is typed as a closed union, add `"interrupted"` to it where it is declared (`grep -rn '"idle-watchdog"' src/agents ../nax-agent/src | head`).

- [ ] **Step 5: Implement the manager without growing it.** In `src/session/manager.ts`, replace the `if (isWatchdogCancelledTurn({...})) { throw new SessionFailureError(...) }` block in `sendPrompt`'s `catch` with:

```ts
      const stale = staleTurnFailure({
        watchdogFired: this._watchdogCancels.hasCancelled(handle.id),
        interrupted: this._watchdogCancels.wasInterrupted(handle.id),
        err,
        signalAborted: opts?.signal?.aborted === true,
      });
      if (stale) throw stale;
```

Then add the method next to `isCancelled`:

```ts
  /** Finish A: soft-cancel the session's running turn; it ends fail-stale and the session stays usable. */
  interruptTurn(name: string): Promise<boolean> {
    return this._watchdogCancels.interrupt(name, this._watchdogControllerRegistry);
  }
```

Update the imports: `staleTurnFailure` replaces `isWatchdogCancelledTurn`; drop the now-unused `SessionFailureError` import if nothing else uses it.

Add to `ISessionManager` in `src/session/types.ts` (after `isCancelled`):

```ts
  /**
   * Soft-cancel the running turn (finish A): the same registered cancel the idle watchdog
   * uses, so the turn ends fail-stale and the session stays usable. False when there is
   * no watchdog registry or no active call.
   */
  interruptTurn(name: string): Promise<boolean>;
```

In `test/helpers/mock-session-manager.ts`, add `interruptTurn: mock(async (_name: string) => false),`.

- [ ] **Step 6: Check the size ratchet.**
Run: `wc -l src/session/manager.ts && bun run check:file-sizes`
Expected: under 662 and PASS. Then lock in the lower number with `bun run check:file-sizes:update`, and review the baseline diff (only `src/session/manager.ts` should change, downward).

- [ ] **Step 7: Run.**
Run: `timeout 60 bun test test/unit/session/ --timeout=5000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/session test/unit/session test/helpers/mock-session-manager.ts scripts/baselines/file-sizes-baseline.json
git commit -m "feat(session): interruptTurn - soft cancel that keeps the session warm"
```

---

### Task 3: A hop body can send with an interrupt

**Files:**
- Create: `src/operations/send-interrupt.ts`
- Modify: `src/operations/types.ts` (`SendTurnOverrides`, `HopBodyContext.send`)
- Modify: `src/operations/build-hop-callback.ts` (`hopBody` property type)
- Modify: `src/operations/build-hop-callback-dispatch.ts` (`send` closure, ~L129)
- Modify: `src/operations/call-dispatch-run.ts` (`createRunSenders`: widen `bodyCtx.send`; `sendWithFileOutput` takes and passes `overrides`; `effectiveHopBody` passes `(p, o) => sendWithFileOutput(p, bodyCtx, o)`)
- Test: `test/unit/operations/send-interrupt.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface SendTurnOverrides { readonly interrupt?: AbortSignal }`, exported from `@/operations`;
  - `HopBodyContext.send: (prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>`;
  - `withInterrupt<T>(interrupt: AbortSignal | undefined, onInterrupt: () => Promise<unknown>, run: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing test.** Create `test/unit/operations/send-interrupt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { withInterrupt } from "@/operations/send-interrupt";

describe("withInterrupt (finish A)", () => {
  test("no interrupt: runs and never calls onInterrupt", async () => {
    let calls = 0;
    expect(await withInterrupt(undefined, async () => void (calls += 1), async () => 7)).toBe(7);
    expect(calls).toBe(0);
  });

  test("aborting the interrupt while the turn runs calls onInterrupt once", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    let release: () => void = () => {};
    const run = withInterrupt(interrupt.signal, async () => {
      calls += 1;
      release();
    }, () => new Promise<string>((r) => {
      release = () => r("done");
    }));
    interrupt.abort();
    expect(await run).toBe("done");
    expect(calls).toBe(1);
  });

  test("the listener is removed after the turn settles", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    await withInterrupt(interrupt.signal, async () => void (calls += 1), async () => "x");
    interrupt.abort();
    expect(calls).toBe(0);
  });

  test("a rejecting onInterrupt never rejects the turn", async () => {
    const interrupt = new AbortController();
    let release: () => void = () => {};
    const run = withInterrupt(interrupt.signal, async () => {
      release();
      throw new Error("boom");
    }, () => new Promise<string>((r) => {
      release = () => r("ok");
    }));
    interrupt.abort();
    expect(await run).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `timeout 30 bun test test/unit/operations/send-interrupt.test.ts --timeout=5000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/operations/send-interrupt.ts`:

```ts
/**
 * Finish A: run one turn with a soft interrupt. When `interrupt` aborts while the
 * turn runs, `onInterrupt` (SessionManager.interruptTurn) soft-cancels it; the turn
 * then ends fail-stale and the session stays usable. The listener never outlives
 * the turn, and a failing `onInterrupt` never fails the turn.
 */
export async function withInterrupt<T>(
  interrupt: AbortSignal | undefined,
  onInterrupt: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  if (!interrupt) return run();
  const fire = (): void => {
    onInterrupt().catch(() => undefined); // best-effort: the turn's own deadline still bounds it
  };
  interrupt.addEventListener("abort", fire, { once: true });
  try {
    return await run();
  } finally {
    interrupt.removeEventListener("abort", fire);
  }
}
```

In `src/operations/types.ts`, above `HopBodyContext`:

```ts
/** Per-turn options a hop body may pass to `send` (finish A). */
export interface SendTurnOverrides {
  /** Soft interrupt: when it aborts, the running turn is soft-cancelled and the session stays usable. */
  readonly interrupt?: AbortSignal;
}
```

Change `HopBodyContext.send` to `(prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>`. Export `SendTurnOverrides` from `src/operations/index.ts`.

In `build-hop-callback.ts`, the `hopBody` `bodyCtx.send` type becomes `(prompt: string, opts?: SendTurnOverrides) => Promise<TurnResult>`.

In `build-hop-callback-dispatch.ts`, wrap the existing closure body:

```ts
    const send = (turnPrompt: string, overrides?: SendTurnOverrides): Promise<TurnResult> =>
      withInterrupt(
        overrides?.interrupt,
        () => ctx.sessionManager.interruptTurn(handle.id),
        () =>
          ctx.agentManager.runAsSession(
            /* ...existing arguments unchanged... */
          ),
      );
```

In `call-dispatch-run.ts` `createRunSenders`:
- widen every `bodyCtx` `send` type to `(p: string, o?: SendTurnOverrides) => Promise<TurnResult>`;
- `sendWithFileOutput(promptText, bodyCtx, overrides?: SendTurnOverrides)` passes `(p) => bodyCtx.send(p, overrides)` to `normalizeHopOutput`;
- `effectiveHopBody` passes `send: (p, o) => sendWithFileOutput(p, bodyCtx, o)` into `op.hopBody`.

- [ ] **Step 4: Run.**
Run: `timeout 60 bun test test/unit/operations/ --timeout=5000 && bun run typecheck && bun run check:file-sizes`
Expected: PASS. If `call-dispatch-run.ts` exceeds 600 lines, move `createRunSenders` with its `RunSenderParams` type, unchanged, to `src/operations/call-run-senders.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/operations test/unit/operations
git commit -m "feat(operations): send(prompt, { interrupt }) soft-cancels a hop turn"
```

---

### Task 4: Finish timeouts config

**Files:**
- Create: `src/config/finish-timeouts-shim.ts`
- Modify: `src/config/compat-shims.ts` (import + one line after `_applyFinishAutoFlowShim`)
- Modify: `src/config/schemas.ts:455-479`
- Modify: `src/config/runtime-types-finish.ts:15`
- Modify: `src/config/selectors.ts` (~L148 comment)
- Modify: `src/finish/config.ts:36,46,95-100`
- Modify: `src/finish/phase.ts:394-397`
- Modify: `src/operations/finish-fix.ts:41` (comment)
- Modify: `../../docs/guides/configuration.md:737,751-754,779`
- Test: `test/unit/config/finish-timeouts-shim.test.ts` (create)
- Test: `test/unit/finish/config.test.ts`
- Test: `test/unit/config/finish-autoflow-schema.test.ts:30-42`
- Test: `test/unit/config/loader-legacy-shim-optimizer.test.ts:116-125`

**Interfaces:**
- Produces:
  - `FinishSettings["timeouts"] = { acceptanceMs; gateMs; flowMs; reviewMs; fixMs }` (all `number`);
  - `_applyFinishStepTimeoutShim(conf, warn)`.

- [ ] **Step 1: Write the failing shim test.** Create `test/unit/config/finish-timeouts-shim.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { _applyFinishStepTimeoutShim } from "@/config/finish-timeouts-shim";

describe("_applyFinishStepTimeoutShim (finish A)", () => {
  test("copies a numeric stepMs into reviewMs and fixMs, drops stepMs and warns", () => {
    const warnings: string[] = [];
    const out = _applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: 600_000, gateMs: 1 } } }, (m) => warnings.push(m));
    expect(out).toEqual({ finish: { timeouts: { gateMs: 1, reviewMs: 600_000, fixMs: 600_000 } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("finish.timeouts.stepMs");
  });

  test("an explicit reviewMs / fixMs wins over stepMs", () => {
    expect(_applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: 600_000, reviewMs: 1_000 } } }, () => {})).toEqual({
      finish: { timeouts: { reviewMs: 1_000, fixMs: 600_000 } },
    });
  });

  test("a null stepMs is dropped silently", () => {
    const warnings: string[] = [];
    expect(_applyFinishStepTimeoutShim({ finish: { timeouts: { stepMs: null } } }, (m) => warnings.push(m))).toEqual({
      finish: { timeouts: {} },
    });
    expect(warnings).toEqual([]);
  });

  test("returns the same object when there is no stepMs, and never mutates the input", () => {
    const plain = { finish: { timeouts: { gateMs: 1 } } };
    expect(_applyFinishStepTimeoutShim(plain, () => {})).toBe(plain);
    const legacy = { finish: { timeouts: { stepMs: 5 } } };
    _applyFinishStepTimeoutShim(legacy, () => {});
    expect(legacy).toEqual({ finish: { timeouts: { stepMs: 5 } } });
  });
});
```

- [ ] **Step 2: Write the failing settings test.** Append to `test/unit/finish/config.test.ts` (import `NaxConfigSchema` from `@/config` if missing):

```ts
describe("readFinishConfig timeouts (finish A)", () => {
  test("defaults: review 15 min, fix 20 min, flow 3 h, acceptance and gate unchanged", () => {
    expect(readFinishConfig(NaxConfigSchema.parse({})).timeouts).toEqual({
      acceptanceMs: 600_000,
      gateMs: 900_000,
      flowMs: 10_800_000,
      reviewMs: 900_000,
      fixMs: 1_200_000,
    });
  });

  test("explicit values win", () => {
    const s = readFinishConfig(NaxConfigSchema.parse({ finish: { timeouts: { reviewMs: 1_000, fixMs: 2_000, flowMs: 3_000 } } }));
    expect([s.timeouts.reviewMs, s.timeouts.fixMs, s.timeouts.flowMs]).toEqual([1_000, 2_000, 3_000]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/config/finish-timeouts-shim.test.ts test/unit/finish/config.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 4: Implement.** Create `src/config/finish-timeouts-shim.ts`:

```ts
/**
 * Finish A: `finish.timeouts.stepMs` became `reviewMs` and `fixMs`. A benign rename
 * (config-patterns.md): a numeric `stepMs` fills whichever of the two is unset, then
 * is removed. Runs per config layer before the Zod parse, which would otherwise strip
 * the key silently. Returns a new object; never mutates.
 */
export function _applyFinishStepTimeoutShim(
  conf: Record<string, unknown>,
  warn: (msg: string) => void,
): Record<string, unknown> {
  const finish = conf.finish as Record<string, unknown> | undefined;
  const timeouts = finish?.timeouts as Record<string, unknown> | undefined;
  if (!timeouts || !("stepMs" in timeouts)) return conf;
  const { stepMs, ...rest } = timeouts;
  if (typeof stepMs !== "number") return { ...conf, finish: { ...finish, timeouts: rest } };
  warn(
    "finish.timeouts.stepMs is deprecated: it now sets finish.timeouts.reviewMs and finish.timeouts.fixMs where those are unset. Set those two keys instead.",
  );
  return {
    ...conf,
    finish: { ...finish, timeouts: { ...rest, reviewMs: rest.reviewMs ?? stepMs, fixMs: rest.fixMs ?? stepMs } },
  };
}
```

In `compat-shims.ts`, import it and add `out = _applyFinishStepTimeoutShim(out, warn);` right after `out = _applyFinishAutoFlowShim(out, warn);`.

In `schemas.ts`, replace the `timeouts` object and both default literals with:

```ts
        timeouts: z
          .object({
            /** Per acceptance-test group. */
            acceptanceMs: z.number().int().positive().default(600_000),
            /** Per quality gate (build / typecheck / lint / test). */
            gateMs: z.number().int().positive().default(900_000),
            /** Whole-phase backstop, enforced as an AbortSignal (finish A: 3 h). */
            flowMs: z.number().int().positive().default(10_800_000),
            /** Per review lens call (finish A). */
            reviewMs: z.number().int().positive().default(900_000),
            /** Per fix session (finish A). */
            fixMs: z.number().int().positive().default(1_200_000),
          })
          .default({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 }),
```

In the `finish` object's outer `.default({...})`, set `timeouts` to the same literal.

In `runtime-types-finish.ts`, replace `stepMs: number | null;` with `reviewMs: number;` and `fixMs: number;`.

In `src/finish/config.ts`:
- the `timeouts` type becomes `{ acceptanceMs: number; gateMs: number; flowMs: number; reviewMs: number; fixMs: number }`;
- `DEFAULTS.timeouts` becomes `{ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 }`;
- the reader's `stepMs` line becomes two lines: `reviewMs: finish.timeouts?.reviewMs ?? DEFAULTS.timeouts.reviewMs,` and `fixMs: finish.timeouts?.fixMs ?? DEFAULTS.timeouts.fixMs,`.

In `phase.ts` (~L394-397), `reviewMs: settings.timeouts.reviewMs` and `fixMs: settings.timeouts.fixMs`. Task 5 adds the margins.

In `selectors.ts` (~L148) and `operations/finish-fix.ts:41`, change the comment text `finish.timeouts.stepMs` to `finish.timeouts.reviewMs / fixMs`.

- [ ] **Step 5: Update the existing tests that pin `stepMs`.**
- `test/unit/config/finish-autoflow-schema.test.ts` (~L30-42): the input becomes `{ acceptanceMs: 1000, gateMs: 2000, flowMs: 3000, reviewMs: 4000, fixMs: 5000 }`. The expected object is the same five keys. Replace the `stepMs` nullable assertion with `expect(NaxConfigSchema.parse({ version: 1 }).finish.timeouts.fixMs).toBe(1_200_000);`.
- `test/unit/config/loader-legacy-shim-optimizer.test.ts` (~L116-125): it runs the full shim chain on `timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 }`. The expected `out.finish.timeouts` becomes `{ acceptanceMs: 1, gateMs: 2, flowMs: 3, reviewMs: 4, fixMs: 4 }`. Add `expect(warnings.join(" ")).toContain("finish.timeouts.stepMs");`.

- [ ] **Step 6: Update the docs** in `../../docs/guides/configuration.md`, matching the table's existing style:
- In the example (L737), replace the timeouts object with `"timeouts": { "acceptanceMs": 600000, "gateMs": 900000, "reviewMs": 900000, "fixMs": 1200000, "flowMs": 10800000 }`.
- Replace rows L753-754 with:

```markdown
| `timeouts.reviewMs` | 15 min | Cap per review lens call. A lens that hits it, or answers after it, counts as missing for that round. |
| `timeouts.fixMs` | 20 min | Cap per fix session. The session is interrupted, writes a handoff note, and its edits are set aside for the next attempt; they are never committed. |
| `timeouts.flowMs` | 3 h | Whole-phase backstop. When it fires, the current step stops and finish ends as a draft PR. |
| `timeouts.stepMs` | — | Removed. A value is migrated to `reviewMs` and `fixMs` with a warning. |
```

- Replace L779's second sentence with: "Any half-finished fix is set aside as a patch under `finish-audit/<feature>/<runId>.handoff-<n>/` and listed in the PR under "Set aside"; it is not committed."

- [ ] **Step 7: Run.**
Run: `timeout 60 bun test test/unit/config/ test/unit/finish/ --timeout=5000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/config src/finish/config.ts src/finish/phase.ts src/operations/finish-fix.ts test/unit/config test/unit/finish/config.test.ts ../../docs/guides/configuration.md
git commit -m "feat(finish): reviewMs / fixMs limits, 3 h flow backstop, stepMs shim"
```

---

### Task 5: Review lenses stop at `reviewMs`, cut off or late

**Files:**
- Create: `src/finish/step-signal.ts`
- Modify: `src/finish/types.ts` (`FinishReviewOutput.stoppedAtLimit`, `FinishTimeouts`)
- Modify: `src/finish/ops-impl.ts` (`reviewSpec`, `reviewBranch`; `timeoutMs` margin)
- Test: `test/unit/finish/step-signal.test.ts` (create)
- Test: `test/unit/finish/ops-impl-a4.test.ts`

**Interfaces:**
- Produces:
  - `STEP_TIMEOUT_MARGIN_MS = 60_000`;
  - `stepSignal(base: AbortSignal | undefined, ms: number | undefined): { signal: AbortSignal | undefined; limit: AbortSignal | undefined }`;
  - `FinishReviewOutput.stoppedAtLimit?: true`;
  - `FinishTimeouts` gains `reviewMs?`, `fixMs?`, `flowMs?`.

- [ ] **Step 1: Write the failing tests.** Create `test/unit/finish/step-signal.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { STEP_TIMEOUT_MARGIN_MS, stepSignal } from "@/finish/step-signal";

describe("stepSignal (finish A)", () => {
  test("no base, no limit", () => {
    expect(stepSignal(undefined, undefined)).toEqual({ signal: undefined, limit: undefined });
  });
  test("base alone is returned as-is", () => {
    const base = new AbortController().signal;
    expect(stepSignal(base, undefined)).toEqual({ signal: base, limit: undefined });
  });
  test("the combined signal follows the base; the limit part does not", () => {
    const base = new AbortController();
    const { signal, limit } = stepSignal(base.signal, 60_000);
    base.abort();
    expect(signal?.aborted).toBe(true);
    expect(limit?.aborted).toBe(false);
  });
  test("margin is one minute", () => {
    expect(STEP_TIMEOUT_MARGIN_MS).toBe(60_000);
  });
});
```

Append to `test/unit/finish/ops-impl-a4.test.ts`, using that file's `baseDeps()`, `freshState()` and `inputs`:

```ts
describe("review step limit (finish A)", () => {
  test("a lens cut off at reviewMs returns missing + stoppedAtLimit", async () => {
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      await new Promise<void>((r) => ctx.signal?.addEventListener("abort", () => r(), { once: true }));
      throw new Error("callOp[finish-spec-review]: aborted");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const out = await createFinishOps({ ...deps, timeouts: { reviewMs: 5, fixMs: 5 } }).reviewSpec(freshState(), inputs);
    expect(out).toMatchObject({ missing: true, stoppedAtLimit: true });
  });

  test("a verdict returned after reviewMs fired is discarded as missing", async () => {
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      await new Promise<void>((r) => ctx.signal?.addEventListener("abort", () => r(), { once: true }));
      return { findings: [{ severity: "LOW", title: "late", problem: "p", fix: "f" }], covered: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const out = await createFinishOps({ ...deps, timeouts: { reviewMs: 5, fixMs: 5 } }).reviewBranch(freshState(), inputs);
    expect(out).toMatchObject({ missing: true, stoppedAtLimit: true, findings: [] });
  });

  test("a phase stop is not a step limit: the error propagates", async () => {
    const phase = new AbortController();
    _finishOpsDeps.callOp = (async () => {
      phase.abort();
      throw new Error("callOp[finish-spec-review]: aborted");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const ops = createFinishOps({ ...deps, callCtx: { ...deps.callCtx, signal: phase.signal }, timeouts: { reviewMs: 60_000 } });
    await expect(ops.reviewSpec(freshState(), inputs)).rejects.toThrow("aborted");
  });

  test("the op's timeoutMs is reviewMs plus the margin, so the step limit fires first", async () => {
    let seen: Record<string, unknown> | undefined;
    _finishOpsDeps.callOp = (async (_ctx: CallContext, _op: unknown, input: Record<string, unknown>) => {
      seen = input;
      return { findings: [], covered: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await createFinishOps({ ...deps, timeouts: { reviewMs: 1_000 } }).reviewSpec(freshState(), inputs);
    expect(seen?.timeoutMs).toBe(61_000);
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/step-signal.test.ts test/unit/finish/ops-impl-a4.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/finish/step-signal.ts`:

```ts
/**
 * Finish A: a step's signal is the phase signal plus its own limit. `limit` is returned
 * alone so callers can tell a step limit (continue the loop) from a phase stop. The
 * agent's own timeout is set to the limit plus a margin, so the step limit always
 * fires first: a fail-timeout is retried without checking the abort signal.
 */
export const STEP_TIMEOUT_MARGIN_MS = 60_000;

export function stepSignal(
  base: AbortSignal | undefined,
  ms: number | undefined,
): { signal: AbortSignal | undefined; limit: AbortSignal | undefined } {
  const limit = ms !== undefined ? AbortSignal.timeout(ms) : undefined;
  if (!limit) return { signal: base, limit: undefined };
  return { signal: base ? AbortSignal.any([base, limit]) : limit, limit };
}
```

In `types.ts`, add `stoppedAtLimit?: true;` to `FinishReviewOutput`, documented as "Finish A: stopped by `finish.timeouts.reviewMs`; always paired with `missing`". Extend `FinishTimeouts` with `reviewMs?: number; fixMs?: number; flowMs?: number;`.

In `ops-impl.ts`, add above `createFinishOps` (import `MISSING_REVIEW` from `./review-json`, `stepSignal` and `STEP_TIMEOUT_MARGIN_MS` from `./step-signal`):

```ts
const STOPPED_REVIEW: FinishReviewOutput = { ...MISSING_REVIEW, stoppedAtLimit: true };

/** One review call under its `reviewMs` limit: cut off or late, it reads as a missing verdict. */
async function underReviewLimit(
  callCtx: CallContext,
  reviewMs: number | undefined,
  run: (ctx: CallContext) => Promise<FinishReviewOutput>,
): Promise<FinishReviewOutput> {
  const { signal, limit } = stepSignal(callCtx.signal, reviewMs);
  const stoppedHere = (): boolean => limit?.aborted === true && callCtx.signal?.aborted !== true;
  try {
    const out = await run(signal ? { ...callCtx, signal } : callCtx);
    return stoppedHere() ? STOPPED_REVIEW : out;
  } catch (err) {
    if (stoppedHere()) return STOPPED_REVIEW;
    throw err;
  }
}

const reviewTimeout = (reviewMs: number | undefined): number | undefined =>
  reviewMs !== undefined ? reviewMs + STEP_TIMEOUT_MARGIN_MS : undefined;
```

In both review methods, set `timeoutMs: reviewTimeout(timeouts?.reviewMs)` in the input, and wrap the call:

```ts
      return underReviewLimit(callCtx, timeouts?.reviewMs, (ctx) =>
        _finishOpsDeps.callOp({ ...ctx, sessionOverride: { role: "finish-review-spec" } }, finishSpecReviewOp, input),
      );
```

Do the same for `reviewBranch` (`finish-review-quality`, `finishBranchReviewOp`). Import `FinishReviewOutput` and `CallContext` as types.

- [ ] **Step 4: Run.**
Run: `timeout 30 bun test test/unit/finish/ --timeout=5000 && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/finish/step-signal.ts src/finish/types.ts src/finish/ops-impl.ts test/unit/finish
git commit -m "feat(finish): review lenses stop at reviewMs, cut off or late"
```

---

### Task 6: The fix op writes a handoff note in its own warm session

**Files:**
- Create: `src/finish/fix/handoff-note.ts`
- Modify: `src/finish/fix/index.ts` (exports)
- Modify: `src/finish/types.ts` (`HandoffNote`, `FixContinuation`)
- Modify: `src/finish/ops.ts` (`FixOutcome`)
- Modify: `src/operations/finish-fix.ts` (`FinishFixInput`, `hopBody`, `parse`, `verify`, `build`)
- Modify: `src/operations/index.ts` (export `HANDOFF_TURN_MS`)
- Modify: `src/prompts/builders/finish-review-builder.ts`, `src/prompts/index.ts`
- Test: `test/unit/operations/finish-fix.test.ts`. It **exists, 169 lines**: append a new `describe` block and keep the existing ones.
- Test: `test/unit/finish/fix/handoff-note.test.ts` (create)
- Test: `test/unit/prompts/builders/finish-review-builder.test.ts` (append if it exists, else create)

**Interfaces:**
- Consumes: `SendTurnOverrides` (Task 3).
- Produces:

```ts
// src/finish/types.ts
export interface HandoffNote {
  findings: { index: number; status: "done" | "partial" | "not-started"; files: string[]; remaining: string }[];
}
export interface FixContinuation { note?: HandoffNote; files: string[] }
// src/finish/ops.ts FixOutcome gains
  /** Finish A: the fix turn was soft-interrupted by its step or the phase. */
  interrupted?: true;
  /** Finish A: the same session's handoff note, when it gave one. */
  handoffNote?: HandoffNote;
// src/finish/fix/handoff-note.ts
export const HANDOFF_MARKER = "<!-- nax-finish-handoff -->";
export function isHandoffNote(v: unknown): v is HandoffNote;
export function parseHandoffReply(output: string): { interrupted: true; handoffNote?: HandoffNote } | null;
// src/operations/finish-fix.ts
export const HANDOFF_TURN_MS = 120_000;
// FinishFixInput gains: interrupt?: AbortSignal; continuation?: FixContinuation
// src/prompts
export function buildFinishHandoffPrompt(phase: "acceptance" | "gate" | "review", findings: Finding[] | undefined): string;
// buildFinishFixPrompt args gain continuation?: FixContinuation
```

- [ ] **Step 1: Write the failing parser test.** Create `test/unit/finish/fix/handoff-note.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { HANDOFF_MARKER, isHandoffNote, parseHandoffReply } from "@/finish/fix";

describe("handoff reply parsing (finish A)", () => {
  test("a non-handoff reply is null", () => {
    expect(parseHandoffReply("## DISPOSITIONS\n1. fixed")).toBeNull();
  });
  test("a marked reply with JSON yields interrupted + the note", () => {
    const out = parseHandoffReply(`${HANDOFF_MARKER}\nsure: {"findings":[{"index":1,"status":"partial","files":["a.ts"],"remaining":"tests"}]}`);
    expect(out).toEqual({ interrupted: true, handoffNote: { findings: [{ index: 1, status: "partial", files: ["a.ts"], remaining: "tests" }] } });
  });
  test("a marked reply without usable JSON is still interrupted, without a note", () => {
    expect(parseHandoffReply(`${HANDOFF_MARKER}\n`)).toEqual({ interrupted: true });
    expect(parseHandoffReply(`${HANDOFF_MARKER}\nno json here`)).toEqual({ interrupted: true });
  });
  test("isHandoffNote rejects a wrong status", () => {
    expect(isHandoffNote({ findings: [{ index: 1, status: "maybe", files: [], remaining: "" }] })).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing op tests.** Append to `test/unit/operations/finish-fix.test.ts` (add the imports below if absent):

```ts
import { assertDefined, makeTurnResult } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import { SessionFailureError } from "@/agents/types";
import { HANDOFF_MARKER, parseHandoffReply } from "@/finish/fix";
import type { FinishFixInput, HopBodyContext, SendTurnOverrides } from "@/operations";
import { finishFixOp } from "@/operations";

function stale(reason: "interrupted" | "idle-watchdog"): SessionFailureError {
  return new SessionFailureError("stale", { category: "availability", outcome: "fail-stale", retriable: true, message: "stale", reason });
}

function hopCtx(input: FinishFixInput, send: (p: string, o?: SendTurnOverrides) => Promise<TurnResult>): HopBodyContext<FinishFixInput> {
  return { send, sendWithParseRetry: (p) => send(p), input };
}

describe("finishFixOp handoff (finish A)", () => {
  const hopBody = assertDefined(finishFixOp.hopBody, "finishFixOp.hopBody");
  const base: FinishFixInput = { phase: "review", workdir: "/repo", findings: [{ severity: "LOW", title: "A", problem: "p", fix: "f" }] };

  test("a normal turn is returned unchanged, sent with the interrupt", async () => {
    const interrupt = new AbortController().signal;
    const seen: (SendTurnOverrides | undefined)[] = [];
    const turn = makeTurnResult({ output: "## DISPOSITIONS\n1. fixed" });
    const out = await hopBody("fix", hopCtx({ ...base, interrupt }, async (_p, o) => {
      seen.push(o);
      return turn;
    }));
    expect(out).toBe(turn);
    expect(seen[0]?.interrupt).toBe(interrupt);
  });

  test("an interrupted turn sends the handoff prompt on the same session and returns a marked reply", async () => {
    const interrupt = new AbortController();
    const prompts: string[] = [];
    const out = await hopBody("fix", hopCtx({ ...base, interrupt: interrupt.signal }, async (p) => {
      prompts.push(p);
      if (prompts.length === 1) {
        interrupt.abort();
        throw stale("interrupted");
      }
      return makeTurnResult({ output: '{"findings":[]}' });
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Stop working");
    expect(out.output.startsWith(HANDOFF_MARKER)).toBe(true);
    expect(parseHandoffReply(out.output)).toMatchObject({ interrupted: true });
  });

  test("a failing handoff turn still returns a marked, interrupted reply (no rethrow, so no stale-retry)", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    const out = await hopBody("fix", hopCtx({ ...base, interrupt: interrupt.signal }, async () => {
      calls += 1;
      if (calls === 1) interrupt.abort();
      throw stale("interrupted");
    }));
    expect(out.output).toBe(`${HANDOFF_MARKER}\n`);
  });

  test("a real watchdog stall (interrupt not fired) is rethrown for the normal stale-retry", async () => {
    await expect(
      hopBody("fix", hopCtx({ ...base, interrupt: new AbortController().signal }, async () => {
        throw stale("idle-watchdog");
      })),
    ).rejects.toBeInstanceOf(SessionFailureError);
  });
});
```

`parse` itself is exercised through `parseHandoffReply` (Step 1) and by the existing parse cases in this file.

- [ ] **Step 3: Write the failing prompt tests.**

```ts
import { describe, expect, test } from "bun:test";
import { buildFinishFixPrompt, buildFinishHandoffPrompt } from "@/prompts";

describe("finish handoff prompts (finish A)", () => {
  test("review: forbids edits, asks per-finding JSON, numbers the findings", () => {
    const p = buildFinishHandoffPrompt("review", [{ severity: "HIGH", title: "A", problem: "p", fix: "f", file: "src/a.ts" }]);
    expect(p).toContain("Stop working");
    expect(p).toContain("Do not edit");
    expect(p).toContain("1. [HIGH] A (src/a.ts)");
  });
  test("each phase names its own work", () => {
    expect(buildFinishHandoffPrompt("gate", undefined)).toContain("failing repo checks");
    expect(buildFinishHandoffPrompt("acceptance", undefined)).toContain("failing acceptance tests");
    expect(buildFinishHandoffPrompt("review", [])).toContain("review findings");
  });
  test("a continuation adds the earlier note and files", () => {
    const p = buildFinishFixPrompt("review", {
      findings: [{ severity: "LOW", title: "A", problem: "p", fix: "f" }],
      continuation: { files: ["src/a.ts"], note: { findings: [{ index: 1, status: "partial", files: ["src/a.ts"], remaining: "update the test" }] } },
    });
    expect(p).toContain("## Continuing earlier work");
    expect(p).toContain("- 1: partial — update the test");
  });
  test("a continuation without a note says so", () => {
    expect(buildFinishFixPrompt("gate", { gateOutput: "x", continuation: { files: ["b.ts"] } })).toContain("No handoff note was recorded");
  });
});
```

- [ ] **Step 4: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/fix/ test/unit/operations/finish-fix.test.ts test/unit/prompts/ --timeout=5000`
Expected: FAIL.

- [ ] **Step 5: Implement the types and parser.** Add `HandoffNote` and `FixContinuation` (shapes above) to `src/finish/types.ts`. Add `interrupted?` and `handoffNote?` to `FixOutcome` in `src/finish/ops.ts`. Create `src/finish/fix/handoff-note.ts`:

```ts
/**
 * Finish A: an interrupted fix op returns its handoff turn's reply prefixed with
 * HANDOFF_MARKER; `parse` reads it here. A marked reply is always `interrupted`,
 * with a note only when the JSON is usable.
 */
import { tryParseLLMJson } from "@/utils/llm-json";
import type { HandoffNote } from "../types";

export const HANDOFF_MARKER = "<!-- nax-finish-handoff -->";
const STATUSES: ReadonlySet<string> = new Set(["done", "partial", "not-started"]);

function isEntry(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.index === "number" &&
    typeof e.status === "string" &&
    STATUSES.has(e.status) &&
    Array.isArray(e.files) &&
    e.files.every((f) => typeof f === "string") &&
    typeof e.remaining === "string"
  );
}

export function isHandoffNote(v: unknown): v is HandoffNote {
  if (typeof v !== "object" || v === null) return false;
  const findings = (v as { findings?: unknown }).findings;
  return Array.isArray(findings) && findings.every(isEntry);
}

export function parseHandoffReply(output: string): { interrupted: true; handoffNote?: HandoffNote } | null {
  if (!output.startsWith(HANDOFF_MARKER)) return null;
  const parsed = tryParseLLMJson<unknown>(output.slice(HANDOFF_MARKER.length));
  return isHandoffNote(parsed) ? { interrupted: true, handoffNote: parsed } : { interrupted: true };
}
```

Export all three from `src/finish/fix/index.ts`. If `tryParseLLMJson` throws on input with no JSON rather than returning `null`, wrap the call in a `try`/`catch` that returns `{ interrupted: true }`. Check its contract in `src/utils/llm-json.ts` first.

- [ ] **Step 6: Implement the prompts.** In `finish-review-builder.ts` (`Finding` is already imported; import `FixContinuation` as a type the same way):

```ts
function numbered(findings: Finding[]): string {
  return findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ""}`).join("\n");
}

const WORK: Record<"acceptance" | "gate" | "review", string> = {
  acceptance: "the failing acceptance tests",
  gate: "the failing repo checks",
  review: "the review findings",
};

/** Finish A: the one extra turn an interrupted fix session gets, in the same session, to say what it did. */
export function buildFinishHandoffPrompt(phase: "acceptance" | "gate" | "review", findings: Finding[] | undefined): string {
  const scope =
    phase === "review" && findings && findings.length > 0
      ? `The findings you were given, by number:\n${numbered(findings)}`
      : `You were fixing ${WORK[phase]}; report that work as finding 1.`;
  return [
    "Stop working: your time limit was reached. Do not edit any file and do not run any command.",
    scope,
    "Reply with only this JSON:",
    '{ "findings": [ { "index": 1, "status": "done" | "partial" | "not-started", "files": ["path"], "remaining": "what is left" } ] }',
  ].join("\n\n");
}

function continuationSection(c: FixContinuation): string {
  const head = `## Continuing earlier work\nAn earlier attempt was stopped. Its edits are already applied to:\n${c.files.map((f) => `- ${f}`).join("\n")}`;
  if (!c.note) return `${head}\n\nNo handoff note was recorded. Read those files before changing them again.`;
  const lines = c.note.findings.map((n) => `- ${n.index}: ${n.status} — ${n.remaining}`);
  return `${head}\n\nIts handoff note, per finding:\n${lines.join("\n")}\n\nFinish what is left; do not redo what is done.`;
}
```

The "each phase names its own work" test expects `"failing repo checks"` and `"failing acceptance tests"`. The `WORK` strings contain them.

Change `buildFinishFixPrompt` to append the section:

```ts
export function buildFinishFixPrompt(
  phase: "acceptance" | "gate" | "review",
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string; continuation?: FixContinuation },
): string {
  const body = phase === "review" ? buildReviewFixPrompt(args.findings ?? []) : buildPhaseFixPrompt(phase, args);
  return args.continuation ? `${body}\n\n${continuationSection(args.continuation)}` : body;
}

function buildPhaseFixPrompt(phase: "acceptance" | "gate", args: { gateOutput?: string; acceptanceOutput?: string }): string {
  const detail = phase === "gate" ? (args.gateOutput ?? "") : (args.acceptanceOutput ?? "");
  return [
    `Fix the failing ${phase === "gate" ? "repo checks" : "acceptance tests"} below, directly in the repo.`,
    NO_COMMIT,
    `Output:\n${detail}`,
    "After fixing, re-run them; stop when they pass.",
  ].join("\n\n");
}
```

Export `buildFinishHandoffPrompt` from `src/prompts/index.ts`.

- [ ] **Step 7: Implement the op.** In `src/operations/finish-fix.ts`:

```ts
import { SessionFailureError } from "@/agents";
import { HANDOFF_MARKER, parseDispositions, parseHandoffReply, validateDispositions } from "@/finish/fix";
import { buildFinishFixPrompt, buildFinishHandoffPrompt } from "@/prompts";
import type { FixContinuation } from "../finish/types";
import type { TurnResult } from "../agents/types";

/** Finish A: the handoff turn's own cap, independent of the stopped fix. */
export const HANDOFF_TURN_MS = 120_000;

const EMPTY_TURN: TurnResult = { output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 };

function isInterruptedStale(err: unknown): boolean {
  return err instanceof SessionFailureError && err.adapterFailure.outcome === "fail-stale" && err.adapterFailure.reason === "interrupted";
}
```

Check `TurnResult`'s required fields in `@nathapp/nax-agent` `session/session-types.ts` (`output`, `tokenUsage`, `estimatedCostUsd`, `internalRoundTrips`), and match `EMPTY_TURN` to them. If `SessionFailureError` is not exported from the `@/agents` barrel, import it from `../agents/types`.

`FinishFixInput` gains:

```ts
  /** Finish A: soft interrupt (phase + fixMs). The op's own signal is the run signal only. */
  interrupt?: AbortSignal;
  /** Finish A: an earlier set-aside attempt this one continues. */
  continuation?: FixContinuation;
```

In `build`, pass `...(input.continuation ? { continuation: input.continuation } : {})` to `buildFinishFixPrompt`.

`parse` becomes:

```ts
  parse(output, _input, _ctx) {
    const handoff = parseHandoffReply(output);
    if (handoff) return { dispositions: [], ...handoff };
    return { dispositions: parseDispositions(output) };
  },
```

`verify` keeps the extra fields:

```ts
  async verify(parsed, input, _verifyCtx) {
    return { ...parsed, dispositions: await validateDispositions(input.workdir, parsed.dispositions ?? []) };
  },
```

Add `hopBody` (and add `"hopBody"` to the op's hook list, the same way `acceptance-generate.ts:64` declares it):

```ts
  /**
   * Finish A: one fix turn under a soft interrupt. When the interrupt fires, the turn
   * ends fail-stale ("interrupted") with the session still warm, and the same session
   * gets one more turn, capped at HANDOFF_TURN_MS, to say what it finished. The reply
   * comes back marked; it is never rethrown, so the stale-retry never re-runs a stopped
   * fix. A watchdog stall (interrupt not fired) is rethrown as before.
   */
  async hopBody(initialPrompt, ctx) {
    const { interrupt } = ctx.input;
    try {
      return await ctx.send(initialPrompt, interrupt ? { interrupt } : undefined);
    } catch (err) {
      if (!interrupt?.aborted || !isInterruptedStale(err)) throw err;
      const prompt = buildFinishHandoffPrompt(ctx.input.phase, ctx.input.findings);
      const handoff = await ctx.send(prompt, { interrupt: AbortSignal.timeout(HANDOFF_TURN_MS) }).catch(() => null);
      return { ...(handoff ?? EMPTY_TURN), output: `${HANDOFF_MARKER}\n${handoff?.output ?? ""}` };
    }
  },
```

Export `HANDOFF_TURN_MS` from `src/operations/index.ts`.

- [ ] **Step 8: Run.**
Run: `timeout 30 bun test test/unit/finish/fix/ test/unit/operations/ test/unit/prompts/ --timeout=5000 && bun run typecheck && bun run check:complexity`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/finish/fix src/finish/types.ts src/finish/ops.ts src/operations src/prompts test/unit/finish/fix test/unit/operations/finish-fix.test.ts test/unit/prompts
git commit -m "feat(finish): interrupted fix session writes a handoff note in the same warm session"
```

---

### Task 7: Set-aside: base snapshot, patch, path-only restore, checked re-apply

**Files:**
- Create: `src/finish/set-aside.ts`
- Modify: `src/finish/types.ts` (`HandoffRecord`, `FixBase`)
- Modify: `src/finish/index.ts` (exports)
- Test: `test/integration/finish/set-aside.test.ts` (create; real git)

**Interfaces:**
- Consumes: `HandoffNote`, `isHandoffNote` (Task 6).
- Produces:

```ts
// types.ts
export interface FixBase { baseSha: string; headSha: string; untrackedBefore: string[] }
export type HandoffLimit = "fix" | "flow" | "run" | "error";
export interface HandoffRecord {
  n: number; dir: string; phase: "acceptance" | "gate" | "review"; limit: HandoffLimit;
  baseSha: string; headSha: string; findingIds: string[]; newUntracked: string[]; changedPaths: string[];
  stoppedAt: string; hasNote: boolean; patchSaved: boolean; restored: boolean; consumed: boolean; reapplied?: boolean;
}
// set-aside.ts
export function handoffDir(audit: AuditTarget, n: number): string;
export async function captureFixBase(workdir: string): Promise<FixBase | null>;
export async function setAside(args: {
  workdir: string; audit: AuditTarget; n: number; base: FixBase; phase: HandoffRecord["phase"];
  limit: HandoffLimit; findingIds: string[]; note?: HandoffNote; now: () => string;
}): Promise<HandoffRecord>;
export async function readHandoffNote(record: HandoffRecord): Promise<HandoffNote | undefined>;
export async function reapplyHandoff(workdir: string, record: HandoffRecord): Promise<{ applied: boolean; files: string[] }>;
export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord>;
export const _setAsideDeps: { remove: (path: string) => Promise<void> };
```

- [ ] **Step 1: Write the failing integration test.** Create `test/integration/finish/set-aside.test.ts`. The audit dir lives in a **second** temp dir, outside the repo, so its files never show up in `git status`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, withTempDir } from "@test/helpers";
import { captureFixBase, handoffDir, markHandoffConsumed, reapplyHandoff, setAside } from "@/finish/set-aside";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return new Response(p.stdout).text();
}

async function repo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "keep.ts"), "export const keep = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
}

const now = () => "2026-10-12T00:00:00.000Z";

/** Runs `fn` with a fresh repo and a separate audit dir outside it. */
async function withRepo(fn: (dir: string, audit: { auditDir: string; runId: string }) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      await repo(dir);
      await fn(dir, { auditDir: outside, runId: "run-1" });
    });
  });
}

describe("set-aside (finish A §4)", () => {
  test("saves only the session's work; pre-existing tracked edits and untracked files survive", async () => {
    await withRepo(async (dir, audit) => {
      await writeFile(join(dir, ".env"), "SECRET=1\n"); // untracked before the session
      await writeFile(join(dir, "keep.ts"), "export const keep = 2;\n"); // a pre-existing tracked edit
      const base = assertDefined(await captureFixBase(dir), "base");
      expect(base.untrackedBefore).toContain(".env");
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n"); // the session's edit
      await writeFile(join(dir, "b.ts"), "export const b = 1;\n"); // the session's new file
      const record = await setAside({ workdir: dir, audit, n: 1, base, phase: "review", limit: "fix", findingIds: ["quality|x|a.ts"], now });
      expect(record).toMatchObject({ patchSaved: true, restored: true, newUntracked: ["b.ts"], changedPaths: ["a.ts"] });
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(join(dir, "b.ts"))).toBe(false);
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(await readFile(join(dir, "keep.ts"), "utf8")).toBe("export const keep = 2;\n");
      const patch = await readFile(join(handoffDir(audit, 1), "changes.patch"), "utf8");
      expect(patch).toContain("export const a = 2;");
      expect(patch).toContain("b.ts");
      expect(patch).not.toContain("keep");
      expect(JSON.parse(await readFile(join(handoffDir(audit, 1), "meta.json"), "utf8"))).toMatchObject({ phase: "review", limit: "fix", consumed: false });
    });
  });

  test("writes note.json when a note is given", async () => {
    await withRepo(async (dir, audit) => {
      const base = assertDefined(await captureFixBase(dir), "base");
      await writeFile(join(dir, "a.ts"), "x\n");
      const note = { findings: [{ index: 1, status: "partial" as const, files: ["a.ts"], remaining: "tests" }] };
      const record = await setAside({ workdir: dir, audit, n: 1, base, phase: "review", limit: "flow", findingIds: [], note, now });
      expect(record.hasNote).toBe(true);
      expect(JSON.parse(await readFile(join(handoffDir(audit, 1), "note.json"), "utf8"))).toEqual(note);
    });
  });

  test("reapply restores the set-aside edits and lists the files; consumed is recorded", async () => {
    await withRepo(async (dir, audit) => {
      const base = assertDefined(await captureFixBase(dir), "base");
      await writeFile(join(dir, "a.ts"), "export const a = 3;\n");
      await writeFile(join(dir, "c.ts"), "c\n");
      const record = await setAside({ workdir: dir, audit, n: 1, base, phase: "review", limit: "fix", findingIds: [], now });
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(true);
      expect([...out.files].sort()).toEqual(["a.ts", "c.ts"]);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 3;\n");
      expect((await markHandoffConsumed(record)).consumed).toBe(true);
    });
  });

  test("a patch that no longer applies touches nothing", async () => {
    await withRepo(async (dir, audit) => {
      const base = assertDefined(await captureFixBase(dir), "base");
      await writeFile(join(dir, "a.ts"), "export const a = 4;\n");
      const record = await setAside({ workdir: dir, audit, n: 1, base, phase: "review", limit: "fix", findingIds: [], now });
      await writeFile(join(dir, "a.ts"), "totally different\n");
      await git(dir, "commit", "-qam", "conflict");
      const out = await reapplyHandoff(dir, record);
      expect(out.applied).toBe(false);
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `timeout -k 5s 60s bun test test/integration/finish/set-aside.test.ts --timeout=60000`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Add `FixBase`, `HandoffLimit` and `HandoffRecord` to `src/finish/types.ts`. Create `src/finish/set-aside.ts`:

```ts
/**
 * Finish A §4: a stopped (or crashed) fix session's edits are set aside, never committed.
 *
 * The base is `git stash create` (a commit object of the current tree that moves no ref
 * and leaves the stash list alone) or HEAD when the tree is clean. Pre-existing tracked
 * edits are therefore part of the base and are never overwritten. On set-aside the
 * session's changes (tracked diff against the base, plus files it created) are saved
 * as a patch, then exactly those paths are restored and those files removed. Never
 * `git clean`, never `reset --hard`. Every step after the snapshot is best-effort and
 * recorded on the returned record; nothing here throws.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { AuditTarget } from "./audit";
import { _finishGitDeps } from "./commit";
import { isHandoffNote } from "./fix";
import type { FixBase, HandoffLimit, HandoffNote, HandoffRecord } from "./types";

export const _setAsideDeps = {
  remove: (path: string): Promise<void> => unlink(path),
};

const PATCH = "changes.patch";
const NOTE = "note.json";
const META = "meta.json";

const git = (args: string[], cwd: string) => _finishGitDeps.git(args, cwd);
const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function handoffDir(audit: AuditTarget, n: number): string {
  return join(audit.auditDir, `${audit.runId}.handoff-${n}`);
}

async function untracked(workdir: string): Promise<string[]> {
  const res = await git(["status", "--porcelain=v1", "-uall"], workdir);
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).trim());
}

export async function captureFixBase(workdir: string): Promise<FixBase | null> {
  const head = await git(["rev-parse", "HEAD"], workdir);
  if (head.exitCode !== 0) return null;
  const headSha = head.stdout.trim();
  const stash = await git(["stash", "create"], workdir);
  const baseSha = stash.exitCode === 0 && stash.stdout.trim() !== "" ? stash.stdout.trim() : headSha;
  return { baseSha, headSha, untrackedBefore: await untracked(workdir) };
}

async function savePatch(workdir: string, dir: string, baseSha: string, created: string[]): Promise<boolean> {
  if (created.length > 0) await git(["add", "-N", "--", ...created], workdir);
  const diff = await git(["diff", "--binary", baseSha], workdir);
  if (created.length > 0) await git(["reset", "-q", "--", ...created], workdir);
  if (diff.exitCode !== 0) return false;
  await writeFile(join(dir, PATCH), diff.stdout, "utf8");
  return true;
}

async function restorePaths(workdir: string, baseSha: string, tracked: string[], created: string[]): Promise<boolean> {
  let ok = true;
  if (tracked.length > 0) {
    const res = await git(["restore", `--source=${baseSha}`, "--worktree", "--", ...tracked], workdir);
    ok = res.exitCode === 0;
  }
  for (const path of created) await _setAsideDeps.remove(join(workdir, path)).catch(() => undefined);
  return ok;
}

async function writeMeta(record: HandoffRecord): Promise<void> {
  await writeFile(join(record.dir, META), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function warn(message: string, err: unknown): void {
  getSafeLogger()?.warn("finish", message, { storyId: "_run", error: errorMessage(err) });
}

export async function setAside(args: {
  workdir: string;
  audit: AuditTarget;
  n: number;
  base: FixBase;
  phase: HandoffRecord["phase"];
  limit: HandoffLimit;
  findingIds: string[];
  note?: HandoffNote;
  now: () => string;
}): Promise<HandoffRecord> {
  const dir = handoffDir(args.audit, args.n);
  const before = new Set(args.base.untrackedBefore);
  const created = (await untracked(args.workdir)).filter((p) => !before.has(p));
  const changed = await git(["diff", "--name-only", args.base.baseSha], args.workdir);
  const changedPaths = changed.exitCode === 0 ? lines(changed.stdout) : [];
  const record: HandoffRecord = {
    n: args.n,
    dir,
    phase: args.phase,
    limit: args.limit,
    baseSha: args.base.baseSha,
    headSha: args.base.headSha,
    findingIds: args.findingIds,
    newUntracked: created,
    changedPaths,
    stoppedAt: args.now(),
    hasNote: false,
    patchSaved: false,
    restored: false,
    consumed: false,
  };
  try {
    await mkdir(dir, { recursive: true });
    if (args.note) {
      await writeFile(join(dir, NOTE), `${JSON.stringify(args.note, null, 2)}\n`, "utf8");
      record.hasNote = true;
    }
    record.patchSaved = await savePatch(args.workdir, dir, args.base.baseSha, created);
  } catch (err) {
    warn("Set-aside could not save the stopped session's work", err);
  }
  record.restored = await restorePaths(args.workdir, args.base.baseSha, changedPaths, created).catch((err) => {
    warn("Set-aside could not restore the worktree", err);
    return false;
  });
  await writeMeta(record).catch((err) => warn("Set-aside could not write meta.json", err));
  return record;
}

export async function readHandoffNote(record: HandoffRecord): Promise<HandoffNote | undefined> {
  if (!record.hasNote) return undefined;
  const text = await readFile(join(record.dir, NOTE), "utf8").catch(() => null);
  const parsed = text ? tryParseLLMJson<unknown>(text) : null;
  return isHandoffNote(parsed) ? parsed : undefined;
}

/** All-or-nothing: `git apply --check` first; on any failure nothing is touched. */
export async function reapplyHandoff(workdir: string, record: HandoffRecord): Promise<{ applied: boolean; files: string[] }> {
  if (!record.patchSaved) return { applied: false, files: [] };
  const patch = join(record.dir, PATCH);
  const check = await git(["apply", "--check", "--whitespace=nowarn", patch], workdir);
  if (check.exitCode !== 0) return { applied: false, files: [] };
  const apply = await git(["apply", "--whitespace=nowarn", patch], workdir);
  if (apply.exitCode !== 0) return { applied: false, files: [] };
  const stat = await git(["apply", "--numstat", patch], workdir);
  const files = lines(stat.stdout).map((l) => l.split("\t")[2] ?? "").filter(Boolean);
  return { applied: true, files };
}

export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord> {
  const next = { ...record, consumed: true };
  await writeMeta(next).catch((err) => warn("Set-aside could not update meta.json", err));
  return next;
}
```

Export `captureFixBase`, `setAside`, `readHandoffNote`, `reapplyHandoff`, `markHandoffConsumed`, `handoffDir` and `_setAsideDeps` from `src/finish/index.ts`.

Note: if `src/finish/fix` imports anything from `src/finish/index.ts`, importing `./fix` here could create a cycle. `check:import-cycles` (Step 4) will say so. If it does, import from `./fix/handoff-note` directly; that is allowed as a nested module within the same directory.

- [ ] **Step 4: Run.**
Run: `timeout -k 5s 60s bun test test/integration/finish/set-aside.test.ts --timeout=60000 && bun run typecheck && bun run check:import-cycles && bun run check:complexity`
Expected: PASS. `setAside` is near the complexity limit; if `check:complexity` flags it, split out a `newRecord(args, created, changedPaths)` helper.

- [ ] **Step 5: Commit.**

```bash
git add src/finish/set-aside.ts src/finish/types.ts src/finish/index.ts test/integration/finish/set-aside.test.ts
git commit -m "feat(finish): set aside a stopped fix session's work; path-only restore; checked re-apply"
```

---

### Task 8: `runFixStep`: one wrapper for every fix session

**Files:**
- Create: `src/finish/fix-step.ts`
- Modify: `src/finish/ops.ts` (`FixRequest.interrupt`, `FixRequest.continuation`)
- Modify: `src/finish/ops-impl.ts` (`FinishOpsDeps.runSignal`; `fix` uses the run signal + interrupt + `timeoutMs` margin)
- Modify: `src/finish/phase.ts` (`createFinishOps` gets `runSignal: ctx.abortSignal`; machine `timeouts` gets `reviewMs`, `fixMs`, `flowMs`)
- Modify: `src/finish/types.ts` (`Stop`)
- Modify: `src/finish/state.ts` (`stops`, `handoffs`, `pendingHandoff`, `lastFixBase`; version stays 2 until Task 10)
- Modify: `src/finish/machine-deps.ts` (`fixStepDeps`)
- Modify: `src/finish/machine.ts` (`reviewLoopDeps` gains `fix` and `reviewMs`)
- Modify: `src/finish/acceptance-loop.ts`, `src/finish/gates-loop.ts`, `src/finish/review-loop.ts`
- Modify: `test/helpers/finish-machine.ts`
- Test: `test/unit/finish/fix-step.test.ts` (create)
- Test: `test/unit/finish/review-loop.test.ts` (its `deps()` gains `fix`)
- Test: `test/unit/finish/machine-loops.test.ts`
- Test: `test/unit/finish/machine-invariants.test.ts:44-63` (update)

**Interfaces:**
- Consumes: `stepSignal`, `STEP_TIMEOUT_MARGIN_MS` (Task 5); `HANDOFF_TURN_MS` (Task 6); `captureFixBase`, `setAside`, `handoffDir` (Task 7).
- Produces:

```ts
// types.ts
export interface Stop {
  kind: "review" | "fix" | "flow" | "run";
  step?: "acceptance" | "review" | "gate" | "resolve";
  phase?: "acceptance" | "gate" | "review";
  lens?: ReviewLens;
  round?: number;
  at: string;
  limitMs: number;
  handoff?: number;
  findings?: number;
}
// ops.ts FixRequest gains
  interrupt?: AbortSignal;
  continuation?: FixContinuation;
// fix-step.ts
export type FixStepResult =
  | { kind: "done"; outcome: FixOutcome; continued?: HandoffRecord }
  | { kind: "failed"; error: unknown }
  | { kind: "stopped"; handoff: HandoffRecord };
export interface FixStepDeps { ops: FinishOps; audit: AuditTarget; now: () => string; signal?: AbortSignal; runSignal?: AbortSignal; fixMs?: number; flowMs?: number }
export function findingIdsOf(findings: Finding[] | undefined): string[];
export async function runFixStep(state: FinishState, deps: FixStepDeps, phase: FixPhase, req: Omit<FixRequest, "state" | "interrupt" | "continuation">): Promise<FixStepResult>;
// state.ts FinishState gains
  stops: Stop[]; handoffs: HandoffRecord[]; pendingHandoff?: number; lastFixBase?: FixBase;
  /** The step the machine is in, for flow stops recorded outside a fix session. */
  step?: Stop["step"];
// machine-deps.ts
export function fixStepDeps(deps: FinishMachineDeps): FixStepDeps;
```

- [ ] **Step 1: Extend the test git model.** In `test/helpers/finish-machine.ts`:
- Add `changedFiles?: string[]` and `applyFails?: boolean` to `FinishGitModel`.
- In `installFinishGit`, add these branches **before** the existing `diff --cached` branch:

```ts
    if (cmd === "diff" && args.includes("--name-only")) {
      // changedFiles() diffs `<base>...HEAD`; set-aside diffs one sha against the tree
      if (args.some((a) => a.includes("..."))) return { exitCode: 0, stdout: (model.changedFiles ?? []).join("\n"), stderr: "" };
      return { exitCode: 0, stdout: model.dirty ? "a.ts\n" : "", stderr: "" };
    }
    if (cmd === "restore") {
      trail?.push("restore");
      model.dirty = false;
    }
    if (cmd === "diff" && args.includes("--binary")) return { exitCode: 0, stdout: model.dirty ? "diff --git a/a.ts b/a.ts\n" : "", stderr: "" };
    if (cmd === "apply") {
      if (args.includes("--numstat")) return { exitCode: 0, stdout: "1\t1\ta.ts\n", stderr: "" };
      if (model.applyFails) return { exitCode: 1, stdout: "", stderr: "conflict" };
      if (!args.includes("--check")) {
        trail?.push("apply");
        model.dirty = true;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
```

- Add `fixMs?: number` and `flowMs?: number` to `MachineHarnessOpts`, and set `timeouts` on `deps` from them: `...(opts.fixMs || opts.flowMs ? { timeouts: { ...(opts.fixMs ? { fixMs: opts.fixMs } : {}), ...(opts.flowMs ? { flowMs: opts.flowMs } : {}) } } : {})`.
- Export `installFinishGit`, `makeFinishOps` and `makeFinishState` from `test/helpers/index.ts` if not already.

- [ ] **Step 2: Write the failing unit tests.** Create `test/unit/finish/fix-step.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, installFinishGit, makeFinishOps, makeFinishState, makeTempDir } from "@test/helpers";
import type { FinishOps, FixRequest } from "@/finish";
import { runFixStep } from "@/finish/fix-step";

const restores: (() => void)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of restores.splice(0)) r();
  await Promise.all(dirs.splice(0).map((d) => cleanupTempDir(d)));
});

async function deps(over: Partial<{ ops: FinishOps; signal: AbortSignal; runSignal: AbortSignal; fixMs: number; flowMs: number }> = {}) {
  const auditDir = await makeTempDir("fixstep-");
  dirs.push(auditDir);
  return { ops: over.ops ?? makeFinishOps([]), audit: { auditDir, runId: "run-1" }, now: () => "2026-10-12T00:00:00.000Z", ...over };
}

/** A fixer that edits, waits for its interrupt, then returns the op's interrupted outcome (as finishFixOp does). */
function interruptedFix(model: { dirty: boolean }): FinishOps["fix"] {
  return async (_phase, req) => {
    model.dirty = true;
    await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
    return { dispositions: [], interrupted: true, handoffNote: { findings: [{ index: 1, status: "partial", files: ["a.ts"], remaining: "tests" }] } };
  };
}

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };

describe("runFixStep (finish A)", () => {
  test("a fix that finishes is done, sent with an interrupt", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        model.dirty = true;
        return { dispositions: [] };
      },
    });
    const state = makeFinishState();
    expect((await runFixStep(state, await deps({ ops, fixMs: 60_000 }), "review", { findings: [finding] })).kind).toBe("done");
    expect(seen?.interrupt).toBeDefined();
    expect(state.stops).toEqual([]);
  });

  test("fixMs: interrupted, set aside with its note, a fix stop recorded, never committed", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops: makeFinishOps([], {}, { fix: interruptedFix(model) }), fixMs: 5 }), "review", { findings: [finding] });
    expect(out.kind).toBe("stopped");
    expect(trail).toContain("restore");
    expect(trail).not.toContain("commit");
    expect(model.dirty).toBe(false);
    expect(state.stops).toEqual([{ kind: "fix", phase: "review", at: "2026-10-12T00:00:00.000Z", limitMs: 5, handoff: 1, findings: 1 }]);
    expect(state.handoffs[0]).toMatchObject({ limit: "fix", hasNote: true });
    expect(state.pendingHandoff).toBe(1);
  });

  test("flow stop: interrupted, set aside, then FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const phase = new AbortController();
    const ops = makeFinishOps([], {}, {
      fix: async (p, req) => {
        queueMicrotask(() => phase.abort());
        return interruptedFix(model)(p, req);
      },
    });
    const state = makeFinishState();
    await expect(runFixStep(state, await deps({ ops, signal: phase.signal, fixMs: 60_000, flowMs: 10_800_000 }), "gate", { failing: ["test"] })).rejects.toThrow("Finish aborted");
    expect(state.stops[0]).toMatchObject({ kind: "flow", phase: "gate", limitMs: 10_800_000, handoff: 1 });
    expect(state.handoffs[0].limit).toBe("flow");
  });

  test("run cancel: set aside as 'run', recorded as a run stop, then FINISH_ABORTED", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const run = new AbortController();
    const ops = makeFinishOps([], {}, {
      fix: async () => {
        model.dirty = true;
        run.abort();
        throw new Error("callOp[finish-fix]: aborted");
      },
    });
    const state = makeFinishState();
    await expect(runFixStep(state, await deps({ ops, signal: run.signal, runSignal: run.signal }), "review", { findings: [] })).rejects.toThrow("Finish aborted");
    expect(state.stops[0]?.kind).toBe("run");
    expect(state.handoffs[0].limit).toBe("run");
  });

  test("commit guard: a fix that returns normally after the limit is set aside", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        model.dirty = true;
        await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
        return { dispositions: [] };
      },
    });
    const state = makeFinishState();
    expect((await runFixStep(state, await deps({ ops, fixMs: 5 }), "acceptance", { acceptanceOutput: "x" })).kind).toBe("stopped");
    expect(model.dirty).toBe(false);
  });

  test("a crashing fixer is set aside as 'error', not offered to the next attempt, and reported failed", async () => {
    const model = { dirty: false, head: 1 };
    restores.push(installFinishGit(model));
    const ops = makeFinishOps([], {}, {
      fix: async () => {
        model.dirty = true;
        throw new Error("model exploded");
      },
    });
    const state = makeFinishState();
    const out = await runFixStep(state, await deps({ ops, fixMs: 60_000 }), "review", { findings: [] });
    expect(out.kind).toBe("failed");
    expect(model.dirty).toBe(false);
    expect(state.handoffs[0].limit).toBe("error");
    expect(state.pendingHandoff).toBeUndefined();
    expect(state.stops).toEqual([]);
  });

  test("an unreadable base fails the step without running the fixer", async () => {
    const restore = installFinishGit({ dirty: false, head: 1 });
    restores.push(restore);
    const { _finishGitDeps } = await import("@/finish");
    const inner = _finishGitDeps.git;
    _finishGitDeps.git = async (args, cwd) => (args[0] === "rev-parse" ? { exitCode: 128, stdout: "", stderr: "x" } : inner(args, cwd));
    restores.push(() => {
      _finishGitDeps.git = inner;
    });
    let ran = false;
    const ops = makeFinishOps([], {}, {
      fix: async () => {
        ran = true;
        return {};
      },
    });
    expect((await runFixStep(makeFinishState(), await deps({ ops }), "review", { findings: [] })).kind).toBe("failed");
    expect(ran).toBe(false);
  });
});
```

`makeTempDir`'s exact signature comes from `@nathapp/nax-test-kit/bun/temp`. Check it, and drop the prefix argument if it takes none.

- [ ] **Step 3: Run it to verify it fails.**
Run: `timeout 30 bun test test/unit/finish/fix-step.test.ts --timeout=5000`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the state, types and ops.**
- Add `Stop` to `types.ts`.
- Add the `FinishState` fields to `state.ts`, with `stops: [], handoffs: []` in `createFinishState`.
- Add `interrupt?` and `continuation?` to `FixRequest`.

In `ops-impl.ts`:
- add `runSignal?: AbortSignal` to `FinishOpsDeps`;
- `fix` builds the input with `timeoutMs: timeouts?.fixMs !== undefined ? timeouts.fixMs + HANDOFF_TURN_MS + STEP_TIMEOUT_MARGIN_MS : undefined`, plus `...(req.interrupt ? { interrupt: req.interrupt } : {})` and `...(req.continuation ? { continuation: req.continuation } : {})`;
- it calls `_finishOpsDeps.callOp({ ...callCtx, sessionOverride: undefined, signal: deps.runSignal }, finishFixOp, input)`.

When `deps.runSignal` is undefined, `signal: undefined` makes callOp fall back to the runtime signal, which is the intended hard stop for the fix op.

In `phase.ts`, pass `runSignal: ctx.abortSignal` to `createFinishOps`, and machine `timeouts: { acceptanceMs, gateMs, reviewMs, fixMs, flowMs }` from `settings.timeouts`.

- [ ] **Step 5: Implement `runFixStep`.** Create `src/finish/fix-step.ts`:

```ts
/**
 * Finish A §3–§4: every fix session (acceptance, review, gate) runs here.
 *
 * - The fixer runs under the run's own signal (hard) plus an interrupt (soft) =
 *   phase signal + fixMs. The fix op answers an interrupt with a handoff note.
 * - Commit guard: anything that stopped is set aside, never returned as done.
 * - A crash is set aside too ("error"), so the next step starts from the base.
 * - fixMs stop -> `stopped` (the loop continues); flow / run stop -> set aside,
 *   then FINISH_ABORTED, so the handoff survives the machine's recovery path.
 */
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { findingId } from "./ledger";
import { assertNotAborted } from "./machine-deps";
import type { FinishOps, FixOutcome, FixPhase, FixRequest } from "./ops";
import { captureFixBase, setAside } from "./set-aside";
import type { FinishState } from "./state";
import { stepSignal } from "./step-signal";
import type { Finding, FixBase, HandoffLimit, HandoffNote, HandoffRecord, Stop } from "./types";

export type FixStepResult =
  | { kind: "done"; outcome: FixOutcome; continued?: HandoffRecord }
  | { kind: "failed"; error: unknown }
  | { kind: "stopped"; handoff: HandoffRecord };

export interface FixStepDeps {
  ops: FinishOps;
  audit: AuditTarget;
  now: () => string;
  /** Phase signal (run signal + flowMs deadline). */
  signal?: AbortSignal;
  /** The run's own signal (SIGINT / cancel). */
  runSignal?: AbortSignal;
  fixMs?: number;
  flowMs?: number;
}

export function findingIdsOf(findings: Finding[] | undefined): string[] {
  return (findings ?? []).map(findingId);
}

function stopKind(deps: FixStepDeps, limit: AbortSignal | undefined, outcome?: FixOutcome): HandoffLimit | undefined {
  if (deps.runSignal?.aborted) return "run";
  if (deps.signal?.aborted) return "flow";
  if (limit?.aborted || outcome?.interrupted) return "fix";
  return undefined;
}

async function setAsideStep(
  state: FinishState,
  deps: FixStepDeps,
  ctx: { phase: FixPhase; base: FixBase; req: Pick<FixRequest, "findings">; limit: HandoffLimit; note?: HandoffNote },
): Promise<HandoffRecord> {
  const record = await setAside({
    workdir: state.workdir,
    audit: deps.audit,
    n: state.handoffs.length + 1,
    base: ctx.base,
    phase: ctx.phase,
    limit: ctx.limit,
    findingIds: findingIdsOf(ctx.req.findings),
    ...(ctx.note ? { note: ctx.note } : {}),
    now: deps.now,
  });
  state.handoffs = [...state.handoffs, record];
  if (ctx.limit === "fix" || ctx.limit === "flow") state.pendingHandoff = record.n;
  if (ctx.limit !== "error") {
    const stop: Stop = {
      kind: ctx.limit === "error" ? "fix" : ctx.limit,
      phase: ctx.phase,
      at: deps.now(),
      limitMs: (ctx.limit === "flow" ? deps.flowMs : ctx.limit === "fix" ? deps.fixMs : 0) ?? 0,
      handoff: record.n,
      ...(ctx.phase === "review" ? { findings: ctx.req.findings?.length ?? 0 } : {}),
    };
    state.stops = [...state.stops, stop];
  }
  getSafeLogger()?.warn("finish", "Fix session set aside", { storyId: "_run", phase: ctx.phase, limit: ctx.limit, handoff: record.dir });
  return record;
}

export async function runFixStep(
  state: FinishState,
  deps: FixStepDeps,
  phase: FixPhase,
  req: Omit<FixRequest, "state" | "interrupt" | "continuation">,
): Promise<FixStepResult> {
  assertNotAborted(deps);
  const base = await captureFixBase(state.workdir);
  if (!base) return { kind: "failed", error: new NaxError("Cannot read the worktree base", "FINISH_FIX_BASE", { stage: "finish" }) };
  state.lastFixBase = base;
  const { signal: interrupt, limit } = stepSignal(deps.signal, deps.fixMs);
  let outcome: FixOutcome;
  try {
    outcome = await deps.ops.fix(phase, { ...req, state, ...(interrupt ? { interrupt } : {}) });
  } catch (error) {
    const kind = stopKind(deps, limit) ?? "error";
    const handoff = await setAsideStep(state, deps, { phase, base, req, limit: kind });
    if (kind === "error") return { kind: "failed", error };
    assertNotAborted(deps);
    return { kind: "stopped", handoff };
  }
  const kind = stopKind(deps, limit, outcome);
  if (!kind) return { kind: "done", outcome };
  const handoff = await setAsideStep(state, deps, { phase, base, req, limit: kind, ...(outcome.handoffNote ? { note: outcome.handoffNote } : {}) });
  assertNotAborted(deps);
  return { kind: "stopped", handoff };
}
```

`setAsideStep`'s `kind` expression keeps TypeScript happy, because `Stop["kind"]` has no `"error"` and the branch is guarded. If the complexity check flags `setAsideStep`, split out `stopFor(deps, ctx, record): Stop`.

`findingId` comes from `./ledger` (Task 10). Until then, create `src/finish/ledger.ts` in this task with only `findingId`:

```ts
import type { Finding } from "./types";
export function findingId(f: Finding): string {
  return `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase();
}
```

Task 10 extends this file.

In `machine-deps.ts`:

```ts
/** The `runFixStep` deps a loop passes, from the machine deps. */
export function fixStepDeps(deps: FinishMachineDeps): FixStepDeps {
  return {
    ops: deps.ops,
    audit: deps.audit,
    now: deps.now,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.runSignal ? { runSignal: deps.runSignal } : {}),
    ...(deps.timeouts?.fixMs !== undefined ? { fixMs: deps.timeouts.fixMs } : {}),
    ...(deps.timeouts?.flowMs !== undefined ? { flowMs: deps.timeouts.flowMs } : {}),
  };
}
```

Import `FixStepDeps` as a type from `./fix-step`. If this closes an import cycle (`check:import-cycles`), move `fixStepDeps` into `fix-step.ts` and import `FinishMachineDeps` there as a type.

- [ ] **Step 6: Wire the three loops.**

**`acceptance-loop.ts` `fixOnce`.** Replace the `try { fixOutcome = await deps.ops.fix(...) } catch {...}` block:

```ts
  const step = await runFixStep(state, fixStepDeps(deps), "acceptance", { acceptanceOutput: output });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Acceptance fix session failed; counted as used", { storyId: "_run", error: errorMessage(step.error) });
    }
    state.phases.acceptance.fixAttempts += 1;
    return;
  }
  const fixOutcome = step.outcome;
```

**`gates-loop.ts` `fixOnce`.** The same, with phase `"gate"` and `{ failing: gates.failing, gateOutput: gates.output }`. In the non-done branch, **increment `state.phases.gate.fixAttempts`** and then `return { committed: false, changed: false }`. Without the increment, `routeQualityGates` (`route.ts:85-91`) never stops the gate loop.

**`review-loop.ts` `fixRound`.** Add `fix: FixStepDeps` and `reviewMs?: number` to `ReviewLoopDeps`. Replace the `try`/`catch` around `deps.ops.fix`:

```ts
  const step = await runFixStep(state, deps.fix, "review", { findings: fixList });
  if (step.kind !== "done") {
    if (step.kind === "failed") {
      getSafeLogger()?.warn("finish", "Review fix session failed; findings stay open", { storyId: "_run", error: String(step.error) });
    }
    state.phases.review.fixAttempts += 1;
    return;
  }
  const outcome = step.outcome;
```

In `machine.ts` `reviewLoopDeps`, add `fix: fixStepDeps(deps)` and `...(deps.timeouts?.reviewMs !== undefined ? { reviewMs: deps.timeouts.reviewMs } : {})`.

In `test/unit/finish/review-loop.test.ts`, the local `deps(ops, auditDir, advise?)` adds `fix: { ops, audit: { auditDir, runId: "run-1" }, now: () => "t" },`. Do the same in every other test file that builds a `ReviewLoopDeps` literal: `grep -rln "assertNotAborted: () =>" test/unit/finish`.

- [ ] **Step 7: Add the machine-level tests and update the existing deadline test.** In `test/unit/finish/machine-loops.test.ts` (reuse its `withTempDir`, `makeMachineHarness`, `runFinishMachine` and finding helpers):

```ts
test("a review fix stopped at fixMs is set aside, never committed, and the loop reviews again (finish A)", async () => {
  await withTempDir(async (dir) => {
    const h = makeMachineHarness({
      auditDir: dir,
      context: { acceptanceStatus: "disabled" },
      script: { quality: [{ findings: [{ severity: "LOW", title: "x", problem: "p", fix: "f", source: "quality", file: "a.ts" }], covered: [] }] },
      fixMs: 5,
      ops: {
        fix: async (_p, req) => {
          await new Promise<void>((r) => req.interrupt?.addEventListener("abort", () => r(), { once: true }));
          return { dispositions: [], interrupted: true };
        },
      },
    });
    await runFinishMachine(h.state, h.deps);
    expect(h.trail.filter((t) => t === "commit")).toHaveLength(0);
    expect(h.trail).toContain("restore");
    expect(h.state.stops[0]).toMatchObject({ kind: "fix", phase: "review" });
    expect(h.trail.filter((t) => t === "review:quality").length).toBeGreaterThan(1);
  });
});
```

Update `test/unit/finish/machine-invariants.test.ts` (~L44-63), "flowMs deadline during a fix session":
- add `flowMs: 10_800_000` to the harness options;
- expect `result.reason?.startsWith("finish time limit (3 h) reached during")` instead of `startsWith("deadline")`. The rest of the reason text comes from Task 11; until Task 11 lands, assert only that it does not start with `"deadline"` and contains `"handoff-1"` or `"finish time limit"`. Tighten it in Task 11.
- The trail after `fix:review` becomes `["restore", "finalizeDraftPr"]`.

- [ ] **Step 8: Run all finish tests.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000 && timeout -k 5s 60s bun test test/integration/finish/ --timeout=60000 && bun run typecheck && bun run check:complexity && bun run check:import-cycles`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/finish test/helpers test/unit/finish
git commit -m "feat(finish): runFixStep - soft interrupt, commit guard, set-aside on stop or crash (#2462)"
```

---

### Task 9: The next attempt continues from the handoff

**Files:**
- Modify: `src/finish/fix-step.ts`
- Modify: the three loops (call `consumeIfCommitted` after `commitFixes`)
- Test: `test/unit/finish/fix-step.test.ts`

**Interfaces:**
- Consumes: `reapplyHandoff`, `readHandoffNote`, `markHandoffConsumed` (Task 7).
- Produces: `consumeIfCommitted(state: FinishState, continued: HandoffRecord | undefined, committed: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing tests.** Append to `test/unit/finish/fix-step.test.ts` (import `HandoffRecord` from `@/finish`, `consumeIfCommitted` from `@/finish/fix-step`, `join` from `node:path`):

```ts
function handoff(auditDir: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    n: 1, dir: join(auditDir, "run-1.handoff-1"), phase: "review", limit: "fix", baseSha: "sha1", headSha: "sha1",
    findingIds: [], newUntracked: [], changedPaths: [], stoppedAt: "t", hasNote: false, patchSaved: true,
    restored: true, consumed: false, ...over,
  };
}

describe("runFixStep continuation (finish A §4.3)", () => {
  test("re-applies the pending handoff of the same phase and passes a continuation", async () => {
    const model = { dirty: false, head: 1 };
    const trail: string[] = [];
    restores.push(installFinishGit(model, trail));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        return { dispositions: [] };
      },
    });
    const d = await deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    const out = await runFixStep(state, d, "review", { findings: [] });
    expect(trail).toContain("apply");
    expect(seen?.continuation).toEqual({ files: ["a.ts"] });
    expect(out.kind === "done" ? out.continued?.n : undefined).toBe(1);
    expect(state.pendingHandoff).toBeUndefined();
  });

  test("a patch that fails --check: fresh start, handoff kept, marked not re-applied", async () => {
    const model = { dirty: false, head: 1, applyFails: true };
    restores.push(installFinishGit(model));
    let seen: FixRequest | undefined;
    const ops = makeFinishOps([], {}, {
      fix: async (_p, req) => {
        seen = req;
        return {};
      },
    });
    const d = await deps({ ops, fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir)];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    expect(seen?.continuation).toBeUndefined();
    expect(state.handoffs[0].reapplied).toBe(false);
  });

  test("a pending handoff of another phase is left alone", async () => {
    const trail: string[] = [];
    restores.push(installFinishGit({ dirty: false, head: 1 }, trail));
    const d = await deps({ fixMs: 60_000 });
    const state = makeFinishState();
    state.handoffs = [handoff(d.audit.auditDir, { phase: "gate" })];
    state.pendingHandoff = 1;
    await runFixStep(state, d, "review", { findings: [] });
    expect(trail).not.toContain("apply");
    expect(state.pendingHandoff).toBe(1);
  });

  test("consumeIfCommitted marks the handoff consumed only after a commit", async () => {
    const d = await deps();
    const state = makeFinishState();
    const rec = handoff(d.audit.auditDir);
    state.handoffs = [rec];
    await consumeIfCommitted(state, rec, false);
    expect(state.handoffs[0].consumed).toBe(false);
    await consumeIfCommitted(state, rec, true);
    expect(state.handoffs[0].consumed).toBe(true);
  });
});
```

`markHandoffConsumed` writes `meta.json` into `rec.dir`, which may not exist. It logs and continues, so the test still passes.

- [ ] **Step 2: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/fix-step.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `fix-step.ts`:

```ts
import { markHandoffConsumed, readHandoffNote, reapplyHandoff } from "./set-aside";
import type { FixContinuation } from "./types";

function replaceHandoff(state: FinishState, next: HandoffRecord): void {
  state.handoffs = state.handoffs.map((h) => (h.n === next.n ? next : h));
}

/** §4.3: the pending stopped handoff of this phase, re-applied; undefined when none or it no longer applies. */
async function continueFrom(state: FinishState, phase: FixPhase): Promise<{ record: HandoffRecord; continuation: FixContinuation } | undefined> {
  const pending = state.handoffs.find((h) => h.n === state.pendingHandoff);
  if (!pending || pending.phase !== phase) return undefined;
  state.pendingHandoff = undefined;
  const { applied, files } = await reapplyHandoff(state.workdir, pending);
  const record = { ...pending, reapplied: applied };
  replaceHandoff(state, record);
  if (!applied) return undefined;
  const note = await readHandoffNote(record);
  return { record, continuation: { files, ...(note ? { note } : {}) } };
}

export async function consumeIfCommitted(state: FinishState, continued: HandoffRecord | undefined, committed: boolean): Promise<void> {
  if (!continued || !committed) return;
  replaceHandoff(state, await markHandoffConsumed(continued));
}
```

In `runFixStep`, **after** `state.lastFixBase = base` (so the base excludes the re-applied edits, and a second stop sets them aside again), add `const cont = await continueFrom(state, phase);`. Pass `...(cont ? { continuation: cont.continuation } : {})` into `deps.ops.fix`. Return `{ kind: "done", outcome, ...(cont ? { continued: cont.record } : {}) }`.

In each loop, right after `commitFixes`, add `await consumeIfCommitted(state, step.continued, commit.committed);`.

- [ ] **Step 4: Run.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000 && bun run check:complexity`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/finish test/unit/finish/fix-step.test.ts
git commit -m "feat(finish): the next fix attempt re-applies the handoff and continues from its note"
```

---

### Task 10: One state per finding (ledger) and state v3

**Files:**
- Modify: `src/finish/ledger.ts` (from Task 8: add the rest)
- Modify: `src/finish/advise.ts` (`JudgedResult.dropped`, `judgeOne`, `judgeContradiction`, `judged`, `judgeWithoutAdvisor`)
- Modify: `src/finish/review-loop.ts` (ledger events; review stops)
- Modify: `src/finish/state.ts` (`review.ledger`; `version: 3`)
- Test: `test/unit/finish/ledger.test.ts` (create)
- Test: `test/unit/finish/advise.test.ts`
- Test: `test/unit/finish/review-loop.test.ts`
- Test: `test/unit/finish/state.test.ts:43-53, 92-98`

**Interfaces:**
- Produces:

```ts
export type LedgerState = "open" | "fixed-unreviewed" | "fixed-reviewed" | "rejected" | "set-aside" | "waived" | "superseded" | "unresolved" | "accepted";
export interface LedgerEntry { id: string; finding: Finding; state: LedgerState; ref?: string }
export type LedgerEvent =
  | { kind: "raised"; findings: Finding[] }
  | { kind: "fixed"; findings: Finding[]; dispositions: FindingDisposition[]; sha: string }
  | { kind: "set-aside"; findings: Finding[]; handoff: string }
  | { kind: "ruled"; finding: Finding; state: "waived" | "superseded" | "unresolved"; ref?: string }
  | { kind: "full-round"; raised: Finding[] }
  | { kind: "accepted"; findings: Finding[]; ref: string };
export const OPEN_STATES: ReadonlySet<LedgerState>;
export function applyLedgerEvent(ledger: readonly LedgerEntry[], ev: LedgerEvent): LedgerEntry[];
export function openFindings(ledger: readonly LedgerEntry[]): Finding[];
// advise.ts JudgedResult gains
  dropped: { finding: Finding; decisionId: string; action: "waive" | "supersede" }[];
  /** hold decisions per finding, for the ledger ref */
  held: { finding: Finding; decisionId: string }[];
// state.ts ReviewLoopState gains: ledger: LedgerEntry[]
```

- [ ] **Step 1: Write the failing ledger tests.** Create `test/unit/finish/ledger.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Finding } from "@/finish";
import { applyLedgerEvent, findingId, type LedgerEntry, type LedgerEvent, openFindings } from "@/finish/ledger";

const f = (title: string): Finding => ({ severity: "MEDIUM", title, problem: "p", fix: "x", file: "src/a.ts", source: "quality" });
const apply = (events: LedgerEvent[]): LedgerEntry[] => events.reduce<LedgerEntry[]>((acc, ev) => applyLedgerEvent(acc, ev), []);

describe("finish ledger (finish A §5)", () => {
  test("raised findings are open", () => {
    expect(apply([{ kind: "raised", findings: [f("A")] }])).toEqual([{ id: findingId(f("A")), finding: f("A"), state: "open" }]);
  });

  test("committed fix: fixed -> fixed-unreviewed(sha); rejected -> rejected(evidence)", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B")] },
      { kind: "fixed", findings: [f("A"), f("B")], dispositions: [{ index: 1, disposition: "fixed" }, { index: 2, disposition: "rejected", evidence: "src/a.ts:3" }], sha: "abc" },
    ]);
    expect(l.map((e) => [e.finding.title, e.state, e.ref])).toEqual([["A", "fixed-unreviewed", "abc"], ["B", "rejected", "src/a.ts:3"]]);
  });

  test("missing disposition stays open", () => {
    expect(apply([{ kind: "raised", findings: [f("A")] }, { kind: "fixed", findings: [f("A")], dispositions: [], sha: "abc" }])[0].state).toBe("open");
  });

  test("a full round that does not re-raise a fixed finding marks it fixed-reviewed; re-raising reopens", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B")] },
      { kind: "fixed", findings: [f("A"), f("B")], dispositions: [{ index: 1, disposition: "fixed" }, { index: 2, disposition: "fixed" }], sha: "s1" },
      { kind: "raised", findings: [f("B")] },
      { kind: "full-round", raised: [f("B")] },
    ]);
    expect(l.map((e) => [e.finding.title, e.state])).toEqual([["A", "fixed-reviewed"], ["B", "open"]]);
  });

  test("waived stays waived when re-raised; set-aside and unresolved count as open", () => {
    const l = apply([
      { kind: "raised", findings: [f("A"), f("B"), f("C")] },
      { kind: "ruled", finding: f("A"), state: "waived", ref: "D-1" },
      { kind: "set-aside", findings: [f("B")], handoff: "handoff-1" },
      { kind: "ruled", finding: f("C"), state: "unresolved" },
      { kind: "raised", findings: [f("A")] },
    ]);
    expect(l[0]).toMatchObject({ state: "waived", ref: "D-1" });
    expect(openFindings(l).map((x) => x.title)).toEqual(["B", "C"]);
  });

  test("the round-cap path and the deadline path give identical states for the same events", () => {
    const events: LedgerEvent[] = [
      { kind: "raised", findings: [f("A")] },
      { kind: "fixed", findings: [f("A")], dispositions: [{ index: 1, disposition: "fixed" }], sha: "s" },
    ];
    expect(apply(events)).toEqual(apply([...events]));
    expect(openFindings(apply(events))).toEqual([]);
  });

  test("accepted residue is recorded and never mutates its input", () => {
    const l0 = apply([{ kind: "raised", findings: [f("A")] }]);
    const copy = structuredClone(l0);
    const l1 = applyLedgerEvent(l0, { kind: "accepted", findings: [f("A")], ref: "advisor approval" });
    expect(l1[0]).toMatchObject({ state: "accepted", ref: "advisor approval" });
    expect(l0).toEqual(copy);
  });
});
```

In the "re-raising reopens" test, `raised` comes **before** `full-round`, matching the review loop's event order (Step 5).

- [ ] **Step 2: Write the failing advise test.** Append to `test/unit/finish/advise.test.ts`, inside the `describe` that holds `"waive and supersede drop the finding"` (it uses that file's `fakeAdvisor`, `decision`, `make`, `state`, `judged`):

```ts
  test("waive and supersede are reported per finding in dropped (finish A)", async () => {
    await withTempDir(async (dir) => {
      for (const [action, kind] of [
        [{ type: "waive", reason: "spec allows it" }, "waive"],
        [{ type: "supersede", target: { kind: "spec", section: "Design" }, newText: "x" }, "supersede"],
      ] as const) {
        const { advisor } = fakeAdvisor(() => ({ decision: decision({ action, chosenOptionId: "B" }) }));
        const out = await make(dir, advisor).judged([judged], [], state(dir));
        expect(out.dropped).toEqual([{ finding: judged, decisionId: "D-1", action: kind }]);
      }
    });
  });

  test("a hold is reported per finding in held (finish A)", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({ decision: decision({ action: { type: "hold", reason: "needs a human" } }) }));
      const out = await make(dir, advisor).judged([judged], [], state(dir));
      expect(out.held).toEqual([{ finding: judged, decisionId: "D-1" }]);
    });
  });
```

If `hold`'s action shape differs, copy it from the file's existing hold case. Update every whole-`JudgedResult` `toEqual` in that file to include `dropped: []` and `held: []`, e.g. `"advisor unavailable gives unresolved"` becomes `{ toFix: [], advice: [], unresolved: [judged], dropped: [], held: [] }`.

- [ ] **Step 3: Write the failing review-loop tests.** Append to `test/unit/finish/review-loop.test.ts`, which uses that file's `q`, `deps`, `stubGit`, `makeFinishOps`, `makeFinishState` and `withTempDir`:

```ts
describe("runReviewLoop ledger (finish A)", () => {
  test("a fixed finding not re-raised by the next full round becomes fixed-reviewed", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const ops = makeFinishOps([], { quality: [q("A")] }, {
        fix: async () => {
          git.dirty = true;
          return { dispositions: [{ index: 1, disposition: "fixed" as const }] };
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.ledger.map((e) => [e.finding.title, e.state, e.ref])).toEqual([["A", "fixed-reviewed", "sha2"]]);
    });
  });

  test("a fix with no dispositions leaves the finding open at the cap", async () => {
    await withTempDir(async (dir) => {
      const git = { dirty: false, head: 1 };
      stubGit(git);
      const ops = makeFinishOps([], { quality: [q("A"), q("A"), q("A")] }, {
        fix: async () => {
          git.dirty = true;
          return {};
        },
      });
      const state = makeFinishState();
      await runReviewLoop(state, deps(ops, dir));
      expect(state.review.ledger[0].state).toBe("open");
    });
  });

  test("a lens stopped at reviewMs is recorded as a review stop", async () => {
    await withTempDir(async (dir) => {
      stubGit({ dirty: false, head: 1 });
      const ops = makeFinishOps([], { quality: [{ findings: [], covered: [], missing: true, stoppedAtLimit: true }] });
      const state = makeFinishState();
      await runReviewLoop(state, { ...deps(ops, dir), reviewMs: 900_000 });
      expect(state.stops).toContainEqual({ kind: "review", lens: "quality", round: 1, at: "t", limitMs: 900_000 });
    });
  });
});
```

`sha2` is the HEAD the stub git model reports after the first commit (`installFinishGit` returns `sha${model.head}`).

- [ ] **Step 4: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/ledger.test.ts test/unit/finish/advise.test.ts test/unit/finish/review-loop.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 5: Implement.** Extend `src/finish/ledger.ts` (keep `findingId`):

```ts
import type { Finding, FindingDisposition } from "./types";

export type LedgerState =
  | "open" | "fixed-unreviewed" | "fixed-reviewed" | "rejected" | "set-aside" | "waived" | "superseded" | "unresolved" | "accepted";

export interface LedgerEntry {
  id: string;
  finding: Finding;
  state: LedgerState;
  ref?: string;
}

export type LedgerEvent =
  | { kind: "raised"; findings: Finding[] }
  | { kind: "fixed"; findings: Finding[]; dispositions: FindingDisposition[]; sha: string }
  | { kind: "set-aside"; findings: Finding[]; handoff: string }
  | { kind: "ruled"; finding: Finding; state: "waived" | "superseded" | "unresolved"; ref?: string }
  | { kind: "full-round"; raised: Finding[] }
  | { kind: "accepted"; findings: Finding[]; ref: string };

export const OPEN_STATES: ReadonlySet<LedgerState> = new Set(["open", "rejected", "set-aside", "unresolved"]);
const STICKY: ReadonlySet<LedgerState> = new Set(["waived", "superseded", "accepted"]);

function upsert(ledger: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  const i = ledger.findIndex((e) => e.id === entry.id);
  return i < 0 ? [...ledger, entry] : ledger.map((e, j) => (j === i ? entry : e));
}

function set(ledger: readonly LedgerEntry[], f: Finding, state: LedgerState, ref?: string): LedgerEntry[] {
  return upsert(ledger, { id: findingId(f), finding: f, state, ...(ref !== undefined ? { ref } : {}) });
}

function raise(ledger: readonly LedgerEntry[], findings: Finding[]): LedgerEntry[] {
  return findings.reduce<LedgerEntry[]>((acc, f) => {
    const prior = acc.find((e) => e.id === findingId(f));
    return prior && STICKY.has(prior.state) ? acc : set(acc, f, "open");
  }, [...ledger]);
}

function fixed(ledger: readonly LedgerEntry[], ev: Extract<LedgerEvent, { kind: "fixed" }>): LedgerEntry[] {
  return ev.findings.reduce<LedgerEntry[]>((acc, f, i) => {
    const d = ev.dispositions.find((x) => x.index === i + 1);
    if (d?.disposition === "fixed") return set(acc, f, "fixed-unreviewed", ev.sha);
    if (d?.disposition === "rejected") return set(acc, f, "rejected", d.evidence);
    return set(acc, f, "open");
  }, [...ledger]);
}

function fullRound(ledger: readonly LedgerEntry[], raised: Finding[]): LedgerEntry[] {
  const again = new Set(raised.map(findingId));
  return ledger.map((e) => (e.state === "fixed-unreviewed" && !again.has(e.id) ? { ...e, state: "fixed-reviewed" } : e));
}

const setAll = (ledger: readonly LedgerEntry[], findings: Finding[], state: LedgerState, ref: string): LedgerEntry[] =>
  findings.reduce<LedgerEntry[]>((acc, f) => set(acc, f, state, ref), [...ledger]);

export function applyLedgerEvent(ledger: readonly LedgerEntry[], ev: LedgerEvent): LedgerEntry[] {
  switch (ev.kind) {
    case "raised":
      return raise(ledger, ev.findings);
    case "fixed":
      return fixed(ledger, ev);
    case "set-aside":
      return setAll(ledger, ev.findings, "set-aside", ev.handoff);
    case "ruled":
      return set(ledger, ev.finding, ev.state, ev.ref);
    case "full-round":
      return fullRound(ledger, ev.raised);
    case "accepted":
      return setAll(ledger, ev.findings, "accepted", ev.ref);
  }
}

export function openFindings(ledger: readonly LedgerEntry[]): Finding[] {
  return ledger.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding);
}
```

In `advise.ts`:
- `JudgedResult` gains `dropped` and `held` (shapes above); `judgeWithoutAdvisor` returns `dropped: [], held: []`.
- `judgeOne` additionally returns `dropped?: "waive" | "supersede"`:
  - for a reused prior: `dropped: prior.action.type === "supersede" ? "supersede" : "waive"`;
  - for a fresh decision whose `action.type` is `"waive"` or `"supersede"`: `dropped: action.type`.
- In `judged`, `out` starts as `{ toFix: [], advice: [], unresolved: [], dropped: [], held: [] }`. Push `{ finding: f, decisionId: r.ref.decisionId, action: r.dropped }` when `r.dropped && r.ref`, and `{ finding: f, decisionId: r.ref.decisionId }` into `held` when `r.hold !== undefined && r.ref`.
- `judgeContradiction` also returns `dropped` (`[c.spec, c.quality]` with the action, for waive or supersede) and `held` (both findings, for a hold). The aggregator pushes them.

In `review-loop.ts`:

```ts
import { applyLedgerEvent, type LedgerEvent } from "./ledger";

function ledgerEvent(state: FinishState, ev: LedgerEvent): void {
  patchReview(state, { ledger: applyLedgerEvent(state.review.ledger, ev) });
}

function recordJudgment(state: FinishState, judged: JudgedResult): void {
  for (const d of judged.dropped) {
    ledgerEvent(state, { kind: "ruled", finding: d.finding, state: d.action === "supersede" ? "superseded" : "waived", ref: d.decisionId });
  }
  const heldRef = new Map(judged.held.map((h) => [h.finding, h.decisionId]));
  for (const u of judged.unresolved) {
    const ref = heldRef.get(u);
    ledgerEvent(state, { kind: "ruled", finding: u, state: "unresolved", ...(ref ? { ref } : {}) });
  }
}

function recordReviewStops(state: FinishState, deps: ReviewLoopDeps, round: ReviewRoundResult): void {
  for (const lens of LENSES) {
    if (!round[lens].stoppedAtLimit) continue;
    state.stops = [...state.stops, { kind: "review", lens, round: state.review.rounds + 1, at: deps.now(), limitMs: deps.reviewMs ?? 0 }];
  }
}
```

In `runOneRound`:
- after `recordLensRounds(...)`, call `recordReviewStops(state, deps, round);`;
- after `const judged = await judgeRound(...)`:

```ts
  const raised = [...merged.toFix, ...merged.judged, ...merged.contradictions.flatMap((c) => [c.spec, c.quality])];
  ledgerEvent(state, { kind: "raised", findings: raised });
  if (round.missing.length === 0) ledgerEvent(state, { kind: "full-round", raised });
  recordJudgment(state, judged);
```

In `fixRound`:
- after a committed fix: `if (commit.committed && commit.shaAfter) ledgerEvent(state, { kind: "fixed", findings: fixList, dispositions: outcome.dispositions ?? [], sha: commit.shaAfter });`
- in the non-done branch, when `step.kind === "stopped"`: `ledgerEvent(state, { kind: "set-aside", findings: fixList, handoff: \`handoff-${step.handoff.n}\` });`

Keep the at-cap `patchReview(state, { lastFindings: [] })` and the unreviewed-commit push unchanged. `lastFindings` is now loop control only; reporting reads the ledger (Task 11).

In `state.ts`:
- `ledger: LedgerEntry[]` on `ReviewLoopState`, `ledger: []` in `zeroedReview`;
- `version: 3` in the interface and `createFinishState`;
- `deserializeFinishState` rejects `version !== 3`, and its doc comment says `3`.

Update `test/unit/finish/state.test.ts`:
- L43-53: the bad payload uses `version: 2`, and the test name says "other than 3".
- L92-98: expect `s.version` to be `3`, and add `ledger: []` to the expected `s.review`.
- Any round-trip fixture with `version: 2` becomes `3`.

- [ ] **Step 6: Run.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000 && bun run typecheck && bun run check:complexity`
Expected: PASS. Fixtures that build `ReviewLoopState` or `JudgedResult` literals need `ledger: []` / `dropped: [], held: []`.

- [ ] **Step 7: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): per-finding ledger, advisor rulings per finding, state v3"
```

---

### Task 11: Facts and reasons from the ledger; coverage and stops on the recovery path

**Files:**
- Modify: `src/finish/types.ts` (`GateFact.status`, `ResolutionFacts.findings` / `stops`)
- Modify: `src/finish/resolve.ts`
- Modify: `src/finish/machine.ts` (`NOT_RUN_GATE`, `state.step`, `recoverAfterThrow`, `finalizeResult`)
- Modify: `src/finish/gates-loop.ts` (crashed gates are named `gates (runner crashed)`)
- Test: `test/unit/finish/resolve.test.ts`
- Test: `test/unit/finish/machine-invariants.test.ts`

**Interfaces:**
- Consumes: `openFindings`, `LedgerEntry`, `applyLedgerEvent` (Task 10); `Stop` (Task 8).
- Produces:
  - `GateFact.status: "green" | "red" | "not-run"`;
  - `ResolutionFacts` gains `findings: LedgerEntry[]; stops: Stop[]`;
  - `computeFacts` args gain `ledger`, `stops`;
  - `stopReason(stops: Stop[]): string | undefined`.

- [ ] **Step 1: Write the failing resolve tests.** Append to `test/unit/finish/resolve.test.ts` (import `LedgerEntry` from `@/finish/ledger`, and `draftReason`, `isClean`, `stopReason` from `@/finish/resolve`):

```ts
function baseFacts(over: Partial<ResolutionFacts> = {}): ResolutionFacts {
  return {
    findingsOpen: [], acceptance: "green", gates: [], reviewsMissing: [], unreviewedFixCommits: [],
    coverage: { spec: 1, quality: 1 }, fixRounds: 1, findings: [], stops: [], ...over,
  };
}
const entry = (title: string, state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
  id: title, finding: { severity: "LOW", title, problem: "p", fix: "f" }, state, ...(ref ? { ref } : {}),
});

describe("facts and reasons (finish A §6)", () => {
  test("counts findings by state and names the unreviewed commit", () => {
    const findings = [entry("A", "open"), ...Array.from({ length: 11 }, (_, i) => entry(`F${i}`, "fixed-unreviewed", "68e7c2189abc"))];
    expect(draftReason(baseFacts({ findings, findingsOpen: [findings[0].finding] }))).toContain("1 open; 11 fixed in unreviewed commit 68e7c21");
  });
  test("gates that never ran read 'gates not run' and still block ready", () => {
    const facts = baseFacts({ gates: [{ name: "gates", status: "not-run" }] });
    expect(draftReason(facts)).toBe("gates not run");
    expect(isClean(facts)).toBe(false);
  });
  test("set-aside findings are counted separately", () => {
    const findings = [entry("A", "set-aside", "handoff-1")];
    expect(draftReason(baseFacts({ findings, findingsOpen: [findings[0].finding] }))).toBe("1 set aside (handoff-1)");
  });
  test("stopReason: first stop plus a count", () => {
    expect(stopReason([
      { kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 13 },
      { kind: "flow", step: "gate", at: "t", limitMs: 10_800_000, handoff: 2 },
    ])).toBe("fix session stopped at the 20 min limit (13 findings, handoff-1); +1 more stop");
    expect(stopReason([{ kind: "review", lens: "quality", round: 2, at: "t", limitMs: 900_000 }])).toBe("review (quality) stopped at the 15 min limit");
    expect(stopReason([{ kind: "flow", step: "review", round: 2, at: "t", limitMs: 10_800_000 }])).toBe("finish time limit (3 h) reached during review round 2");
    expect(stopReason([{ kind: "run", step: "gate", at: "t", limitMs: 0 }])).toBe("run cancelled during gate");
    expect(stopReason([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing machine tests.** Append to `test/unit/finish/machine-invariants.test.ts`:

```ts
describe("recovery path (finish A §6)", () => {
  test("a deadline after a completed review round reports non-null coverage (#2461)", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      const h = makeMachineHarness({
        auditDir: dir,
        signal: phase.signal,
        flowMs: 10_800_000,
        context: { acceptanceStatus: "disabled" },
        script: { quality: [{ findings: [], covered: ["src/a.ts"] }], spec: [{ findings: [], covered: ["src/a.ts"] }] },
        qualityExit: () => {
          phase.abort();
          return 1;
        },
      });
      h.git.changedFiles = ["src/a.ts"];
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.outcome).toBe("draft");
      expect(result.facts?.coverage).toEqual({ spec: 1, quality: 1 });
    });
  });

  test("a deadline outside a fix session is recorded as a flow stop with its step (#2463 wording)", async () => {
    await withTempDir(async (dir) => {
      const phase = new AbortController();
      phase.abort();
      const h = makeMachineHarness({ auditDir: dir, signal: phase.signal, flowMs: 10_800_000 });
      const result = await runFinishMachine(h.state, h.deps);
      expect(result.reason).toContain("gates not run");
      expect(result.reason).toContain("finish time limit (3 h) reached during finish"); // aborted before any step began
      expect(h.state.stops).toHaveLength(1);
    });
  });
});
```

Tighten the Task 8 update of "flowMs deadline during a fix session" to `expect(result.reason?.startsWith("finish time limit (3 h) reached during review")).toBe(true);`.

- [ ] **Step 3: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/resolve.test.ts test/unit/finish/machine-invariants.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 4: Implement types and `resolve.ts`.** In `types.ts`, `GateFact.status: "green" | "red" | "not-run"`, and `ResolutionFacts` gains `findings: import("./ledger").LedgerEntry[]` and `stops: Stop[]`.

In `resolve.ts`:

```ts
import { type LedgerEntry, openFindings } from "./ledger";
import type { Stop } from "./types";

const SHORT_SHA = 7;

function duration(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`;
}

function where(s: Stop): string {
  const step = s.step ?? s.phase ?? "finish";
  return s.round !== undefined && step === "review" ? `${step} round ${s.round}` : step;
}

function describeStop(s: Stop): string {
  switch (s.kind) {
    case "review":
      return `review (${s.lens ?? "?"}) stopped at the ${duration(s.limitMs)} limit`;
    case "flow":
      return `finish time limit (${duration(s.limitMs)}) reached during ${where(s)}`;
    case "run":
      return `run cancelled during ${where(s)}`;
    case "fix": {
      const held = s.findings !== undefined ? `${s.findings} findings, ` : "";
      return `fix session stopped at the ${duration(s.limitMs)} limit (${held}handoff-${s.handoff})`;
    }
  }
}

export function stopReason(stops: Stop[]): string | undefined {
  if (stops.length === 0) return undefined;
  const rest = stops.length - 1;
  return rest > 0 ? `${describeStop(stops[0])}; +${rest} more stop${rest > 1 ? "s" : ""}` : describeStop(stops[0]);
}

function countBy(entries: LedgerEntry[], label: (ref: string, n: number) => string): string[] {
  const refs = [...new Set(entries.map((e) => e.ref ?? ""))];
  return refs.map((ref) => label(ref, entries.filter((e) => (e.ref ?? "") === ref).length));
}

function findingParts(findings: LedgerEntry[], openCount: number): string[] {
  if (findings.length === 0) return openCount > 0 ? [`${openCount} open finding(s)`] : [];
  const open = findings.filter((e) => e.state === "open" || e.state === "rejected" || e.state === "unresolved");
  return [
    ...(open.length > 0 ? [`${open.length} open`] : []),
    ...countBy(findings.filter((e) => e.state === "fixed-unreviewed"), (ref, n) => `${n} fixed in unreviewed commit ${ref.slice(0, SHORT_SHA)}`),
    ...countBy(findings.filter((e) => e.state === "set-aside"), (ref, n) => `${n} set aside (${ref})`),
  ];
}
```

The `"N open finding(s)"` fallback keeps the old wording for facts without a ledger (old fixtures).

`draftReason`:

```ts
export function draftReason(f: ResolutionFacts): string {
  const parts = [...findingParts(f.findings ?? [], f.findingsOpen.length)];
  if (!acceptanceOk(f.acceptance)) parts.push(`acceptance ${f.acceptance}`);
  if (f.gates.some((g) => g.status === "not-run")) parts.push("gates not run");
  const red = f.gates.filter((g) => g.status === "red").map((g) => g.name);
  if (red.length > 0) parts.push(`gates red: ${red.join(", ")}`);
  for (const lens of LENSES) if (f.reviewsMissing.includes(lens)) parts.push(`${lens} review missing`);
  if (f.unreviewedFixCommits.length > 0) parts.push(`${f.unreviewedFixCommits.length} unreviewed fix commit(s)`);
  return parts.join("; ");
}
```

`computeFacts` args gain `ledger: LedgerEntry[]` and `stops: Stop[]`. Its result sets `findingsOpen: openFindings(args.ledger)`, `findings: [...args.ledger]` and `stops: [...args.stops]`. Delete the old `findingsOpen` built from `lastFindings` + `unresolved`.

- [ ] **Step 5: Implement `machine.ts`.**
- `const NOT_RUN_GATE: GateFact[] = [{ name: "gates", status: "not-run", excerpt: "not run" }];`.
- `currentFacts` passes `ledger: state.review.ledger, stops: state.stops` to `computeFacts`.
- In `runFinishMachine`, set `state.step` before each phase: `"acceptance"` before `runAcceptanceLoop`, `"review"` before `runReviewLoop`, `"gate"` before `runGatesLoop`, `"resolve"` before `resolveAndFinalize`.
- Keep `let inputs: ReviewInputs | undefined;` above the `try`, assign it where `loadReviewInputs` runs, and pass it to `recoverAfterThrow(state, deps, err, inputs)`.

`recoverAfterThrow` becomes:

```ts
function recordFlowStop(state: FinishState, deps: FinishMachineDeps): void {
  if (!deps.signal?.aborted || deps.runSignal?.aborted) return;
  if (state.stops.some((s) => s.kind === "flow")) return;
  state.stops = [
    ...state.stops,
    { kind: "flow", ...(state.step ? { step: state.step } : {}), round: state.review.rounds, at: deps.now(), limitMs: deps.timeouts?.flowMs ?? 0 },
  ];
}

async function recoverAfterThrow(state: FinishState, deps: FinishMachineDeps, err: unknown, inputs?: ReviewInputs): Promise<FinishResult> {
  const message = errorMessage(err);
  if (deps.runSignal?.aborted) return failedResult(state, deps, "aborted");
  if (state.finalizing) return failedResult(state, deps, message);
  recordFlowStop(state, deps);
  const prefix = deps.signal?.aborted ? (stopReason(state.stops) ?? "deadline") : `finish error: ${message}`;
  try {
    const changed = inputs?.changed ?? (await changedFiles(state.workdir, state.base));
    if (changed.length === 0) getSafeLogger()?.warn("finish", "No changed files for coverage on the recovery path", { storyId: "_run" });
    const facts = currentFacts(state, changed);
    const detail = draftReason(facts);
    return await finalizeResult(state, deps, facts, { outcome: "draft", reason: detail ? `${prefix}; ${detail}` : prefix });
  } catch (finalizeErr) {
    return failedResult(state, deps, errorMessage(finalizeErr));
  }
}
```

Import `changedFiles` from `./changed-files`, `stopReason` from `./resolve`, and `applyLedgerEvent` from `./ledger`.

In `finalizeResult`:
- For a normal (non-throw) draft with stops, prefix the stop reason. `const stopped = stopReason(state.stops);` then `reason = stopped && !decision.reason.startsWith(stopped) ? \`${stopped}; ${decision.reason}\` : decision.reason`.
- When `acceptedResidue.length > 0`, first apply `{ kind: "accepted", findings: acceptedResidue, ref: "advisor approval" }` to `state.review.ledger`.

In `gates-loop.ts` `runGatesOrCrash`, name the crashed gate `"gates (runner crashed)"` in both `ran` and `failing`.

- [ ] **Step 6: Run.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000 && bun run typecheck && bun run check:complexity`
Expected: PASS. Update fixtures that construct `ResolutionFacts` literals by adding `findings: [], stops: []`.

- [ ] **Step 7: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "fix(finish): facts from the ledger, stop reasons, coverage and flow stops on the recovery path (#2461 #2463)"
```

---

### Task 12: Checkpoints after every step

**Files:**
- Create: `src/finish/checkpoint.ts`
- Modify: `src/finish/machine.ts`, `src/finish/index.ts`
- Test: `test/unit/finish/checkpoint.test.ts` (create)
- Test: `test/unit/finish/machine-end-to-end.test.ts`

**Interfaces:**
- Produces: `checkpointPath(audit)`, i.e. `<auditDir>/<runId>.checkpoint.json`; `writeCheckpoint(audit, state): Promise<void>` (atomic, never throws).

- [ ] **Step 1: Write the failing test.** Create `test/unit/finish/checkpoint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { makeFinishState, withTempDir } from "@test/helpers";
import { checkpointPath, deserializeFinishState, writeCheckpoint } from "@/finish";

describe("finish checkpoint (finish A §4.4)", () => {
  test("writes a version-3 state that round-trips, with no temp file left behind", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const state = makeFinishState();
      await writeCheckpoint(audit, state);
      const parsed = deserializeFinishState(await readFile(checkpointPath(audit), "utf8"));
      expect(parsed.version).toBe(3);
      expect(parsed.feature).toBe(state.feature);
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("never throws when the directory cannot be written", async () => {
    await writeCheckpoint({ auditDir: "/dev/null/nope", runId: "r" }, makeFinishState());
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
Run: `timeout 30 bun test test/unit/finish/checkpoint.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 3: Implement.** Create `src/finish/checkpoint.ts`:

```ts
/**
 * Finish A §4.4: the serialized FinishState after every completed step, for
 * `nax finish --resume` (sub-project E); nothing reads it in A. Atomic (temp file +
 * rename). Best-effort: a write failure is logged and never stops finish.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { type FinishState, serializeFinishState } from "./state";

export function checkpointPath(audit: AuditTarget): string {
  return join(audit.auditDir, `${audit.runId}.checkpoint.json`);
}

export async function writeCheckpoint(audit: AuditTarget, state: FinishState): Promise<void> {
  const target = checkpointPath(audit);
  const tmp = `${target}.tmp`;
  try {
    await mkdir(audit.auditDir, { recursive: true });
    await writeFile(tmp, serializeFinishState(state), "utf8");
    await rename(tmp, target);
  } catch (err) {
    getSafeLogger()?.warn("finish", "Finish checkpoint could not be written", { storyId: "_run", error: errorMessage(err) });
  }
}
```

Export both from `src/finish/index.ts`.

In `machine.ts`, call `await writeCheckpoint(deps.audit, state);`:
- after each `runAcceptanceLoop` call;
- after `runReviewLoop`;
- after `runGatesLoop`;
- in `finalizeResult` after `state.status = out.status`;
- in `recoverAfterThrow` before `finalizeResult`.

- [ ] **Step 4: Add the machine check.** In one passing case of `test/unit/finish/machine-end-to-end.test.ts`, add `expect(existsSync(join(<that case's audit dir>, "run-1.checkpoint.json"))).toBe(true);`. Import `existsSync` from `node:fs` and `join` from `node:path`.

- [ ] **Step 5: Run.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): atomic state checkpoint after every completed step"
```

---

### Task 13: PR body, `result.json`, finalize

**Files:**
- Modify: `src/finish/pr/context.ts` (`fromResolution` takes `state`; `unresolved` gains `ledger`, `stops`, `handoffs`)
- Modify: `src/finish/pr/body.ts`
- Modify: `src/finish/types.ts` (`FinishResult.handoffs`)
- Modify: `src/finish/machine.ts` (`result.handoffs`)
- Modify: `src/finish/commit.ts` (export `isDirty`)
- Modify: `src/finish/ops-impl.ts` (`finalizeDraftPr`, `fallbackBody`)
- Test: `test/unit/finish/pr-body.test.ts`
- Test: `test/unit/finish/pr-context.test.ts`
- Test: `test/unit/finish/ops-impl-a4.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry`, `LedgerState` (Task 10); `Stop`, `HandoffRecord`, `stopReason` (Tasks 7, 8, 11).
- Produces:
  - `FinishPrContext.unresolved` gains `ledger: LedgerEntry[]; stops: Stop[]; handoffs: HandoffRecord[]`;
  - `FinishResult.handoffs?: { dir: string; limit: HandoffLimit; findingIds: string[]; consumed: boolean; reapplied?: boolean }[]`;
  - `export async function isDirty(repoRoot: string): Promise<boolean>` (`commit.ts`).

- [ ] **Step 1: Write the failing body tests.** Append to `test/unit/finish/pr-body.test.ts`. It uses that file's own context builder; if the file has none, build `FinishPrContext` through `loadFinishPrContext` as its other cases do:

```ts
describe("findings table, Set aside and Stops (finish A §7)", () => {
  const unresolvedBase = { reason: "r", findings: [], acceptance: "green" as const, gates: [], missing: [], unreviewed: [], accepted: [], ledger: [], stops: [], handoffs: [] };
  const e = (title: string, severity: Finding["severity"], state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: title, finding: { severity, title, problem: "p", fix: "f", file: "src/x|y.ts" }, state, ...(ref ? { ref } : {}),
  });

  test("one table sorted by state then severity; resolved rows collapsed", () => {
    const body = buildFinishBody(makeCtx({ unresolved: { ...unresolvedBase, ledger: [
      e("fixed one", "HIGH", "fixed-unreviewed", "68e7c2189abc"),
      e("open low", "LOW", "open"),
      e("open high", "HIGH", "open"),
      e("waived one", "MEDIUM", "waived", "D-2"),
    ] } }));
    const table = body.slice(body.indexOf("| Severity |"));
    expect(table.indexOf("open high")).toBeLessThan(table.indexOf("open low"));
    expect(table.indexOf("open low")).toBeLessThan(table.indexOf("fixed one"));
    expect(body).toContain("`68e7c21`");
    expect(body).toContain("src/x\\|y.ts");
    expect(body).toMatch(/<details>[\s\S]*waived one[\s\S]*D-2[\s\S]*<\/details>/);
  });

  test("lists set-aside handoffs and stops", () => {
    const body = buildFinishBody(makeCtx({ unresolved: { ...unresolvedBase,
      stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
      handoffs: [{ n: 1, dir: "/o/finish-audit/feat/run-1.handoff-1", phase: "review", limit: "fix", baseSha: "s", headSha: "s",
        findingIds: ["a", "b", "c"], newUntracked: [], changedPaths: [], stoppedAt: "t", hasNote: true, patchSaved: true,
        restored: true, consumed: false, reapplied: false }],
    } }));
    expect(body).toContain("### Set aside");
    expect(body).toContain("run-1.handoff-1/changes.patch");
    expect(body).toContain("not re-applied");
    expect(body).toContain("### Stops");
    expect(body).toContain("fix session stopped at the 20 min limit (3 findings, handoff-1)");
  });

  test("a not-run gate renders as 'Gates did not run', never as a red gate named gates", () => {
    const body = buildFinishBody(makeCtx({ unresolved: { ...unresolvedBase, gates: [{ name: "gates", status: "not-run" }] } }));
    expect(body).toContain("Gates did not run");
    expect(body).not.toContain("Gate `gates` is red");
  });
});
```

- [ ] **Step 2: Write the failing finalize tests.** Append to `test/unit/finish/ops-impl-a4.test.ts` (import `withTempDir` and `assertDefined` from `@test/helpers` if missing):

```ts
describe("finalizeDraftPr after a stop (finish A §4.5)", () => {
  function stubDirtyGit(calls: string[][], dirty: { value: boolean }): void {
    _finishGitDeps.git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return { exitCode: 0, stdout: dirty.value ? " M a.ts\n?? new.ts\n" : "", stderr: "" };
      if (args[0] === "restore") dirty.value = false;
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "sha1\n", stderr: "" };
      if (args[0] === "diff" && args.includes("--name-only")) return { exitCode: 0, stdout: dirty.value ? "a.ts\n" : "", stderr: "" };
      if (args[0] === "diff" && args.includes("--cached")) return { exitCode: dirty.value ? 1 : 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  test("a restore-failed set-aside: the remaining dirt is set aside with the recorded untrackedBefore, not committed", async () => {
    await withTempDir(async (dir) => {
      const { deps } = baseDeps();
      const calls: string[][] = [];
      stubDirtyGit(calls, { value: true });
      const removed: string[] = [];
      const { _setAsideDeps } = await import("@/finish");
      const originalRemove = _setAsideDeps.remove;
      _setAsideDeps.remove = async (p) => void removed.push(p);
      try {
        const state = {
          ...freshState(),
          stops: [{ kind: "flow" as const, step: "review" as const, at: "t", limitMs: 1 }],
          handoffs: [{ n: 1, dir: `${dir}/h1`, phase: "review" as const, limit: "flow" as const, baseSha: "sha1", headSha: "sha1",
            findingIds: [], newUntracked: [], changedPaths: ["a.ts"], stoppedAt: "t", hasNote: false, patchSaved: true,
            restored: false, consumed: false }],
          lastFixBase: { baseSha: "sha1", headSha: "sha1", untrackedBefore: ["new.ts"] },
        };
        const out = await createFinishOps({ ...deps, forgeKind: null, audit: { auditDir: dir, runId: "run-1" } }).finalizeDraftPr(state);
        expect(out.status).toBe("local-only");
        expect(calls.some((a) => a[0] === "commit")).toBe(false);
        expect(state.handoffs).toHaveLength(2);
        expect(removed).toEqual([]); // new.ts existed before the session: never deleted
      } finally {
        _setAsideDeps.remove = originalRemove;
      }
    });
  });

  test("without a failed restore, a dirty tree is committed as before", async () => {
    const { deps } = baseDeps();
    const calls: string[][] = [];
    stubDirtyGit(calls, { value: true });
    const state = { ...freshState(), stops: [{ kind: "fix" as const, phase: "review" as const, at: "t", limitMs: 1, handoff: 1 }] };
    await createFinishOps({ ...deps, forgeKind: null }).finalizeDraftPr(state);
    expect(calls.some((a) => a[0] === "commit")).toBe(true);
  });
});
```

`baseDeps()` overwrites `_finishGitDeps.git` itself, so call `stubDirtyGit` after it, as shown. The file's `afterEach` restores `_finishGitDeps.git`.

- [ ] **Step 3: Run them to verify they fail.**
Run: `timeout 30 bun test test/unit/finish/pr-body.test.ts test/unit/finish/ops-impl-a4.test.ts --timeout=5000`
Expected: FAIL.

- [ ] **Step 4: Implement the context.** In `pr/context.ts`, change `fromResolution(resolution)` to `fromResolution(state: FinishState)` (read `state.resolution` inside) and update its one caller. Add to `unresolved`:

```ts
            ledger: facts.findings ?? [],
            stops: state.stops ?? [],
            handoffs: state.handoffs ?? [],
```

Change `needsBlock` to `outcome === "draft" || acceptedResidue.length > 0 || (state.stops ?? []).length > 0`. Add the three fields to the `unresolved` type in `FinishPrContext`.

- [ ] **Step 5: Implement the body.** In `pr/body.ts` (`SEVERITY_ORDER`, `SHORT_SHA_LEN` and `escapeTableCell` already exist; import `LedgerEntry` and `LedgerState` from `../ledger`, `HandoffRecord` from `../types`, `stopReason` from `../resolve`):

```ts
const STATE_ORDER: Record<LedgerState, number> = {
  open: 0, rejected: 1, "set-aside": 2, unresolved: 3, "fixed-unreviewed": 4,
  accepted: 5, "fixed-reviewed": 6, waived: 7, superseded: 8,
};
const RESOLVED: ReadonlySet<LedgerState> = new Set(["fixed-reviewed", "waived", "superseded"]);
const TABLE_HEAD = "| Severity | Finding | File | State | Ref |\n|---|---|---|---|---|";

function refCell(e: LedgerEntry): string {
  if (!e.ref) return "";
  const isSha = e.state === "fixed-unreviewed" || e.state === "fixed-reviewed";
  return isSha ? `\`${e.ref.slice(0, SHORT_SHA_LEN)}\`` : escapeTableCell(e.ref);
}

function ledgerRow(e: LedgerEntry): string {
  const loc = e.finding.file ? `${e.finding.file}${e.finding.line !== undefined ? `:${e.finding.line}` : ""}` : "";
  return `| ${e.finding.severity} | ${escapeTableCell(e.finding.title)} | ${escapeTableCell(loc)} | ${e.state} | ${refCell(e)} |`;
}

function sortLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity],
  );
}

function buildFindingsTable(ledger: LedgerEntry[]): string | null {
  if (ledger.length === 0) return null;
  const live = sortLedger(ledger.filter((e) => !RESOLVED.has(e.state)));
  const done = sortLedger(ledger.filter((e) => RESOLVED.has(e.state)));
  const table = live.length > 0 ? `${TABLE_HEAD}\n${live.map(ledgerRow).join("\n")}` : "";
  const folded = done.length > 0 ? `<details><summary>${done.length} resolved</summary>\n\n${TABLE_HEAD}\n${done.map(ledgerRow).join("\n")}\n\n</details>` : "";
  return [table, folded].filter(Boolean).join("\n\n");
}

function renderHandoff(h: HandoffRecord): string {
  const where = h.patchSaved ? `\`${h.dir}/changes.patch\`` : "_patch not saved, work lost_";
  const state = h.consumed ? "re-applied and committed" : h.reapplied === false ? "not re-applied" : h.limit === "error" ? "crashed, not re-applied" : "pending";
  return `- handoff-${h.n} (${h.phase}, ${h.limit}, ${h.findingIds.length} finding(s)): ${where} — ${state}`;
}
```

If `escapeTableCell` does not escape `|`, the test expecting `src/x\|y.ts` fails. Read it first and extend it to escape `|` if needed.

In `buildUnresolvedSection`:
- `const table = buildFindingsTable(u.ledger);`. Use `...(table ? [\`### Findings\n${table}\`] : block("Open findings", bySeverity(u.findings).map(renderOpenFinding)))` in place of the old "Open findings" block, so pre-v3 results keep the old list.
- In `checks`, add `...(u.gates.some((g) => g.status === "not-run") ? ["- Gates did not run"] : [])`.
- After "Unreviewed fix commits", add `...block("Set aside", u.handoffs.map(renderHandoff))` and `...block("Stops", u.stops.map((s) => \`- ${stopReason([s])}\`))`.

If `buildUnresolvedSection` exceeds the complexity limit, move the three new blocks into `buildStopSections(u): string[]`.

- [ ] **Step 6: Implement `result.json` and finalize.** In `types.ts`, add the `handoffs?` field (shape above) to `FinishResult`. In `machine.ts` `finalizeResult`, add:

```ts
    ...(state.handoffs.length > 0
      ? { handoffs: state.handoffs.map((h) => ({ dir: h.dir, limit: h.limit, findingIds: h.findingIds, consumed: h.consumed, ...(h.reapplied !== undefined ? { reapplied: h.reapplied } : {}) })) }
      : {}),
```

In `commit.ts`, change `async function isDirty` to `export async function isDirty`, and export it from `src/finish/index.ts` if other modules import it through the barrel.

In `ops-impl.ts` `finalizeDraftPr`, before `commitAndPush`:

```ts
      // Finish A §4.5: only when a set-aside's restore failed is remaining dirt set aside
      // instead of committed, with the base and untrackedBefore of that fix session.
      const failedRestore = state.handoffs.some((h) => !h.restored);
      if (failedRestore && state.lastFixBase && (await isDirty(state.workdir))) {
        const record = await setAside({
          workdir: state.workdir,
          audit,
          n: state.handoffs.length + 1,
          base: state.lastFixBase,
          phase: "review",
          limit: "flow",
          findingIds: [],
          now: () => new Date().toISOString(),
        });
        state.handoffs = [...state.handoffs, record];
      }
```

Import `isDirty` from `./commit` and `setAside` from `./set-aside`.

`fallbackBody` adds the stop reason and the handoff dirs:

```ts
  const stopped = stopReason(state.stops ?? []);
  if (stopped) lines.push(`Stopped: ${stopped}`);
  for (const h of state.handoffs ?? []) lines.push(`- Set aside: ${h.dir}`);
```

Put these lines after the `Reason:` line.

- [ ] **Step 7: Run.**
Run: `timeout 60 bun test test/unit/finish/ --timeout=5000 && bun run typecheck && bun run check:complexity`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/finish test/unit/finish
git commit -m "feat(finish): findings table, Set aside and Stops in the PR; handoffs in result.json; safe finalize (#2469)"
```

---

### Task 14: Outcome regression, full gates, notes

**Files:**
- Test: `test/unit/finish/resolve.test.ts`
- Modify: `../../docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md` (append "Implementation notes")

- [ ] **Step 1: Write the unchanged-outcomes regression.** Append to `test/unit/finish/resolve.test.ts`, reusing `baseFacts` from Task 11 and importing `OPEN_STATES` alongside `LedgerEntry` from `@/finish/ledger`, plus `resolve` from `@/finish/resolve`:

```ts
describe("unchanged ready/draft rules on ledger-derived facts (finish A §2)", () => {
  const one = (state: LedgerEntry["state"]): LedgerEntry => ({ id: "x", finding: { severity: "LOW", title: "x", problem: "p", fix: "f" }, state });
  const facts = (findings: LedgerEntry[], over: Partial<ResolutionFacts> = {}) =>
    baseFacts({ findings, findingsOpen: findings.filter((e) => OPEN_STATES.has(e.state)).map((e) => e.finding), ...over });

  test.each([
    ["clean", facts([]), true],
    ["fixed-reviewed only", facts([one("fixed-reviewed")]), true],
    ["waived only", facts([one("waived")]), true],
    ["one open", facts([one("open")]), false],
    ["set-aside", facts([one("set-aside")]), false],
    ["fixed-unreviewed with its commit", facts([one("fixed-unreviewed")], { unreviewedFixCommits: ["s"] }), false],
    ["acceptance red", facts([], { acceptance: "red" }), false],
    ["gate not run", facts([], { gates: [{ name: "gates", status: "not-run" }] }), false],
    ["lens missing", facts([], { reviewsMissing: ["spec"] }), false],
  ] as const)("%s -> clean=%s", (_name, f, clean) => {
    expect(isClean(f)).toBe(clean);
  });

  test("advisor off: not clean -> draft; clean -> ready", async () => {
    expect((await resolve({ facts: facts([one("open")]), reReviewUsed: false })).outcome).toBe("draft");
    expect((await resolve({ facts: facts([]), reReviewUsed: false })).outcome).toBe("ready");
  });
});
```

- [ ] **Step 2: Run it.**
Run: `timeout 30 bun test test/unit/finish/resolve.test.ts --timeout=5000`
Expected: PASS (it pins existing behaviour).

- [ ] **Step 3: Full gates.** From `packages/nax`, run `bun run test && bun run check:all && bun run typecheck && bun run test:coverage`. From the repo root, run `bun run check:all`.
Expected: all green.
- If `test:coverage` fails on a new file, add focused cases to its test until it meets the floor. Never lower a baseline.
- If a ratchet fails on a count that grew, fix the site, never `--update-baseline`. The one exception is `manager.ts`'s size, lowered in Task 2.

- [ ] **Step 4: Record implementation notes.** Append to the spec a short "Implementation notes" section:
- The handoff note travels as the fix op's marked reply (`HANDOFF_MARKER`), not as a side file.
- `fail-stale` gains the reason `interrupted`.
- `manager.ts` shrank: the stale classification moved into `staleTurnFailure`.
- A crashed fixer is set aside as `limit: "error"`.
- The 30-second latency is pinned per layer:
  - run options carry the signal (Task 1);
  - `interruptTurn` ends a turn through the real `SessionManager` (Task 2);
  - native turns honour `opts.signal` and the registered cancel (nax-agent's existing US-002 and nax#2218 tests).
  - End to end, only the live check proves it.

Commit:

```bash
git add test/unit/finish/resolve.test.ts ../../docs/superpowers/specs/2026-10-12-finish-a-honest-stop-and-reporting-design.md
git commit -m "test(finish): pin unchanged ready/draft rules on ledger facts; spec implementation notes"
```

- [ ] **Step 5: Live check. Needs approval; do not launch.** Tell the user the spec §11 live check is still owed. It is a real `nax run` with finish on, from the local build `repos/nax-run` fast-forwarded to this branch, with a temporarily low `finish.timeouts.fixMs` (e.g. `120000`). Check that:
- the stopped turn ends within 30 s;
- a handoff turn follows in the same session (the tool-audit or prompt-audit shows the handoff prompt);
- no commit lands from the stopped session;
- `finish-audit/<feature>/<runId>.handoff-1/` holds `changes.patch`, `meta.json` and `note.json`;
- `<runId>.checkpoint.json` exists;
- the draft PR's reason, findings table, Set aside and Stops match `result.json`.

`nax run` is billed and needs explicit approval at launch.
