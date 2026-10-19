/** A5 workflow mode: the story review prompt (spec §6 step 4) and the JSON retries shared with the re-review. */

import { WORKFLOW_ENUMERATION_INSTRUCTION, WORKFLOW_QUALITY_CHECKLIST } from "./workflow-quality-checklist";

/**
 * US-006 (nax#2527): the story's recorded gate states, declared here rather than imported from
 * `@/workflow` — this builder must keep reaching nothing outside `src/prompts`. Structurally the
 * workflow module's `Partial<Record<GateName, GateState>>`.
 */
export type WorkflowStoryGateStates = Readonly<
  Partial<Record<"lint" | "typecheck" | "scoped" | "full-suite", "green" | "red" | "skipped">>
>;

/** The gates nax itself ran on the story before the review, and what it runs thereafter. */
function naxCheckedBlock(gates: WorkflowStoryGateStates, e2eGate: boolean): string {
  const state = (name: "lint" | "typecheck" | "scoped"): string => gates[name] ?? "not run";
  // US-009 (nax#2530): the host runs e2e, so its journeys are never something the reviewer could
  // not verify — only the projects that declare the gate hear about it.
  const e2e = e2eGate
    ? "\nnax runs the e2e suite as a repository gate on the host; do not list e2e journeys in cannotVerify."
    : "";
  return `## What nax already checked
nax ran these gates on this story before your review: lint ${state("lint")}, typecheck ${state("typecheck")}, scoped tests ${state("scoped")}.
After your review nax runs the full test suite on this story, and once every story is done it runs the repository gates. Both run only when the workflow reaches them: a red gate, or a finding left open, can end the story before the suite. nax records whether each one ran and what it returned, so never list the full suite or the repository gates in "cannotVerify", even though they have not run yet.
If you have a shell tool, run this story's own test files with one scoped test command before you give the spec verdict.${e2e}`;
}

/** The narrowed cannotVerify rule and the evidence rule behind an unavailability claim (US-006, nax#2531). */
const CANNOT_VERIFY_RULE = `Put in "cannotVerify" only what neither nax's gates nor a scoped command can check, such as behaviour that needs a live external service.
Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.`;

export function buildWorkflowStoryReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  concerns: readonly string[];
  gates?: WorkflowStoryGateStates;
  /** US-009: the project declares a host-side e2e gate, so its journeys are not unverifiable. */
  e2eGate?: boolean;
}): string {
  const concerns =
    input.concerns.length > 0
      ? `\n\nThe implementer raised these concerns. Judge them as part of the review:\n${input.concerns.map((c) => `- ${c}`).join("\n")}`
      : "";
  return `You are reviewing one story. Start with these three files:
- the brief (the requirements): ${input.briefPath}
- the implementer's report: ${input.reportPath}
- the review package (commits, --stat, full diff with context; when it is truncated it ends with "Files not shown in the diff", read those yourself): ${input.packagePath}${concerns}

For each acceptance criterion, verify the current code implements it correctly. Use the diff to find the changed paths, not as the only source of truth. Follow each criterion's data and contract to where it is declared or stored (schema, migrations, DTOs, shared types), including code an earlier story created that this diff does not touch: a limit the story accepts must fit the storage and contracts it writes to. Read a file before you flag it.

${naxCheckedBlock(input.gates ?? {}, input.e2eGate === true)}

${WORKFLOW_QUALITY_CHECKLIST}

${WORKFLOW_ENUMERATION_INSTRUCTION}

Give two verdicts:
- **spec**: "pass" only if every acceptance criterion is implemented and covered by a test that would fail without it. Check the report's TDD evidence: missing evidence for an AC (other than an honest not-captured note), or a test that asserts nothing, is a spec failure. A report that says the failing run was not captured is not a spec failure when the test exercises the new code path. A failing run produced by reverting or stashing the implementation is a finding.
- **quality**: "approved" or "changes" (correctness, error handling, edge cases, conventions of the surrounding code).

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before this story is done), "minor" (worth noting, not blocking). ${CANNOT_VERIFY_RULE}

List every file you opened in "inspectedFiles". A critical or important finding about what the code does carries "observed": a verbatim 1-3 line excerpt from the file that proves it; if you cannot quote one, it is minor or belongs in "cannotVerify". A finding about a missing or empty test names the AC and the test file you checked instead.

Reply with only this JSON object:
{"spec": "pass|fail", "quality": "approved|changes", "inspectedFiles": ["path"], "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "observed": "verbatim excerpt", "suggestion": "how to fix"}], "cannotVerify": ["..."]}`;
}

export function buildWorkflowReviewJsonRetry(): string {
  return "Your reply was not the required JSON object. Re-send it now as only the JSON object, with no other text.";
}

export function buildWorkflowReviewJsonRetryCondensed(): string {
  return 'Your reply was cut off. Re-send a shorter version: keep every finding but shorten "issue" and "suggestion" to one sentence each. Only the JSON object.';
}
