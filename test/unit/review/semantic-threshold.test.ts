/**
 * Unit tests for blockingThreshold in runSemanticReview.
 *
 * Tests cover:
 * - default ("error"): warnings are advisory, errors block
 * - "warning" threshold: warnings become blocking
 * - advisoryFindings is populated with below-threshold findings
 * - success=true when all findings are below threshold
 * - "info" threshold: all findings block
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-THR",
  title: "Threshold tests",
  description: "Validate blocking threshold logic",
  acceptanceCriteria: ["blockingThreshold controls which findings block"],
};

const BASE_CFG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/"],
  timeoutMs: 60_000,
};

// LLM response: one warning, one error
const MIXED_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "warning", file: "src/foo.ts", line: 1, issue: "A warning", suggestion: "Fix warning" },
    { severity: "error", file: "src/bar.ts", line: 2, issue: "An error", suggestion: "Fix error" },
  ],
});

// LLM response: only a warning
const WARNING_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "warning", file: "src/foo.ts", line: 1, issue: "Just a warning", suggestion: "Fix it" },
  ],
});

// LLM response: only an info finding
const INFO_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "info", file: "src/foo.ts", line: 1, issue: "Just info", suggestion: "FYI" },
  ],
});

function makeAgentManager(llmResponse: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: cost, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeAsFn: async (_agent, _prompt, _opts) => ({ output: llmResponse, costUsd: cost, source: "mock" }),
  });
}

function makeSpawnMock(stdout = "src/foo.ts | 2 ++") {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _semanticDeps.writeReviewAudit;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _semanticDeps.writeReviewAudit;
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock();
  _semanticDeps.writeReviewAudit = mock(async () => {});
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _semanticDeps.writeReviewAudit = origWriteReviewAudit;
});

// ---------------------------------------------------------------------------
// Default threshold ("error")
// ---------------------------------------------------------------------------

describe("runSemanticReview — blockingThreshold defaults to 'error'", () => {
  test("warning finding goes to advisoryFindings, not findings, by default", async () => {
    const agentManager = makeAgentManager(WARNING_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, BASE_CFG, agentManager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings!.length).toBe(1);
    expect(result.advisoryFindings![0].message).toBe("Just a warning");
  });

  test("error finding blocks by default (goes to findings)", async () => {
    const errorOnly = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/a.ts", line: 1, issue: "An error", suggestion: "Fix" }],
    });
    const agentManager = makeAgentManager(errorOnly);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, BASE_CFG, agentManager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);

    expect(result.success).toBe(false);
    expect(result.findings).toBeDefined();
    expect(result.findings!.length).toBe(1);
  });

  test("mixed: error goes to findings, warning to advisoryFindings by default", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, BASE_CFG, agentManager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(result.findings![0].message).toBe("An error");
    expect(result.advisoryFindings!.length).toBe(1);
    expect(result.advisoryFindings![0].message).toBe("A warning");
  });

  test("info finding goes to advisoryFindings by default", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, BASE_CFG, agentManager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// "warning" threshold
// ---------------------------------------------------------------------------

describe("runSemanticReview — blockingThreshold: 'warning'", () => {
  test("warning finding blocks when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(WARNING_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, "warning", undefined, undefined, undefined, undefined, runtime,
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });

  test("info finding remains advisory when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, "warning", undefined, undefined, undefined, undefined, runtime,
    );

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings!.length).toBe(1);
  });

  test("both error and warning block when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, "warning", undefined, undefined, undefined, undefined, runtime,
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(2);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// "info" threshold
// ---------------------------------------------------------------------------

describe("runSemanticReview — blockingThreshold: 'info'", () => {
  test("info finding blocks when threshold is 'info'", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, "info", undefined, undefined, undefined, undefined, runtime,
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// advisoryFindings absent when no advisory findings
// ---------------------------------------------------------------------------

describe("runSemanticReview — advisoryFindings absent when no advisory findings", () => {
  test("advisoryFindings is undefined when all findings block", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, "warning", undefined, undefined, undefined, undefined, runtime,
    );

    // Both findings are blocking at "warning" threshold
    expect(result.advisoryFindings).toBeUndefined();
  });

  test("advisoryFindings is undefined when passed=true with no findings", async () => {
    const agentManager = makeAgentManager(JSON.stringify({ passed: true, findings: [] }));
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, agentManager,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime,
    );

    expect(result.advisoryFindings).toBeUndefined();
  });
});
