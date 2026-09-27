import { parseRefinementResponse, refinementWouldFallback } from "../acceptance/refinement";
import type { RefinedCriterion } from "../acceptance/types";
import { ParseValidationError } from "../agents/retry";
import { acceptanceConfigSelector } from "../config";
import type { AcceptanceConfig } from "../config/selectors";
import { AcceptancePromptBuilder } from "../prompts";
import type { CompleteOperation } from "./types";

export interface AcceptanceRefineInput {
  criteria: string[];
  codebaseContext: string;
  storyId: string;
  testStrategy?: "unit" | "component" | "cli" | "e2e" | "snapshot";
  testFramework?: string;
  storyTitle?: string;
  storyDescription?: string;
}

export type AcceptanceRefineOutput = RefinedCriterion[];

export const acceptanceRefineOp: CompleteOperation<AcceptanceRefineInput, AcceptanceRefineOutput, AcceptanceConfig> = {
  kind: "complete",
  name: "acceptance-refine",
  stage: "acceptance",
  config: acceptanceConfigSelector,
  // Retry once on empty output. In practice empty output arrives as fail-unknown
  // (ACP process crash) which completeWithFallback does NOT retry — making this
  // the sole retry opportunity. For fail-stale (clean empty), completeWithFallback
  // already runs 3 stale retries before reaching parse(); the op-tier retry then
  // adds one more completeAs call (4 more adapter attempts). Bounded at 8 total.
  retry: { preset: "transient-network" as const, maxAttempts: 2, baseDelayMs: 0 },
  model: (_input, ctx) => ctx.config.acceptance.model,
  timeoutMs: (_input, ctx) => ctx.config.acceptance.timeoutMs,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildRefinementPrompt(input.criteria, input.codebaseContext, {
      testStrategy: input.testStrategy,
      testFramework: input.testFramework,
      storyTitle: input.storyTitle,
      storyDescription: input.storyDescription,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, input, _ctx) {
    if (!output?.trim()) {
      throw new ParseValidationError("acceptance-refine: empty output");
    }
    // Unusable output (non-JSON, or a non-array result) would otherwise be
    // silently swapped for the unrefined criteria — throw so the op's retry
    // budget runs and the caller falls back explicitly (US-003).
    if (refinementWouldFallback(output)) {
      throw new ParseValidationError("acceptance-refine: unusable refinement output");
    }
    const items = parseRefinementResponse(output, input.criteria);
    // A count mismatch means the model dropped or invented criteria; the
    // persisted artifact must map 1:1 onto the input ACs (US-003).
    if (items.length !== input.criteria.length) {
      throw new ParseValidationError(
        `acceptance-refine: returned ${items.length} of ${input.criteria.length} criteria`,
      );
    }
    return items.map((item) => ({ ...item, storyId: item.storyId || input.storyId }));
  },
};
