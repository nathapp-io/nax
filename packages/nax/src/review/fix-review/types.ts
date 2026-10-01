/**
 * Fix-review interface (US-001).
 *
 * Verdict-only review of a *fix's own delta* — the scoped check the NBF keep
 * gate runs before keeping a best-effort pass (nax#2229). Distinct from the
 * seeded reviewers, which re-read the whole story: this one reads only what the
 * fix changed, against the story's ACs and description.
 *
 * Declarations only in this story (US-001): the operation, prompt, runner and
 * execution wiring land in US-003/US-004/US-005.
 */

import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";
import type { ReviewConfig } from "../types";

/** Outcome of one scoped fix review. */
export type FixReviewVerdict =
  | { readonly kind: "pass"; readonly reviewed: boolean; readonly reason: string }
  | { readonly kind: "fail"; readonly cause: "scope"; readonly files: readonly string[]; readonly reason: string }
  | {
      readonly kind: "fail";
      readonly cause: "contradiction";
      readonly reason: string;
      /** 1-based index into story.acceptanceCriteria, when the reviewer named one. */
      readonly acIndex?: number;
      readonly file?: string;
    }
  | { readonly kind: "error"; readonly reason: string };

/** What `fixReviewOp.parse` returns. */
export type FixReviewOpOutput =
  | {
      readonly parsed: true;
      readonly passed: boolean;
      readonly reason: string;
      readonly acIndex?: number;
      readonly file?: string;
    }
  | { readonly parsed: false; readonly unparsedPreview: string };

export interface FixReviewRequest {
  /** The story's package dir (`ctx.packageDir`); git runs here, and git output is repo-root-relative. */
  readonly workdir: string;
  readonly story: UserStory;
  /** Tree-ish of the working tree before the fix (a commit sha or a tree id). */
  readonly preFixTree: string;
  /** The findings that seeded this fix. */
  readonly findings: readonly Finding[];
  readonly config: ReviewConfig;
}
