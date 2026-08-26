/**
 * Unit tests for blockingThreshold in runAdversarialReview.
 *
 * Tests cover:
 * - default ("error"): warnings are advisory, errors block
 * - "warning" threshold: warnings become blocking
 * - advisoryFindings populated with below-threshold findings
 * - success=true when all findings below threshold
 * - "info" threshold: all findings block
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSpawn } from "@test/helpers";
import type { IAgentManager } from "@/agents/manager-types";
import { _adversarialDeps, runAdversarialReview } from "@/review/adversarial";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { AdversarialReviewConfig, SemanticStory } from "@/review/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-ADV-THR",
  title: "Adversarial threshold tests",
  description: "Validate blocking threshold logic for adversarial reviewer",
  acceptanceCriteria: ["blockingThreshold controls which findings block"],
};

const BASE_CFG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 180_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 2,
};

const STAT_OUTPUT = "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

// LLM responses
const WARNING_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warning",
      category: "input",
      file: "src/foo.ts",
      line: 1,
      issue: "A warning",
      suggestion: "Fix it",
      verifiedBy: { file: "src/foo.ts", observed: "warning stub" },
    },
  ],
});

// #1359 — the observed US-004 shape: an advisory finding that asks for nothing.
const COMPLIANCE_RESPONSE = JSON.stringify({
  passed: true,
  findings: [
    {
      severity: "warning",
      category: "out-of-scope",
      file: "src/foo.ts",
      line: 1,
      issue: "Removed quarantined:0 — correct per Out of Scope #10 which mandates omission",
      suggestion: "No action needed; this is the intended behaviour.",
      actionRequired: false,
      verifiedBy: { file: "src/foo.ts", observed: "warning stub" },
    },
  ],
});

const ERROR_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "error-path",
      file: "src/findings-bar.ts",
      line: 2,
      issue: "An error",
      suggestion: "Fix error",
      acQuote: "findings",
      acIndex: 1,
      verifiedBy: { file: "src/findings-bar.ts", observed: "error stub" },
    },
  ],
});

// #1359 — actionRequired must not become a "do not block me" escape hatch.
const BLOCKING_WITH_NO_ACTION_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "error-path",
      file: "src/findings-bar.ts",
      line: 2,
      issue: "An error the reviewer would rather not be held to",
      suggestion: "Fix error",
      acQuote: "findings",
      acIndex: 1,
      actionRequired: false,
      verifiedBy: { file: "src/findings-bar.ts", observed: "error stub" },
    },
  ],
});

const MIXED_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warning",
      category: "input",
      file: "src/foo.ts",
      line: 1,
      issue: "A warning",
      suggestion: "Fix w",
      verifiedBy: { file: "src/foo.ts", observed: "warning stub" },
    },
    {
      severity: "error",
      category: "error-path",
      file: "src/findings-bar.ts",
      line: 2,
      issue: "An error",
      suggestion: "Fix e",
      acQuote: "findings",
      acIndex: 1,
      verifiedBy: { file: "src/findings-bar.ts", observed: "error stub" },
    },
  ],
});

const INFO_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "info", category: "abandonment", file: "src/baz.ts", line: 3, issue: "Just info", suggestion: "FYI" },
  ],
});

function makeAgentManager(llmResponse: string, cost = 0): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agentName: string, _opts: unknown) => ({
      success: true as const,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeFn: async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
    runWithFallbackFn: async () => ({
      result: {
        success: true as const,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [] as unknown[],
      },
      fallbacks: [],
    }),
  });
}

function makeSpawnMock(stdout = STAT_OUTPUT) {
  return makeSpawn(() => stdout).spawn;
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock();
  _adversarialDeps.writeReviewAudit = mock(async () => {});
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
});

// ---------------------------------------------------------------------------
// Default threshold ("error")
// ---------------------------------------------------------------------------

describe("runAdversarialReview — blockingThreshold defaults to 'error'", () => {
  test("warning finding goes to advisoryFindings, not findings, by default", async () => {
    const agentManager = makeAgentManager(WARNING_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    const advisoryFindings = result.advisoryFindings;
    assertDefined(advisoryFindings, "result.advisoryFindings");
    expect(advisoryFindings[0].message).toBe("A warning");
  });

  // #1359 — the actionability filter reads `actionRequired` off the wire Finding, so it
  // has to survive the whole reviewer pipeline (parse → substantiate → recurrence split
  // → projection), not just the projection helper the unit test covers.
  test("actionRequired: false survives the reviewer pipeline onto the advisory finding", async () => {
    const agentManager = makeAgentManager(COMPLIANCE_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.advisoryFindings?.[0]?.actionRequired).toBe(false);
  });

  test("actionRequired: false does NOT let a blocking finding escape the gate (#1359)", async () => {
    // The filter is scoped to the advisory bucket at nbf seeding. If it ever reached the
    // blocking bucket, a reviewer could self-exempt any error finding by flagging it
    // no-action — turning an advisory hint into a story-verdict override.
    const agentManager = makeAgentManager(BLOCKING_WITH_NO_ACTION_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.findings?.length).toBeGreaterThan(0);
  });

  test("error finding blocks by default", async () => {
    const agentManager = makeAgentManager(ERROR_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });

  test("mixed: error blocks, warning advisory by default", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
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
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
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

describe("runAdversarialReview — blockingThreshold: 'warning'", () => {
  test("warning finding blocks when threshold is 'warning'", async () => {
    const agentManager = makeAgentManager(WARNING_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
      blockingThreshold: "warning",
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
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
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
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
      blockingThreshold: "warning",
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

describe("runAdversarialReview — blockingThreshold: 'info'", () => {
  test("info finding blocks when threshold is 'info'", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
      blockingThreshold: "info",
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

describe("runAdversarialReview — advisoryFindings absent when no advisory findings", () => {
  test("advisoryFindings is undefined when all findings block", async () => {
    const agentManager = makeAgentManager(MIXED_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
      blockingThreshold: "info",
    });

    expect(result.advisoryFindings).toBeUndefined();
  });

  test("advisoryFindings is undefined when passed=true with no findings", async () => {
    const agentManager = makeAgentManager(JSON.stringify({ passed: true, findings: [] }));
    const runtime = makeMockRuntime({ agentManager });
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: BASE_CFG,
      agentManager,
      runtime,
      blockingThreshold: "info",
    });

    expect(result.advisoryFindings).toBeUndefined();
  });
});
