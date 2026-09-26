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
 *
 * RED STUB (US-003 test-writer session): `session` and `model` are placeholders
 * and `parse` returns a fixed verdict, so AC6-AC9 fail on their assertions
 * rather than on a throw or an import. The implementer supplies the real
 * values: `session` → `{ role: "reviewer-fix", lifetime: "fresh" }`,
 * `model` → `resolveFixReviewModel(ctx.config.review)`, and `parse` → the JSON
 * verdict (or `{ parsed: false, unparsedPreview }`).
 */

import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding } from "../findings";
import type { UserStory } from "../prd";
import { buildFixReviewPrompt } from "../prompts";
import type { FixReviewOpOutput } from "../review/fix-review";
import type { RunOperation } from "./types";

export interface FixReviewOpInput {
  readonly story: UserStory;
  /** The fix's own delta, already truncated by the runner. */
  readonly diff: string;
  /** The findings that seeded the fix. */
  readonly findings: readonly Finding[];
}

/** Placeholder reason so an unimplemented parse surfaces as an assertion failure. */
const NOT_IMPLEMENTED_REASON = "fix-review parse not implemented (US-003)";

export const fixReviewOp: RunOperation<FixReviewOpInput, FixReviewOpOutput, ReviewConfig> = {
  kind: "run",
  name: "fix-review",
  stage: "review",
  // PLACEHOLDER (US-003 RED): AC8 pins the real role/lifetime pair.
  session: { role: "reviewer-semantic", lifetime: "warm" },
  tools: ["Read", "Glob", "Grep"],
  config: reviewConfigSelector,
  // PLACEHOLDER (US-003 RED): AC9 requires resolveFixReviewModel(ctx.config.review).
  model: () => undefined,
  timeoutMs: (_input, ctx) => ctx.config.review.fixReview.timeoutMs,
  build: (input, _ctx) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildFixReviewPrompt(input), overridable: false },
  }),
  // PLACEHOLDER (US-003 RED): AC6/AC7 require the real verdict parse.
  parse: (_output, _input, _ctx) => ({ parsed: true, passed: true, reason: NOT_IMPLEMENTED_REASON }),
};
