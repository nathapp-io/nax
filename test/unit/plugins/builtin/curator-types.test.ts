/**
 * Curator Observation Types Tests
 */

import { describe, expect, test } from "bun:test";
import type {
  ChunkIncludedObservation,
  ChunkExcludedObservation,
  ProviderEmptyObservation,
  ReviewFindingObservation,
  RectifyCycleObservation,
  EscalationObservation,
  AcceptanceVerdictObservation,
  PullCallObservation,
  VerdictObservation,
  FixCycleIterationObservation,
  Observation,
} from "../../../../src/plugins/builtin/curator";

describe("Observation Types", () => {
  test("ChunkIncludedObservation should have correct shape", () => {
    const obs: ChunkIncludedObservation = {
      schemaVersion: 1,
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
