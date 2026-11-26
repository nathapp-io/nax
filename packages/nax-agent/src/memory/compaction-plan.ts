/**
 * Compaction planning: which notes a plan may act on, and whether a plan may be applied.
 *
 * ## Candidates
 *
 * The rule is deliberately narrow, because everything it lets through is a note a person
 * can lose. A candidate is what the *project* mirror holds, still `active`, of type
 * `project` or `reference`, and not already on its way out through a queued forget. That
 * leaves the note kinds a compaction must never touch untouched:
 *
 * - a `feedback` or `user` note is a standing instruction, not project knowledge that goes
 *   stale, and rewriting it would change how the agent behaves rather than what it knows;
 * - a user-scope note belongs to the person across every project, so one project's
 *   compaction has no standing to fold it;
 * - a `pending` note is one already awaiting a decision — retiring it would decide it;
 * - a note a queued forget already holds is going regardless, so listing it would let a
 *   plan take credit for work the outbox is doing and archive a note nobody chose to lose;
 * - decisions and repository notes are not in the mirror at all (the index and the host
 *   hold them), so they are out of reach here by construction rather than by a check.
 *
 * The answer is in slug order so the same mirror always produces the same candidate list,
 * and a plan built from it is reproducible rather than dependent on directory read order.
 *
 * ## Validation
 *
 * `validateMemoryCompactionPlan` is the gate between what a model proposed and what an
 * apply writes. Its answer is a list of reasons rather than a verdict, because the model is
 * asked to revise the plan: one fault at a time would cost a round trip per fault, and a
 * plan wrong in three ways would take three revisions to say so. Each reason names the slug
 * or merge target it is about, so the revision reads as an instruction.
 *
 * The checks are the mirror's rules restated, in the order a person reading the reasons
 * would want them: what the plan does at all, whether every note it names may be acted on,
 * whether a slug is touched once, whether a merge is a merge, whether its target is free,
 * and finally whether the note and the retire reasons it writes could be stored directly.
 * The last one is the same `validateMemoryNoteWrite` a save runs and the same
 * `forgetReasonRefusal` a forget runs, so a plan can never write what a bare save refuses.
 */
import { byCodePoint } from "#src/internal/sort";
import {
  MEMORY_COMPACTION_SOURCE,
  type MemoryCompactionMerge,
  type MemoryCompactionPlan,
  type MemoryCompactionPlanCheck,
} from "./compaction-types.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import { type MemoryNote, type MemoryNoteType, memoryNoteKey } from "./types.ts";
import { forgetReasonRefusal, validateMemoryNoteWrite } from "./validate.ts";

/** The two note types a compaction may rewrite: project knowledge and the references to it. */
const COMPACTABLE_TYPES: ReadonlySet<MemoryNoteType> = new Set<MemoryNoteType>(["project", "reference"]);

/** Whether one listed note may be acted on, given the keys a queued forget already holds. */
function isCandidate(note: MemoryNote, heldForgets: ReadonlySet<string>): boolean {
  if (note.scope !== "project") return false;
  if (note.status !== "active") return false;
  if (!COMPACTABLE_TYPES.has(note.type)) return false;
  return !heldForgets.has(memoryNoteKey(note.scope, note.slug));
}

/**
 * The notes a compaction may act on, in slug order.
 *
 * `store.listNotes("project")` is a listing, not a promise: a failing scope answers `[]`,
 * and a note whose frontmatter declares another scope is still returned. The `scope` check
 * is therefore part of the rule, not a restatement of the listing.
 */
export async function memoryCompactionCandidates(input: {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
}): Promise<readonly MemoryNote[]> {
  const projectNotes = await input.store.listNotes("project");
  const heldForgets = await input.outbox.heldKeys("forget");
  return projectNotes.filter((note) => isCandidate(note, heldForgets)).sort((a, b) => byCodePoint(a.slug, b.slug));
}

/** The reason a plan that retires and merges nothing is refused with. */
const CHANGES_NOTHING_REASON = "the plan changes nothing: it retires no note and merges no notes";

/** The reasons a plan that acts on nothing at all is refused with (rule 1). */
function nothingToDoReasons(plan: MemoryCompactionPlan): string[] {
  return plan.retire.length === 0 && plan.merge.length === 0 ? [CHANGES_NOTHING_REASON] : [];
}

/** The reasons a slug a plan names may not be acted on because no candidate holds it (rule 2). */
function membershipReasons(plan: MemoryCompactionPlan, candidates: ReadonlyMap<string, MemoryNote>): string[] {
  const reasons: string[] = [];
  for (const retire of plan.retire) {
    if (!candidates.has(retire.slug)) reasons.push(`retire "${retire.slug}": it is not a compaction candidate`);
  }
  for (const merge of plan.merge) {
    for (const from of merge.from) {
      if (!candidates.has(from)) {
        reasons.push(`merge into "${merge.into.slug}": its source "${from}" is not a compaction candidate`);
      }
    }
  }
  return reasons;
}

/** Every slug the plan's actions name, in the order it names them. */
function actionSlugs(plan: MemoryCompactionPlan): string[] {
  return [...plan.retire.map((retire) => retire.slug), ...plan.merge.flatMap((merge) => merge.from)];
}

/** The values repeated in `slugs`, in the order of their first appearance. */
function repeatedValues(slugs: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([slug]) => slug);
}

