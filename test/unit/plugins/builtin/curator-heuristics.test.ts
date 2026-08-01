/**
 * Curator Heuristics Tests
 *
 * Tests for H1-H6 heuristics that convert observations into proposals.
 */

import { describe, expect, test } from "bun:test";
import type { Observation } from "../../../../src/plugins/builtin/curator";
import { runHeuristics } from "../../../../src/plugins/builtin/curator/heuristics";
import type { CuratorThresholds, Proposal } from "../../../../src/plugins/builtin/curator/heuristics";

describe("runHeuristics", () => {
  const defaultThresholds: CuratorThresholds = {
    repeatedFinding: 2,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  test("returns empty array for empty observations and non-triggering observations", () => {
    expect(runHeuristics([], defaultThresholds)).toEqual([]);
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        runId: "run-1",
        featureId: "feat-story-1",
        storyId: "story-1",
        stage: "context",
        ts: "2026-05-04T00:00:00Z",
        kind: "chunk-included",
        payload: { chunkId: "c1", label: "chunk 1", tokens: 100 },
      },
    ];
    expect(runHeuristics(obs, defaultThresholds)).toEqual([]);
  });

  test("uses default thresholds when config values are absent", () => {
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        runId: "run-1",
        featureId: "feat-story-1",
        storyId: "story-1",
        stage: "review",
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding",
        payload: {
          ruleId: "rule1",
          severity: "error",
          file: "src/index.ts",
          line: 10,
          message: "test error",
        },
      },
    ];
    const incompleteThresholds: Partial<CuratorThresholds> = {};
    // Should not throw and should use sensible defaults
    const proposals = runHeuristics(obs, incompleteThresholds as CuratorThresholds);
    expect(Array.isArray(proposals)).toBe(true);
  });

  describe("H1 — Repeated Review Finding", () => {
    test("triggers when same checkId count >= threshold across stories", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-2",
          storyId: "story-2",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1).toBeDefined();
      expect(h1?.severity).toBe("MED");
      // Description names the locus, not the old single-word ruleId bucket (#1422).
      expect(h1?.description).toContain("src/index.ts");
      expect(h1?.description).toContain("2 features");
      expect(h1?.target.action).toBe("add");
    });

    test("produces HIGH severity at wide feature spread; does not trigger for 1 feature", () => {
      const highObs: Observation[] = Array.from({ length: 5 }, (_, i) => ({
        schemaVersion: 1 as const,
        runId: "run-1",
        featureId: `feat-${i}`,
        storyId: `story-${i}`,
        stage: "review" as const,
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding" as const,
        payload: { ruleId: "rule1", severity: "error", file: "src/index.ts", line: 10 + i, message: "test error" },
      }));
      expect(runHeuristics(highObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1")?.severity).toBe("HIGH");

      const singleObs: Observation[] = [{
        schemaVersion: 1,
        runId: "run-1",
        featureId: "feat-story-1",
        storyId: "story-1",
        stage: "review",
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding",
        payload: { ruleId: "rule1", severity: "error", file: "src/index.ts", line: 10, message: "test error" },
      }];
      expect(runHeuristics(singleObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1")).toBeUndefined();
    });

    test("includes storyIds in evidence", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-a",
          storyId: "story-a",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-b",
          storyId: "story-b",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.storyIds).toContain("story-a");
      expect(h1?.storyIds).toContain("story-b");
    });
  });

  describe("H2 — Pull-tool Empty Result", () => {
    test("triggers for empty keyword results; does not trigger for non-empty results", () => {
      const emptyObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "pull", ts: "2026-05-04T00:00:00Z", kind: "pull-call", payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-2", stage: "pull", ts: "2026-05-04T00:01:00Z", kind: "pull-call", payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" } },
      ];
      const h2 = runHeuristics(emptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2");
      expect(h2).toBeDefined();
      expect(h2?.severity).toBe("MED");
      expect(h2?.target.action).toBe("add");
      expect(h2?.description).toContain("review batch");

      const nonEmptyObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "pull", ts: "2026-05-04T00:00:00Z", kind: "pull-call", payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 2, status: "completed" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-2", stage: "pull", ts: "2026-05-04T00:01:00Z", kind: "pull-call", payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 1, status: "completed" } },
      ];
      expect(runHeuristics(nonEmptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2")).toBeUndefined();
    });
  });

  describe("H3 — Repeated Rectification Cycle", () => {
    test("triggers when same story >= threshold; does not trigger for different stories", () => {
      const sameStoryObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "rectify", ts: "2026-05-04T00:00:00Z", kind: "rectify-cycle", payload: { iteration: 1, status: "failed" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "rectify", ts: "2026-05-04T00:01:00Z", kind: "rectify-cycle", payload: { iteration: 2, status: "failed" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "rectify", ts: "2026-05-04T00:02:00Z", kind: "rectify-cycle", payload: { iteration: 3, status: "failed" } },
      ];
      const h3 = runHeuristics(sameStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3");
      expect(h3).toBeDefined();
      expect(h3?.severity).toBe("HIGH");
      expect(h3?.target.action).toBe("add");

      const diffStoryObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "rectify", ts: "2026-05-04T00:00:00Z", kind: "rectify-cycle", payload: { iteration: 1, status: "failed" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-2", stage: "rectify", ts: "2026-05-04T00:01:00Z", kind: "rectify-cycle", payload: { iteration: 1, status: "failed" } },
      ];
      expect(runHeuristics(diffStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3")).toBeUndefined();
    });
  });

  describe("H4 — Escalation Chain", () => {
    test("triggers for same tier path >= threshold; does not trigger for different paths", () => {
      const samePathObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "escalation", ts: "2026-05-04T00:00:00Z", kind: "escalation", payload: { from: "fast", to: "balanced" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-2", stage: "escalation", ts: "2026-05-04T00:01:00Z", kind: "escalation", payload: { from: "fast", to: "balanced" } },
      ];
      const h4 = runHeuristics(samePathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4");
      expect(h4).toBeDefined();
      expect(h4?.severity).toBe("MED");
      expect(h4?.target.action).toBe("add");

      const diffPathObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "escalation", ts: "2026-05-04T00:00:00Z", kind: "escalation", payload: { from: "fast", to: "balanced" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-2", stage: "escalation", ts: "2026-05-04T00:01:00Z", kind: "escalation", payload: { from: "balanced", to: "powerful" } },
      ];
      expect(runHeuristics(diffPathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4")).toBeUndefined();
    });
  });

  describe("H5 — Stale Chunk Excluded", () => {
    test("triggers for stale exclusions persisting across runs; does not trigger for non-stale", () => {
      const staleObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "context", ts: "2026-05-04T00:00:00Z", kind: "chunk-excluded", payload: { chunkId: "c1", label: "stale chunk", reason: "stale" } },
        { schemaVersion: 1, runId: "run-2", featureId: "feat-1", storyId: "story-1", stage: "context", ts: "2026-05-05T00:00:00Z", kind: "chunk-excluded", payload: { chunkId: "c1", label: "stale chunk", reason: "stale" } },
      ];
      const h5 = runHeuristics(staleObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5");
      expect(h5).toBeDefined();
      expect(h5?.severity).toBe("LOW");
      expect(h5?.target.action).toBe("drop");

      const noMatchObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "context", ts: "2026-05-04T00:00:00Z", kind: "chunk-excluded", payload: { chunkId: "c1", label: "chunk", reason: "no-match" } },
        { schemaVersion: 1, runId: "run-2", featureId: "feat-1", storyId: "story-1", stage: "context", ts: "2026-05-05T00:00:00Z", kind: "chunk-excluded", payload: { chunkId: "c1", label: "chunk", reason: "no-match" } },
      ];
      expect(runHeuristics(noMatchObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5")).toBeUndefined();
    });
  });

  describe("H6 — Fix-cycle Unchanged Outcome", () => {
    test("triggers when unchanged outcome >= threshold; does not trigger with mixed outcomes", () => {
      const unchangedObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "fix-cycle", ts: "2026-05-04T00:00:00Z", kind: "fix-cycle-iteration", payload: { iteration: 1, status: "failed", outcome: "unchanged" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "fix-cycle", ts: "2026-05-04T00:01:00Z", kind: "fix-cycle-iteration", payload: { iteration: 2, status: "failed", outcome: "unchanged" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "fix-cycle", ts: "2026-05-04T00:02:00Z", kind: "fix-cycle-iteration", payload: { iteration: 3, status: "failed", outcome: "unchanged" } },
      ];
      const h6 = runHeuristics(unchangedObs, { ...defaultThresholds, unchangedOutcome: 3 }).find((p) => p.id === "H6");
      expect(h6).toBeDefined();
      expect(h6?.severity).toBe("LOW");
      expect(h6?.target.action).toBe("advisory");

      const mixedObs: Observation[] = [
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "fix-cycle", ts: "2026-05-04T00:00:00Z", kind: "fix-cycle-iteration", payload: { iteration: 1, status: "passed", outcome: "resolved" } },
        { schemaVersion: 1, runId: "run-1", featureId: "feat-1", storyId: "story-1", stage: "fix-cycle", ts: "2026-05-04T00:01:00Z", kind: "fix-cycle-iteration", payload: { iteration: 2, status: "failed", outcome: "unchanged" } },
      ];
      expect(runHeuristics(mixedObs, { ...defaultThresholds, unchangedOutcome: 2 }).find((p) => p.id === "H6")).toBeUndefined();
    });
  });

  describe("Multiple heuristics firing", () => {
    test("returns all triggered proposals together", () => {
      const obs: Observation[] = [
        // H1: Repeated finding
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-2",
          storyId: "story-2",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
        // H2: Pull-tool empty
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:02:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-3",
          storyId: "story-3",
          stage: "pull",
          ts: "2026-05-04T00:03:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
      ];

      const proposals = runHeuristics(obs, defaultThresholds);

      expect(proposals.length).toBeGreaterThanOrEqual(2);
      expect(proposals.some((p) => p.id === "H1")).toBe(true);
      expect(proposals.some((p) => p.id === "H2")).toBe(true);
    });
  });

  describe("Evidence and metadata", () => {
    test("includes observation kind in sourceKinds", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-2",
          storyId: "story-2",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, defaultThresholds);
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.sourceKinds).toContain("review-finding");
    });

    test("produces non-empty description and evidence", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-2",
          storyId: "story-2",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, defaultThresholds);
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.description).toMatch(/\S/);
      expect(h1?.evidence).toMatch(/\S/);
    });
  });
});

