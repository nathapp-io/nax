import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { precomputeBatchPlan } from "@/execution/batching";

describe("precomputeBatchPlan", () => {
  test("splits full batches and isolates no-test and non-batchable work in order", () => {
    const simple = (id: string) =>
      makeStory({ id, routing: { complexity: "simple", testStrategy: "test-after", reasoning: "test" } });
    const noTest = makeStory({
      id: "docs",
      routing: { complexity: "simple", testStrategy: "no-test", reasoning: "docs" },
    });
    const complex = makeStory({
      id: "complex",
      routing: { complexity: "complex", testStrategy: "three-session-tdd", reasoning: "complex" },
    });
    const a = simple("a");
    const b = simple("b");
    const c = simple("c");
    const d = simple("d");
    expect(precomputeBatchPlan([a, b, c, noTest, d, complex], 2)).toEqual([
      { stories: [a, b], isBatch: true },
      { stories: [c], isBatch: false },
      { stories: [noTest], isBatch: false },
      { stories: [d], isBatch: false },
      { stories: [complex], isBatch: false },
    ]);
    expect(precomputeBatchPlan([a, b], 2)).toEqual([{ stories: [a, b], isBatch: true }]);
    expect(precomputeBatchPlan([])).toEqual([]);
  });
});
