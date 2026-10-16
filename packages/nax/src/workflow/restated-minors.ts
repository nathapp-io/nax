/**
 * A branch reviewer triages each deferred minor by id, yet some also repeat one as a minor finding
 * of their own ("M2: …", "DEFERRED M4 (…)"). Kept, the copy lists the minor twice and stays "left"
 * after the branch fix addresses the original. Pure.
 *
 * nax numbers deferred minors M1..Mn in order, so an id lead alone cannot tell a copy from the
 * reviewer's own numbering of a new minor. A copy also says DEFERRED, or repeats enough of the known
 * minor's wording. Every dropped draft is returned, so the caller can record it.
 */
import type { MinorItem, WorkflowFindingDraft } from "./types";

/** A leading deferred-minor id: `M2: …`, `[M2] …`, `DEFERRED M4 (…)`. Group 1 = DEFERRED, group 2 = id. */
const MINOR_ID_LEAD = /^\W*(deferred\s+)?\[?(M\d+)\b/i;
/** Share of the shorter text's significant words both texts use; restatements measured 0.21-0.95. */
const RESTATEMENT_OVERLAP = 0.2;
const MIN_WORD_CHARS = 4;

export interface RestatedMinor {
  readonly id: string;
  readonly issue: string;
}

function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_WORD_CHARS);
  return new Set(words.map((w) => (w.endsWith("s") ? w.slice(0, -1) : w)));
}

function overlap(a: string, b: string): number {
  const wa = significantWords(a);
  const wb = significantWords(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size));
}

/** The known minor this draft restates, if any. */
function restatedId(draft: WorkflowFindingDraft, known: ReadonlyMap<string, string>): string | undefined {
  if (draft.severity !== "minor") return undefined;
  const lead = MINOR_ID_LEAD.exec(draft.issue);
  const id = lead?.[2]?.toUpperCase();
  const text = id === undefined ? undefined : known.get(id);
  if (id === undefined || text === undefined) return undefined;
  return lead?.[1] !== undefined || overlap(draft.issue, text) >= RESTATEMENT_OVERLAP ? id : undefined;
}

/** `minors` are the deferred minors the reviewer was shown; a minor it never saw cannot be restated. */
export function splitRestatedMinors<T extends WorkflowFindingDraft>(
  drafts: readonly T[],
  minors: readonly Pick<MinorItem, "id" | "text">[],
): { kept: T[]; dropped: RestatedMinor[] } {
  const known = new Map(minors.map((m) => [m.id.toUpperCase(), m.text]));
  const kept: T[] = [];
  const dropped: RestatedMinor[] = [];
  for (const draft of drafts) {
    const id = restatedId(draft, known);
    if (id === undefined) kept.push(draft);
    else dropped.push({ id, issue: draft.issue });
  }
  return { kept, dropped };
}
