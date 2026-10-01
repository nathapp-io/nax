import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry";

/**
 * Shared parse-retry `exhaustedFallback` for the semantic and adversarial review
 * ops. Both reach the same decision when the retry budget is spent, and both must
 * carry a preview of the output that defeated the parser — the raw reviewer
 * response is retained nowhere else (prompt-audit stores prompts only), so
 * without it a give-up leaves only a byte count behind and cannot be diagnosed
 * after the run. See `docs/findings/2026-08-01-review-pipeline-gap-analysis.md` (F2).
 *
 * The `looksLikeFail` regex decides block-vs-fail-open. It is a weak signal —
 * 7 of 13 July-2026 give-ups fell through to fail-open, shipping the story with
 * no story-level review — but changing that verdict needs evidence this preview
 * is what collects. Behaviour is deliberately unchanged here.
 */
export function reviewExhaustedFallback<T extends { passed: boolean; failOpen?: boolean }>(
  lastOutput: string,
  failOpen: T,
): T {
  const unparsedPreview = previewOutput(lastOutput, UNPARSED_PREVIEW_BYTES);
  if (!/"passed"\s*:\s*false/.test(lastOutput)) return { ...failOpen, unparsedPreview };
  // FAIL_OPEN already carries the empty findings/normalizedFindings/acDropped
  // arrays both shapes need; only the verdict flags differ.
  return { ...failOpen, passed: false, failOpen: false, looksLikeFail: true, unparsedPreview };
}
