/**
 * Issue #942 AC-1 / AC-2 — semantic-debate reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw LLMFinding[].
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DebateResult, DebateRunner } from "../../../src/debate";
import { reviewConfigSelector } from "../../../src/config/selectors";
import type { Finding } from "../../../src/findings";
import type { ReviewAuditDecision } from "../../../src/runtime";
import { runSemanticDebate } from "../../../src/review/semantic-debate";
// ReviewerSession / DialogueMessage are imported as types only — erased at
// compile time, so leaf-path import does not fragment the module registry.
import type { DialogueMessage, ReviewerSession } from "../../../src/review/dialogue";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import { makeNaxConfig, makeMockAgentManager, makeMockRuntime, captureAuditDecisions } from "../../helpers";

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

function makeResolverSession(findings: Finding[]): ReviewerSession {
  const history: DialogueMessage[] = [];
  return {
    active: true,
    get history() {
      return history;
    },
    getVerdict: () => ({
      storyId: "US-001",
      passed: findings.length === 0,
      timestamp: new Date().toISOString(),
      acCount: 1,
      findings,
    }),
    review: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map() }),
    reReview: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map() }),
    clarify: async () => "",
    resolveDebate: async () => {
      // Grow history so sessionUsed becomes true
      history.push({ role: "reviewer", content: "verdict" });
      return { checkResult: { success: false, findings }, findingReasoning: new Map() };
    },
    reReviewDebate: async () => ({ checkResult: { success: true, findings: [] }, findingReasoning: new Map() }),
    destroy: () => {},
  } as unknown as ReviewerSession;
}

const DIALOGUE_FINDINGS: Finding[] = [
  {
    source: "semantic-review",
    severity: "error",
    category: "input",
    rule: "no-unvalidated-listener",
    file: "src/foo.ts",
    line: 73,
    message: "Listener arg must be validated before use",
    suggestion: "Add typeof guard",
    fixTarget: "source",
  },
];

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
    const naxConfig = reviewConfigSelector.select(makeNaxConfig());

    await runSemanticDebate({
      naxConfig,
      runtime,
      workdir: "/tmp/test",
      agentManager,
      featureName: "feat-x",
      story: STORY,
      resolverSession: undefined,
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
    const naxConfig = reviewConfigSelector.select(makeNaxConfig());

    await runSemanticDebate({
      naxConfig,
      runtime,
      workdir: "/tmp/test",
      agentManager,
      featureName: "feat-x",
      story: STORY,
      resolverSession: undefined,
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

  test("dialogue path (sessionUsed): Finding[] projected to canonical ruleId+message shape", async () => {
    const agentManager = makeMockAgentManager();
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });
    const naxConfig = reviewConfigSelector.select(makeNaxConfig());
    const resolverSession = makeResolverSession(DIALOGUE_FINDINGS);

    // The mock debate runner calls resolverSession.resolveDebate() which grows
    // history — triggering sessionUsed = true so the dialogue path executes.
    const dialogueDebateRunner: DebateRunner = {
      run: async () => {
        await resolverSession.resolveDebate([], [], {} as never, STORY, CFG, {} as never);
        return makeDebateResult(LLM_FINDINGS_JSON).outcome === "failed"
          ? makeDebateResult(LLM_FINDINGS_JSON)
          : makeDebateResult(LLM_FINDINGS_JSON);
      },
    } as unknown as DebateRunner;

    await runSemanticDebate({
      naxConfig,
      runtime,
      workdir: "/tmp/test",
      agentManager,
      featureName: "feat-x",
      story: STORY,
      resolverSession,
      diffMode: "embedded",
      diff: "some diff",
      stat: "",
      semanticConfig: CFG,
      effectiveRef: "abc123",
      startTime: Date.now(),
      prompt: "review this diff",
      productionExcludePatterns: [],
      blockingThreshold: undefined,
      createDebateRunner: () => dialogueDebateRunner,
    });

    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[0]!;
    const findings = decision.result?.findings as Array<Record<string, unknown>>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings!.length).toBeGreaterThan(0);

    for (const f of findings!) {
      // Must have canonical fields
      expect(typeof f.ruleId).toBe("string");
      expect((f.ruleId as string).length).toBeGreaterThan(0);
      expect(typeof f.message).toBe("string");
      expect((f.message as string).length).toBeGreaterThan(0);
      // Must NOT have top-level LLM-only fields
      expect(f.issue).toBeUndefined();
      expect(f.suggestion).toBeUndefined();
    }

    // rule is promoted directly to ruleId for Finding sources
    const finding = findings![0]!;
    expect(finding.ruleId).toBe("no-unvalidated-listener");
    expect(finding.message).toBe("Listener arg must be validated before use");
  });
});
