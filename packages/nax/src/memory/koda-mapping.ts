/**
 * koda-mapping.ts — pure reconciliation of one koda export page into the notes
 * and decisions a mirror may hold.
 *
 * nax-agent's sync applies a page's notes by slug and deletes a slug's note for
 * any tombstone, so a feed that carries rows for ids the mirror no longer holds
 * would let a stale row delete a newer note. This module therefore folds a page
 * into at most one note per slug before sync sees it:
 *
 * - R1 a row that is not a `NOTE` of the page's scope is not this page's note;
 * - R2 a row that is not a note the mirror may hold (bad slug, unknown
 *   predicate, missing or non-string field) is skipped and counted;
 * - R3 a `superseded` row adds no note, and when it supersedes the slug's known
 *   id it leaves that id *unknown*, because its successor may be an `active`
 *   row or a tombstone later in the same page;
 * - R4 an `active` row with no `deletedAt` becomes the slug's current note;
 * - R5 a `rejected` row, or any row carrying `deletedAt`, is a tombstone: it
 *   applies only to the slug's known id, or to an id R3 left unknown, and is
 *   otherwise ignored;
 * - R6 the answer is the current note of every slug that has one, ordered by
 *   slug code point.
 *
 * `DECISION` rows never become notes; `mergeKodaDecisions` merges them into the
 * mirror's `decisions.jsonl` instead, by id, newest first.
 *
 * Internal to `src/memory/`: the pull composes it, the barrel re-exports it.
 */

import type { MemoryDecision, MemoryNote, MemoryNoteStatus, MemoryNoteType, MemoryScope } from "@nathapp/nax-agent";
import { MEMORY_SLUG_RE, MEMORY_SOURCE_MAX_CHARS } from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";

const STAGE = "memory";

/** koda's kind for a row a mirror can hold a note for. */
const NOTE_KIND = "NOTE";
/** koda's kind for a row the decision merge applies. */
const DECISION_KIND = "DECISION";

const STATUS_ACTIVE = "active";
const STATUS_SUPERSEDED = "superseded";
const STATUS_REJECTED = "rejected";

/** The source a row is recorded under when its `sourceType` is absent or blank. */
const DEFAULT_SOURCE = "koda";
const WHITESPACE_RUN = /\s+/g;

/** One row of koda's export feed, as koda spells it. */
export interface KodaMemoryItem {
  readonly id: string;
  readonly kind: string; // "NOTE" | "DECISION" | other koda kinds
  readonly scope: string; // "project" | "user"
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly description?: string;
  readonly status: string; // "active" | "superseded" | "rejected"
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
  readonly sourceType?: string;
}

/**
 * The predicates a note may carry.
 *
 * `MEMORY_NOTE_TYPES` is not exported from the `@nathapp/nax-agent` entry, so
 * the list is restated here; `satisfies` keeps it a subset of the note types
 * that entry does export.
 */
export const KODA_NOTE_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const satisfies readonly MemoryNoteType[];

/** The most decisions the mirror's `decisions.jsonl` keeps: the newest ones. */
export const MEMORY_KODA_DECISIONS_MAX = 500;

/**
 * The container shape of a row — an object, not an array or a scalar.
 *
 * Only the container is asserted: that a row claiming to be a note still has a
 * string slug, a known predicate and every required field is R2's job, and a row
 * that fails it is *skipped and counted*, not thrown away here.
 */