/** The reasons a slug is touched by more than one action (rule 3). */
function duplicateReasons(plan: MemoryCompactionPlan): string[] {
  const reasons = repeatedValues(actionSlugs(plan)).map(
    (slug) => `slug "${slug}" appears in more than one action of the plan`,
  );
  for (const slug of repeatedValues(plan.merge.map((merge) => merge.into.slug))) {
    reasons.push(`merge target "${slug}" is used by more than one merge`);
  }
  return reasons;
}

/** The fewest notes a merge may fold together: one note is not a merge. */
const MIN_MERGE_SOURCES = 2;

/**
 * The distinct types the merge's sources carry, or `null` when one of them is not a
 * candidate — its type is unknown, and the membership reason already covers it.
 */
function sourceTypes(
  merge: MemoryCompactionMerge,
  candidates: ReadonlyMap<string, MemoryNote>,
): MemoryNoteType[] | null {
  const notes = merge.from.map((slug) => candidates.get(slug)).filter((note): note is MemoryNote => note !== undefined);
  if (notes.length !== merge.from.length) return null;
  return [...new Set(notes.map((note) => note.type))];
}

/**
 * The reasons a merge does not fold two-or-more notes of one type (rules 4 and 5).
 *
 * A merge is a fold, not a rename: one source is a rewrite a save could do, and a mix of
 * types would produce a note whose type lies about half of what it holds. The target type
 * is therefore not free either — it is the type its sources already share.
 */
function sourceReasons(merge: MemoryCompactionMerge, candidates: ReadonlyMap<string, MemoryNote>): string[] {
  const target = merge.into.slug;
  const reasons: string[] =
    merge.from.length < MIN_MERGE_SOURCES
      ? [`merge into "${target}": a merge needs at least ${MIN_MERGE_SOURCES} sources, it lists ${merge.from.length}`]
      : [];
  const types = sourceTypes(merge, candidates);
  if (types === null || types.length === 0) return reasons;
  if (types.length > 1) {
    reasons.push(`merge into "${target}": its sources are of different types (${types.join(", ")})`);
    return reasons;
  }
  const [shared] = types;
  if (merge.into.type !== shared) {
    reasons.push(
      `merge into "${target}": the target type "${merge.into.type}" differs from its sources' type "${shared}"`,
    );
  }
  return reasons;
}

/** The reason a merge would take a slug that already exists (rule 6). */
function targetReasons(merge: MemoryCompactionMerge, existingSlugs: ReadonlySet<string>): string[] {
  const { slug } = merge.into;
  if (!existingSlugs.has(slug)) return [];
  if (merge.from.includes(slug)) return [];
  return [`merge target "${slug}": the slug already exists and is not one of the merge's own sources`];
}

/**
 * The reasons the note a merge writes would not survive a direct save (rule 7).
 *
 * A compacted note is a note like any other — a person reads it, a provider stores it and
 * the index renders it — so it is held to the same write validation a save runs rather than
 * to a looser copy of it. The reason is `validateMemoryNoteWrite`'s own text, prefixed with
 * the merge it belongs to so a plan with several merges says which one is wrong.
 */
function writeReasons(merge: MemoryCompactionMerge): string[] {
  const refusal = validateMemoryNoteWrite({ ...merge.into, scope: "project" }, MEMORY_COMPACTION_SOURCE);
  return refusal === null ? [] : [`merge target "${merge.into.slug}": ${refusal.reason}`];
}

/**
 * The reasons a retire's justification could not be recorded (rule 8).
 *
 * The reason is not a note field that only the archive keeps: it is the text the forget the
 * retire enqueues is delivered with, and the outbox refuses a request whose reason breaks
 * the same rule. Checking it here is what lets an apply reach the outbox with a request it
 * will take, instead of failing half-way through a plan the person already confirmed.
 */
function retireReasons(plan: MemoryCompactionPlan): string[] {
  const reasons: string[] = [];
  for (const retire of plan.retire) {
    const refusal = forgetReasonRefusal(retire.reason);
    if (refusal !== null) reasons.push(`retire "${retire.slug}": ${refusal.reason}`);
  }
  return reasons;
}

/**
 * Every reason `plan` may not be applied against `candidates`, or `{ ok: true }`.
 *
 * `candidates` is what `memoryCompactionCandidates` answered, and `existingSlugs` is every
 * slug a merge target may not take — the mirror's own project slugs plus, at a nax host,
 * the repository notes' slugs. A target equal to one of its own sources is exempt: that is
 * a merge that keeps the slug the note already had.
 */
export function validateMemoryCompactionPlan(
  plan: MemoryCompactionPlan,
  candidates: readonly MemoryNote[],
  existingSlugs: ReadonlySet<string>,
): MemoryCompactionPlanCheck {
  const candidatesBySlug = new Map(candidates.map((note) => [note.slug, note]));
  const reasons = [
    ...nothingToDoReasons(plan),
    ...membershipReasons(plan, candidatesBySlug),
    ...duplicateReasons(plan),
    ...plan.merge.flatMap((merge) => sourceReasons(merge, candidatesBySlug)),
    ...plan.merge.flatMap((merge) => targetReasons(merge, existingSlugs)),
    ...plan.merge.flatMap((merge) => writeReasons(merge)),
    ...retireReasons(plan),
  ];
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
