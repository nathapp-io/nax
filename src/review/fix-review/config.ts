/**
 * Model resolution for the scoped fix review (US-001).
 *
 * `review.fixReview.model` is optional by design: an unset value falls back to
 * the semantic reviewer's model, and only then to the "balanced" tier — so an
 * operator who pinned one reviewer model for the whole run does not have to
 * repeat it under `fixReview`.
 */

import type { ConfiguredModel } from "@/config/schema-types";
import type { ReviewConfig } from "../types";

/** Final fallback when neither fixReview nor semantic pins a model. */
const DEFAULT_FIX_REVIEW_MODEL = "balanced";

export function resolveFixReviewModel(review: ReviewConfig): ConfiguredModel {
  return review.fixReview.model ?? review.semantic?.model ?? DEFAULT_FIX_REVIEW_MODEL;
}