function isKodaRow(value: unknown): value is KodaMemoryItem {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short name for a value that is not an array, for the error message and its context. */
function valueKindOf(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}

/**
 * Parse an export page's `items`.
 *
 * A shape check only: an array of rows. Every field is read defensively by the
 * reconciliation, so a row that is not an object is dropped here rather than
 * carried into it.
 *
 * @param value - The page's `data.items`
 */
export function parseKodaItems(value: unknown): readonly KodaMemoryItem[] {
  if (!Array.isArray(value)) {
    throw new NaxError(
      `[memory] koda answered an export page whose items are not an array (got ${valueKindOf(value)})`,
      "MEMORY_KODA_BAD_RESPONSE",
      { stage: STAGE, received: valueKindOf(value) },
    );
  }
  return value.filter(isKodaRow);
}

/** A row's `field` when it is a string, else `undefined` — the test every required field takes. */
function stringField(item: KodaMemoryItem, field: keyof KodaMemoryItem): string | undefined {
  const value: unknown = item[field];
  return typeof value === "string" ? value : undefined;
}

function isNoteType(value: string): value is MemoryNoteType {
  return KODA_NOTE_TYPES.some((type) => type === value);
}

/** A row is deleted when it carries a `deletedAt` value; koda answers `null` for one it has not deleted. */
function isDeleted(item: KodaMemoryItem): boolean {
  return typeof item.deletedAt === "string";
}

/**
 * The note's `source`: `sourceType` with whitespace runs collapsed to one space,
 * cut to `MEMORY_SOURCE_MAX_CHARS`, or {@link DEFAULT_SOURCE} when that is blank.
 */
function sourceOf(sourceType: string | undefined): string {
  const collapsed = (sourceType ?? "").replace(WHITESPACE_RUN, " ").trim();
  if (collapsed === "") return DEFAULT_SOURCE;
  return collapsed.slice(0, MEMORY_SOURCE_MAX_CHARS).trimEnd();
}

/** One NOTE row the mirror may hold, its fields validated and its source resolved. */
interface NoteRow {
  readonly id: string;
  readonly slug: string;
  readonly type: MemoryNoteType;
  readonly description: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly status: string;
  readonly source: string;
  readonly deleted: boolean;
}

/** The row as a note row, or `undefined` when R2 says it is not one the mirror may hold. */
function readNoteRow(item: KodaMemoryItem): NoteRow | undefined {
  const id = stringField(item, "id");
  const slug = stringField(item, "subject");
  const type = stringField(item, "predicate");
  const body = stringField(item, "object");
  const description = stringField(item, "description");
  const updatedAt = stringField(item, "updatedAt");
  const status = stringField(item, "status");
  if (id === undefined || slug === undefined || type === undefined || body === undefined) return undefined;
  if (description === undefined || updatedAt === undefined || status === undefined) return undefined;
  if (!MEMORY_SLUG_RE.test(slug)) return undefined;
  if (!isNoteType(type)) return undefined;
  return {
    id,
    slug,
    type,
    description,
    body,
    updatedAt,
    status,
    source: sourceOf(item.sourceType),
    deleted: isDeleted(item),
  };
}

/** One slug's state within a page: its current note, or the fact that its id is unknown. */
interface SlugState {
  readonly note?: MemoryNote;
  readonly unknown: boolean;
}

/** No note and no supersession yet: what a slug starts as. */
const EMPTY_STATE: SlugState = { unknown: false };

function noteOf(row: NoteRow, scope: MemoryScope, status: MemoryNoteStatus): MemoryNote {
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    scope,
    description: row.description,
    body: row.body,
    updatedAt: row.updatedAt,
    source: row.source,
    status,
  };
}

/** The id the slug's note is known to have: the page's own note first, then the mirror's. */
function currentIdOf(state: SlugState, mirrorIds: ReadonlyMap<string, string>, slug: string): string | undefined {
  return state.note?.id ?? mirrorIds.get(slug);
}

/** R3: adds no note; a match with the slug's known id leaves that id unknown. */
function superseded(row: NoteRow, state: SlugState, mirrorIds: ReadonlyMap<string, string>): SlugState {
  if (state.unknown || currentIdOf(state, mirrorIds, row.slug) !== row.id) return state;
  return { unknown: true };
}

/** R5: applies only to the slug's known id, or to the id a supersession left unknown. */
function tombstone(
  row: NoteRow,
  state: SlugState,
  mirrorIds: ReadonlyMap<string, string>,
  scope: MemoryScope,
): SlugState {
  if (!state.unknown && currentIdOf(state, mirrorIds, row.slug) !== row.id) return state;
  return { note: noteOf(row, scope, row.deleted ? "deleted" : "rejected"), unknown: false };
}

