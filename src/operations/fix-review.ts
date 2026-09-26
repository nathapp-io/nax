/**
 * Fix-review operation (US-003, ADR-033).
 *
 * `fix-review` is a verdict-only run operation: it reviews a *fix's own delta*
 * against the story's acceptance criteria and description, rather than
 * re-reviewing the whole story the way the seeded semantic/adversarial
 * reviewers do. It declares Read/Glob/Grep because the diff is embedded but the
 * reviewer may need to open surrounding code; it has no parse-retry — an
 * unparseable response is an `error` verdict (see `runFixReview`).
 *
 * The `ReviewConfig` generic is the selector slice from `src/config/selectors.ts`
 * (as `semanticReviewOp` uses), not the `ReviewConfig` interface in
 * `src/review/types.ts` — `FixReviewRequest.config` and `resolveFixReviewModel`
 * take the latter.
 */

import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding } from "../findings";
import type { UserStory } from "../prd";
import { buildFixReviewPrompt } from "../prompts";
import type { FixReviewOpOutput } from "../review/fix-review";
import { resolveFixReviewModel } from "../review/fix-review";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface FixReviewOpInput {
  readonly story: UserStory;
  /** The fix's own delta, already truncated by the runner. */
  readonly diff: string;
  /** The findings that seeded the fix. */
  readonly findings: readonly Finding[];
}

/** Coerce a structurally unknown parsed value into the typed `FixReviewOpOutput`. */
function asFixReviewOutput(value: unknown): FixReviewOpOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.passed !== "boolean" || typeof raw.reason !== "string") return null;
  const out: {
    parsed: true;
    passed: boolean;
    reason: string;
    acIndex?: number;
    file?: string;
  } = { parsed: true, passed: raw.passed, reason: raw.reason };
  if (typeof raw.acIndex === "number") out.acIndex = raw.acIndex;
  if (typeof raw.file === "string") out.file = raw.file;
  return out;
}

export const fixReviewOp: RunOperation<FixReviewOpInput, FixReviewOpOutput, ReviewConfig> = {
  kind: "run",
  name: "fix-review",
  stage: "review",
  session: { role: "reviewer-fix", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: reviewConfigSelector,
  model: (_input, ctx) => resolveFixReviewModel(ctx.config.review),
  timeoutMs: (_input, ctx) => ctx.config.review.fixReview.timeoutMs,
  build: (input, _ctx) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildFixReviewPrompt(input), overridable: false },
  }),
  parse: (output, _input, _ctx) => {
    const parsed = asFixReviewOutput(tryParseLLMJson<unknown>(output));
    if (parsed) return parsed;
    // No JSON object at all — return the clipped preview so the caller can
    // treat the verdict as `kind: "error"` (AC16) and audit it.
    // `previewOutput` collapses whitespace and trims; a whitespace-only or
    // empty response would otherwise yield "" and violate AC7's "non-empty
    // unparsedPreview" contract.
    const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
    return { parsed: false, unparsedPreview: preview === "" ? "(empty response)" : preview };
  },
};
