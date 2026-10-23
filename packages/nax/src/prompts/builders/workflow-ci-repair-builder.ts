/**
 * A5 workflow mode: the CI repair's brief (US-004, nax#2642).
 *
 * The CI repair used to run the branch-fix prompt, which says "You are fixing a feature branch after
 * its whole-branch review" — work the session is not doing. This is that session's own brief: the
 * failing checks of the published PR, the two rules a repair must never break, and the artifacts and
 * reply contract every workflow session carries.
 */
import {
  REPAIR_VERIFICATION_RULE,
  renderWorkflowFindings,
  WORKFLOW_ARTIFACTS_RULE,
  WORKFLOW_REPLY_CONTRACT,
  type WorkflowPromptFinding,
} from "./workflow-implementer-builder";

/** A check made green by turning it off is not green: the repair fixes the code, never the CI. */
export const CI_REPAIR_NO_SHORTCUTS_RULE =
  "Never skip, disable or ignore a failing check, and never edit the CI configuration to make it pass.";

/**
 * US-003 reads which step failed and which the job then skipped. A repair told only the check's name
 * would fix the first failure and leave the steps behind it unrun, so the rule names both.
 */
export const CI_REPAIR_STEP_REPRODUCTION_RULE =
  "A CI job stops at its first failing step, so a step CI skipped never ran: reproduce the failing step and every skipped step locally.";

export function buildWorkflowCiRepairPrompt(input: {
  readonly round: number;
  readonly prUrl?: string;
  readonly specPath?: string;
  readonly prdPath?: string;
  readonly reportPath: string;
  readonly findings: readonly WorkflowPromptFinding[];
}): string {
  const where = input.prUrl ? `pull request ${input.prUrl}` : "this pull request";
  const documents = [
    ...(input.specPath ? [`the spec (${input.specPath})`] : []),
    ...(input.prdPath !== undefined ? [`the PRD (${input.prdPath})`] : []),
  ];
  const read = documents.length > 0 ? ` Read ${documents.join(" and ")} for what the feature must do.` : "";
  return `You are repairing the CI of ${where}.${read} The feature is already on the branch: the failing checks below are the whole of your work.

## Failing checks
${renderWorkflowFindings(input.findings)}

## How to work
- ${CI_REPAIR_NO_SHORTCUTS_RULE}
- ${CI_REPAIR_STEP_REPRODUCTION_RULE}
- Fix the cause each check reports, then re-run that check's command before you commit.
- Before you commit, run the full test command of every package you changed, not only the tests you touched: the repository gates run every suite, and a repair that breaks an unrelated test turns the branch red again.
- Commit, then append a "CI repair r${input.round}" section to ${input.reportPath}: what you changed for each check, the test evidence, and any Decisions & assumptions.
- ${WORKFLOW_ARTIFACTS_RULE}
- Do not dispatch sub-agents or reviewers.

${REPAIR_VERIFICATION_RULE}

${WORKFLOW_REPLY_CONTRACT}`;
}
