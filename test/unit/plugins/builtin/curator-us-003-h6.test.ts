/**
 * H6 fix-cycle-iteration storyIds use the composite featureId/storyId key
 * (US-003). The bug: H6 was the only heuristic keying by bare storyId,
 * so two unrelated features' "US-001" iterations interleaved into one
 * fabricated streak (#1422 / BUG-48). The fix keys by
 * `<featureId>/<storyId>` — the same composite H1, H2, H3, H4 already use.
 *
 * ACs 4 and 5 are exercised here against `runHeuristics` directly because
 * H6 owns the grouping decision.
 */

import { describe, expect, test } from "bun:test";
import type { Observation } from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";

describe("H6 — storyIds is the composite featureId/storyId key (US-003)", () => {
  const defaultThresholds: CuratorThresholds = {
    repeatedFinding: 2,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  function makeUnchangedObs(featureId: string, storyId: string, iteration: number, runId = "run-test"): Observation {
    return {
      schemaVersion: 1,
      projectKey: "test-proj",
      runId,
      featureId,
      storyId,
      stage: "fix-cycle",
      ts: "2026-05-04T00:00:00Z",
      kind: "fix-cycle-iteration",
      payload: { iteration, status: "failed", outcome: "unchanged" },
    };
  }

  test("AC4: H6 proposal storyIds for featureId='context-providers-22' and storyId='US-001' is ['context-providers-22/US-001']", () => {
    const observations: Observation[] = [
      makeUnchangedObs("context-providers-22", "US-001", 1),
      makeUnchangedObs("context-providers-22", "US-001", 2),
      makeUnchangedObs("context-providers-22", "US-001", 3),
    ];

    const h6 = runHeuristics(observations, { ...defaultThresholds, unchangedOutcome: 3 }).find((p) => p.id === "H6");
    expect(h6).toBeDefined();
    expect(h6?.storyIds).toContain("context-providers-22/US-001");
  });

  test("AC4 (boundary): H6 storyIds is NOT just the bare storyId", () => {
    // The pre-fix bug: bare "US-001" interleaves with another feature's
    // "US-001". This boundary test would catch a regression to bare storyIds.
    const observations: Observation[] = [
      makeUnchangedObs("context-providers-22", "US-001", 1),
      makeUnchangedObs("context-providers-22", "US-001", 2),
      makeUnchangedObs("context-providers-22", "US-001", 3),
    ];

    const h6 = runHeuristics(observations, { ...defaultThresholds, unchangedOutcome: 3 }).find((p) => p.id === "H6");
    expect(h6?.storyIds).not.toEqual(["US-001"]);
  });

  test("AC5: same storyId under two different featureIds yields two distinct H6 proposals", () => {
    // The bug being fixed: the same bare storyId was being grouped across
    // features, so the two unrelated features' iterations interleaved into a
    // single fabricated streak. After the fix, two different featureIds →
    // two different composite keys → two distinct H6 proposals.
    const observations: Observation[] = [
      // feature A, US-001: enough unchanged to fire H6
      makeUnchangedObs("feature-A", "US-001", 1, "run-A"),
      makeUnchangedObs("feature-A", "US-001", 2, "run-A"),
      makeUnchangedObs("feature-A", "US-001", 3, "run-A"),
      // feature B, US-001: also enough unchanged to fire H6
      makeUnchangedObs("feature-B", "US-001", 1, "run-B"),
      makeUnchangedObs("feature-B", "US-001", 2, "run-B"),
      makeUnchangedObs("feature-B", "US-001", 3, "run-B"),
    ];

    const h6Proposals = runHeuristics(observations, { ...defaultThresholds, unchangedOutcome: 3 }).filter(
      (p) => p.id === "H6",
    );
    expect(h6Proposals).toHaveLength(2);
    const storyIds = h6Proposals.map((p) => p.storyIds[0]);
    expect(storyIds).toContain("feature-A/US-001");
    expect(storyIds).toContain("feature-B/US-001");
    expect(storyIds[0]).not.toBe(storyIds[1]);
  });

  test("AC5 (boundary): same featureId and same storyId stays a single H6 proposal", () => {
    const observations: Observation[] = [
      makeUnchangedObs("feature-A", "US-001", 1),
      makeUnchangedObs("feature-A", "US-001", 2),
      makeUnchangedObs("feature-A", "US-001", 3),
    ];

    const h6Proposals = runHeuristics(observations, { ...defaultThresholds, unchangedOutcome: 3 }).filter(
      (p) => p.id === "H6",
    );
    expect(h6Proposals).toHaveLength(1);
    expect(h6Proposals[0].storyIds).toEqual(["feature-A/US-001"]);
  });
});
