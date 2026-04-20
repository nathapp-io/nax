/**
 * Unit tests for cross-cutting Bun-op wrappers in src/utils/bun-deps.ts.
 *
 * Currently covers `cancellableDelay` — the canonical implementation of the
 * `setTimeout + AbortController` pattern from docs/architecture/coding-standards.md §6.
 * This test pins the helper's contract so it can be reused safely across rate-limit
 * backoffs, reconnect loops, and any future abort-aware delay site.
 */

import { describe, expect, test } from "bun:test";
import { cancellableDelay } from "../../../src/utils/bun-deps";

describe("cancellableDelay", () => {
  test("without a signal — resolves after the requested delay", async () => {
    const start = performance.now();
    await cancellableDelay(50);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(200);
  });

  test("with a signal — aborting mid-flight rejects quickly", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled mid-delay")), 10);

    const start = performance.now();
    let error: unknown;
    try {
      await cancellableDelay(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("cancelled mid-delay");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("already-aborted signal — rejects synchronously", async () => {
    const controller = new AbortController();
    controller.abort(new Error("aborted before delay"));

    const start = performance.now();
    let error: unknown;
    try {
      await cancellableDelay(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("aborted before delay");
    expect(elapsed).toBeLessThan(100);
  });

  test("abort after resolution is a no-op (no unhandled rejection)", async () => {
    const controller = new AbortController();
    const delayed = cancellableDelay(20, controller.signal);
    await delayed;
    // Aborting after the delay has already resolved should not throw.
    controller.abort(new Error("too late"));
    // Give event loop a tick to surface any unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(true).toBe(true);
  });

  test("default rejection reason when signal.reason is undefined", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    let error: unknown;
    try {
      await cancellableDelay(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    // Some runtimes set signal.reason to DOMException("AbortError") when abort()
    // is called without arguments — accept either shape.
    const message = (error as Error).message ?? (error as { name?: string }).name ?? "";
    expect(message.length).toBeGreaterThan(0);
  });
});
