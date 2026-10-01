import { describe, expect, test } from "bun:test";
import { StoryTokenUsage } from "@/metrics";

describe("StoryTokenUsage persisted shape", () => {
  test("keeps the metrics.json key names and omits zero cache counts", () => {
    expect(
      JSON.stringify(
        new StoryTokenUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 3 }),
      ),
    ).toBe('{"inputTokens":1,"outputTokens":2,"cacheCreationInputTokens":3}');
  });
});
