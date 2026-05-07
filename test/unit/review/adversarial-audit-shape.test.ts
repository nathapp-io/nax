/**
 * Issue #942 AC-1 / AC-2 — adversarial reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw AdversarialLLMFinding[].
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReviewAuditDecision } from "../../../src/runtime";
import { runAdversarialReview } from "../../../src/review/adversarial";
import type { AdversarialReviewConfig, SemanticStory } from "../../../src/review/types";
import {
  agentManagerWithFixedLLMResponse,
  captureAuditDecisions,
  mockDiffUtilsDeps,
  makeMockRuntime,
} from "../../helpers";

const STORY: SemanticStory = {
  id: "US-001",
  title: "Test adversarial audit shape",
  description: "Validate canonical shape on disk",
  acceptanceCriteria: ["AC-1: validate input"],
};

const CFG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  rules: [],
  timeoutMs: 60_000,
  parallel: false,
  maxConcurrentSessions: 2,
};

const ADVERSARIAL_LLM_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warning",
      category: "input",
      file: "src/foo.ts",
      line: 10,
      issue: "Listener arg not validated as function",
      suggestion: "Add typeof guard before registering",
    },
    {
      severity: "warning",
      category: "error-path",
      file: "src/foo.ts",
      line: 25,
      issue: "Error is swallowed without logging",
      suggestion: "",
    },
  ],
});

describe("adversarial reviewer audit shape (#942 AC-1 / AC-2)", () => {
  let decisions: ReviewAuditDecision[];
  let teardown: () => void;

  beforeEach(() => {
    decisions = [];
    teardown = mockDiffUtilsDeps("some diff");
  });

  afterEach(() => {
    teardown();
  });

  test("on-disk findings carry ruleId + message, never top-level issue/suggestion", async () => {
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(ADVERSARIAL_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: CFG,
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

    const inputFinding = findings!.find((f) => f.line === 10)!;
    expect(inputFinding.category).toBe("input");
    expect((inputFinding.ruleId as string).startsWith("input:")).toBe(true);
    expect(inputFinding.message).toContain("Listener arg not validated");
    expect(inputFinding.message).toContain("→ Add typeof guard");
    expect(inputFinding.severity).toBe("warning");
  });

  test("ruleId starts with the finding's category", async () => {
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(ADVERSARIAL_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    const decision = decisions[0]!;
    const findings = decision.result?.findings as Array<{ ruleId: string; category: string }>;
    for (const f of findings) {
      expect(f.ruleId).toContain(":");
      expect(f.ruleId.startsWith(`${f.category}:`)).toBe(true);
    }
  });
});