// ─── Issue #942 AC-5: H1 ruleId buckets are not single-word collapses ──────

function makeReviewFindingObs942(
  storyId: string,
  ruleId: string,
  severity: string,
  message = "msg",
): Observation {
  return {
    schemaVersion: 1,
    runId: "run-test",
    // One feature per story: H1 measures recurrence across FEATURES (#1422), so
    // fixtures that mean "this recurred" must spread across them.
    featureId: `feat-${storyId}`,
    storyId,
    stage: "review",
    ts: "2026-05-07T00:00:00.000Z",
    kind: "review-finding",
    payload: { ruleId, checkId: ruleId, severity, file: "src/foo.ts", line: 1, message },
  };
}

describe("H1 — sample messages in evidence", () => {
  test("evidence includes up to two sample messages drawn from the group", () => {
    const observations: Observation[] = [
      // Same defect, three phrasings that share the fingerprint prefix — that is
      // what "one group" now means (#1422). Only two samples may surface.
      makeReviewFindingObs942("US-001", "input:listener-arg-not-validated", "warning", "Listener argument is not validated as a function (register path)"),
      makeReviewFindingObs942("US-002", "input:listener-arg-not-validated", "warning", "Listener argument is not validated as a function (handler path)"),
      makeReviewFindingObs942("US-003", "input:listener-arg-not-validated", "warning", "Listener argument is not validated as a function (third example should not appear)"),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;

    expect(h1).toBeDefined();
    expect(h1.evidence).toContain("(register path)");
    expect(h1.evidence).toContain("(handler path)");
    expect(h1.evidence).not.toContain("third example should not appear");
  });

  test("evidence omits sample section when all messages are empty", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "input:listener-arg-not-validated", "warning", ""),
      makeReviewFindingObs942("US-002", "input:listener-arg-not-validated", "warning", ""),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;
    expect(h1).toBeDefined();
    expect(h1.evidence).not.toContain("Examples:");
  });

  test("sample uses only the first line of a multi-line message", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "review:null-check", "warning", "Null check missing\n→ Add a guard before access"),
      makeReviewFindingObs942("US-002", "review:null-check", "warning", "Null check missing\n→ Add a guard before access"),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1 = proposals.find((p) => p.id === "H1")!;
    expect(h1.evidence).toContain("Null check missing");
    expect(h1.evidence).not.toContain("→ Add a guard");
  });

  test("an empty message does not group with a real one, and cannot borrow its sample", () => {
    // Superseded shape: this used to assert that an empty first message did not
    // suppress a later real sample within one ruleId bucket. Under fingerprint
    // grouping (#1422) the message IS part of the key, so an empty message forms
    // its own group — the two can never share a proposal to begin with.
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "review:null-check", "warning", ""),
      makeReviewFindingObs942("US-002", "review:null-check", "warning", "Null check missing"),
    ];

    const h1s = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds).filter((p) => p.id === "H1");
    // Two groups of one feature each — neither reaches the threshold.
    expect(h1s).toHaveLength(0);
  });
});

