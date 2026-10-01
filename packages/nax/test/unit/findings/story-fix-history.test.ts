/**
 * US-004 — run-scoped story fix history store.
 *
 * Tests the public store API added by US-004. The store sits beside
 * `rectificationOscillations` on NaxRuntime and carries one (storyId, tier)
 * pair's fix-state across rectification re-entry. US-002 (runFixCycle
 * consumption) and US-003 (seeding) are out of scope.
 *
 * Acceptance criteria covered here:
 *   AC 4 — storyFixKey("US-004", "fast") !== storyFixKey("US-004", "powerful")
 *   AC 5 — storyFixKey("US-004") === storyFixKey("US-004", "default")
 *   AC 6 — getStoryFixState on a fresh store returns { iterations: [], declines: <empty Map> }
 *   AC 7 — appendStoryFixIterations(key, [iter1, iter2]) preserves order
 *   AC 8 — appendStoryFixIterations twice (one iter each) yields length 2
 *   AC 9 — writes under key A do not bleed into key B
 */

import { describe, expect, test } from "bun:test";
import type { Iteration } from "@/findings";
import { appendStoryFixIterations, createStoryFixHistory, getStoryFixState, storyFixKey } from "@/findings";
import { makeFinding } from "./_cycle-fixtures";

function makeIteration(iterationNum: number): Iteration {
  return {
    iterationNum,
    findingsBefore: [makeFinding({ source: "lint", message: `before-${iterationNum}` })],
    fixesApplied: [],
    findingsAfter: [makeFinding({ source: "lint", message: `after-${iterationNum}` })],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("storyFixKey (US-004)", () => {
  test("[US-004 AC 4] different tiers produce different keys for the same storyId", () => {
    const fast = storyFixKey("US-004", "fast");
    const powerful = storyFixKey("US-004", "powerful");
    expect(fast).not.toBe(powerful);
    expect(fast).toBe("US-004::fast::default");
    expect(powerful).toBe("US-004::powerful::default");
  });

  test("[US-004 AC 5] undefined tier is canonicalised to 'default'", () => {
    expect(storyFixKey("US-004")).toBe(storyFixKey("US-004", "default"));
    expect(storyFixKey("US-004")).toBe("US-004::default::default");
  });

  // The escalation ladder is a (tier, agent) tuple and repeated tier names across
  // agents are a supported shape, so the tier alone does not identify a rung.
  test("[#1530] the same tier under different agents produces different keys", () => {
    const agentA = storyFixKey("US-004", "fast", "agent-a");
    const agentB = storyFixKey("US-004", "fast", "agent-b");
    expect(agentA).not.toBe(agentB);
    expect(agentA).toBe("US-004::fast::agent-a");
    expect(agentB).toBe("US-004::fast::agent-b");
  });

  test("[#1530] undefined agent is canonicalised to 'default'", () => {
    expect(storyFixKey("US-004", "fast")).toBe(storyFixKey("US-004", "fast", "default"));
  });

  test("[#1530] agent and tier are independently significant", () => {
    const keys = new Set([
      storyFixKey("US-004", "fast", "agent-a"),
      storyFixKey("US-004", "fast", "agent-b"),
      storyFixKey("US-004", "balanced", "agent-a"),
      storyFixKey("US-004", "balanced", "agent-b"),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("createStoryFixHistory / getStoryFixState (US-004)", () => {
  test("[US-004 AC 6] getStoryFixState on an unwritten key returns empty iterations + empty declines map", () => {
    const store = createStoryFixHistory();
    const state = getStoryFixState(store, "US-004::fast");
    expect(state.iterations).toEqual([]);
    expect(state.declines).toBeInstanceOf(Map);
    expect(state.declines.size).toBe(0);
  });

  test("[US-004 AC 7] appendStoryFixIterations preserves order of supplied iterations", () => {
    const store = createStoryFixHistory();
    const key = storyFixKey("US-004", "fast");
    const iter1 = makeIteration(1);
    const iter2 = makeIteration(2);
    appendStoryFixIterations(store, key, [iter1, iter2]);
    const state = getStoryFixState(store, key);
    expect(state.iterations).toHaveLength(2);
    expect(state.iterations[0]).toBe(iter1);
    expect(state.iterations[1]).toBe(iter2);
  });

  test("[US-004 AC 8] two appendStoryFixIterations calls (one iter each) accumulate to length 2", () => {
    const store = createStoryFixHistory();
    const key = storyFixKey("US-004", "balanced");
    appendStoryFixIterations(store, key, [makeIteration(1)]);
    appendStoryFixIterations(store, key, [makeIteration(2)]);
    const state = getStoryFixState(store, key);
    expect(state.iterations).toHaveLength(2);
  });

  test("[US-004 AC 9] writes under key A do not bleed into key B (isolation)", () => {
    const store = createStoryFixHistory();
    const keyA = storyFixKey("US-004", "fast");
    const keyB = storyFixKey("US-005", "fast");
    appendStoryFixIterations(store, keyA, [makeIteration(1), makeIteration(2)]);
    const stateB = getStoryFixState(store, keyB);
    expect(stateB.iterations).toEqual([]);
    expect(stateB.declines.size).toBe(0);
    const stateA = getStoryFixState(store, keyA);
    expect(stateA.iterations).toHaveLength(2);
  });
});

describe("createStoryFixHistory — store shape (US-004)", () => {
  test("returns a Map instance", () => {
    const store = createStoryFixHistory();
    expect(store).toBeInstanceOf(Map);
    expect(store.size).toBe(0);
  });
});
