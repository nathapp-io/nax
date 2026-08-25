/**
 * Tests for src/bakeoff/ranking.ts
 *
 * Covers: rankContestants function behavior per AC-1 through AC-7
 */

import { describe, expect, it } from "bun:test";
import { rankContestants } from "@/bakeoff/ranking";
import type { ContestantResult, ContestantStatus } from "@/bakeoff/types";

// Helper to create a ContestantResult with defaults
function makeContestant(
  overrides: Partial<ContestantResult> & {
    status: ContestantStatus;
    storiesPassed: number;
    costUsd: number;
    wallTimeMs: number;
  },
): ContestantResult {
  return {
    name: "test-contestant",
    agent: "claude",
    error: overrides.error,
    ...overrides,
  };
}

describe("rankContestants", () => {
  // AC-1: callable and returns ContestantResult[]
  it("is callable and returns a ContestantResult array", () => {
    const results: ContestantResult[] = [
      makeContestant({ status: "passed", storiesPassed: 1, costUsd: 1, wallTimeMs: 100 }),
    ];
    const ranked = rankContestants(results);
    expect(Array.isArray(ranked)).toBe(true);
    expect(ranked.length).toBe(1);
    expect(ranked[0].storiesPassed).toBe(1);
  });

  // AC-2: more storiesPassed wins
  it("puts the result with more storiesPassed first", () => {
    const results: ContestantResult[] = [
      makeContestant({ name: "a", status: "passed", storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
      makeContestant({ name: "b", status: "passed", storiesPassed: 3, costUsd: 9, wallTimeMs: 50 }),
    ];
    const ranked = rankContestants(results);
    expect(ranked[0].name).toBe("b");
    expect(ranked[0].storiesPassed).toBe(3);
  });

  // AC-3: equal storiesPassed, lower costUsd wins
  it("puts lower costUsd result first when storiesPassed are equal", () => {
    const results: ContestantResult[] = [
      makeContestant({ name: "a", status: "passed", storiesPassed: 2, costUsd: 2, wallTimeMs: 100 }),
      makeContestant({ name: "b", status: "passed", storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
    ];
    const ranked = rankContestants(results);
    expect(ranked[0].name).toBe("b");
    expect(ranked[0].costUsd).toBe(1);
  });

  // AC-4: equal storiesPassed and costUsd, lower wallTimeMs wins
  it("puts lower wallTimeMs result first when storiesPassed and costUsd are equal", () => {
    const results: ContestantResult[] = [
      makeContestant({ name: "a", status: "passed", storiesPassed: 2, costUsd: 1, wallTimeMs: 200 }),
      makeContestant({ name: "b", status: "passed", storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
    ];
    const ranked = rankContestants(results);
    expect(ranked[0].name).toBe("b");
    expect(ranked[0].wallTimeMs).toBe(100);
  });

  // AC-5: finisher beats DNF regardless of cost/time
  it("puts finisher with passed status first even against DNF with higher cost/time", () => {
    const finisher: ContestantResult = {
      name: "finisher",
      agent: "claude",
      status: "passed",
      storiesPassed: 1,
      costUsd: 100,
      wallTimeMs: 10000,
      error: undefined,
    };
    const dnf: ContestantResult = {
      name: "dnf-crashed",
      agent: "claude",
      status: "dnf-crashed",
      storiesPassed: 0,
      costUsd: 1,
      wallTimeMs: 100,
      error: "crashed",
    };
    const results = [dnf, finisher];
    const ranked = rankContestants(results);
    expect(ranked[0].status).toBe("passed");
    expect(ranked[0].storiesPassed).toBe(1);
  });

  // AC-6: all DNF results sort by costUsd without throwing
  it("returns array of same length when all results are DNF and orders by costUsd ascending", () => {
    const results: ContestantResult[] = [
      makeContestant({ name: "a", status: "dnf-crashed", storiesPassed: 0, costUsd: 3, wallTimeMs: 50 }),
      makeContestant({ name: "b", status: "dnf-not-installed", storiesPassed: 0, costUsd: 1, wallTimeMs: 100 }),
      makeContestant({ name: "c", status: "dnf-crashed", storiesPassed: 0, costUsd: 2, wallTimeMs: 75 }),
    ];
    const ranked = rankContestants(results);
    expect(ranked).toHaveLength(3);
    expect(ranked[0].costUsd).toBe(1);
    expect(ranked[1].costUsd).toBe(2);
    expect(ranked[2].costUsd).toBe(3);
  });

  // AC-5 extended: status is primary sort key, not storiesPassed
  // DNF with storiesPassed > 0 should NOT outrank a finisher with fewer stories
  it("puts finisher first even when DNF has more storiesPassed", () => {
    const finisher: ContestantResult = {
      name: "finisher",
      agent: "claude",
      status: "passed",
      storiesPassed: 1,
      costUsd: 1,
      wallTimeMs: 100,
    };
    const dnf: ContestantResult = {
      name: "dnf-crashed",
      agent: "claude",
      status: "dnf-crashed",
      storiesPassed: 5,
      costUsd: 1,
      wallTimeMs: 100,
    };
    const results = [dnf, finisher];
    const ranked = rankContestants(results);
    expect(ranked[0].status).toBe("passed");
    expect(ranked[0].storiesPassed).toBe(1);
  });

  // AC-7: error field is undefined when status is passed and no error
  it("has error field as undefined when status is passed and no error is provided", () => {
    const result: ContestantResult = {
      name: "test",
      agent: "claude",
      status: "passed",
      storiesPassed: 1,
      costUsd: 1,
      wallTimeMs: 100,
    };
    expect(result.error).toBeUndefined();
  });
});
