/**
 * H4-H6 heuristics — escalation chains, stale chunks, fix-cycle outcomes,
 * plus the multi-heuristic and evidence/metadata guards.
 *
 * Split from curator-heuristics.test.ts, which crossed the 800-line test limit
 * after the #1929 cross-feature target fix added new H2/H4/H3-guard cases.
 */

import { describe, expect, test } from "bun:test";
import type { Observation } from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";

describe("runHeuristics", () => {
  const defaultThresholds: CuratorThresholds = {
    repeatedFinding: 2,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  describe("H4 — Escalation Chain", () => {
    test("triggers for same tier path >= threshold; does not trigger for different paths", () => {
      const samePathObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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

    test("targets the project-level rules file, not the oldest evidence row's feature, when sites span multiple features (#1929)", () => {
      const crossFeatureObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-context-fragments",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-onboarding",
          storyId: "story-3",
          stage: "escalation",
          ts: "2026-05-04T00:02:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
      ];

      const h4 = runHeuristics(crossFeatureObs, { ...defaultThresholds, escalationChain: 2 }).find(
        (p) => p.id === "H4",
      );
      expect(h4).toBeDefined();
      expect(h4?.target.canonicalFile).toBe(".nax/rules/curator-suggestions.md");
      expect(h4?.target.canonicalFile).not.toContain("feature-context-fragments");
      expect(h4?.target.canonicalFile).not.toContain(".nax/features/");
      expect(h4?.evidence).toContain("feature-context-fragments");
      expect(h4?.evidence).toContain("feature-billing");
      expect(h4?.evidence).toContain("feature-onboarding");
    });
  });

  describe("H5 — Stale Chunk Excluded", () => {
    test("triggers for stale exclusions persisting across runs; does not trigger for non-stale", () => {
      const staleObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
          projectKey: "test-proj",
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
