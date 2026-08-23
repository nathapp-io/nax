/**
 * Issue #942 AC-1 / AC-2 — adversarial reviewer must persist canonical
 * ReviewFinding[] to .nax/review-audit/*.json, never raw AdversarialLLMFinding[].
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _diffUtilsDeps, runAdversarialReview } from "@/review";
import type { AdversarialReviewConfig, SemanticStory } from "@/review/types";
import type { ReviewAuditDecision } from "@/runtime";
import {
  agentManagerWithFixedLLMResponse,
  captureAuditDecisions,
  makeMockRuntime,
  mockDiffUtilsDeps,
  withTempDir,
} from "@test/helpers";

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

  test("acknowledgements land in `acks`, never in findings (#1423)", async () => {
    // Before #1423 the verdict template gave the reviewer no channel but
    // `findings` for an "addressed" verdict, so bookkeeping was counted as
    // defects and became the evidence quoted in curator rule proposals.
    const { auditor, decisions: captured } = captureAuditDecisions();
    decisions = captured;
    const agentManager = agentManagerWithFixedLLMResponse(
      JSON.stringify({
        passed: false,
        acks: [
          { priorFinding: "src/foo.ts:10", status: "addressed", note: "fixed at src/foo.ts:12" },
          { priorFinding: "the picker layout", status: "never-an-issue", note: "misread the markup" },
        ],
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/foo.ts",
            line: 10,
            issue: "Listener arg not validated as function",
            suggestion: "Add typeof guard",
          },
        ],
      }),
    );
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
    // The one real defect is a finding; the two acks are not.
    expect((decision.result?.findings as unknown[]).length).toBe(1);
    expect(decision.acks).toHaveLength(2);
    expect(decision.acks?.[0]).toEqual({
      priorFinding: "src/foo.ts:10",
      status: "addressed",
      note: "fixed at src/foo.ts:12",
    });
    expect(decision.acks?.[1]?.status).toBe("never-an-issue");
  });

  test("a response with no acks records none, rather than an empty array (#1423)", async () => {
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

    expect(decisions[0]!.acks).toBeUndefined();
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

describe("adversarial structural counterfactual telemetry (#986)", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = mockDiffUtilsDeps(
      // Diff that mentions src/foo.ts so fileInDiff=true for findings that target it.
      `diff --git a/src/foo.ts b/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-x
+y
`,
    );
  });
  afterEach(() => teardown());

  test("dropped finding gets adversarialDropAnalysis with counterfactual", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export const foo = 1;\n");

      // Drop trigger: missing acQuote on a "error" finding.
      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "input",
            file: "src/foo.ts",
            line: 10,
            issue: "missing input validation",
            suggestion: "add zod schema",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "export const foo = 1;",
            },
            // No acQuote / acIndex → filterByAcQuote drops with missing_ac_quote.
          },
        ],
      });

      const { auditor, decisions } = captureAuditDecisions();
      const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
      const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: { ...CFG, diffMode: "embedded" },
        agentManager,
        featureName: "feat-x",
        runtime,
      });

      expect(decisions.length).toBeGreaterThanOrEqual(1);
      const decision = decisions[0]!;
      expect(decision.diffAvailable).toBe(true);
      expect(Array.isArray(decision.adversarialDropAnalysis)).toBe(true);
      expect(decision.adversarialDropAnalysis!.length).toBe(1);

      const drop = decision.adversarialDropAnalysis![0]!;
      expect(drop.dropCode).toBe("missing_ac_quote");
      expect(drop.finding.file).toBe("src/foo.ts");
      expect(drop.rawCategory).toBe("input");
      expect(drop.counterfactual.fileInDiff).toBe(true);
      expect(drop.counterfactual.categoryBlocking).toBe(true);
      expect(drop.counterfactual.acIndexInRange).toBe(false); // no acIndex
      expect(drop.counterfactual.wouldSurviveStructural).toBe(false);
    });
  });

  test("accepted blocking finding gets adversarialAcceptAnalysis", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo(input: string) { return input; }\n");

      // Accept path: valid acQuote substring + locus keyword present.
      const story: SemanticStory = {
        id: "US-002",
        title: "Accept path",
        description: "",
        acceptanceCriteria: ["The foo function must validate input arguments"],
      };
      const llmResponse = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "input",
            file: "src/foo.ts",
            line: 10,
            issue: "foo missing validation",
            suggestion: "add check",
            acQuote: "foo function must validate",
            acIndex: 1,
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "export function foo(input: string) { return input; }",
            },
          },
        ],
      });

      const { auditor, decisions } = captureAuditDecisions();
      const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
      const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story,
        adversarialConfig: { ...CFG, diffMode: "embedded" },
        agentManager,
        featureName: "feat-y",
        runtime,
      });

      const decision = decisions[0]!;
      expect(decision.adversarialDropAnalysis ?? []).toEqual([]);
      expect(Array.isArray(decision.adversarialAcceptAnalysis)).toBe(true);
      expect(decision.adversarialAcceptAnalysis!.length).toBe(1);

      const accept = decision.adversarialAcceptAnalysis![0]!;
      expect(accept.finding.file).toBe("src/foo.ts");
      expect(accept.acIndex).toBe(1);
      expect(accept.counterfactual.acIndexInRange).toBe(true);
      expect(accept.counterfactual.categoryBlocking).toBe(true);
      expect(accept.counterfactual.fileInDiff).toBe(true);
      expect(accept.counterfactual.wouldSurviveStructural).toBe(true);
    });
  });

  test("passed review records adversarialAcceptAnalysis: [] (BUG-1, v0.80.0 regression)", async () => {
    await withTempDir(async (workdir) => {
      const llmResponse = JSON.stringify({ passed: true, findings: [] });

      const { auditor, decisions } = captureAuditDecisions();
      const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
      const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

      await runAdversarialReview({
        workdir,
        storyGitRef: "abc123",
        story: STORY,
        adversarialConfig: { ...CFG, diffMode: "embedded" },
        agentManager,
        featureName: "feat-passed",
        runtime,
      });

      const decision = decisions[0]!;
      expect(decision.passed).toBe(true);
      // Pre-refactor (v0.80.0), every passed-style outcome hardcoded [] here —
      // only the blocking-failure branch ever recorded real accept-analysis.
      // A decomposition regression briefly passed the (currently always-empty,
      // but not guaranteed to stay that way) telemetry value through instead.
      expect(decision.adversarialAcceptAnalysis).toEqual([]);
    });
  });

  test("ref mode without diff records diffAvailable=false", async () => {
    // Reset the embedded-mode mock from beforeEach; this test installs its own
    // command-discriminating spawn so collectDiffStat succeeds (non-empty stat)
    // but collectDiffFileList fails (exitCode != 0 → undefined → diffAvailable=false).
    teardown();
    const origSpawn = _diffUtilsDeps.spawn;
    const origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.isGitRefValid = (async () => true) as typeof _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.spawn = ((opts: { cmd: string[] }) => {
      const isFileList = (opts.cmd ?? []).includes("--name-only");
      const stdout = isFileList ? "" : "1 file changed";
      const exitCode = isFileList ? 128 : 0;
      return {
        exited: Promise.resolve(exitCode),
        stdout: new ReadableStream({
          start: (c) => {
            c.enqueue(new TextEncoder().encode(stdout));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        kill: () => {},
      } as unknown as ReturnType<typeof _diffUtilsDeps.spawn>;
    }) as typeof _diffUtilsDeps.spawn;
    teardown = () => {
      _diffUtilsDeps.spawn = origSpawn;
      _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    };

    const llmResponse = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          category: "input",
          file: "src/foo.ts",
          line: 1,
          issue: "x",
          suggestion: "y",
        },
      ],
    });
    const { auditor, decisions } = captureAuditDecisions();
    const agentManager = agentManagerWithFixedLLMResponse(llmResponse);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/test",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: { ...CFG, diffMode: "ref" },
      agentManager,
      featureName: "feat-z",
      runtime,
    });

    expect(decisions[0]!.diffAvailable).toBe(false);
  });
});
