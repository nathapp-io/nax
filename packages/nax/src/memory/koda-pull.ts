/**
 * koda-pull.ts — one page of koda's export feed, reconciled into the notes and
 * decisions a mirror may hold.
 *
 * The feed is one request: `GET projects/<slug>/memory/export` with the scope's
 * last checkpointed cursor as `since` (absent on the first page, so koda starts at
 * the beginning) and a `take` koda will honour. koda has no scope parameter — its
 * answer carries the project's rows *and* the calling principal's user-scope rows —
 * so both pulls read the same feed and the reconciliation keeps only the page's own
 * scope.
 *
 * The mirror's ids are read **before** the page is reconciled, because R5 compares a
 * tombstone's id against them: a row that names a note the mirror no longer holds must
 * not delete the newer one it holds instead. They are read once for each distinct slug
 * the page's own-scope NOTE rows that pass R2 name, and never for a slug only a row the
 * mirror could not hold a note for names.
 *
 * A `DECISION` row is the project mirror's to merge, never a user page's: sync writes
 * `decisions.jsonl` for a project page alone, so a user page's rows are not read against
 * it and its answer carries no `decisions` at all. A page with no valid `DECISION` row
 * answers none either, which is what keeps `decisions.jsonl` from being rewritten for
 * nothing.
 *
 * What the mirror cannot take is counted and reported once per page, never thrown: one
 * unreadable row must not cost the page its cursor. A page whose *shape* is wrong — items
 * that are not an array, a `hasMore` that is not a boolean — is a different matter: it
 * cannot be read as a page at all, so it is a bad response and sync keeps the cursor the
 * last good page checkpointed.
 *
 * A `202` save wrote no row: koda opened an approval request instead, and the provider
 * recorded it (`koda-approvals.ts`). At the scope's own last page this module resolves at
 * most `MEMORY_KODA_APPROVAL_CHECKS_MAX` of that scope's records, oldest first, by reading
 * `GET approvals/<id>`. A proposal koda has not settled keeps its record; one it executed
 * drops it, because the row arrives through the feed; one it refused drops it *and* puts
 * the slug back, which is the part the feed can never do — a rejected proposal leaves the
 * note an edit replaced locally standing as `pending` in the mirror forever. A `404` is
 * koda saying it has no such approval: nothing to restore, nothing to ask again. Every
 * other failure learned nothing, so the record stays for a later pull.
 *
 * Resolution happens on the scope's own last page because sync writes a page's notes to
 * the page's scope: a user-scope note on a project page would land in the project mirror.
 *
 * Internal to `src/memory/`: the provider answers `pull` with it, the barrel re-exports
 * the provider.
 */

import type { MemoryDecision, MemoryNote, MemoryPage, MemoryScope } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { KodaApproval } from "./koda-approvals";
import { kodaStatusOf } from "./koda-http";
import { findActiveKodaNote } from "./koda-lookup";
import {
  type KodaMemoryItem,
  kodaNoteSlugs,
  mergeKodaDecisions,
  parseKodaItems,
  reconcileKodaNotes,
} from "./koda-mapping";
import type { CreateKodaMemoryProviderInput } from "./koda-provider";

const STAGE = "memory";

/** The most rows one export page may ask koda for: its own ceiling whatever `take` says. */
const EXPORT_TAKE_MAX = 500;

/**
 * How many recorded approvals one pull resolves at a scope's last page.
 *
 * Declared here, beside the loop that spends it, and re-exported by the provider, which owns
 * the record: the provider already imports `pullKodaPage` from this module at runtime, so a
 * value imported the other way would close a runtime cycle between the two.
 */
export const MEMORY_KODA_APPROVAL_CHECKS_MAX = 20;

/**
 * The statuses that leave a proposal open, so its record stays: koda has not settled it and
 * `approved` can still settle to `executed` or `failed`.
 */
const APPROVAL_OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "approved"]);

/** The statuses that refused a proposal: its slug is restored, and then the record goes. */
const APPROVAL_REFUSED_STATUSES: ReadonlySet<string> = new Set(["rejected", "expired", "cancelled", "failed"]);

/** The status that settled a proposal by writing the row the feed carries: nothing to restore. */
const APPROVAL_EXECUTED_STATUS = "executed";

