# Review Fixes Bundle C — Process and Abort Hygiene

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** Timed-out hooks take their children with them, the hardening pass can never wedge on a daemon's pipe, a provider that throws synchronously cannot crash the run 5 s later, and a coding tool that ignores its signal cannot hang a cancelled turn.

**Architecture:** Four independent tasks. Tasks 1, 2 and 3 are in `packages/nax`; Task 4 is in `packages/nax-agent`. Each applies the pattern a sibling already uses (detached spawn for group kill; a bounded post-exit drain; an abort race), so no new design.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #11, #14, #22, #29. (#18, also in this area, is closed as not a defect — see the master plan.)

**Branch:** `git fetch origin && git checkout -b fix/review-c-process-abort origin/main`

## Global Constraints

See the master plan. Bundle-specific: `packages/nax/test/unit/acceptance/hardening.test.ts` is 767 lines and `packages/nax/test/unit/context/engine/orchestrator.test.ts` is 749 (more after bundle A), so Tasks 2 and 3 put their tests in new concern-split files.

## Files

- Modify: `packages/nax/src/hooks/runner.ts:224-231` (Task 1)
- Test: `packages/nax/test/integration/hooks/runner-timeout.test.ts` (new; spawns real processes)
- Create: `packages/nax/src/utils/drain-within.ts` (Task 2)
- Modify: `packages/nax/src/acceptance/hardening.ts:53-61, 211-217` (Task 2)
- Test: `packages/nax/test/unit/utils/drain-within.test.ts` (new, mirrors src)
- Test: `packages/nax/test/unit/acceptance/hardening-drain.test.ts` (new concern split)
- Modify: `packages/nax/src/context/engine/orchestrator.ts:128` (Task 3)
- Test: `packages/nax/test/unit/context/engine/orchestrator-fetch-timeout.test.ts` (new concern split)
- Modify: `packages/nax-agent/src/session/session-interaction.ts:96-118, 157-172` (Task 4)
- Test: `packages/nax-agent/test/unit/session/session-interaction.test.ts` (314 lines)

---

### Task 1: A timed-out hook is killed as a process group (#11)

`Bun.spawn` without `detached: true` leaves the hook in nax's own process group, so `killProcessGroup(proc.pid, …)` cannot reach the group and only the direct child dies; anything the hook started keeps running for the rest of the run. Every sibling kill site passes `detached: true` (`quality/runner.ts:169`, `acceptance/hardening.ts:190`).

**Files:**
- Modify: `packages/nax/src/hooks/runner.ts`
- Test: `packages/nax/test/integration/hooks/runner-timeout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/nax/test/integration/hooks/runner-timeout.test.ts`:

```ts
/**
 * A hook that exceeds its timeout is killed together with everything it spawned.
 * Real processes: the defect only shows when a real child outlives the hook.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { fireHook, type LoadedHooksConfig } from "@/hooks/runner";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("fireHook — timeout kills the hook's process group", () => {
  let dir = "";
  const strays: number[] = [];

  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone: the case this test expects.
      }
    }
    cleanupTempDir(dir);
  });

  test("a background child started by the hook does not outlive the timeout", async () => {
    dir = makeTempDir();
    const pidFile = join(dir, "child.pid");
    const script = join(dir, "hook.sh");
    await Bun.write(script, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);
    // A global hook needs no project trust (runner-validation.test.ts AC11).
    const config: LoadedHooksConfig = {
      hooks: {},
      _global: { hooks: { "on-start": { command: `sh '${script}'`, timeout: 300 } } },
    };

    await fireHook(config, "on-start", { event: "on-start", feature: "timeout-test" }, dir);

    const childPid = Number((await Bun.file(pidFile).text()).trim());
    strays.push(childPid);
    const deadline = Date.now() + 2_000;
    while (isAlive(childPid) && Date.now() < deadline) await Bun.sleep(50);
    expect(isAlive(childPid)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `timeout 60 bun test test/integration/hooks/runner-timeout.test.ts --timeout=15000`
Expected: FAIL — the `sleep 30` child is still alive after 2 s.

- [ ] **Step 3: Implement**

In `runner.ts`, add `detached: true` to the spawn options with the same comment shape the siblings use:

```ts
  // nax-git-env-allow: not git: hook argv (hooks.*.command)
  // detached: the hook leads its own process group, so the timeout's
  // killProcessGroup(-pid) reaches every process it started (quality/runner.ts does the same).
  const proc = Bun.spawn(argv, {
    cwd: workdir,
    stdin: new Response(contextJson),
    stdout: "pipe",
    stderr: "pipe",
    env: buildAllowedEnv({ env }),
    detached: true,
  });
