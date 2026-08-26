/**
 * Issue #942 AC-1 / AC-2 — semantic reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw LLMFinding[].
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentManagerWithFixedLLMResponse,
  assertDefined,
  captureAuditDecisions,
  makeMockRuntime,
  mockDiffUtilsDeps,
} from "@test/helpers";
import { runSemanticReview } from "@/review/semantic";
import type { SemanticReviewConfig, SemanticStory } from "@/review/types";
import type { ReviewAuditDecision } from "@/runtime";

const STORY: SemanticStory = {
  id: "US-001",
  title: "Test semantic audit shape",
  description: "Validate canonical shape on disk",
  acceptanceCriteria: ["AC-1: validate input", "AC-2: must validate listener input"],
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

function first<T>(items: T[]): T {
  const v = items[0];
  assertDefined(v, "first item");
  return v;
}

describe("semantic reviewer audit shape (#942 AC-1 / AC-2)", () => {
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
    const agentManager = agentManagerWithFixedLLMResponse(SEMANTIC_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

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
    const decision = first(decisions);
    const findings = decision.result?.findings as Array<Record<string, unknown>>;
    assertDefined(findings, "result findings");
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(2);

    for (const f of findings) {
      expect(typeof f.ruleId).toBe("string");
      expect((f.ruleId as string).length).toBeGreaterThan(0);
      expect(typeof f.message).toBe("string");
      expect((f.message as string).length).toBeGreaterThan(0);
      expect(f.issue).toBeUndefined();
      expect(f.suggestion).toBeUndefined();
    }

    const blocking = findings.find((f) => f.line === 73);
    assertDefined(blocking, "line-73 finding");
    expect(blocking.message).toContain("does not validate that listener is a function");
    expect(blocking.message).toContain("→ Add a typeof guard");
    expect(blocking.severity).toBe("error");
    const meta = blocking.meta as Record<string, unknown>;
    expect(meta.acId).toBe("AC-2");
    expect(meta.acQuote).toBe("must validate listener input");
    expect(meta.acIndex).toBe(2);
    expect(meta.issue).toContain("does not validate");
    expect(meta.suggestion).toContain("typeof guard");

    // advisoryFindings (warning severity — below default "error" threshold) must
    // also conform to canonical ReviewFinding shape, not raw LLMFinding shape.
    const advisory = decision.advisoryFindings as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(advisory)).toBe(true);
    assertDefined(advisory, "advisoryFindings");
    expect(advisory.length).toBe(1);
    const advisoryFinding = first(advisory);
    expect(typeof advisoryFinding.ruleId).toBe("string");
    expect((advisoryFinding.ruleId as string).length).toBeGreaterThan(0);
    expect(typeof advisoryFinding.message).toBe("string");
    expect(advisoryFinding.message).toContain("Listener errors are swallowed");
    expect(advisoryFinding.issue).toBeUndefined();
    expect(advisoryFinding.suggestion).toBeUndefined();
  });

  test("ruleId is non-coarse — does not collapse to a single category word", async () => {
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(SEMANTIC_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runSemanticReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    const decision = first(decisions);
    const findings = decision.result?.findings as Array<{ ruleId: string }>;
    for (const f of findings) {
      expect(f.ruleId).toContain(":");
      const slug = f.ruleId.split(":")[1] ?? "";
      expect(slug.split("-").length).toBeGreaterThan(1);
    }
  });
  test("acknowledgements reach the audit even when the review PASSES (#1423)", async () => {
    // The most common ack shape by far: the implementer fixed everything, so the
    // reviewer acknowledges the prior findings and reports none. If acks are only
    // wired on the failing branch, exactly this case is lost.
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(
      JSON.stringify({
        passed: true,
        inspectedFiles: ["src/foo.ts"],
        acks: [
          { priorFinding: "src/foo.ts:73", status: "addressed", note: "typeof guard added at line 74" },
          { priorFinding: "src/foo.ts:81", status: "never-an-issue", note: "logger is never null here" },
        ],
        findings: [],
      }),
    );
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runSemanticReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    const decision = first(decisions);
    expect(decision.result?.passed).toBe(true);
    expect(decision.result?.findings).toEqual([]);
    expect(decision.acks).toHaveLength(2);
    expect(decision.acks?.[0]?.status).toBe("addressed");
    expect(decision.acks?.[1]?.status).toBe("never-an-issue");
  });

  test("acknowledgements reach the audit on the failing branch too (#1423)", async () => {
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(
      JSON.stringify({
        passed: false,
        acks: [{ priorFinding: "src/foo.ts:73", status: "addressed" }],
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 73,
            issue: "still unvalidated",
            suggestion: "guard it",
            acIndex: 2,
          },
        ],
      }),
    );
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runSemanticReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CFG,
      agentManager,
      featureName: "feat-x",
      runtime,
    });

    expect(first(decisions).acks).toHaveLength(1);
  });
});