/** The status a mirror note has while the proposal that would replace it is open. */
const NOTE_STATUS_PENDING = "pending";

/** The status a restored tombstone carries: the note a refused proposal left behind is gone. */
const NOTE_STATUS_REJECTED = "rejected";

/** No mirror ids: a restoring lookup reads one row, and no tombstone rule compares against the mirror. */
const NO_MIRROR_IDS: ReadonlyMap<string, string> = new Map();

/** What an export answer says: the rows, where the feed resumes, and whether more follow. */
interface ExportPage {
  readonly items: readonly KodaMemoryItem[];
  readonly nextCursor: string | undefined;
  readonly hasMore: boolean;
}

/** What the decision half of a page came to: the merged list, and the rows it skipped. */
interface DecisionsResult {
  readonly decisions?: readonly MemoryDecision[];
  readonly skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rejection an export answer the pull cannot use is thrown as; transient by nature. */
function badExport(project: string, detail: string): NaxError {
  return new NaxError(`[memory] koda export page for project "${project}" ${detail}`, "MEMORY_KODA_BAD_RESPONSE", {
    stage: STAGE,
    project,
  });
}

/**
 * The answer read as an export page.
 *
 * `items` is `parseKodaItems`' check (an array of rows, else a bad response) and `hasMore`
 * is checked here: a page whose `hasMore` is not a boolean cannot say whether the feed
 * ended, so it is no page at all rather than one read as finished — the difference between
 * a pull that stops early and one that believes it drained the feed.
 */
function readExportAnswer(project: string, data: unknown): ExportPage {
  const payload = isRecord(data) ? data : {};
  const items = parseKodaItems(payload.items);
  const hasMore: unknown = payload.hasMore;
  if (typeof hasMore !== "boolean") {
    throw badExport(project, `does not carry a boolean hasMore (got ${typeof hasMore})`);
  }
  const nextCursor: unknown = payload.nextCursor;
  return { items, hasMore, nextCursor: typeof nextCursor === "string" ? nextCursor : undefined };
}

/**
 * The mirror's note id for every slug this page's own-scope rows name.
 *
 * Read before the page is reconciled because R5 compares a tombstone's id against it, and
 * read once per distinct slug: a page names the same slug in several rows whenever a note
 * was superseded. The reads are independent, so they are issued together.
 */
async function mirrorIdsOf(
  input: CreateKodaMemoryProviderInput,
  scope: MemoryScope,
  items: readonly KodaMemoryItem[],
): Promise<ReadonlyMap<string, string>> {
  const slugs = kodaNoteSlugs(items, scope);
  const notes = await Promise.all(slugs.map((slug) => input.readNote(scope, slug)));
  const ids = new Map<string, string>();
  for (const [index, note] of notes.entries()) {
    if (note !== null) ids.set(slugs[index], note.id);
  }
  return ids;
}

/**
 * The page's DECISION rows merged into the mirror's current decisions.
 *
 * Only a project page has decisions to merge: sync writes `decisions.jsonl` for a project
 * page alone, so a user page's rows are not the mirror's to write and its list is not read.
 */
async function decisionsOf(
  input: CreateKodaMemoryProviderInput,
  scope: MemoryScope,
  items: readonly KodaMemoryItem[],
): Promise<DecisionsResult> {
  if (scope !== "project") return { skipped: 0 };
  return mergeKodaDecisions(await input.readDecisions(), items);
}

/** One warn per page, naming how many of its rows the mirror could not take. */
function warnSkipped(input: CreateKodaMemoryProviderInput, scope: MemoryScope, skipped: number): void {
  if (skipped === 0) return;
  const noun = skipped === 1 ? "row" : "rows";
  input.logger.warn(STAGE, `koda export page skipped ${skipped} ${noun}`, {
    project: input.project,
    scope,
    skipped,
  });
}

/** Where one record is being resolved: the provider input, the pull's scope and the page's slugs. */
interface ResolutionScope {
  readonly input: CreateKodaMemoryProviderInput;
  readonly scope: MemoryScope;
  /** The slugs the page holds a note for, extended as resolution adds them. */
  readonly pageSlugs: Set<string>;
}

/** What one proposal record's resolution came to: whether it is forgotten, and the note its slug gains. */
interface RecordResolution {
  readonly drop: boolean;
  readonly note?: MemoryNote;
}

/** What a last page's resolution came to: the notes it restores, and the approvals it forgets. */
interface ResolutionResult {
  readonly notes: readonly MemoryNote[];
  readonly dropped: readonly string[];
}

/** What one approval's status read came to: a status word, a proposal koda no longer has, or nothing usable. */
type ApprovalAnswer =
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "gone" }
  | { readonly kind: "unreadable" };