describe("H1 — issue #942 AC-5: ruleId buckets are not single-word collapses", () => {
  test("findings sharing a category but different issues yield distinct buckets", () => {
    const observations: Observation[] = [
      makeReviewFindingObs942("US-001", "input:listener-arg", "warning", "Listener argument is not validated as a function"),
      makeReviewFindingObs942("US-002", "input:listener-arg", "warning", "Listener argument is not validated as a function"),
      makeReviewFindingObs942("US-003", "input:timeout-bound", "error", "Timeout value has no upper bound and can hang the run"),
      makeReviewFindingObs942("US-004", "input:timeout-bound", "error", "Timeout value has no upper bound and can hang the run"),
    ];

    const proposals = runHeuristics(observations, { repeatedFinding: 2 } as CuratorThresholds);
    const h1s = proposals.filter((p) => p.id === "H1");

    expect(h1s.length).toBe(2);
    // Buckets are per-defect, not per-category: a proposal must name a locus and
    // carry a distinguishing sample, never collapse to the bare word "input".
    for (const p of h1s) {
      expect(p.description).not.toMatch(/\(input\)/);
      expect(p.evidence).toContain("Examples:");
    }
    expect(h1s.some((p) => p.evidence.includes("Listener argument"))).toBe(true);
    expect(h1s.some((p) => p.evidence.includes("Timeout value"))).toBe(true);
  });
});

