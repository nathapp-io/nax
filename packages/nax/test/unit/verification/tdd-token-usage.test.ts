/**
 * `src/tdd/types.ts` was invisible to the coverage gate (#2329): every other
 * import of it is type-only, so the module never executed and Bun wrote no
 * `SF:` record. This exercises its one runtime value.
 */
import { describe, expect, test } from "bun:test";
import type { TddSessionResult } from "@/tdd/types";
import { sumTddTokenUsage } from "@/tdd/types";

function session(tokenUsage?: TddSessionResult["tokenUsage"]): TddSessionResult {
  return { role: "implementer", success: true, estimatedCostUsd: 0, filesChanged: [], durationMs: 0, tokenUsage };
}

describe("sumTddTokenUsage", () => {
  test("returns undefined when no session reported usage", () => {
    expect(sumTddTokenUsage([])).toBeUndefined();
    expect(sumTddTokenUsage([session(), session()])).toBeUndefined();
  });

  test("sums usage across sessions", () => {
    expect(
      sumTddTokenUsage([
        session({ inputTokens: 100, outputTokens: 10 }),
        session({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 6 }),
      ]),
    ).toEqual({ inputTokens: 101, outputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 6 });
  });

  test("omits the cache keys while every cache total is zero", () => {
    expect(sumTddTokenUsage([session({ inputTokens: 3, outputTokens: 4 })])).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
  });
});
