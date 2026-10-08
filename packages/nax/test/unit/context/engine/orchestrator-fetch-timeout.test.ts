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
  test("a provider whose fetch throws synchronously rejects cleanly and clears the fetch timer", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    // Wrap the global timer functions for the duration of the call so the
    // deadline handle is observable: the fix must clear it, not merely outlive
    // it (the pre-fix code leaked it, so it fired and rejected the race timer).
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: Array<{ handle: ReturnType<typeof setTimeout>; delay: number | undefined }> = [];
    const cleared = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((handler: Bun.TimerHandler, delay?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(handler, delay, ...args);
      armed.push({ handle, delay });
      return handle;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== undefined) cleared.add(handle);
      realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout;

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
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      process.off("unhandledRejection", onUnhandled);
    }

    // The provider's own timer (the 20 ms deadline) must be disarmed. If it is
    // not found, the fix under test armed nothing — fail loudly.
    const deadline = armed.find((entry) => entry.delay === 20);
    if (deadline === undefined) throw new Error("provider fetch timer was never armed");
    expect(cleared.has(deadline.handle)).toBe(true);

    // A concurrently-running test in this worker can reject for its own reasons;
    // only a leaked provider-timeout rejection is a defect of THIS test.
    const strayTimeouts = unhandled.filter(
      (reason) => reason instanceof Error && reason.message === 'Provider "sync-thrower" timed out',
    );
    expect(strayTimeouts).toEqual([]);
  });
});