// ─── #1422: cross-feature recurrence ──────────────────────────────────────────

describe("H1 — cross-feature recurrence (#1422)", () => {
  const thresholds: CuratorThresholds = {
    repeatedFinding: 3,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  function finding(featureId: string, storyId: string, over: Partial<{ category: string; file: string; message: string }> = {}): Observation {
    return {
      schemaVersion: 1,
      runId: "run-1",
      featureId,
      storyId,
      stage: "review",
      ts: "2026-08-01T00:00:00Z",
      kind: "review-finding",
      payload: {
        ruleId: "test-gap:missing-runtime-assertion",
        category: over.category ?? "test-gap",
        severity: "error",
        file: over.file ?? "src/api.ts",
        line: 10,
        message: over.message ?? "Test asserts a pattern exists in the file instead of invoking the code",
      },
    };
  }

  test("proposes when the same finding recurs across enough DISTINCT features", () => {
    const obs = [finding("feat-a", "US-001"), finding("feat-b", "US-002"), finding("feat-c", "US-003")];
    const h1 = runHeuristics(obs, thresholds).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
    expect(h1?.evidence).toContain("feat-a");
    expect(h1?.evidence).toContain("feat-c");
  });

  test("does NOT propose when one feature repeats the same finding many times", () => {
    // A rule is worth writing when a defect crosses features. One feature
    // repeating itself is a story problem, and was the old behaviour's main
    // source of noise ("test-gap appeared 1008x" from a single 7-story run).
    const obs = Array.from({ length: 12 }, (_, i) => finding("feat-a", `US-${i}`));
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });

  test("separates distinct defects that share a category and file", () => {
    const a = [1, 2, 3].map((i) => finding(`feat-${i}`, "US-001", { message: "Placeholder assertion expect(true)" }));
    const b = [1, 2, 3].map((i) => finding(`feat-${i}`, "US-002", { message: "Source-inspection test reads the file" }));
    const h1s = runHeuristics([...a, ...b], thresholds).filter((p) => p.id === "H1");
    expect(h1s).toHaveLength(2);
  });

  test("groups the same defect reported at different lines and stories", () => {
    const obs = ["feat-a", "feat-b", "feat-c"].map((f) => finding(f, "US-001"));
    expect(runHeuristics(obs, thresholds).filter((p) => p.id === "H1")).toHaveLength(1);
  });

  test("severity escalates with feature spread, not raw count", () => {
    const three = ["a", "b", "c"].map((f) => finding(`feat-${f}`, "US-001"));
    const five = ["a", "b", "c", "d", "e"].map((f) => finding(`feat-${f}`, "US-001"));
    expect(runHeuristics(three, thresholds).find((p) => p.id === "H1")?.severity).toBe("MED");
    expect(runHeuristics(five, thresholds).find((p) => p.id === "H1")?.severity).toBe("HIGH");
  });

  test("acknowledgement-shaped findings cannot form a proposal on their own", () => {
    // Belt and braces with #1423: even if a stale ack leaks into findings,
    // it carries no category/file locus worth writing a rule about.
    const obs = ["a", "b", "c"].map((f) =>
      finding(`feat-${f}`, "US-001", { category: "", file: "", message: "Prior finding 1: addressed. No action required." }),
    );
    expect(runHeuristics(obs, thresholds).find((p) => p.id === "H1")).toBeUndefined();
  });
});
