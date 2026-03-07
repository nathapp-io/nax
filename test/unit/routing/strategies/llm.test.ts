// RE-ARCH: keep
/**
 * LLM Routing Strategy Tests
 *
 * BUG-039: Stream drain fix — stdout/stderr cancelled before proc.kill() on timeout
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../../src/logger";
import { type PipedProc, _deps } from "../../../../src/routing/strategies/llm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<NaxConfig["routing"]["llm"]> = {}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    routing: {
      ...DEFAULT_CONFIG.routing,
      strategy: "llm",
      llm: {
        mode: "per-story",
        timeoutMs: 50,
        retries: 0,
        retryDelayMs: 0,
        fallbackToKeywords: false,
        cacheDecisions: false,
        model: "fast",
        ...overrides,
      },
    },
  } as NaxConfig;
}

/** Creates a fake Bun.spawn proc that never resolves (simulates a hanging LLM call). */
function makeHangingProc() {
  const stdoutCancelled = { value: false };
  const stderrCancelled = { value: false };
  const killCalled = { value: false };
  const killCalledAfterCancel = { value: false };

  // ReadableStream that never produces data and never closes
  const neverStream = () => {
    const cancelFn: () => void = () => {};
    const stream = new ReadableStream({
      start() {},
      cancel() {
        cancelFn();
      },
    });
    return stream;
  };

  const stdout = neverStream();
  const stderr = neverStream();

  const originalStdoutCancel = stdout.cancel.bind(stdout);
  const originalStderrCancel = stderr.cancel.bind(stderr);

  // Wrap cancel to track calls
  const trackedStdout = new Proxy(stdout, {
    get(target, prop) {
      if (prop === "cancel") {
        return () => {
          stdoutCancelled.value = true;
          return originalStdoutCancel();
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop as string | symbol];
    },
  });

  const trackedStderr = new Proxy(stderr, {
    get(target, prop) {
      if (prop === "cancel") {
        return () => {
          stderrCancelled.value = true;
          return originalStderrCancel();
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop as string | symbol];
    },
  });

  const proc = {
    stdout: trackedStdout,
    stderr: trackedStderr,
    exited: new Promise<number>(() => {}), // never resolves
    kill() {
      killCalledAfterCancel.value = stdoutCancelled.value && stderrCancelled.value;
      killCalled.value = true;
    },
  };

  return { proc, stdoutCancelled, stderrCancelled, killCalled, killCalledAfterCancel };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

describe("BUG-039/BUG-040: stream cleanup on timeout", () => {
  test("kills process on timeout without calling cancel() on locked streams", async () => {
    const { proc, stdoutCancelled, stderrCancelled, killCalled } = makeHangingProc();

    const originalSpawn = _deps.spawn;
    _deps.spawn = mock(() => proc as PipedProc);

    const config = makeConfig({ timeoutMs: 30 });

    const { llmStrategy } = await import("../../../../src/routing/strategies/llm");

    const story = {
      id: "TEST-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const startTime = Date.now();

    await expect(llmStrategy.route(story, { config })).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - startTime;

    // Should resolve promptly — within 500ms of the 30ms timeout
    expect(elapsed).toBeLessThan(500);

    // BUG-040: cancel() must NOT be called on locked streams — it returns a rejected
    // Promise (per Web Streams spec) which becomes an unhandled rejection crash.
    expect(stdoutCancelled.value).toBe(false);
    expect(stderrCancelled.value).toBe(false);
    expect(killCalled.value).toBe(true);

    _deps.spawn = originalSpawn;
  });

  test("no unhandled rejection when Response.text() locks streams and proc is killed", async () => {
    // Simulate the exact BUG-040 scenario:
    // 1. Spawn proc with piped streams
    // 2. Response(proc.stdout).text() locks the streams
    // 3. Timeout fires, proc.kill() called
    // 4. No unhandled rejection should occur

    const unhandledRejections: Error[] = [];
    const handler = (event: PromiseRejectionEvent) => {
      unhandledRejections.push(event.reason as Error);
      event.preventDefault();
    };

    // biome-ignore lint/suspicious/noGlobalAssign: test-only override
    globalThis.addEventListener("unhandledrejection", handler);

    // Create a proc where streams are locked by Response readers
    const stdout = new ReadableStream({ start() {} });
    const stderr = new ReadableStream({ start() {} });
    const proc = {
      stdout,
      stderr,
      exited: new Promise<number>(() => {}),
      kill: mock(() => {}),
    };

    const originalSpawn = _deps.spawn;
    _deps.spawn = mock(() => proc as PipedProc);

    const config = makeConfig({ timeoutMs: 20, retries: 0 });

    const { llmStrategy } = await import("../../../../src/routing/strategies/llm");
    const story = {
      id: "BUG040",
      title: "Bug test",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    await expect(llmStrategy.route(story, { config })).rejects.toThrow(/timeout/i);

    // Give microtasks time to settle
    await Bun.sleep(50);

    globalThis.removeEventListener("unhandledrejection", handler);
    _deps.spawn = originalSpawn;

    // No unhandled rejections should have occurred
    expect(unhandledRejections).toHaveLength(0);
  });

  test("clearTimeout is called on success path (no resource leak)", async () => {
    const originalSpawn = _deps.spawn;

    // proc that resolves immediately with valid output
    const successProc = {
      stdout: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                complexity: "simple",
                modelTier: "fast",
                testStrategy: "test-after",
                reasoning: "Simple test story",
              }),
            ),
          );
          ctrl.close();
        },
      }),
      stderr: new ReadableStream({
        start(ctrl) {
          ctrl.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };

    _deps.spawn = mock(() => successProc as PipedProc);

    const config = makeConfig({ timeoutMs: 5000 });

    const { llmStrategy, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const story = {
      id: "TEST-002",
      title: "Add login button",
      description: "Simple button feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const result = await llmStrategy.route(story, { config });

    expect(result).not.toBeNull();
    expect(result?.complexity).toBe("simple");
    // kill() must NOT be called on the success path
    expect(successProc.kill).not.toHaveBeenCalled();

    _deps.spawn = originalSpawn;
    clearCache();
  });

  test("timeout promise rejects and does not hang beyond timeout window", async () => {
    const originalSpawn = _deps.spawn;
    const { proc } = makeHangingProc();

    _deps.spawn = mock(() => proc as PipedProc);

    const config = makeConfig({ timeoutMs: 50, retries: 0 });

    const { llmStrategy } = await import("../../../../src/routing/strategies/llm");

    const story = {
      id: "TEST-003",
      title: "Hanging story",
      description: "This will hang",
      acceptanceCriteria: ["AC"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const before = Date.now();
    await expect(llmStrategy.route(story, { config })).rejects.toThrow();
    const after = Date.now();

    // Should complete well under 2s even though proc never exits
    expect(after - before).toBeLessThan(2000);

    _deps.spawn = originalSpawn;
  });
});
