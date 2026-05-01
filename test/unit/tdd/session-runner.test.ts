/**
 * session-runner — stripped-config type boundary test (issue #745 Phase 4c).
 *
 * Verifies that runTddSession accepts a narrowed Pick (tddConfigSelector output)
 * without requiring a full NaxConfig cast at the call site.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, tddConfigSelector } from "../../../src/config";
import { _sessionRunnerDeps, runTddSession } from "../../../src/tdd/session-runner";
import { makeNaxConfig, makeStory } from "../../helpers";
import { fakeAgentManager } from "../../helpers/fake-agent-manager";
import { makeAgentAdapter } from "../../helpers/mock-agent-adapter";

// Stripped config — only the keys declared in tddConfigSelector.
const strippedConfig = tddConfigSelector.select(DEFAULT_CONFIG);

let origDeps: Record<string, unknown>;

beforeEach(() => {
  origDeps = {
    autoCommitIfDirty: _sessionRunnerDeps.autoCommitIfDirty,
    getChangedFiles: _sessionRunnerDeps.getChangedFiles,
    verifyImplementerIsolation: _sessionRunnerDeps.verifyImplementerIsolation,
    verifyTestWriterIsolation: _sessionRunnerDeps.verifyTestWriterIsolation,
    captureGitRef: _sessionRunnerDeps.captureGitRef,
    cleanupProcessTree: _sessionRunnerDeps.cleanupProcessTree,
    buildPrompt: _sessionRunnerDeps.buildPrompt,
  };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => []);
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "abc");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "mock prompt");
});

afterEach(() => {
  Object.assign(_sessionRunnerDeps, origDeps);
});

describe("runTddSession — narrowed config boundary (#745 Phase 4c)", () => {
  test("accepts tddConfigSelector output without full NaxConfig cast", async () => {
    const adapter = makeAgentAdapter({
      sendTurn: mock(async () => ({
        output: "tests pass",
        tokenUsage: undefined,
        internalRoundTrips: 1,
        estimatedCostUsd: 0,
      })),
    });

    // strippedConfig is Pick<NaxConfig, "tdd"|"execution"|"quality"|"agent"|"models">
    // — not a full NaxConfig. This must compile and run without a cast.
    const result = await runTddSession(
      "implementer",
      adapter as never,
      fakeAgentManager(adapter as never),
      makeStory(),
      strippedConfig,
      "/tmp/fake",
      "balanced",
      "HEAD",
    );

    expect(result.success).toBe(true);
  });

  test("strippedConfig preserves tdd keys from DEFAULT_CONFIG", () => {
    const full = makeNaxConfig();
    const stripped = tddConfigSelector.select(full);
    expect(stripped).toHaveProperty("tdd");
    expect(stripped).toHaveProperty("execution");
    expect(stripped).toHaveProperty("quality");
    expect(stripped).toHaveProperty("agent");
    expect(stripped).toHaveProperty("models");
    // Must NOT carry keys outside the selector's slice.
    expect(stripped).not.toHaveProperty("routing");
    expect(stripped).not.toHaveProperty("review");
    expect(stripped).not.toHaveProperty("debate");
  });
});
