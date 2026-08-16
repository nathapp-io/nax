import { describe, expect, test } from "bun:test";
import type { Finding, Iteration } from "@/findings";
import {
  MAX_ITERATIONS_PER_STORY,
  countPriorAppearances,
  fingerprintFor,
  getReviewIterations,
  recordReviewIteration,
} from "@/review";

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
  test("records rounds; getReviewIterations returns them; count reflects recurrence", () => {
    const store = new Map<string, Iteration[]>();
    recordReviewIteration(store, "US-1", [advFinding("window expiry non-atomic")]);
    recordReviewIteration(store, "US-1", [advFinding("window expiry non-atomic")]);
    const iters = getReviewIterations(store, "US-1");
    expect(iters.length).toBe(2);
    expect(iters[1].iterationNum).toBe(2);
    expect(iters[1].fixesApplied).toEqual([]);
    const fp = fingerprintFor("lib/store.ts", "assumption", "window expiry non-atomic");
    expect(countPriorAppearances(iters).get(fp)?.count).toBe(2);
  });

  test("is scoped by storyId; unknown story returns empty", () => {
    const store = new Map<string, Iteration[]>();
    recordReviewIteration(store, "US-1", [advFinding("x padded padded padded")]);
    expect(getReviewIterations(store, "US-2")).toEqual([]);
  });
});

describe("PERF-1 — per-story iteration cap", () => {
  test("drops oldest rounds and renumbers iterationNum contiguously past the cap", () => {
    const store = new Map<string, Iteration[]>();
    // Append well past the cap.
    const total = MAX_ITERATIONS_PER_STORY + 5;
    for (let i = 0; i < total; i++) {
      recordReviewIteration(store, "US-1", [advFinding(`r${i}`)]);
    }
    const iters = getReviewIterations(store, "US-1");
    expect(iters).toHaveLength(MAX_ITERATIONS_PER_STORY);
    // iterationNum is contiguous 1..N even though we dropped rounds — consumers
    // that read this see a clean sequence.
    expect(iters.map((it) => it.iterationNum)).toEqual(
      Array.from({ length: MAX_ITERATIONS_PER_STORY }, (_, i) => i + 1),
    );
    // The newest rounds (which are still inside the window) are retained.
    const newest = iters[iters.length - 1];
    expect(newest.findingsAfter[0]?.message).toBe(`r${total - 1}`);
  });

  test("does not touch older rounds that are still within the cap", () => {
    const store = new Map<string, Iteration[]>();
    for (let i = 0; i < MAX_ITERATIONS_PER_STORY - 1; i++) {
      recordReviewIteration(store, "US-1", [advFinding(`r${i}`)]);
    }
    const before = getReviewIterations(store, "US-1").map((it) => it.iterationNum);
    recordReviewIteration(store, "US-1", [advFinding("final")]);
    const after = getReviewIterations(store, "US-1").map((it) => it.iterationNum);
    expect(after).toEqual([...before, MAX_ITERATIONS_PER_STORY]);
  });
});
