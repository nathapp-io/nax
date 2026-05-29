/**
 * Issue #942 AC-1 / AC-2 — semantic-debate reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw LLMFinding[].
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DebateResult, DebateRunner } from "../../../src/debate";
import { reviewConfigSelector } from "../../../src/config/selectors";
import type { NaxRuntime, ReviewAuditDecision } from "../../../src/runtime";
import { runSemanticDebate } from "../../../src/review/semantic-debate";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import { makeNaxConfig, makeMockAgentManager, makeMockRuntime, captureAuditDecisions } from "../../helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY: SemanticStory = {
  id: "US-001",
  title: "Test debate audit shape",
  description: "Validate canonical shape on disk",
  acceptanceCriteria: ["AC-1: validate input"],
};

const CFG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/"],
  timeoutMs: 60_000,
};

const LLM_FINDINGS_JSON = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warning",
      file: "src/foo.ts",
      line: 10,
      issue: "Listener callback errors are not handled in the event loop",
      suggestion: "Wrap the listener call in a try-catch",
    },
    {
      severity: "warning",
      file: "src/bar.ts",
      line: 42,
      issue: "Missing null check before property access",
      suggestion: "",
    },
  ],
});

function makeDebateResult(proposalOutput: string): DebateResult {
  return {
    storyId: "US-001",
    stage: "review",
    outcome: "failed",
    rounds: 1,
    debaters: ["claude"],
    resolverType: "majority-fail-closed",
    proposals: [{ debater: { agent: "claude" }, output: proposalOutput }],
    totalCostUsd: 0,
  };
}

function makeMockDebateRunner(result: DebateResult): DebateRunner {
  return {
    run: async () => result,
  } as unknown as DebateRunner;
}

describe("semantic-debate reviewer audit shape (#942 AC-1 / AC-2)", () => {
  let decisions: ReviewAuditDecision[];

  beforeEach(() => {
    decisions = [];
  });

  test("stateless fallback path: findings carry ruleId + message, no top-level issue/suggestion", async () => {
    const debateResult = makeDebateResult(LLM_FINDINGS_JSON);
    const agentManager = makeMockAgentManager();
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });
    createdRuntimes.push(runtime);
    const naxConfig = reviewConfigSelector.select(makeNaxConfig());

    await runSemanticDebate({
      naxConfig,
      runtime,
      workdir: "/tmp/test",
      agentManager,
      featureName: "feat-x",
      story: STORY,
      diffMode: "embedded",
      diff: "some diff",
      stat: "",
      semanticConfig: CFG,
      effectiveRef: "abc123",
      startTime: Date.now(),
      prompt: "review this diff",
      productionExcludePatterns: [],
      blockingThreshold: undefined,
      createDebateRunner: () => makeMockDebateRunner(debateResult),
    });

    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[0]!;
    const findings = decision.result?.findings as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings!.length).toBeGreaterThan(0);

    for (const f of findings!) {
      expect(typeof f.ruleId).toBe("string");
      expect((f.ruleId as string).length).toBeGreaterThan(0);
      expect(typeof f.message).toBe("string");
      expect((f.message as string).length).toBeGreaterThan(0);
      expect(f.issue).toBeUndefined();
      expect(f.suggestion).toBeUndefined();
    }

    const finding = findings!.find((f) => f.line === 10)!;
    expect(finding.message).toContain("Listener callback errors are not handled");
    expect(finding.message).toContain("→ Wrap the listener call");
    expect((finding.ruleId as string)).toContain(":");
  });

  test("ruleId is non-coarse — slug has multiple tokens", async () => {
    const debateResult = makeDebateResult(LLM_FINDINGS_JSON);
    const agentManager = makeMockAgentManager();
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });
    createdRuntimes.push(runtime);
    const naxConfig = reviewConfigSelector.select(makeNaxConfig());

    await runSemanticDebate({
      naxConfig,
      runtime,
      workdir: "/tmp/test",
      agentManager,
      featureName: "feat-x",
      story: STORY,
      diffMode: "embedded",
      diff: "some diff",
      stat: "",
      semanticConfig: CFG,
      effectiveRef: "abc123",
      startTime: Date.now(),
      prompt: "review this diff",
      productionExcludePatterns: [],
      blockingThreshold: undefined,
      createDebateRunner: () => makeMockDebateRunner(debateResult),
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
