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
 * Ceiling on retained acknowledgements; the rest are dropped rather than
 * bloating every audit record.
 *
 * Bounds a single reviewer response here. Historically also exported for the
 * merged total in the deleted `semantic-debate.ts` (#1859), where N debaters'
 * responses were concatenated into one audit entry and would otherwise have
 * persisted N × this.
 */
export const MAX_ACKS = 50;
/** Ceiling on a single `note`, matching the clipping other reviewer text gets. */
const MAX_NOTE_CHARS = 500;

/**
 * Normalize a reviewer's `acks` array.
 *
 * Absent on first review rounds and on any response from a reviewer that
 * ignored the field, so a missing or malformed value degrades to "no
 * acknowledgements" — never an error.
 *
 * An unrecognised `status` is recorded as `unknown` with the literal value
 * preserved in `rawStatus`, NOT coerced to `addressed`. The realistic misuse is
 * a reviewer writing `still-blocking` into `acks` instead of re-flagging the
 * finding: coercing that to `addressed` would make the audit affirmatively
 * certify an unfixed defect as resolved, and no post-hoc analysis could ever
 * surface the pattern.
 */
export function extractAcks(raw: unknown): ReviewAck[] {
  if (!Array.isArray(raw)) return [];
  const acks: ReviewAck[] = [];
  for (const entry of raw) {
    if (acks.length >= MAX_ACKS) break;
    // A bare string is a plausible LLM shape ("fixed the null check"); keep it
    // as the referent rather than dropping the acknowledgement entirely.
    if (typeof entry === "string") {
      if (entry !== "") acks.push({ priorFinding: entry, status: "unknown" });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const known = e.status === "addressed" || e.status === "never-an-issue";
    const note = typeof e.note === "string" ? e.note.slice(0, MAX_NOTE_CHARS) : "";
    acks.push({
      priorFinding: typeof e.priorFinding === "string" ? e.priorFinding : "",
      status: known ? (e.status as "addressed" | "never-an-issue") : "unknown",
      ...(note !== "" && { note }),
      ...(!known && typeof e.status === "string" && { rawStatus: e.status }),
    });
  }
  return acks;
}