/** Nothing resolved: the answer of a page that is not its scope's last one. */
const NO_RESOLUTION: ResolutionResult = { notes: [], dropped: [] };

/** The status word `data` carries, or `undefined` when the answer holds anything else. */
function answerStatusOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const status = data.status;
  return typeof status === "string" && status !== "" ? status : undefined;
}

/** One warn naming an approval this pull could not settle, and why its record stays. */
function warnApproval(where: ResolutionScope, record: KodaApproval, reason: string): void {
  where.input.logger.warn(STAGE, "koda approval was not resolved", {
    project: where.input.project,
    scope: where.scope,
    approvalId: record.approvalId,
    slug: record.slug,
    reason,
  });
}

/**
 * koda's answer about one recorded approval.
 *
 * A status word is the only answer this module can act on, so an envelope without one is
 * as uninformative as a failure: the record stays and the next pull asks again. A `404` is
 * the one failure that is a fact — koda has no such approval, so there is nothing left to
 * restore and nothing worth asking twice.
 */
async function readApproval(where: ResolutionScope, record: KodaApproval): Promise<ApprovalAnswer> {
  try {
    const answer = await where.input.client.get(`approvals/${record.approvalId}`);
    const status = answerStatusOf(answer.data);
    if (status !== undefined) return { kind: "status", status };
    warnApproval(where, record, "the answer carries no status");
    return { kind: "unreadable" };
  } catch (error) {
    if (kodaStatusOf(error) === 404) return { kind: "gone" };
    warnApproval(where, record, errorMessage(error));
    return { kind: "unreadable" };
  }
}

/** The mirror's note a refused proposal would put back, or `null` when the mirror has moved on. */
async function restorableNote(where: ResolutionScope, record: KodaApproval): Promise<MemoryNote | null> {
  const note = await where.input.readNote(where.scope, record.slug);
  if (note === null || note.id !== record.clientId || note.status !== NOTE_STATUS_PENDING) return null;
  return note;
}

/** The mirror's pending note itself as a tombstone: every field comes from it, so sync accepts it. */
function tombstoneOf(pending: MemoryNote): MemoryNote {
  return { ...pending, status: NOTE_STATUS_REJECTED };
}

/**
 * koda's active row as the page's note.
 *
 * A row the mirror may not hold is, for the mirror, no active row at all, so it falls back
 * to the tombstone: the proposal is resolved either way, and leaving the mirror's note
 * `pending` forever would be the one outcome this resolution exists to prevent.
 */
function noteOfRow(row: KodaMemoryItem, scope: MemoryScope, pending: MemoryNote): MemoryNote {
  return reconcileKodaNotes([row], scope, NO_MIRROR_IDS).notes[0] ?? tombstoneOf(pending);
}

/** What a restoring lookup came to: the note the page gains, or the fact that the record stays. */
type Restoration = { readonly kind: "resolved"; readonly note: MemoryNote } | { readonly kind: "kept" };

/**
 * The note a refused proposal's slug gains: koda's active row, or a tombstone for what the
 * mirror still holds. A lookup that threw learned nothing — the record stays and a later
 * pull asks again — so the two outcomes are told apart by the caller.
 */
async function restoreSlug(where: ResolutionScope, record: KodaApproval, pending: MemoryNote): Promise<Restoration> {
  try {
    const row = await findActiveKodaNote({
      client: where.input.client,
      project: where.input.project,
      scope: where.scope,
      slug: record.slug,
    });
    return { kind: "resolved", note: row === null ? tombstoneOf(pending) : noteOfRow(row, where.scope, pending) };
  } catch (error) {
    warnApproval(where, record, errorMessage(error));
    return { kind: "kept" };
  }
}

