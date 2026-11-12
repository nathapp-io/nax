/** A5 workflow mode: the scoped re-review prompt (spec §6 step 5). */
import {
  renderWorkflowFindings,
  WORKFLOW_SETTLED_RULINGS_RULE,
  type WorkflowPromptFinding,
} from "./workflow-implementer-builder";

export function buildWorkflowReReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  return `You are checking one fix round. Read the brief (${input.briefPath}), the report (${input.reportPath}, see its latest "Fix round" section) and the fix package (${input.packagePath}). The package holds only this fix diff.

## Findings the fix had to address
${renderWorkflowFindings(input.findings)}

For each finding id, answer ADDRESSED, PARTIAL or NOT_ADDRESSED. PARTIAL means the fix resolved part of the finding and a smaller problem remains: describe only what remains in "residual". A residual "issue" must name a concrete scenario that still fails - the input, the path or the sequence that breaks now - not the area that feels thin. When what remains is the same problem as the finding, in a narrower form, also set "narrower": true on that entry: another fix round cannot converge on the same problem again, so nax sends it to the advisor. Never list a residual again in "newFindings". Then list new problems introduced only in this fix diff. Do not re-review the rest of the story.

${WORKFLOW_SETTLED_RULINGS_RULE}

Reply with only this JSON object:
{"findings": [{"id": "F1", "verdict": "ADDRESSED|PARTIAL|NOT_ADDRESSED", "note": "one sentence", "residual": {"issue": "...", "suggestion": "...", "file": "path", "line": 0}, "narrower": true}], "newFindings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "issue": "...", "suggestion": "..."}]}`;
}
