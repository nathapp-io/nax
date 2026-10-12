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
  return `You are reviewing one story. Read three files:
- the brief (the requirements): ${input.briefPath}
- the implementer's report: ${input.reportPath}
- the review package (commits, --stat, full diff with context; truncated files are listed by name, read them yourself): ${input.packagePath}${concerns}

Give two verdicts:
- **spec**: "pass" only if every acceptance criterion is implemented and covered by a test that would fail without it. Check the report's TDD evidence: missing evidence for an AC, or a test that asserts nothing, is a spec failure.
- **quality**: "approved" or "changes" (correctness, error handling, edge cases, conventions of the surrounding code).

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before this story is done), "minor" (worth noting, not blocking). Put anything you could not check in "cannotVerify".

Reply with only this JSON object:
{"spec": "pass|fail", "quality": "approved|changes", "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "suggestion": "how to fix"}], "cannotVerify": ["..."]}`;
}

export function buildWorkflowReviewJsonRetry(): string {
  return "Your reply was not the required JSON object. Re-send it now as only the JSON object, with no other text.";
}

export function buildWorkflowReviewJsonRetryCondensed(): string {
  return 'Your reply was cut off. Re-send a shorter version: keep every finding but shorten "issue" and "suggestion" to one sentence each. Only the JSON object.';
}
