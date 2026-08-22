/**
 * Shared helpers for reviewer audit-shape tests.
 * Extracted to avoid duplicating spawn mocks and IReviewAuditor setup
 * across semantic-audit-shape, adversarial-audit-shape, and
 * semantic-debate-audit-shape tests.
 */

import { mock } from "bun:test";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { IReviewAuditor, ReviewAuditDecision } from "@/runtime";
import { makeAgentAdapter } from "./mock-agent-adapter";
import { makeMockAgentManager } from "./mock-agent-manager";
import { makeSpawn } from "./spawn";

export function captureAuditDecisions(): { auditor: IReviewAuditor; decisions: ReviewAuditDecision[] } {
  const decisions: ReviewAuditDecision[] = [];
  const auditor: IReviewAuditor = {
    recordDispatch: () => {},
    recordDecision: (entry) => {
      decisions.push(entry);
    },
    flush: async () => {},
    getAdvisoryFindings: () => [],
  };
  return { auditor, decisions };
}

export function makeSpawnMock(stdout = "diff output", exitCode = 0) {
  return makeSpawn(() => ({ stdout, exitCode })).spawn;
}

/** Mock `_diffUtilsDeps` for tests that call diff-producing reviewers. Returns a teardown function. */
export function mockDiffUtilsDeps(stdout = "some diff"): () => void {
  const origSpawn = _diffUtilsDeps.spawn;
  const origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  const origGetMergeBase = _diffUtilsDeps.getMergeBase;
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock(stdout);
  return () => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  };
}

const COMPLETE_RESULT_BASE = {
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
};

/** Agent manager that returns a fixed LLM response for all call types. */
export function agentManagerWithFixedLLMResponse(llmResponse: string) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async () => ({
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
      result: {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
        agentFallbacks: [],
      },
      fallbacks: [],
      bundle: request.bundle,
    }),
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, ...COMPLETE_RESULT_BASE }, fallbacks: [] }),
    runAsFn: async () => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: 0,
      agentFallbacks: [],
    }),
    completeAsFn: async () => ({ output: llmResponse, ...COMPLETE_RESULT_BASE }),
    getAgentFn: () => makeAgentAdapter(),
  });
}
