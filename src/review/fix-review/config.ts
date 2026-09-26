/**
 * Model resolution for the scoped fix review (US-001).
 *
 * `review.fixReview.model` is optional by design: an unset value falls back to
 * the semantic reviewer's model, and only then to the "balanced" tier — so an
 * operator who pinned one reviewer model for the whole run does not have to
 * repeat it under `fixReview`.
 *
 * RED STUB (US-001 test-writer session): the body returns a fixed placeholder
 * so AC5-AC7 fail on their assertion rather than on a throw or an import. The
 * implementer replaces it with the real chain — see the ACs.
 */

import type { ConfiguredModel } from "@/config/schema-types";
import type { ReviewConfig } from "../types";

/** Placeholder so every AC5-AC7 fixture mismatch surfaces as an assertion failure. */
const NOT_IMPLEMENTED_MODEL = "fast";

export function resolveFixReviewModel(_review: ReviewConfig): ConfiguredModel {
  return NOT_IMPLEMENTED_MODEL;
}
