/**
 * US-004: the CI repair's own brief.
 *
 * The repair used to run the branch-fix prompt ("You are fixing a feature branch after its
 * whole-branch review"), which describes work the session is not doing. This builder is the CI
 * repair's brief: the failing checks, the two rules a repair must never break, and the same
 * artifacts and reply contract every workflow session carries.
 */
import { describe, expect, test } from "bun:test";
import {
  buildWorkflowCiRepairPrompt,
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
