/**
 * US-004: the CI repair's own brief.
 *
 * The repair used to run the branch-fix prompt ("You are fixing a feature branch after its
 * whole-branch review"), which describes work the session is not doing. This builder is the CI
 * repair's brief: the failing checks, the two rules a repair must never break, and the same
 * artifacts and reply contract every workflow session carries.
 */
import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import {
  buildWorkflowCiRepairPrompt,
  memorySectionOf,
  REPAIR_VERIFICATION_RULE,
  WORKFLOW_ARTIFACTS_RULE,
  WORKFLOW_REPLY_CONTRACT,
  type WorkflowPromptFinding,
} from "@/prompts";
import { renderWorkflowFindings } from "@/prompts/builders/workflow-implementer-builder";

const PR_URL = "https://github.com/o/r/pull/7";
const REPORT = "/r/report.md";

const findings: readonly WorkflowPromptFinding[] = [
  {
    id: "C1",
    kind: "gate",
    severity: "important",
    issue:
      'CI check Security audit failed at step "bun audit".\nSteps CI skipped after it, which never ran: pip-audit\nE',
    suggestion: "See https://ci/1",
  },
  { id: "C2", kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom" },
];

const input = { round: 1, prUrl: PR_URL, reportPath: REPORT, findings } as const;

describe("buildWorkflowCiRepairPrompt", () => {
  test("AC-1: names the pull request whose CI is being repaired", () => {
    expect(buildWorkflowCiRepairPrompt(input)).toContain(
      "You are repairing the CI of pull request https://github.com/o/r/pull/7.",
    );
  });

  test("AC-2: renders every finding the way renderWorkflowFindings does", () => {
    const text = buildWorkflowCiRepairPrompt(input);
    const rendered = renderWorkflowFindings(findings);
    expect(text).toContain(rendered);
    for (const finding of findings) expect(text).toContain(`[${finding.id}]`);
  });

  test("AC-3: forbids skipping or disabling a failing check", () => {
    expect(buildWorkflowCiRepairPrompt(input)).toContain(
      "Never skip, disable or ignore a failing check, and never edit the CI configuration to make it pass.",
    );
  });

  test("AC-4: explains that a skipped step never ran, and asks for a local reproduction", () => {
    expect(buildWorkflowCiRepairPrompt(input)).toContain(
      "A CI job stops at its first failing step, so a step CI skipped never ran: reproduce the failing step and every skipped step locally.",
    );
  });

  test("AC-5: carries the shared repair verification rule", () => {
    expect(buildWorkflowCiRepairPrompt(input)).toContain(REPAIR_VERIFICATION_RULE);
  });

  test("AC-6: the report section is round-labelled", () => {
    expect(buildWorkflowCiRepairPrompt({ ...input, round: 2 })).toContain(
      'append a "CI repair r2" section to /r/report.md',
    );
  });

  test("AC-7: ends with the reply contract every workflow session carries", () => {
    const text = buildWorkflowCiRepairPrompt(input);
    expect(text).toContain(WORKFLOW_REPLY_CONTRACT);
    expect(text.endsWith(WORKFLOW_REPLY_CONTRACT)).toBe(true);
  });

  test("AC-8: does not describe a whole-branch review the session is not doing", () => {
    expect(buildWorkflowCiRepairPrompt(input)).not.toContain("whole-branch review");
  });

  test("AC-9: names the spec path when one is supplied", () => {
    expect(buildWorkflowCiRepairPrompt({ ...input, specPath: "/r/spec.md" })).toContain("/r/spec.md");
  });

  test("names the PRD path when one is supplied", () => {
    expect(buildWorkflowCiRepairPrompt({ ...input, prdPath: "/r/prd.json" })).toContain("/r/prd.json");
  });

  test("carries the artifacts rule, before the reply contract", () => {
    const text = buildWorkflowCiRepairPrompt(input);
    expect(text).toContain(WORKFLOW_ARTIFACTS_RULE);
    expect(text.indexOf(WORKFLOW_ARTIFACTS_RULE)).toBeLessThan(text.indexOf(WORKFLOW_REPLY_CONTRACT));
  });

  test("without a PR URL it still says whose CI it is, and never prints undefined", () => {
    const text = buildWorkflowCiRepairPrompt({ round: 1, reportPath: REPORT, findings });
    expect(text.startsWith("You are repairing the CI of this pull request.")).toBe(true);
    expect(text).not.toContain("undefined");
  });
});

/**
 * US-002 — the memory index in the CI repair brief.
 *
 * A repair session reads and saves memory like any other implementer session, so it gets the
 * tool section, after the verification rule (which is about this brief's own work) and before
 * the reply contract every workflow session ends with.
 */
describe("buildWorkflowCiRepairPrompt — the memory section (US-002)", () => {
  test("AC-12: an index renders the memory section", () => {
    const text = buildWorkflowCiRepairPrompt({ ...input, memoryIndex: "INDEX-LINE" });
    const expected = memorySectionOf("INDEX-LINE");
    assertDefined(expected, "memorySectionOf section");
    expect(text).toContain(expected);
  });

  test("AC-13: ## Memory follows the verification rule and precedes the reply contract", () => {
    const text = buildWorkflowCiRepairPrompt({ ...input, memoryIndex: "INDEX-LINE" });
    expect(text.indexOf(REPAIR_VERIFICATION_RULE)).toBeGreaterThan(-1);
    expect(text.indexOf("## Memory")).toBeGreaterThan(text.indexOf(REPAIR_VERIFICATION_RULE));
    expect(text.indexOf("## Memory")).toBeLessThan(text.indexOf(WORKFLOW_REPLY_CONTRACT));
  });

  test("AC-14: an absent index adds no ## Memory heading, and the prompt is what it was", () => {
    const text = buildWorkflowCiRepairPrompt(input);
    expect(text).not.toContain("## Memory");
    expect(text).toBe(buildWorkflowCiRepairPrompt({ ...input, memoryIndex: "" }));
    // The section does arrive when there is an index, so the absence above is real.
    expect(buildWorkflowCiRepairPrompt({ ...input, memoryIndex: "INDEX-LINE" })).not.toBe(text);
    expect(text.endsWith(WORKFLOW_REPLY_CONTRACT)).toBe(true);
  });
});
