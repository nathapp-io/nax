/**
 * ADR-012 follow-up: verify the rate-limit backoff delay helper is cancellable.
 *
 * `AgentManager._agentManagerDeps.sleep` is the cancellable replacement for
 * the original `Bun.sleep(ms)`. Without a signal it behaves identically; with
 * an `AbortSignal` it resolves immediately on abort. This test pins the new
 * contract so the canonical pattern from docs/architecture/coding-standards.md
 * §6 cannot silently regress back to uncancellable `Bun.sleep`.
 *
 * Full abort-signal plumbing through `runWithFallback` is tracked in issue #585.
 */

import { describe, expect, test } from "bun:test";
import { _agentManagerDeps } from "../../../src/agents/manager";

describe("AgentManager cancellable backoff helper", () => {
  test("without a signal — resolves after the requested delay", async () => {
    const start = performance.now();
    await _agentManagerDeps.sleep(50);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(200);
  });

  test("with a signal — aborting mid-flight rejects quickly", async () => {
    const controller = new AbortController();
    // Schedule an abort well before the sleep would otherwise resolve.
    setTimeout(() => controller.abort(new Error("cancelled mid-backoff")), 10);

    const start = performance.now();
    let error: unknown;
    try {
      await _agentManagerDeps.sleep(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("cancelled mid-backoff");
    // Would be ~5000ms without cancellation — assert it settled before 1s.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("already-aborted signal — rejects synchronously, no delay", async () => {
    const controller = new AbortController();
    controller.abort(new Error("aborted before sleep"));

    const start = performance.now();
    let error: unknown;
    try {
      await _agentManagerDeps.sleep(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("aborted before sleep");
    expect(elapsed).toBeLessThan(100);
  });
});
