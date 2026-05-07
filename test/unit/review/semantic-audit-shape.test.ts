/**
 * Issue #942 AC-1 / AC-2 — semantic reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw LLMFinding[].
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IReviewAuditor, ReviewAuditDecision } from "../../../src/runtime";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { runSemanticReview } from "../../../src/review/semantic";
import type { SemanticReviewConfig, SemanticStory } from "../../../src/review/types";
import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "../../helpers";

const STORY: SemanticStory = {
  id: "US-001",
  title: "Test semantic audit shape",
  description: "Validate canonical shape on disk",
  acceptanceCriteria: [
    "AC-1: validate input",
    "AC-2: must validate listener input",
  ],
};

const CFG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/"],
  timeoutMs: 60_000,
};

const SEMANTIC_LLM_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      file: "src/foo.ts",
      line: 73,
      issue: "onAgentStream(listener) does not validate that listener is a function",
      suggestion: "Add a typeof guard at the top of the function",
      acId: "AC-2",
      acQuote: "must validate listener input",
      acIndex: 2,
    },
    {
      severity: "warning",
      file: "src/foo.ts",
      line: 81,
      issue: "Listener errors are swallowed when logger is null",
      suggestion: "",
    },
  ],
});

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

describe("semantic reviewer audit shape (#942 AC-1 / AC-2)", () => {
  const decisions: ReviewAuditDecision[] = [];

  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    decisions.length = 0;
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock("some diff");
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  function makeReviewAuditor(): IReviewAuditor {
    return {
      recordDispatch: () => {},
      recordDecision: (entry) => { decisions.push(entry); },
      flush: async () => {},
    };
  }

  const COMPLETE_RESULT_BASE = {
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
  };

  function makeAgentManagerForResponse(llmResponse: string) {
    return makeMockAgentManager({
      getDefaultAgent: "claude",
      runFn: async (_agent, _opts) => ({
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
        agentFallbacks: [],
      }),
      completeFn: async () => ({ output: llmResponse, ...COMPLETE_RESULT_BASE }),
      runWithFallbackFn: async (request) => ({
        result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
        bundle: request.bundle,
      }),
      completeWithFallbackFn: async () => ({ result: { output: llmResponse, ...COMPLETE_RESULT_BASE }, fallbacks: [] }),
      runAsFn: async () => ({ success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCostUsd: 0, agentFallbacks: [] }),
      completeAsFn: async () => ({ output: llmResponse, ...COMPLETE_RESULT_BASE }),
      getAgentFn: () => makeAgentAdapter(),
    });
  }

  test("on-disk findings carry ruleId + message, never top-level issue/suggestion", async () => {
    const agentManager = makeAgentManagerForResponse(SEMANTIC_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: makeReviewAuditor() });

    await runSemanticReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[0]!;
    const findings = decision.result?.findings as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings!.length).toBe(2);

    for (const f of findings!) {
      expect(typeof f.ruleId).toBe("string");
      expect((f.ruleId as string).length).toBeGreaterThan(0);
      expect(typeof f.message).toBe("string");
      expect((f.message as string).length).toBeGreaterThan(0);
      expect(f.issue).toBeUndefined();
      expect(f.suggestion).toBeUndefined();
    }

    const blocking = findings!.find((f) => f.line === 73)!;
    expect(blocking.message).toContain("does not validate that listener is a function");
    expect(blocking.message).toContain("→ Add a typeof guard");
    expect(blocking.severity).toBe("error");
    const meta = blocking.meta as Record<string, unknown>;
    expect(meta.acId).toBe("AC-2");
    expect(meta.acQuote).toBe("must validate listener input");
    expect(meta.acIndex).toBe(2);
    expect(meta.issue).toContain("does not validate");
    expect(meta.suggestion).toContain("typeof guard");
  });

  test("ruleId is non-coarse — does not collapse to a single category word", async () => {
    const agentManager = makeAgentManagerForResponse(SEMANTIC_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: makeReviewAuditor() });

    await runSemanticReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    const decision = decisions[0]!;
    const findings = decision.result?.findings as Array<{ ruleId: string }>;
    for (const f of findings) {
      expect(f.ruleId).toContain(":");
      const slug = f.ruleId.split(":")[1] ?? "";
      expect(slug.split("-").length).toBeGreaterThan(1);
    }
  });
});
