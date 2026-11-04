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
 * mirror's `decisions.jsonl` instead, by id, newest first. An active row must
 * satisfy the mirror's decision contract (six non-empty strings, a status in
 * range) before it replaces anything: the store writes what it is given, so one
 * it would later refuse would take the decision it replaced with it.
 *
 * `kodaHitOf` maps one row of a full-text answer to a keyword-search hit, and is
 * held to the same R2 check: a record the mirror could not hold a note for is
 * dropped rather than ranked. Its `score` is positional, because koda answers a
 * query in its own rank order and nax must not re-rank what the search index
 * already ranked.
 *
 * Internal to `src/memory/`: the pull composes it, the barrel re-exports it.
 */

import type {
  MemoryDecision,
  MemoryHit,
  MemoryNote,
  MemoryNoteStatus,
  MemoryNoteType,
  MemoryScope,
} from "@nathapp/nax-agent";
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

/**
 * The statuses a mirror line may carry.
 *
 * `MEMORY_DECISION_STATUSES` is not exported from the `@nathapp/nax-agent` entry,
 * so the list is restated here; `satisfies` against a decision's own `status`
 * field keeps it a subset of the statuses that entry does express.
 */
const KODA_DECISION_STATUSES = [
  "active",
  "superseded",
  "rejected",
] as const satisfies readonly MemoryDecision["status"][];

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

/**
 * Parse a list page's `records`.
 *
 * The same shape check as {@link parseKodaItems}, for the other route: koda's paginated
 * `GET projects/<slug>/memory` answers its rows in `data.records`, where only the export
 * feed answers `data.items`. The error names the list route so a bad answer is traced to it.
 *
 * @param value - The page's `data.records`
 */
export function parseKodaRecords(value: unknown): readonly KodaMemoryItem[] {
  if (!Array.isArray(value)) {
    throw new NaxError(
      `[memory] koda answered a list page whose records are not an array (got ${valueKindOf(value)})`,
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
 *
 * The caller reads `sourceType` through `stringField`, so a row that carries
 * anything but a string — `parseKodaItems` checks the container only — reads as
 * absent instead of throwing and taking the whole page with it.
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
    source: sourceOf(stringField(item, "sourceType")),
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

/**
 * The distinct slugs this page's own-scope NOTE rows name, in feed order.
 *
 * R1 and R2 are the same two checks `reconcileKodaNotes` applies, so a slug only a row the
 * mirror could not hold a note for names is not answered: the pull reads the mirror's id
 * exactly for the slugs R3 and R5 may compare a row's id against, and once each — a page
 * names one slug in several rows whenever a note was superseded.
 *
 * @param items - The page's rows, in feed order
 * @param scope - The page's scope: a row of the other scope is not this page's note
 */
export function kodaNoteSlugs(items: readonly KodaMemoryItem[], scope: MemoryScope): readonly string[] {
  const slugs = new Set<string>();
  for (const item of items) {
    if (item.kind !== NOTE_KIND || item.scope !== scope) continue;
    const row = readNoteRow(item);
    if (row !== undefined) slugs.add(row.slug);
  }
  return [...slugs];
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
  // An empty id addresses no line, so it can neither set nor remove one.
  if (id === "") return undefined;
  return {
    id,
    active: status === STATUS_ACTIVE && !isDeleted(item),
    decision: { id, subject, predicate, object, updatedAt, status: STATUS_ACTIVE },
  };
}

/**
 * True when `decision` is a line the mirror's `decisions.jsonl` accepts.
 *
 * `DecisionSchema` (`packages/nax-agent/src/memory/records.ts`) requires six
 * non-empty strings and a status in range. The store writes what it is given, so
 * an active row that fails the contract would be persisted and then dropped when
 * the mirror next decodes the file — losing the decision it replaced.
 */
function isStorableDecision(decision: MemoryDecision): boolean {
  const fields = [decision.id, decision.subject, decision.predicate, decision.object, decision.updatedAt];
  if (fields.some((field) => field === "")) return false;
  return KODA_DECISION_STATUSES.some((status) => status === decision.status);
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
    if (row.active) {
      // A row the mirror would refuse cannot replace the decision it names: it is
      // skipped, so the current decision stays exactly as the mirror has it.
      if (!isStorableDecision(row.decision)) {
        skipped += 1;
        continue;
      }
      merged.set(row.id, row.decision);
    } else {
      merged.delete(row.id);
    }
    touched = true;
  }
  if (!touched) return { decisions: undefined, skipped };
  return { decisions: orderedDecisions(merged.values()), skipped };
}

/** The characters of a row's `object` a hit's snippet keeps: a hit is one index line, not a body. */
const HIT_SNIPPET_CHARS = 200;

/** True when `scope` names a mirror a hit can be filed under. */
function isMemoryScope(scope: string): scope is MemoryScope {
  return scope === "project" || scope === "user";
}

/** The body as one line, cut to what an index line holds. */
function snippetOf(body: string): string {
  return body.replace(WHITESPACE_RUN, " ").trim().slice(0, HIT_SNIPPET_CHARS);
}

/**
 * One search record as a keyword-search hit, or `null` when R2 says it is not a note.
 *
 * koda answers a full-text query in its own rank order, best first, so the `score` is
 * positional: the first of `total` records scores `total`, the last scores `1`. The
 * scope comes from the record because a hit is filed where the note lives, and a record
 * naming a scope no mirror has is dropped like any other row the mirror cannot hold.
 *
 * @param record - One record of the search answer
 * @param index - Its position in that answer
 * @param total - How many records the answer carried
 */
export function kodaHitOf(record: KodaMemoryItem, index: number, total: number): MemoryHit | null {
  const note = readNoteRow(record);
  if (note === undefined || !isMemoryScope(record.scope)) return null;
  return {
    slug: note.slug,
    scope: record.scope,
    type: note.type,
    description: note.description,
    status: STATUS_ACTIVE,
    score: total - index,
    snippet: snippetOf(note.body),
  };
}
