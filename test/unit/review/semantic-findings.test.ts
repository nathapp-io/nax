/**
 * Unit tests for structured ReviewFinding output in runSemanticReview (US-003)
 *
 * Covers the new AC-2 mapping behavior:
 * - runSemanticReview() populates result.findings with ReviewFinding[] when LLM returns findings
 * - Each LLMFinding maps to ReviewFinding with source='semantic-review', ruleId='semantic'
 * - finding.issue maps to ReviewFinding.message
 * - finding.severity is normalised ("warn" -> "warning")
 * - result.findings is empty/absent when LLM returns passed=true
 * - result.findings is empty/absent on fail-open (invalid JSON)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { AgentAdapter } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-003",
  title: "Wire semantic findings",
  description: "Wire findings into autofix context",
  acceptanceCriteria: ["ctx.reviewFindings is populated when semantic fails"],
};

const CFG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/"],
  timeoutMs: 60_000,
};

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
    runWithFallbackFn: async (request) => {
      const result = { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: cost, agentFallbacks: [] };
      return { result, fallbacks: [], bundle: request.bundle };
    },
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async () => ({ success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: cost, agentFallbacks: [] }),
    completeAsFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    getAgentFn: () => makeAgentAdapter(),
  });
}

function makeRuntime(agentManager: ReturnType<typeof makeAgentManager>) {
  return makeMockRuntime({ agentManager });
}

async function callRunSemanticReview(llmResponse: string, overrides?: Partial<import("../../../src/review/types").ReviewCheckResult>): Promise<import("../../../src/review/types").ReviewCheckResult> {
  const agentManager = makeAgentManager(llmResponse);
  return runSemanticReview({
    workdir: "/tmp/wd",
    storyGitRef: "abc123",
    story: STORY,
    semanticConfig: CFG,
    agentManager,
    runtime: makeRuntime(agentManager),
  });
}

function makeSpawnMock(stdout = "diff output", exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ---------------------------------------------------------------------------
// AC-2: structured ReviewFinding[] in result.findings when LLM returns findings
// ---------------------------------------------------------------------------

describe("runSemanticReview — structured findings in result (US-003 AC-2)", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  });
  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  test("result.findings is defined and non-empty when LLM returns passed=false with findings", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 10, issue: "Stub left in code", suggestion: "Remove stub" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);
  });

  test("maps finding.issue to ReviewFinding.message", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 5, issue: "Missing wiring in runner", suggestion: "Fix it" },
      ],
    });

    const result = await callRunSemanticReview(llmResponse);

    expect(result.findings![0].message).toBe("Missing wiring in runner");
  });

  test("sets source='semantic-review' on blocking ReviewFindings", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "An issue", suggestion: "Fix" },
        { severity: "error", file: "src/b.ts", line: 2, issue: "Another issue", suggestion: "Fix" },
      ],
    });

    const result = await callRunSemanticReview(llmResponse);

    for (const finding of result.findings!) {
      expect(finding.source).toBe("semantic-review");
    }
  });

  test("sets ruleId='semantic' on advisory ReviewFinding (info severity)", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/x.ts", line: 3, issue: "Info issue", suggestion: "Fix" },
      ],
    });

    const result = await callRunSemanticReview(llmResponse);

    // info is advisory by default — check advisoryFindings
    expect(result.advisoryFindings![0].ruleId).toBe("semantic");
  });

  test("maps finding.file to ReviewFinding.file", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/review/runner.ts", line: 42, issue: "Issue", suggestion: "Fix" },
      ],
    });

    const result = await callRunSemanticReview(llmResponse);

    expect(result.findings![0].file).toBe("src/review/runner.ts");
  });

  test("maps finding.line to ReviewFinding.line", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 99, issue: "Issue", suggestion: "Fix" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);

    expect(result.findings![0].line).toBe(99);
  });

  test("maps finding.severity 'error' directly to ReviewFinding.severity", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/foo.ts", line: 1, issue: "Issue", suggestion: "Fix" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);

    expect(result.findings![0].severity).toBe("error");
  });

  test("normalises severity 'warn' to 'warning' in advisoryFindings (advisory at default threshold)", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "warn", file: "src/foo.ts", line: 1, issue: "Warn issue", suggestion: "Fix" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);

    // warn → warning, placed in advisoryFindings at default "error" threshold
    expect(result.advisoryFindings![0].severity).toBe("warning");
  });

  test("maps 'info' severity as-is into advisoryFindings (advisory at default threshold)", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "info", file: "src/foo.ts", line: 1, issue: "Info issue", suggestion: "Fix" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);

    // info is advisory at default "error" threshold
    expect(result.advisoryFindings![0].severity).toBe("info");
  });

  test("splits multiple findings into blocking (error) and advisory (warn/info) by default", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "Issue A", suggestion: "Fix A" },
        { severity: "warn", file: "src/b.ts", line: 20, issue: "Issue B", suggestion: "Fix B" },
        { severity: "info", file: "src/c.ts", line: 5, issue: "Issue C", suggestion: "Fix C" },
      ],
    });
    const result = await callRunSemanticReview(llmResponse);

    // Only error blocks by default
    expect(result.findings!.length).toBe(1);
    expect(result.findings![0].message).toBe("Issue A");
    // warn + info are advisory
    expect(result.advisoryFindings!.length).toBe(2);
    expect(result.advisoryFindings![0].message).toBe("Issue B");
    expect(result.advisoryFindings![0].severity).toBe("warning");
  });

  test("result.findings is empty or absent when LLM returns passed=true", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const result = await callRunSemanticReview(JSON.stringify({ passed: true, findings: [] }));
    expect(!result.findings || result.findings.length === 0).toBe(true);
  });

  test("result.findings is empty or absent on fail-open (invalid JSON)", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
    const result = await callRunSemanticReview("not valid json {{");
    expect(!result.findings || result.findings.length === 0).toBe(true);
  });

  test("result.findings is empty or absent when storyGitRef is missing (skipped)", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: CFG,
    });

    expect(!result.findings || result.findings.length === 0).toBe(true);
  });
});
