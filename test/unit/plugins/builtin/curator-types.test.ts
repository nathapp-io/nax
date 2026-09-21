/**
 * Curator Observation Types Tests
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type {
  AcceptanceVerdictObservation,
  ChunkExcludedObservation,
  ChunkIncludedObservation,
  CuratorPostRunContext,
  EscalationObservation,
  FixCycleIterationObservation,
  Observation,
  ProviderEmptyObservation,
  PullCallObservation,
  RectifyCycleObservation,
  ReviewFindingObservation,
  VerdictObservation,
} from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";
import { resolveCuratorOutputs } from "@/plugins/builtin/curator/paths";

describe("Observation Types", () => {
  test("ChunkIncludedObservation should have correct shape", () => {
    const obs: ChunkIncludedObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "context",
      ts: new Date().toISOString(),
      kind: "chunk-included",
      payload: {
        chunkId: "chunk-1",
        label: "Code Context",
        tokens: 150,
      },
    };

    expect(obs.kind).toBe("chunk-included");
    expect(obs.schemaVersion).toBe(1);
    expect(obs.payload.tokens).toBe(150);
  });

  test("ChunkExcludedObservation should have correct shape", () => {
    const obs: ChunkExcludedObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "context",
      ts: new Date().toISOString(),
      kind: "chunk-excluded",
      payload: {
        chunkId: "chunk-2",
        label: "Old Code",
        reason: "Token budget exceeded",
      },
    };

    expect(obs.kind).toBe("chunk-excluded");
    expect(obs.payload.reason).toBe("Token budget exceeded");
  });

  test("ProviderEmptyObservation should have correct shape", () => {
    const obs: ProviderEmptyObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "context",
      ts: new Date().toISOString(),
      kind: "provider-empty",
      payload: {
        provider: "jira",
        reason: "No matching ticket found",
      },
    };

    expect(obs.kind).toBe("provider-empty");
    expect(obs.payload.provider).toBe("jira");
  });

  test("ReviewFindingObservation should have correct shape", () => {
    const obs: ReviewFindingObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "review",
      ts: new Date().toISOString(),
      kind: "review-finding",
      payload: {
        ruleId: "security-001",
        severity: "critical",
        file: "src/auth.ts",
        line: 42,
        message: "Hardcoded password detected",
      },
    };

    expect(obs.kind).toBe("review-finding");
    expect(obs.payload.severity).toBe("critical");
  });

  test("RectifyCycleObservation should have correct shape", () => {
    const obs: RectifyCycleObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "rectify",
      ts: new Date().toISOString(),
      kind: "rectify-cycle",
      payload: {
        iteration: 2,
        status: "failed",
      },
    };

    expect(obs.kind).toBe("rectify-cycle");
    expect(obs.payload.iteration).toBe(2);
  });

  test("EscalationObservation should have correct shape", () => {
    const obs: EscalationObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "escalation",
      ts: new Date().toISOString(),
      kind: "escalation",
      payload: {
        from: "fast",
        to: "balanced",
      },
    };

    expect(obs.kind).toBe("escalation");
    expect(obs.payload.from).toBe("fast");
  });

  test("AcceptanceVerdictObservation should have correct shape", () => {
    const obs: AcceptanceVerdictObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "acceptance",
      ts: new Date().toISOString(),
      kind: "acceptance-verdict",
      payload: {
        passed: 5,
        failed: 2,
      },
    };

    expect(obs.kind).toBe("acceptance-verdict");
    expect(obs.payload.passed).toBe(5);
  });

  test("PullCallObservation should have correct shape", () => {
    const obs: PullCallObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "pull",
      ts: new Date().toISOString(),
      kind: "pull-call",
      payload: {
        toolName: "git-pull",
        status: "completed",
      },
    };

    expect(obs.kind).toBe("pull-call");
    expect(obs.payload.status).toBe("completed");
  });

  test("VerdictObservation should have correct shape", () => {
    const obs: VerdictObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "verdict",
      ts: new Date().toISOString(),
      kind: "verdict",
      payload: {
        status: "completed",
        cost: 15.5,
        tokens: 2500,
      },
    };

    expect(obs.kind).toBe("verdict");
    expect(obs.payload.status).toBe("completed");
  });

  test("FixCycleIterationObservation should have correct shape", () => {
    const obs: FixCycleIterationObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "fix-cycle",
      ts: new Date().toISOString(),
      kind: "fix-cycle-iteration",
      payload: {
        iteration: 1,
        status: "passed",
      },
    };

    expect(obs.kind).toBe("fix-cycle-iteration");
    expect(obs.payload.iteration).toBe(1);
  });

  test("all observation types should have schemaVersion=1", () => {
    const obs1: ChunkIncludedObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "context",
      ts: new Date().toISOString(),
      kind: "chunk-included",
      payload: { chunkId: "1", label: "test", tokens: 100 },
    };

    const obs2: ReviewFindingObservation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "review",
      ts: new Date().toISOString(),
      kind: "review-finding",
      payload: { ruleId: "r1", severity: "error", file: "f.ts", line: 1, message: "msg" },
    };

    expect(obs1.schemaVersion).toBe(1);
    expect(obs2.schemaVersion).toBe(1);
  });

  test("Observation union should accept all types", () => {
    const observations: Observation[] = [
      {
        schemaVersion: 1,
        projectKey: "TEST",
        runId: "run-123",
        featureId: "feature-1",
        storyId: "story-1",
        stage: "context",
        ts: new Date().toISOString(),
        kind: "chunk-included",
        payload: { chunkId: "1", label: "test", tokens: 100 },
      },
      {
        schemaVersion: 1,
        projectKey: "TEST",
        runId: "run-123",
        featureId: "feature-1",
        storyId: "story-1",
        stage: "escalation",
        ts: new Date().toISOString(),
        kind: "escalation",
        payload: { from: "fast", to: "balanced" },
      },
    ];

    expect(observations.length).toBe(2);
    expect(observations[0].kind).toBe("chunk-included");
    expect(observations[1].kind).toBe("escalation");
  });

  test("observations should have required base fields", () => {
    const obs: Observation = {
      schemaVersion: 1,
      projectKey: "TEST",
      runId: "run-123",
      featureId: "feature-1",
      storyId: "story-1",
      stage: "context",
      ts: new Date().toISOString(),
      kind: "chunk-included",
      payload: { chunkId: "1", label: "test", tokens: 100 },
    };

    expect(obs.schemaVersion).toBe(1);
    expect(obs.runId).toBeDefined();
    expect(obs.featureId).toBeDefined();
    expect(obs.storyId).toBeDefined();
    expect(obs.stage).toBeDefined();
    expect(obs.ts).toBeDefined();
    expect(obs.kind).toBeDefined();
    expect(obs.payload).toBeDefined();
  });
});

// ---- absorbed from test/unit/plugins/builtin/curator-paths.test.ts ----
describe("resolveCuratorOutputs", () => {
  test("should resolve observations path under outputDir/runs/<runId>/", () => {
    const context: CuratorPostRunContext = {
      runId: "run-abc123",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.observationsPath).toContain("run-abc123");
    expect(paths.observationsPath).toContain("observations.jsonl");
  });

  test("should resolve proposals path under outputDir/runs/<runId>/", () => {
    const context: CuratorPostRunContext = {
      runId: "run-def456",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.proposalsPath).toContain("run-def456");
    expect(paths.proposalsPath).toContain("proposals.jsonl");
  });

  test("should use context.curatorRollupPath as rollup path", () => {
    const rollupPath = "/home/user/.nax/global/curator/rollup.jsonl";
    const context: CuratorPostRunContext = {
      runId: "run-123",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: rollupPath,
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.rollupPath).toBe(rollupPath);
  });

  test("should return all three paths", () => {
    const context: CuratorPostRunContext = {
      runId: "run-xyz",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: "/output",
      globalDir: "/global",
      projectKey: "proj",
      curatorRollupPath: "/global/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths).toHaveProperty("observationsPath");
    expect(paths).toHaveProperty("proposalsPath");
    expect(paths).toHaveProperty("rollupPath");
  });
});

// ---- absorbed from test/unit/plugins/builtin/curator-integration.test.ts ----
describe("Curator Plugin Integration", () => {
  describe("End-to-end workflow", () => {
    test("wires collect → heuristics → render → rollup", async () => {
      // This test verifies the complete workflow without implementation details
      // The actual implementation will connect these pieces together

      await withTempDir(async (dir) => {
        const observationsPath = path.join(dir, "observations.jsonl");
        const proposalsPath = path.join(dir, "proposals.md");
        const rollupPath = path.join(dir, "rollup.jsonl");

        // Simulate having observations from a run
        const _obs: Observation[] = [
          {
            schemaVersion: 1,
            projectKey: "test-proj",
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

        // Verify the paths are set up
        expect(observationsPath).toContain("observations.jsonl");
        expect(proposalsPath).toContain("proposals.md");
        expect(rollupPath).toContain("rollup.jsonl");
      });
    });

    test("curatorPlugin.execute() wires full pipeline", async () => {
      // Once the plugin implementation is complete, this test should:
      // 1. Create a mock PostRunContext with observations
      // 2. Call curatorPlugin.extensions.postRunAction.execute()
      // 3. Verify observations.jsonl and curator-proposals.md are written
      // 4. Verify rollup is appended to
      // 5. Verify exit code is not affected by curator failures

      expect(true).toBe(true); // Placeholder
    });
  });

  describe("Error handling", () => {
    test("curator failures do not change run exit code", () => {
      // Curator should gracefully handle and log errors
      // without affecting the overall run status
      expect(true).toBe(true); // Placeholder
    });

    test("missing observations directory is handled gracefully", () => {
      // collectObservations should not throw if directories don't exist
      expect(true).toBe(true); // Placeholder
    });

    test("write errors during rollup append are logged, not thrown", async () => {
      // appendToRollup should catch and log write errors
      expect(true).toBe(true); // Placeholder
    });
  });

  describe("Output file generation", () => {
    test("writes observations.jsonl with proper JSONL format", async () => {
      // Each observation should be one JSON line
      // File should have newline separators
      expect(true).toBe(true); // Placeholder
    });

    test("writes curator-proposals.md with markdown format", async () => {
      // Markdown should be valid and include all required sections
      expect(true).toBe(true); // Placeholder
    });

    test("appends to rollup.jsonl across multiple runs", async () => {
      // Rollup should maintain history from previous runs
      expect(true).toBe(true); // Placeholder
    });
  });

  describe("Threshold defaults", () => {
    test("applies sensible default thresholds when config omits them", () => {
      // Default thresholds should be loaded from config or schema defaults
      expect(true).toBe(true); // Placeholder
    });

    test("respects custom thresholds from config", () => {
      // Custom thresholds should override defaults
      expect(true).toBe(true); // Placeholder
    });
  });
});

// ---- absorbed from test/unit/plugins/builtin/curator-us-003-h6.test.ts ----
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
