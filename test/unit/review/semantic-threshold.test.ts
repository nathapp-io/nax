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
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSpawn } from "@test/helpers";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { SemanticStory } from "@/review/semantic";
import { _semanticDeps, runSemanticReview } from "@/review/semantic";
import type { SemanticReviewConfig } from "@/review/types";

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
  model: "balanced",
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
    {
      severity: "error",
      file: "src/blockingThreshold.ts",
      line: 2,
      issue: "An error",
      suggestion: "Fix error",
      acQuote: "blockingThreshold controls which findings block",
      acIndex: 1,
    },
  ],
});

// LLM response: only a warning
const WARNING_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [{ severity: "warning", file: "src/foo.ts", line: 1, issue: "Just a warning", suggestion: "Fix it" }],
});

// LLM response: only an info finding
const INFO_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [{ severity: "info", file: "src/foo.ts", line: 1, issue: "Just info", suggestion: "FYI" }],
});

function makeAgentManager(llmResponse: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, _opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
    runWithFallbackFn: async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [],
      },
      fallbacks: [],
    }),
    completeWithFallbackFn: async () => ({
      result: {
        output: llmResponse,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: cost,
      },
      fallbacks: [],
    }),
    runAsFn: async (_agent, _opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeAsFn: async (_agent, _prompt, _opts) => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
  });
}

function makeSpawnMock(stdout = "src/foo.ts | 2 ++") {
  return makeSpawn(() => stdout).spawn;
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
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings).toBeDefined();
    const advisoryFindings = result.advisoryFindings;
    assertDefined(advisoryFindings, "result.advisoryFindings");
    expect(advisoryFindings.length).toBe(1);
    expect(advisoryFindings[0].message).toBe("Just a warning");
  });

  test("error finding blocks by default (goes to findings)", async () => {
    const errorOnly = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "src/blockingThreshold.ts",
          line: 1,
          issue: "An error",
          suggestion: "Fix",
          acQuote: "blockingThreshold controls which findings block",
          acIndex: 1,
        },
      ],
    });
    const agentManager = makeAgentManager(errorOnly);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.findings).toBeDefined();
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(1);
  });

  test("mixed: error goes to findings, warning to advisoryFindings by default", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(1);
    expect(findings[0].message).toBe("An error");
    const advisoryFindings = result.advisoryFindings;
    assertDefined(advisoryFindings, "result.advisoryFindings");
    expect(advisoryFindings.length).toBe(1);
    expect(advisoryFindings[0].message).toBe("A warning");
  });

  test("info finding goes to advisoryFindings by default", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    const advisoryFindings = result.advisoryFindings;
    assertDefined(advisoryFindings, "result.advisoryFindings");
    expect(advisoryFindings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// "warning" threshold
// ---------------------------------------------------------------------------

describe("runSemanticReview — blockingThreshold: 'warning'", () => {
  test("warning finding blocks when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(WARNING_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      blockingThreshold: "warning",
      runtime,
    });

    expect(result.success).toBe(false);
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });

  test("info finding remains advisory when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      blockingThreshold: "warning",
      runtime,
    });

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    const advisoryFindings = result.advisoryFindings;
    assertDefined(advisoryFindings, "result.advisoryFindings");
    expect(advisoryFindings.length).toBe(1);
  });

  test("both error and warning block when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      blockingThreshold: "warning",
      runtime,
    });

    expect(result.success).toBe(false);
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(2);
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
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      blockingThreshold: "info",
      runtime,
    });

    expect(result.success).toBe(false);
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(1);
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
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      blockingThreshold: "warning",
      runtime,
    });

    // Both findings are blocking at "warning" threshold
    expect(result.advisoryFindings).toBeUndefined();
  });

  test("advisoryFindings is undefined when passed=true with no findings", async () => {
    const agentManager = makeAgentManager(JSON.stringify({ passed: true, findings: [] }));
    const runtime = makeMockRuntime({ agentManager });
    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.advisoryFindings).toBeUndefined();
  });
});
