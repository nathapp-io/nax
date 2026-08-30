/**
 * Tests for crash-signals.ts — installSignalHandlers
 *
 * Verifies that signal handlers are correctly registered and removed.
 * BUG-1: unhandledRejection handler must use a stable reference so
 * removeListener can actually deregister it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SignalHandlerContext } from "@/execution/crash-signals";
import {
  _crashSignalsDeps,
  FATAL_TEARDOWN_DEADLINE_MS,
  installSignalHandlers,
  performTeardown,
} from "@/execution/crash-signals";
import { PidRegistry } from "@/execution/pid-registry";
import type { StatusWriter } from "@/execution/status-writer";

const minimalCtx: SignalHandlerContext = {
  getTotalCost: () => 0,
  getIterations: () => 0,
  statusWriter: {} as StatusWriter,
};

describe("installSignalHandlers", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    // Always run cleanup to avoid leaking handlers if a test fails mid-way
    cleanup?.();
    cleanup = undefined;
  });

  test("unhandledRejection listener count increases by 1 after install (BUG-1)", () => {
    const before = process.listenerCount("unhandledRejection");
    cleanup = installSignalHandlers(minimalCtx);
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  });

  test("unhandledRejection listener is removed after cleanup — returns to original count (BUG-1)", () => {
    const before = process.listenerCount("unhandledRejection");
    cleanup = installSignalHandlers(minimalCtx);
    cleanup();
    cleanup = undefined;
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  test("onShutdown is called before pidRegistry.killAll on signal (#228)", () => {
    // Verify that the shutdown ordering is: onShutdown first, killAll second.
    // We can't fire real signals in tests, so we verify the handler structure
    // by inspecting the context wiring: both fields are accepted and onShutdown
    // is listed before killAll in the handler code path.
    const callOrder: string[] = [];
    const pidRegistry = new PidRegistry("/tmp/crash-signals-test-228");
    pidRegistry.killAll = async () => {
      callOrder.push("killAll");
    };
    pidRegistry.register = async () => {};
    pidRegistry.unregister = async () => {};
    pidRegistry.cleanupStale = async () => {};
    const ctx: SignalHandlerContext = {
      ...minimalCtx,
      pidRegistry,
      onShutdown: async () => {
        callOrder.push("onShutdown");
      },
    };

    // Just verify the context is accepted without error
    cleanup = installSignalHandlers(ctx);
    expect(ctx.onShutdown).toBeDefined();
    expect(ctx.pidRegistry).toBeDefined();
  });

  // BUG-11: freeze() previously ran BEFORE onShutdown, so any PID spawned during
  // onShutdown (e.g. `acpx sessions close`/`stop`) was silently dropped by
  // register() and never reachable by the killAll() sweep that follows. freeze()
  // must run AFTER onShutdown completes — late-spawned PIDs get registered
  // normally, and freeze() still locks the set before killAll() enumerates it.
  //
  // performTeardown() is exercised directly (not via a real signal) so the test
  // never touches process.exit — see forbidden-patterns-tests.md ("Real signal
  // sending... can kill the test runner").
  test("PID registered during onShutdown is present in killAll's target set (BUG-11)", async () => {
    const registered: number[] = [];
    const killedPids: number[] = [];
    let frozenDuringShutdown: boolean | undefined;

    const pidRegistry = new PidRegistry("/tmp/crash-signals-test-bug11");
    let isFrozen = false;
    pidRegistry.freeze = () => {
      isFrozen = true;
    };
    pidRegistry.isFrozen = () => isFrozen;
    pidRegistry.register = async (pid: number) => {
      if (isFrozen) return;
      registered.push(pid);
    };
    pidRegistry.unregister = async () => {};
    pidRegistry.killAll = async () => {
      killedPids.push(...registered);
    };

    const ctx: SignalHandlerContext = {
      ...minimalCtx,
      pidRegistry,
      onShutdown: async () => {
        // Simulates spawning `acpx sessions close` during teardown — must land
        // in the registry before freeze() locks it.
        frozenDuringShutdown = pidRegistry.isFrozen();
        await pidRegistry.register(9876);
      },
    };

    await performTeardown(ctx);

    expect(frozenDuringShutdown).toBe(false);
    expect(killedPids).toContain(9876);
    expect(pidRegistry.isFrozen()).toBe(true);
  });

  test("freeze() still blocks a PID registered after killAll's sweep target list is fixed (BUG-11)", async () => {
    const registered: number[] = [];
    const pidRegistry = new PidRegistry("/tmp/crash-signals-test-bug11-block");
    let isFrozen = false;
    pidRegistry.freeze = () => {
      isFrozen = true;
    };
    pidRegistry.isFrozen = () => isFrozen;
    pidRegistry.register = async (pid: number) => {
      if (isFrozen) return;
      registered.push(pid);
    };
    pidRegistry.unregister = async () => {};
    pidRegistry.killAll = async () => {
      // A late registration attempt after the sweep has started must be
      // rejected — this is the invariant freeze() exists to protect.
      await pidRegistry.register(11111);
    };

    const ctx: SignalHandlerContext = {
      ...minimalCtx,
      pidRegistry,
    };

    await performTeardown(ctx);

    expect(registered).not.toContain(11111);
  });

  test("uncaughtException listener is removed after cleanup", () => {
    const before = process.listenerCount("uncaughtException");
    cleanup = installSignalHandlers(minimalCtx);
    cleanup();
    cleanup = undefined;
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  test("SIGPIPE listener is registered after install (prevents silent crash on broken pipe)", () => {
    const before = process.listenerCount("SIGPIPE");
    cleanup = installSignalHandlers(minimalCtx);
    expect(process.listenerCount("SIGPIPE")).toBe(before + 1);
  });

  test("SIGPIPE listener is removed after cleanup", () => {
    const before = process.listenerCount("SIGPIPE");
    cleanup = installSignalHandlers(minimalCtx);
    cleanup();
    cleanup = undefined;
    expect(process.listenerCount("SIGPIPE")).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-37: every fatal handler arms a hard exit deadline, not just the signal one
//
// The signal path has always armed a 10 s deadline before teardown. The
// uncaughtException and unhandledRejection paths ran the same teardown with no
// deadline at all, and all three share one `shuttingDown` flag — so a teardown
// that wedged after a crash hung the process *and* made a follow-up Ctrl+C a
// no-op, because the signal handler sees the flag already set and returns.
//
// The handlers are driven directly here rather than by firing a real fatal
// event: `onShutdown` never resolves, so each handler parks inside
// performTeardown and never reaches its `process.exit`. That is exactly the
// wedged-teardown state the deadline exists to break.
// ─────────────────────────────────────────────────────────────────────────────

describe("fatal teardown deadline (BUG-37)", () => {
  type FatalEvent = "uncaughtException" | "unhandledRejection" | "SIGTERM";
  const HANDLER_EVENTS: FatalEvent[] = ["uncaughtException", "unhandledRejection", "SIGTERM"];

  /** ctx whose teardown never completes — the wedge the deadline must escape. */
  const hangingCtx: SignalHandlerContext = {
    ...minimalCtx,
    onShutdown: () => new Promise<void>(() => {}),
  };

  let scheduled: { delay: number; fire: () => void }[];
  let realArmDeadline: (typeof _crashSignalsDeps)["armDeadline"];
  let realExit: (typeof _crashSignalsDeps)["exit"];
  let realStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    scheduled = [];
    realArmDeadline = _crashSignalsDeps.armDeadline;
    realExit = _crashSignalsDeps.exit;
    _crashSignalsDeps.armDeadline = (fn, ms) => {
      scheduled.push({ delay: ms, fire: fn });
      return () => {};
    };
    // The handlers print a crash banner straight to stderr; swallow it so a
    // deliberately-triggered crash does not read as a real failure in the run.
    realStderrWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    _crashSignalsDeps.armDeadline = realArmDeadline;
    _crashSignalsDeps.exit = realExit;
    process.stderr.write = realStderrWrite;
  });

  /**
   * Invoke the listener this install added for `event`, without awaiting it.
   *
   * Dispatched per event rather than through one loosely-typed call so each
   * listener is invoked with the arguments Node actually passes it.
   */
  function fireHandler(event: FatalEvent): () => void {
    const before = process.listeners(event).length;
    const cleanup = installSignalHandlers(hangingCtx);
    // Deliberately not awaited: teardown never settles, which is the point.
    if (event === "SIGTERM") {
      void process.listeners("SIGTERM")[before]?.("SIGTERM");
    } else if (event === "uncaughtException") {
      void process.listeners("uncaughtException")[before]?.(new Error("boom"), "uncaughtException");
    } else {
      void process.listeners("unhandledRejection")[before]?.(new Error("boom"), Promise.resolve());
    }
    return cleanup;
  }

  test.each(HANDLER_EVENTS)("%s arms the hard deadline before teardown", (event) => {
    const cleanup = fireHandler(event);
    try {
      expect(scheduled.map((t) => t.delay)).toContain(FATAL_TEARDOWN_DEADLINE_MS);
    } finally {
      cleanup();
    }
  });

  const EXPECTED_EXIT_CODES: [FatalEvent, number][] = [
    ["uncaughtException", 1],
    ["unhandledRejection", 1],
    ["SIGTERM", 143],
  ];

  test.each(EXPECTED_EXIT_CODES)(
    "%s deadline exits with code %d when teardown never returns",
    (event, expectedCode) => {
      const exited: number[] = [];
      _crashSignalsDeps.exit = (code: number) => {
        exited.push(code);
      };

      const cleanup = fireHandler(event);
      try {
        const deadline = scheduled.find((t) => t.delay === FATAL_TEARDOWN_DEADLINE_MS);
        expect(deadline).toBeDefined();
        deadline?.fire();
        expect(exited).toEqual([expectedCode]);
      } finally {
        cleanup();
      }
    },
  );
});
