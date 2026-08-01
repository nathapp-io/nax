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
      // Description carries a distinguishing gist, never a bare category (#942);
      // the file locus moved to evidence, since it is not part of cross-feature
      // identity (#1422).
      expect(h1?.description).toContain("2 features");
      expect(h1?.description).toContain("test error");
      expect(h1?.evidence).toContain("src/index.ts");
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
      expect(
        runHeuristics(highObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1")?.severity,
      ).toBe("HIGH");

      const singleObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: { ruleId: "rule1", severity: "error", file: "src/index.ts", line: 10, message: "test error" },
        },
      ];
      expect(
        runHeuristics(singleObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1"),
      ).toBeUndefined();
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

      // Story IDs alone collide across features; the pair is the site reference.
      expect(h1?.storyIds).toContain("feat-story-a/story-a");
      expect(h1?.storyIds).toContain("feat-story-b/story-b");
    });
  });

  describe("H2 — Pull-tool Empty Result", () => {
    test("triggers for empty keyword results; does not trigger for non-empty results", () => {
      const emptyObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:00:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "pull",
          ts: "2026-05-04T00:01:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
      ];
      const h2 = runHeuristics(emptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2");
      expect(h2).toBeDefined();
      expect(h2?.severity).toBe("MED");
      expect(h2?.target.action).toBe("add");
      expect(h2?.description).toContain("review batch");

      const nonEmptyObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:00:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 2, status: "completed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "pull",
          ts: "2026-05-04T00:01:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 1, status: "completed" },
        },
      ];
      expect(
        runHeuristics(nonEmptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2"),
      ).toBeUndefined();
    });
  });

  describe("H3 — Repeated Rectification Cycle", () => {
    test("triggers when same story >= threshold; does not trigger for different stories", () => {
      const sameStoryObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:00:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:01:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 2, status: "failed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:02:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 3, status: "failed" },
        },
      ];
      const h3 = runHeuristics(sameStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3");
      expect(h3).toBeDefined();
      expect(h3?.severity).toBe("HIGH");
      expect(h3?.target.action).toBe("add");

      const diffStoryObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:00:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "rectify",
          ts: "2026-05-04T00:01:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
      ];
      expect(
        runHeuristics(diffStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3"),
      ).toBeUndefined();
    });
  });

  describe("H4 — Escalation Chain", () => {
    test("triggers for same tier path >= threshold; does not trigger for different paths", () => {
      const samePathObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
      ];
      const h4 = runHeuristics(samePathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4");
      expect(h4).toBeDefined();
      expect(h4?.severity).toBe("MED");
      expect(h4?.target.action).toBe("add");

      const diffPathObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "balanced", to: "powerful" },
        },
      ];
      expect(
        runHeuristics(diffPathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4"),
      ).toBeUndefined();
    });
  });

  describe("H5 — Stale Chunk Excluded", () => {
    test("triggers for stale exclusions persisting across runs; does not trigger for non-stale", () => {
      const staleObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "stale chunk", reason: "stale" },
        },
        {
          schemaVersion: 1,
          runId: "run-2",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-05T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "stale chunk", reason: "stale" },
        },
      ];
      const h5 = runHeuristics(staleObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5");
      expect(h5).toBeDefined();
      expect(h5?.severity).toBe("LOW");
      expect(h5?.target.action).toBe("drop");

      const noMatchObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "chunk", reason: "no-match" },
        },
        {
          schemaVersion: 1,
          runId: "run-2",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-05T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "chunk", reason: "no-match" },
        },
      ];
      expect(
        runHeuristics(noMatchObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5"),
      ).toBeUndefined();
    });
  });

  describe("H6 — Fix-cycle Unchanged Outcome", () => {
    test("triggers when unchanged outcome >= threshold; does not trigger with mixed outcomes", () => {
      const unchangedObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:00:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 1, status: "failed", outcome: "unchanged" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:01:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 2, status: "failed", outcome: "unchanged" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:02:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 3, status: "failed", outcome: "unchanged" },
        },
      ];
      const h6 = runHeuristics(unchangedObs, { ...defaultThresholds, unchangedOutcome: 3 }).find((p) => p.id === "H6");
      expect(h6).toBeDefined();
      expect(h6?.severity).toBe("LOW");
      expect(h6?.target.action).toBe("advisory");

      const mixedObs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:00:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 1, status: "passed", outcome: "resolved" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:01:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 2, status: "failed", outcome: "unchanged" },
        },
      ];
      expect(
        runHeuristics(mixedObs, { ...defaultThresholds, unchangedOutcome: 2 }).find((p) => p.id === "H6"),
      ).toBeUndefined();
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
