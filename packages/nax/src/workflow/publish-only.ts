/**
 * `nax run --publish-only` (#2819): rerun only the workflow's publish step for a feature whose
 * finished run left no PR (local-only or pushed), reusing that run's record so the PR carries the
 * same review, gates and items. Nothing is reviewed again, so it refuses whenever the record does
 * not describe the current HEAD.
 */
import { isNaxAutoCommitSubject } from "@/utils/git";
import type { WorkflowFeatureRecord } from "./types";

export type PublishOnlyStart =
  | { readonly kind: "resume"; readonly record: WorkflowFeatureRecord }
  | { readonly kind: "published" }
  | { readonly kind: "refused"; readonly reason: string };

/** One commit between the recorded head and HEAD, as the HEAD-moved refusal names it. */
export interface MovedCommit {
  readonly sha: string;
  readonly subject: string;
}

/** How many commits a refusal names before it counts the rest. */
const MAX_NAMED_COMMITS = 5;

/** `abc1234 fix: one, def5678 fix: two`, plus `, and 3 more` past the cap. */
function namedCommits(moved: readonly MovedCommit[]): string {
  const named = moved
    .slice(0, MAX_NAMED_COMMITS)
    .map((commit) => `${commit.sha} ${commit.subject}`)
    .join(", ");
  const leftOut = moved.length - MAX_NAMED_COMMITS;
  return leftOut > 0 ? `${named}, and ${leftOut} more` : named;
}

/**
 * The refusal text for a HEAD that moved. `moved` is the commits between the recorded head and HEAD,
 * or `undefined` when the lookup failed — an unknown range reads exactly as it did before, because
 * the refusal itself does not depend on it. US-001 (run-start-baseline-fixes): the caller needs to
 * know when every commit is a nax auto-commit, since re-running would then review bookkeeping only.
 */
function movedReason(prior: WorkflowFeatureRecord, moved: readonly MovedCommit[] | undefined): string {
  if (moved === undefined || moved.length === 0) {
    return "HEAD moved since the workflow finished; run nax run so the new commits are reviewed";
  }
  const named = namedCommits(moved);
  if (!moved.every((commit) => isNaxAutoCommitSubject(commit.subject))) {
    return `HEAD moved since the workflow finished (${named}); run nax run so the new commits are reviewed`;
  }
  const published = prior.url ? `; the published PR is ${prior.url}` : "";
  return `HEAD moved since the workflow finished, by nax auto-commits only (${named}); the recorded review, gates and items describe ${prior.head}, and nax run would review the whole branch again${published}`;
}

/**
 * Where a publish-only run starts, given the newest prior feature record and the current HEAD.
 * `moved` is the commits between the recorded head and HEAD (`commitsSince`), used only to word the
 * HEAD-moved refusal; every decision is taken from `prior` and `head` alone.
 */
export function publishOnlyStart(
  prior: WorkflowFeatureRecord | null,
  head: string | undefined,
  moved?: readonly MovedCommit[],
): PublishOnlyStart {
  if (prior === null) {
    return { kind: "refused", reason: "no finished workflow run for this feature; run nax run first" };
  }
  if (prior.step !== "done") {
    return { kind: "refused", reason: `the workflow stopped at ${prior.step}; run nax run to finish it` };
  }
  if (head === undefined || head === "" || prior.head !== head) {
    return { kind: "refused", reason: movedReason(prior, moved) };
  }
  if (prior.outcome === "ready" || prior.outcome === "draft") return { kind: "published" };
  return { kind: "resume", record: { ...prior, step: "publish" } };
}

/**
 * Only transport failures and a pending CI retry publishing without spending another review at the
 * same HEAD. US-003: a pending CI keeps the PR a draft, so the draft is published again — but only
 * when that pending CI is the draft's sole reason, so a draft held for an unrelated reason is not
 * re-published on every run.
 */
export function isTransientDraft(prior: WorkflowFeatureRecord): boolean {
  return (
    prior.outcome === "draft" &&
    (prior.ci === "unavailable" ||
      (prior.ci === "pending" && prior.reasons.length === 1) ||
      prior.reasons.some((reason) => reason.startsWith("PR update failed:")))
  );
}

/** The publication a publish-only run at `head` would skip over. */
export interface PublishedAtHead {
  readonly outcome: "ready" | "draft";
  readonly url?: string;
}

/**
 * US-002: the prior record's publication when a publish-only run at `head` would do nothing;
 * otherwise undefined. It repeats exactly the condition `runInContext` skips at (nax#2550), so a
 * chat launch can refuse before billing a run that would skip in its first second.
 */
export function publishedAtHead(
  prior: WorkflowFeatureRecord | null,
  head: string | undefined,
): PublishedAtHead | undefined {
  if (prior === null || prior.step !== "done") return undefined;
  if (head === undefined || head === "" || prior.head !== head) return undefined;
  if (prior.outcome !== "ready" && prior.outcome !== "draft") return undefined;
  if (isTransientDraft(prior)) return undefined;
  return { outcome: prior.outcome, ...(prior.url === undefined ? {} : { url: prior.url }) };
}