/** R3, R4 and R5 for one row: the slug's state after it. */
function applyRow(
  row: NoteRow,
  state: SlugState,
  mirrorIds: ReadonlyMap<string, string>,
  scope: MemoryScope,
): SlugState {
  if (row.status === STATUS_SUPERSEDED) return superseded(row, state, mirrorIds);
  if (row.status === STATUS_ACTIVE && !row.deleted) return { note: noteOf(row, scope, "active"), unknown: false };
  if (row.status === STATUS_REJECTED || row.deleted) return tombstone(row, state, mirrorIds, scope);
  return state;
}

/** R6: the current note of every slug that has one, in slug code-point order. */
function currentNotes(states: ReadonlyMap<string, SlugState>): readonly MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const slug of [...states.keys()].sort(byCodePoint)) {
    const note = states.get(slug)?.note;
    if (note !== undefined) notes.push(note);
  }
  return notes;
}

/**
 * Reconcile one page's rows into the notes it moves.
 *
 * @param items - The page's rows, in feed order
 * @param scope - The page's scope: a row of the other scope is not this page's note
 * @param mirrorIds - The mirror's note id for each slug the page names, read before the page
 */
export function reconcileKodaNotes(
  items: readonly KodaMemoryItem[],
  scope: MemoryScope,
  mirrorIds: ReadonlyMap<string, string>,
): { readonly notes: readonly MemoryNote[]; readonly skipped: number } {
  const states = new Map<string, SlugState>();
  let skipped = 0;
  for (const item of items) {
    if (item.kind !== NOTE_KIND || item.scope !== scope) continue;
    const row = readNoteRow(item);
    if (row === undefined) {
      skipped += 1;
      continue;
    }
    states.set(row.slug, applyRow(row, states.get(row.slug) ?? EMPTY_STATE, mirrorIds, scope));
  }
  return { notes: currentNotes(states), skipped };
}

/** One DECISION row the merge can apply. */
interface DecisionRow {
  readonly id: string;
  readonly active: boolean;
  readonly decision: MemoryDecision;
}

/** The row as a decision row, or `undefined` when a required field is missing or not a string. */
function readDecisionRow(item: KodaMemoryItem): DecisionRow | undefined {
  const id = stringField(item, "id");
  const subject = stringField(item, "subject");
  const predicate = stringField(item, "predicate");
  const object = stringField(item, "object");
  const updatedAt = stringField(item, "updatedAt");
  const status = stringField(item, "status");
  if (id === undefined || subject === undefined || predicate === undefined) return undefined;
  if (object === undefined || updatedAt === undefined || status === undefined) return undefined;
  return {
    id,
    active: status === STATUS_ACTIVE && !isDeleted(item),
    decision: { id, subject, predicate, object, updatedAt, status: STATUS_ACTIVE },
  };
}

/** Newest first, ties by id, cut to the number of decisions the mirror keeps. */
function orderedDecisions(decisions: Iterable<MemoryDecision>): readonly MemoryDecision[] {
  return [...decisions].sort(compareDecisions).slice(0, MEMORY_KODA_DECISIONS_MAX);
}

function compareDecisions(left: MemoryDecision, right: MemoryDecision): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
  return byCodePoint(left.id, right.id);
}

/**
 * Merge a page's DECISION rows into the mirror's current decisions, by id.
 *
 * The caller decides whether a page's decisions are the mirror's to write: sync
 * owns `decisions.jsonl` for a project page only.
 *
 * @param current - The mirror's decisions before this page
 * @param items - The page's rows, in feed order
 */
export function mergeKodaDecisions(
  current: readonly MemoryDecision[],
  items: readonly KodaMemoryItem[],
): { readonly decisions: readonly MemoryDecision[] | undefined; readonly skipped: number } {
  const merged = new Map<string, MemoryDecision>();
  for (const decision of current) merged.set(decision.id, decision);
  let skipped = 0;
  let touched = false;
  for (const item of items) {
    if (item.kind !== DECISION_KIND) continue;
    const row = readDecisionRow(item);
    if (row === undefined) {
      skipped += 1;
      continue;
    }
    touched = true;
    if (row.active) merged.set(row.id, row.decision);
    else merged.delete(row.id);
  }
  if (!touched) return { decisions: undefined, skipped };
  return { decisions: orderedDecisions(merged.values()), skipped };
}
