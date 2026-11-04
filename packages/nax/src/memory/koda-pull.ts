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
 * Internal to `src/memory/`: the provider answers `pull` with it, the barrel re-exports
 * the provider. US-008 adds the resolution of recorded proposals at the last page.
 */

import type { MemoryDecision, MemoryPage, MemoryScope } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
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
  return {
    notes: reconciled.notes,
    ...(decisions.decisions === undefined ? {} : { decisions: decisions.decisions }),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    done: !page.hasMore,
  };
}
