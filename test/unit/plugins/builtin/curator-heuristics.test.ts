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

  test("returns empty array for empty observations", () => {
    const proposals = runHeuristics([], defaultThresholds);
    expect(proposals).toEqual([]);
  });

  test("returns empty array for non-triggering observations", () => {
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        runId: "run-1",
        featureId: "feat-1",
        storyId: "story-1",
        stage: "context",
        ts: "2026-05-04T00:00:00Z",
        kind: "chunk-included",
        payload: { chunkId: "c1", label: "chunk 1", tokens: 100 },
      },
    ];
    const proposals = runHeuristics(obs, defaultThresholds);
    expect(proposals).toEqual([]);
  });

  test("uses default thresholds when config values are absent", () => {
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        runId: "run-1",
        featureId: "feat-1",
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
          featureId: "feat-1",
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
          featureId: "feat-1",
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
      expect(h1?.description).toContain("rule1");
      expect(h1?.target.action).toBe("add");
    });

    test("produces HIGH severity when finding count >= 4", () => {
      const obs: Observation[] = Array.from({ length: 4 }, (_, i) => ({
        schemaVersion: 1 as const,
        runId: "run-1",
        featureId: "feat-1",
        storyId: `story-${i}`,
        stage: "review" as const,
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding" as const,
        payload: {
          ruleId: "rule1",
          severity: "error",
          file: "src/index.ts",
          line: 10 + i,
          message: "test error",
        },
      }));

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.severity).toBe("HIGH");
    });

    test("does not trigger for 1 finding", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1).toBeUndefined();
    });

    test("includes storyIds in evidence", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
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
          featureId: "feat-1",
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
    test("triggers when pull-call with same empty keyword appears >= threshold times", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, emptyKeyword: 2 });
      const h2 = proposals.find((p) => p.id === "H2");

      expect(h2).toBeDefined();
      expect(h2?.severity).toBe("MED");
      expect(h2?.target.action).toBe("add");
      expect(h2?.description).toContain("review batch");
    });

    test("does not trigger for non-empty pull-call results", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, emptyKeyword: 2 });
      const h2 = proposals.find((p) => p.id === "H2");

      expect(h2).toBeUndefined();
    });
  });

  describe("H3 — Repeated Rectification Cycle", () => {
    test("triggers when same story has rectify-cycle attempts >= threshold", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, rectifyAttempts: 3 });
      const h3 = proposals.find((p) => p.id === "H3");

      expect(h3).toBeDefined();
      expect(h3?.severity).toBe("HIGH");
      expect(h3?.target.action).toBe("add");
    });

    test("does not trigger for different stories", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, rectifyAttempts: 3 });
      const h3 = proposals.find((p) => p.id === "H3");

      expect(h3).toBeUndefined();
    });
  });

  describe("H4 — Escalation Chain", () => {
    test("triggers when escalation count from specific tier -> tier >= threshold", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, escalationChain: 2 });
      const h4 = proposals.find((p) => p.id === "H4");

      expect(h4).toBeDefined();
      expect(h4?.severity).toBe("MED");
      expect(h4?.target.action).toBe("add");
    });

    test("distinguishes between different escalation paths", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, escalationChain: 2 });
      const h4 = proposals.find((p) => p.id === "H4");

      expect(h4).toBeUndefined();
    });
  });

  describe("H5 — Stale Chunk Excluded", () => {
    test("triggers when chunk-excluded with reason stale persists", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, staleChunkRuns: 2 });
      const h5 = proposals.find((p) => p.id === "H5");

      expect(h5).toBeDefined();
      expect(h5?.severity).toBe("LOW");
      expect(h5?.target.action).toBe("drop");
    });

    test("does not trigger for non-stale exclusions", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, staleChunkRuns: 2 });
      const h5 = proposals.find((p) => p.id === "H5");

      expect(h5).toBeUndefined();
    });
  });

  describe("H6 — Fix-cycle Unchanged Outcome", () => {
    test("triggers when fix-cycle-iteration has unchanged outcome >= threshold", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, unchangedOutcome: 3 });
      const h6 = proposals.find((p) => p.id === "H6");

      expect(h6).toBeDefined();
      expect(h6?.severity).toBe("LOW");
      expect(h6?.target.action).toBe("advisory");
    });

    test("does not trigger with mixed outcomes", () => {
      const obs: Observation[] = [
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

      const proposals = runHeuristics(obs, { ...defaultThresholds, unchangedOutcome: 2 });
      const h6 = proposals.find((p) => p.id === "H6");

      expect(h6).toBeUndefined();
    });
  });

  describe("Multiple heuristics firing", () => {
    test("returns all triggered proposals together", () => {
      const obs: Observation[] = [
        // H1: Repeated finding
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
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
          featureId: "feat-1",
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
          featureId: "feat-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:02:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          runId: "run-1",
          featureId: "feat-1",
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
          featureId: "feat-1",
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
          featureId: "feat-1",
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
          featureId: "feat-1",
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
          featureId: "feat-1",
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
