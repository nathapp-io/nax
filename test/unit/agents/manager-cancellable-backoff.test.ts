/**
 * ADR-012 follow-up: verify `_agentManagerDeps.sleep` delegates to the
 * cancellable helper in src/utils/bun-deps.ts rather than plain Bun.sleep.
 *
 * This is a narrow wiring test — comprehensive coverage of the helper itself
 * lives in test/unit/utils/bun-deps.test.ts. The role of this test is to
 * prevent a silent regression back to uncancellable `Bun.sleep(ms)` at the
 * manager layer (which would violate docs/architecture/coding-standards.md §6).
 *
 * Full AbortSignal plumbing through `runWithFallback` is tracked in #585.
 */

import { describe, expect, test } from "bun:test";
import { _agentManagerDeps } from "../../../src/agents/manager";

describe("AgentManager — rate-limit backoff wiring", () => {
  test("_deps.sleep accepts an AbortSignal and aborts mid-flight", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("aborted")), 10);

    const start = performance.now();
    let error: unknown;
    try {
      await _agentManagerDeps.sleep(5_000, controller.signal);
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - start;

    expect(error).toBeDefined();
    expect((error as Error).message).toBe("aborted");
    expect(elapsed).toBeLessThan(1_000);
  });

  test("_deps.sleep resolves normally when no signal is passed", async () => {
    const start = performance.now();
    await _agentManagerDeps.sleep(30);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });
});