```

Keep the existing `// nax-git-env-allow` line directly above `const proc` if `check:git-spawn-env` requires adjacency (run the gate; if it complains, put the new comment lines ABOVE the allow line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/integration/hooks/ test/unit/hooks/ --timeout=15000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/hooks/runner.ts packages/nax/test/integration/hooks/runner-timeout.test.ts
git commit -m "fix(hooks): spawn hooks detached so a timeout kills the whole group (review #11)"
```

---

### Task 2: The hardening pass bounds its post-exit drain (#29)

The SIGTERM→SIGKILL escalation bounds `proc.exited`, but the two `new Response(proc.std*).text()` drains are awaited inside the same `Promise.all` with no deadline. A daemon that escaped the group and still holds stdout keeps the pipe open forever, so the completion phase hangs. Fix: await the exit, then give each drain a fixed deadline (the same 2 s the quality runner uses).

**Files:**
- Create: `packages/nax/src/utils/drain-within.ts`
- Modify: `packages/nax/src/acceptance/hardening.ts`
- Test: `packages/nax/test/unit/utils/drain-within.test.ts`
- Test: `packages/nax/test/unit/acceptance/hardening-drain.test.ts`

**Interfaces:**
- Produces: `export async function drainWithin(drain: Promise<string>, deadlineMs: number): Promise<string>` — resolves with the drained text, or `""` when the deadline passes first; never leaves a timer armed.
- `_hardeningDeps` gains `drainTimeoutMs: number` (default `2_000`).

- [ ] **Step 1: Write the failing tests**

Create `packages/nax/test/unit/utils/drain-within.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { drainWithin } from "@/utils/drain-within";

describe("drainWithin", () => {
  test("returns the drained text when it settles in time", async () => {
    expect(await drainWithin(Promise.resolve("output"), 1_000)).toBe("output");
  });

  test("gives up with an empty string when the drain never settles", async () => {
    expect(await drainWithin(new Promise<string>(() => {}), 20)).toBe("");
  });
});
```

Create `packages/nax/test/unit/acceptance/hardening-drain.test.ts`:

```ts
/**
 * The hardening pass must finish even when a process the acceptance command
 * started escapes the group and keeps the output pipe open.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeSpawn,
  makeStory,
} from "@test/helpers";
import { _hardeningDeps, type HardeningContext, runHardeningPass } from "@/acceptance/hardening";

const CONFIG = makeNaxConfig({
  agent: { default: "claude" },
  acceptance: { model: "fast", hardening: { enabled: true } },
});

let saved: typeof _hardeningDeps;
beforeEach(() => {
  saved = { ..._hardeningDeps };
  _hardeningDeps.detectLanguage = mock(async () => undefined);
  _hardeningDeps.writeFile = mock(async () => {});
  _hardeningDeps.savePRD = mock(async () => {});
  _hardeningDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "acceptance-refine") {
      return [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }];
    }
    return { testCode: 'test("AC-1", () => {})' };
  }) as typeof _hardeningDeps.callOp;
});
afterEach(() => {
  Object.assign(_hardeningDeps, saved);
});

describe("runHardeningPass — post-exit drain", () => {
  test("settles when the runner has exited but an orphan still holds stdout open", async () => {
    _hardeningDeps.drainTimeoutMs = 20;
    // exitCode 0 with a stdout that never closes: the escaped daemon still has the write end.
    // `stdoutStall` (test-kit FakeProcSpec) gives that stream without a cast.
    _hardeningDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdoutStall: true })).spawn;
    const story = makeStory({ suggestedCriteria: ["edge case"], status: "passed", passes: true, attempts: 1 });
    const ctx: HardeningContext = {
      prd: makePRD({ userStories: [story] }),
      prdPath: "/tmp/prd.json",
      featureDir: "/tmp/features/test",
      workdir: "/tmp/workdir",
      config: CONFIG,
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      runtime: makeMockRuntime({ agentManager: makeMockAgentManager(), config: CONFIG }),
      abortSignal: new AbortController().signal,
    };

    // Before the fix this hangs past the 5 s per-test timeout. After it, exit 0 with no
    // failing AC is a pass, so the suggested criterion is promoted (same path as the
    // "promotes passing suggested criteria" test in hardening.test.ts).
    const result = await runHardeningPass(ctx);
    expect(result.promoted).toEqual(["edge case"]);
  });
});
```

(The `as typeof _hardeningDeps.callOp` cast copies `hardening.test.ts:113`'s `mockCallOp` exactly. If `check:test-escape-hatches` reports a `looseCast` increase for this new file, move the callOp stub into a helper typed with the deps' function type instead of casting.)

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax`): `timeout 30 bun test test/unit/utils/drain-within.test.ts test/unit/acceptance/hardening-drain.test.ts --timeout=5000`
Expected: `drain-within` FAILS (module missing); `hardening-drain` FAILS by hitting the 5 s per-test timeout (the drain never settles).

- [ ] **Step 3: Implement**

Create `packages/nax/src/utils/drain-within.ts`:

```ts
/**
 * A stream drain with a deadline.
 *
 * After a process exits, a descendant that escaped its process group can still
 * hold the pipe's write end, so `new Response(stream).text()` may never settle.
 * Callers that already know the process is gone give the drain a fixed window,
 * then move on with nothing rather than wedging (quality/runner.ts and
 * hooks/runner.ts bound their post-kill drains the same way).
 */
