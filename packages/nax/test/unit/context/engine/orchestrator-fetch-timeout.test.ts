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
