/**
 * Continuation prompt for autofix retry attempts (PROMPT-001).
 * Sent on attempt 2+ when the implementer session is confirmed open.
 * Contains ONLY new error output + escalation preamble — NOT the full prompt.
 */

import type { ReviewCheckResult } from "../../review/types";
import { CONTRADICTION_ESCAPE_HATCH } from "./autofix-prompts";

export function buildReviewRectificationContinuation(
  failedChecks: ReviewCheckResult[],
  attempt: number,
  rethinkAtAttempt: number,
  urgencyAtAttempt: number,
): string {
  const parts: string[] = [];

  parts.push("Your previous fix attempt did not resolve all issues. Here are the remaining failures:\n");

  for (const check of failedChecks) {
    parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
    const truncated = check.output.length > 4000;
    const output = truncated
      ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
      : check.output;
    parts.push(`\`\`\`\n${output}\n\`\`\`\n`);
    if (check.findings?.length) {
      parts.push("Structured findings:\n");
      for (const f of check.findings) {
        parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
      }
    }
  }

  if (attempt >= rethinkAtAttempt) {
    parts.push(
      "\n**Rethink your approach.** The same strategy has failed multiple times. Consider a fundamentally different fix.\n",
    );
  }
  if (attempt >= urgencyAtAttempt) {
    parts.push(
      "\n**URGENT: This is your final attempt.** If you cannot fix all issues, emit `UNRESOLVED: <reason>` to escalate.\n",
    );
  }

  parts.push(CONTRADICTION_ESCAPE_HATCH);

  return parts.join("\n");
}