export async function drainWithin(drain: Promise<string>, deadlineMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), deadlineMs);
  });
  try {
    return await Promise.race([drain, expired]);
  } finally {
    clearTimeout(timer);
  }
}
```

In `hardening.ts`:

1. Add `drainTimeoutMs: 2_000,` to `_hardeningDeps` (with a one-line comment: "Post-exit window for the output drains (#29); tests shrink it.").
2. Add `import { drainWithin } from "../utils/drain-within";` next to the existing `../utils/path-frame` import (this file uses relative imports).
3. Replace:

```ts
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
```

with:

```ts
  // Drain concurrently with the exit wait (a full pipe would block the runner), but bound the
  // drain once it HAS exited: an escaped daemon can hold the pipe open forever (#29).
  const stdoutDrain = new Response(proc.stdout).text().catch(() => "");
  const stderrDrain = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    drainWithin(stdoutDrain, _hardeningDeps.drainTimeoutMs),
    drainWithin(stderrDrain, _hardeningDeps.drainTimeoutMs),
  ]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/utils/drain-within.test.ts test/unit/acceptance/ --timeout=5000`
Expected: PASS, including every existing `hardening.test.ts` case (their streams close immediately).

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/utils/drain-within.ts packages/nax/src/acceptance/hardening.ts packages/nax/test/unit/utils/drain-within.test.ts packages/nax/test/unit/acceptance/hardening-drain.test.ts
git commit -m "fix(acceptance): bound the hardening runner's post-exit drain (review #29)"
```

---

### Task 3: A synchronously-throwing provider cannot leak the timeout (#22)

`provider.fetch(...)` is called before the `try`, so a synchronous throw skips `finally { clearTimeout(handle) }`; the armed timer later rejects a promise nobody awaits — an unhandled rejection that can kill the process. Wrap the call so a sync throw becomes a rejection inside the race.

**Files:**
- Modify: `packages/nax/src/context/engine/orchestrator.ts:128`
- Test: `packages/nax/test/unit/context/engine/orchestrator-fetch-timeout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/nax/test/unit/context/engine/orchestrator-fetch-timeout.test.ts` (copy the `import type { ... }` line for `ContextRequest` and `IContextProvider` from the top of `orchestrator.test.ts` so the type import path matches):

```ts
import { describe, expect, test } from "bun:test";
import { fetchWithTimeout } from "@/context/engine/orchestrator";
import type { ContextRequest, IContextProvider } from "@/context/engine/types";

const REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 1_000,
};

describe("fetchWithTimeout", () => {
  test("a provider whose fetch throws synchronously rejects cleanly and arms no stray timer", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const provider: IContextProvider = {
        id: "sync-thrower",
        kind: "feature",
        fetch: () => {
          throw new Error("boom before any await");
        },
      };
      await expect(fetchWithTimeout(provider, REQUEST, 20)).rejects.toThrow("boom before any await");
      await Bun.sleep(80); // well past the 20 ms deadline
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 30 bun test test/unit/context/engine/orchestrator-fetch-timeout.test.ts --timeout=5000`
Expected: FAIL — `unhandled` holds `Error: Provider "sync-thrower" timed out` (or bun reports the unhandled rejection as a test error).

- [ ] **Step 3: Implement**

In `fetchWithTimeout`, change:

```ts
  const fetchPromise = provider.fetch(request, controller.signal).then(
```

to:

```ts
  // The async wrapper turns a SYNCHRONOUS throw from a plugin provider into a rejection that
  // reaches the race below, so the finally always clears the timer (#22).
  const fetchPromise = (async () => provider.fetch(request, controller.signal))().then(
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/context/engine/ --timeout=5000`
Expected: PASS (the `NeutralityLintError` escalation tests still pass: a rejection carries the same error object).

- [ ] **Step 5: Commit**

```bash
git add packages/nax/src/context/engine/orchestrator.ts packages/nax/test/unit/context/engine/orchestrator-fetch-timeout.test.ts
git commit -m "fix(context): a provider's synchronous throw no longer leaks the fetch timer (review #22)"
```

---

### Task 4: A coding tool that ignores its signal is abandoned when the turn aborts (#14)

Embedder tools are raced against the turn signal (`invoke`, `session-interaction.ts:102-118`) because the tool batch has no abort race of its own; coding tools registered through `registerCodingTool` are awaited bare, so one that ignores `ToolCallContext.signal` hangs the turn and `session.close()`. Extract the race and use it for both.

**Files:**
- Modify: `packages/nax-agent/src/session/session-interaction.ts`
- Test: `packages/nax-agent/test/unit/session/session-interaction.test.ts`

**Interfaces:**
- New module-private helper `raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T>`.

- [ ] **Step 1: Write the failing test**

Append next to the existing test `"a run that ignores its signal is abandoned when the turn aborts"`:

```ts
  test("a built-in tool that ignores its signal is abandoned when the turn aborts", async () => {
    const h = harness({ kind: "ok", content: "" });
    const deps: SessionInteractionDeps = {
      ...h.deps,
      runtime: { advertised: () => [], callTool: () => new Promise(() => {}) },
    };
    const controller = new AbortController();
    const pending = createSessionInteractionHandler(deps).onInteraction({
      ...codingTool("Read"),
      signal: controller.signal,
    });
    controller.abort();
    expect((await thrown(pending)).message).toContain("abandoned");
    expect(h.slot.callId).toBeUndefined();
  });
```

(If `CodingToolRuntime` has more required members than `advertised` and `callTool`, spread `h.deps.runtime` first: `runtime: { ...h.deps.runtime, callTool: () => new Promise(() => {}) }`.)

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/session/session-interaction.test.ts --timeout=5000`
Expected: FAIL — the test hits the 5 s timeout (the call never settles).

- [ ] **Step 3: Implement**

In `session-interaction.ts`, add above `invoke`:

```ts
/**
 * Settle with `work`, or with `onAbort()` the moment `signal` aborts. The tool
 * batch awaits interaction handlers with no abort race of its own, so a tool
 * that ignores its signal would otherwise hang the turn (and `close()`, which
 * awaits the turn). The abandoned work's late settlement is ignored.
 */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  let listener = (): void => {};
  const aborted = new Promise<T>((resolve) => {
    listener = () => resolve(onAbort());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
```

Rewrite `invoke` on top of it (behaviour unchanged):

```ts
async function invoke(tool: EmbedderTool, input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
  const abandoned: EmbedderToolResult = {
    content: `Tool "${tool.name}" was abandoned: the turn ended.`,
    isError: true,
  };
  if (ctx.signal.aborted) return abandoned;
  return raceAbort(runSafely(tool, input, ctx), ctx.signal, () => abandoned);
}
```

and keep its existing doc comment, shortened to point at `raceAbort`.

In `runCodingTool`, change:

```ts
    const outcome = await deps.runtime.callTool(request.name, request.input ?? {}, toolCallContext(request));
```

to:

```ts
    const signal = request.signal ?? deps.turnSignal();
    const abandoned: CodingToolOutcome = {
      kind: "error",
      content: `Tool "${request.name}" was abandoned: the turn ended.`,
    };
    const outcome = signal.aborted
      ? abandoned
      : await raceAbort(
          deps.runtime.callTool(request.name, request.input ?? {}, toolCallContext(request)),
          signal,
          () => abandoned,
        );
```

Add `CodingToolOutcome` to the existing type import on line 16: `import type { CodingToolOutcome, CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";`. The existing `if (outcome.kind === "error") throw toolError(outcome.content, request.name);` then reports the abandonment exactly as the embedder path does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 60 bun test test/unit/session/ --timeout=5000`
Expected: PASS. `wc -l src/session/session-interaction.ts` stays far below 600.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/session/session-interaction.ts packages/nax-agent/test/unit/session/session-interaction.test.ts
git commit -m "fix(session): race coding tools against the turn signal like embedder tools (review #14)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `hooks,acceptance,context,session`, running the gates for both nax and nax-agent.
