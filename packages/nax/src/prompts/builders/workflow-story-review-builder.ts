/** A5 workflow mode: the story review prompt (spec §6 step 4) and the JSON retries shared with the re-review. */

export function buildWorkflowStoryReviewPrompt(input: {
  briefPath: string;
  reportPath: string;
  packagePath: string;
  concerns: readonly string[];
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

Give two verdicts:
- **spec**: "pass" only if every acceptance criterion is implemented and covered by a test that would fail without it. Check the report's TDD evidence: missing evidence for an AC, or a test that asserts nothing, is a spec failure.
- **quality**: "approved" or "changes" (correctness, error handling, edge cases, conventions of the surrounding code).

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before this story is done), "minor" (worth noting, not blocking). Put anything you could not check in "cannotVerify".

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
