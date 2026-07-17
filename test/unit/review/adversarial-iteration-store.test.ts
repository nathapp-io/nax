import { describe, expect, test } from "bun:test";
import type { Finding, Iteration } from "@/findings";
import { countPriorAppearances, fingerprintFor, getAdversarialIterations, recordAdversarialIteration } from "@/review";

function advFinding(message: string): Finding {
  return {
    source: "adversarial-review",
    severity: "error",
    category: "assumption",
    file: "lib/store.ts",
    message,
  } as Finding;
}

describe("adversarial iteration store", () => {
  test("records rounds; getAdversarialIterations returns them; count reflects recurrence", () => {
    const store = new Map<string, Iteration[]>();
    recordAdversarialIteration(store, "US-1", [advFinding("window expiry non-atomic")]);
    recordAdversarialIteration(store, "US-1", [advFinding("window expiry non-atomic")]);
    const iters = getAdversarialIterations(store, "US-1");
    expect(iters.length).toBe(2);
    expect(iters[1].iterationNum).toBe(2);
    expect(iters[1].fixesApplied).toEqual([]);
    const fp = fingerprintFor("lib/store.ts", "assumption", "window expiry non-atomic");
    expect(countPriorAppearances(iters).get(fp)?.count).toBe(2);
  });

  test("is scoped by storyId; unknown story returns empty", () => {
    const store = new Map<string, Iteration[]>();
    recordAdversarialIteration(store, "US-1", [advFinding("x padded padded padded")]);
    expect(getAdversarialIterations(store, "US-2")).toEqual([]);
  });
});
