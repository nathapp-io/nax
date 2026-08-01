/**
 * Review acknowledgements (#1423).
 *
 * The carry-forward verdict template (`buildPriorIterationsBlock`) asks the
 * reviewer to classify every prior finding as `addressed`, `still-blocking`, or
 * `never-an-issue`. Only `still-blocking` is a defect. Before `acks` existed the
 * reviewer's only output channel was `findings`, so the other two verdicts were
 * emitted as findings — 2.2% of July's, all `info`, and they became the evidence
 * samples quoted in curator rule proposals.
 *
 * Shared by both reviewers: the verdict template is the same for semantic and
 * adversarial, so the read path is too.
 */

import type { ReviewAck } from "./types";

/**
 * Normalize a reviewer's `acks` array.
 *
 * Absent on first review rounds and on any response from a reviewer that
 * ignored the field, so a missing or malformed value degrades to "no
 * acknowledgements" — never an error. An unrecognised `status` falls back to
 * `addressed`, the benign reading: it keeps the entry out of `findings`, which
 * is the whole point, without inventing a withdrawal the reviewer did not make.
 */
export function extractAcks(raw: unknown): ReviewAck[] {
  if (!Array.isArray(raw)) return [];
  const acks: ReviewAck[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    acks.push({
      priorFinding: typeof e.priorFinding === "string" ? e.priorFinding : "",
      status: e.status === "never-an-issue" ? "never-an-issue" : "addressed",
      ...(typeof e.note === "string" && e.note !== "" && { note: e.note }),
    });
  }
  return acks;
}
