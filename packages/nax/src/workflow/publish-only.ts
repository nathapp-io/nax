/**
 * `nax run --publish-only` (#2819): rerun only the workflow's publish step for a feature whose
 * finished run left no PR (local-only or pushed), reusing that run's record so the PR carries the
 * same review, gates and items. Nothing is reviewed again, so it refuses whenever the record does
 * not describe the current HEAD.
 */
import type { WorkflowFeatureRecord } from "./types";

export type PublishOnlyStart =
  | { readonly kind: "resume"; readonly record: WorkflowFeatureRecord }
  | { readonly kind: "published" }
  | { readonly kind: "refused"; readonly reason: string };

/** Where a publish-only run starts, given the newest prior feature record and the current HEAD. */
export function publishOnlyStart(prior: WorkflowFeatureRecord | null, head: string | undefined): PublishOnlyStart {
  if (prior === null) {
    return { kind: "refused", reason: "no finished workflow run for this feature; run nax run first" };
  }
  if (prior.step !== "done") {
    return { kind: "refused", reason: `the workflow stopped at ${prior.step}; run nax run to finish it` };
  }
  if (head === undefined || head === "" || prior.head !== head) {
    return {
      kind: "refused",
      reason: "HEAD moved since the workflow finished; run nax run so the new commits are reviewed",
    };
  }
  if (prior.outcome === "ready" || prior.outcome === "draft") return { kind: "published" };
  return { kind: "resume", record: { ...prior, step: "publish" } };
}
