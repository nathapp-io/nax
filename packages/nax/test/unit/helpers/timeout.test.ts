import { describe, expect, jest, test } from "bun:test";
import { withTimeout, withTimerSpy } from "@test/helpers";

describe("withTimeout", () => {
  test.each([false, true])("clears its deadline after operation rejection=%s", async (reject) => {
    const failure = new Error("operation failed");
    const observed = await withTimerSpy(async () =>
      withTimeout(reject ? Promise.reject(failure) : Promise.resolve("done"), 1_000).catch((error: unknown) => error),
    );
    try {
      expect(observed.result).toBe(reject ? failure : "done");
      expect(observed.leaked).toEqual([]);
    } finally {
      for (const timer of observed.armed) clearTimeout(Number(timer));
    }
  });

  test("rejects a pending operation at its deadline", async () => {
    jest.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => {}), 75, "fixture").catch((error: unknown) => error);
      jest.advanceTimersByTime(75);
      expect(await pending).toEqual(new Error("fixture timed out after 75ms"));
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