/** The record's fate once koda has refused its proposal: restored, or kept because the lookup failed. */
async function refusedRecord(where: ResolutionScope, record: KodaApproval): Promise<RecordResolution> {
  if (where.pageSlugs.has(record.slug)) return { drop: true };
  const pending = await restorableNote(where, record);
  if (pending === null) return { drop: true };
  const restoration = await restoreSlug(where, record, pending);
  return restoration.kind === "kept" ? { drop: false } : { drop: true, note: restoration.note };
}

/**
 * One record against koda's own answer about it.
 *
 * Only a status word decides anything. An open proposal keeps its record, `executed` drops
 * it because the row arrives through the feed, and a status this module does not know is
 * no fact to act on — the record stays, with a warn, rather than being forgotten on a guess.
 */
async function resolveRecord(where: ResolutionScope, record: KodaApproval): Promise<RecordResolution> {
  const answer = await readApproval(where, record);
  if (answer.kind === "unreadable") return { drop: false };
  if (answer.kind === "gone") return { drop: true };
  if (APPROVAL_OPEN_STATUSES.has(answer.status)) return { drop: false };
  if (APPROVAL_REFUSED_STATUSES.has(answer.status)) return await refusedRecord(where, record);
  if (answer.status === APPROVAL_EXECUTED_STATUS) return { drop: true };
  warnApproval(where, record, `koda answered the status "${answer.status}"`);
  return { drop: false };
}

/**
 * Resolve this scope's recorded proposals, oldest record first, up to the check budget.
 *
 * The budget is a per-pull ceiling on requests, not a claim about the file: a record beyond
 * it is left for a later pull, which is why the list is read oldest-first — the oldest
 * proposal has waited longest.
 */
async function resolveApprovals(
  input: CreateKodaMemoryProviderInput,
  scope: MemoryScope,
  pageNotes: readonly MemoryNote[],
): Promise<ResolutionResult> {
  const records = (await input.approvals.list()).filter((record) => record.scope === scope);
  const where: ResolutionScope = { input, scope, pageSlugs: new Set(pageNotes.map((note) => note.slug)) };
  const notes: MemoryNote[] = [];
  const dropped: string[] = [];
  for (const record of records.slice(0, MEMORY_KODA_APPROVAL_CHECKS_MAX)) {
    const resolution = await resolveRecord(where, record);
    if (!resolution.drop) continue;
    dropped.push(record.approvalId);
    if (resolution.note === undefined) continue;
    notes.push(resolution.note);
    where.pageSlugs.add(record.slug);
  }
  return { notes, dropped };
}

/**
 * The last page's resolution, or nothing when this page is not the scope's last one.
 *
 * Only the last page resolves: an earlier page's answer is checkpointed and the next page
 * follows, so a resolution there would be paid for on every page of the feed.
 */
async function resolutionOf(
  input: CreateKodaMemoryProviderInput,
  scope: MemoryScope,
  page: ExportPage,
  pageNotes: readonly MemoryNote[],
): Promise<ResolutionResult> {
  if (page.hasMore) return NO_RESOLUTION;
  const resolution = await resolveApprovals(input, scope, pageNotes);
  if (resolution.dropped.length > 0) await input.approvals.drop(resolution.dropped);
  return resolution;
}

/**
 * One page of koda's export feed, reconciled for one scope's mirror.
 *
 * @param input - The client, the project slug and the reads the reconciliation needs
 * @param request - The scope to reconcile, the last checkpointed cursor and the page size asked
 */
export async function pullKodaPage(
  input: CreateKodaMemoryProviderInput,
  request: { readonly scope: MemoryScope; readonly cursor: string | null; readonly take: number },
): Promise<MemoryPage> {
  const answer = await input.client.get(`projects/${input.project}/memory/export`, {
    since: request.cursor ?? undefined,
    take: Math.min(request.take, EXPORT_TAKE_MAX),
  });
  const page = readExportAnswer(input.project, answer.data);
  const mirrorIds = await mirrorIdsOf(input, request.scope, page.items);
  const reconciled = reconcileKodaNotes(page.items, request.scope, mirrorIds);
  const decisions = await decisionsOf(input, request.scope, page.items);
  warnSkipped(input, request.scope, reconciled.skipped + decisions.skipped);
  const resolution = await resolutionOf(input, request.scope, page, reconciled.notes);
  return {
    notes: [...reconciled.notes, ...resolution.notes],
    ...(decisions.decisions === undefined ? {} : { decisions: decisions.decisions }),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    done: !page.hasMore,
  };
}
