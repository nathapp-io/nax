/** A5 workflow mode: the scoped re-review prompt (spec §6 step 5). */
import { renderWorkflowFindings, type WorkflowPromptFinding } from "./workflow-implementer-builder";

export function buildWorkflowReReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  return `You are checking one fix round. Read the brief (${input.briefPath}), the report (${input.reportPath}, see its latest "Fix round" section) and the fix package (${input.packagePath}). The package holds only this fix diff.

## Findings the fix had to address
${renderWorkflowFindings(input.findings)}

For each finding id, answer ADDRESSED or NOT_ADDRESSED. Then list new problems introduced only in this fix diff. Do not re-review the rest of the story.

Reply with only this JSON object:
{"findings": [{"id": "F1", "verdict": "ADDRESSED|NOT_ADDRESSED", "note": "one sentence"}], "newFindings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "issue": "...", "suggestion": "..."}]}`;
}
