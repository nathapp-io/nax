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
import type { AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { _adversarialDeps, runAdversarialReview } from "../../../src/review/adversarial";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";

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
  modelTier: "balanced",
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
    { severity: "warning", category: "input", file: "src/foo.ts", line: 1, issue: "A warning", suggestion: "Fix it" },
  ],
});

const ERROR_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "error", category: "error-path", file: "src/bar.ts", line: 2, issue: "An error", suggestion: "Fix error" },
  ],
});

const MIXED_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    { severity: "warning", category: "input", file: "src/foo.ts", line: 1, issue: "A warning", suggestion: "Fix w" },
    { severity: "error", category: "error-path", file: "src/bar.ts", line: 2, issue: "An error", suggestion: "Fix e" },
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
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" as const }),
  });
}

function makeSpawnMock(stdout = STAT_OUTPUT) {
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
    const result = await runAdversarialReview("/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(WARNING_ONLY_RESPONSE));

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings![0].message).toBe("A warning");
  });

  test("error finding blocks by default", async () => {
    const result = await runAdversarialReview("/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(ERROR_ONLY_RESPONSE));

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });

  test("mixed: error blocks, warning advisory by default", async () => {
    const result = await runAdversarialReview("/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(MIXED_RESPONSE));

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(result.findings![0].message).toBe("An error");
    expect(result.advisoryFindings!.length).toBe(1);
    expect(result.advisoryFindings![0].message).toBe("A warning");
  });

  test("info finding goes to advisoryFindings by default", async () => {
    const result = await runAdversarialReview("/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(INFO_ONLY_RESPONSE));

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// "warning" threshold
// ---------------------------------------------------------------------------

describe("runAdversarialReview — blockingThreshold: 'warning'", () => {
  test("warning finding blocks when threshold is 'warning'", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(WARNING_ONLY_RESPONSE),
      undefined, undefined, undefined, "warning",
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });

  test("info finding remains advisory when threshold is 'warning'", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(INFO_ONLY_RESPONSE),
      undefined, undefined, undefined, "warning",
    );

    expect(result.success).toBe(true);
    expect(!result.findings || result.findings.length === 0).toBe(true);
    expect(result.advisoryFindings!.length).toBe(1);
  });

  test("both error and warning block when threshold is 'warning'", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(MIXED_RESPONSE),
      undefined, undefined, undefined, "warning",
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(2);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// "info" threshold
// ---------------------------------------------------------------------------

describe("runAdversarialReview — blockingThreshold: 'info'", () => {
  test("info finding blocks when threshold is 'info'", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(INFO_ONLY_RESPONSE),
      undefined, undefined, undefined, "info",
    );

    expect(result.success).toBe(false);
    expect(result.findings!.length).toBe(1);
    expect(!result.advisoryFindings || result.advisoryFindings.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// advisoryFindings absent when no advisory findings
// ---------------------------------------------------------------------------

describe("runAdversarialReview — advisoryFindings absent when no advisory findings", () => {
  test("advisoryFindings is undefined when all findings block", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG, makeAgentManager(MIXED_RESPONSE),
      undefined, undefined, undefined, "warning",
    );

    expect(result.advisoryFindings).toBeUndefined();
  });

  test("advisoryFindings is undefined when passed=true with no findings", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd", "abc123", STORY, BASE_CFG,
      makeAgentManager(JSON.stringify({ passed: true, findings: [] })),
    );

    expect(result.advisoryFindings).toBeUndefined();
  });
});
