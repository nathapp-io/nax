import { describe, expect, test } from "bun:test";
import { fetchWithTimeout } from "../../../src/context/engine/orchestrator";

describe("fetchWithTimeout", () => {
  test("aborts the losing provider fetch when the timeout wins and does not throw unhandled", async () => {
    let aborted = false;
    const slowProvider = {
      id: "slow",
      fetch: (_req: any, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
          // never resolves on its own
        }),
    };
    await expect(
      fetchWithTimeout(slowProvider as any, {} as any, 20)
    ).rejects.toThrow(/timed out/);
    // Give the abort event a tick to fire
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
  });
});
