/**
 * koda-lookup.ts — the exact-match lookup that finds the row a slug is active as.
 *
 * A forget names a slug, but koda retires a row by id: `POST memory/notes/<id>/retire`.
 * This module is the step between them. It reads the project's `GET projects/<slug>/memory`
 * with `kind`, `subject`, `scope`, `status` and a page, and answers the first record whose
 * `subject` is the slug **exactly** and whose `scope` is the scope asked for.
 *
 * koda's `subject` filter is a prefix match, so `replay-budget` also answers
 * `replay-budget-2`; the exact comparison is what makes the answer this slug's row rather
 * than a neighbour's. The lookup therefore pages while no record matches and koda says
 * there is more, up to {@link MEMORY_KODA_LOOKUP_MAX_PAGES} pages.
 *
 * Paging has a ceiling because this runs inside sync's per-operation race: a forget can
 * cost up to `MEMORY_KODA_LOOKUP_MAX_PAGES` requests here plus two more, which may outlast
 * it. That is safe to retry — retiring a row that is already retired answers `409`, which
 * the provider reads as `deleted` — but an unbounded walk is not, so reaching the ceiling
 * is a transient `MEMORY_KODA_LOOKUP_EXHAUSTED` rather than a claim that the row is gone.
 *
 * Every other failure is transient and rethrown unchanged, a `404` included: a wrong slug
 * or a lost membership is a config problem to fix, not a fact about this note.
 *
 * Internal to `src/memory/`: the forget and the proposal resolution compose it, the barrel
 * re-exports it.
 */

import type { MemoryScope } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { KodaClient } from "./koda-http";
import { type KodaMemoryItem, parseKodaItems } from "./koda-mapping";

const STAGE = "memory";

/** The pages one lookup reads before it gives up and leaves the entry to a later sync. */
export const MEMORY_KODA_LOOKUP_MAX_PAGES = 10;

/** The most rows one page may carry; koda's own ceiling for a search page. */
const LOOKUP_PAGE_SIZE = 100;

/** The kind a note's row carries. */
const NOTE_KIND = "NOTE";

/** The status a row has while it is the note's current one. */
const STATUS_ACTIVE = "active";

/** What {@link findActiveKodaNote} is asked. */
export interface FindActiveKodaNoteInput {
  readonly client: KodaClient;
  /** The koda project **slug**: every route takes it in the path. */
  readonly project: string;
  readonly scope: MemoryScope;
  readonly slug: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer's rows; an answer whose `items` is not an array is a response no caller can use. */
function itemsOf(data: unknown): readonly KodaMemoryItem[] {
  return parseKodaItems(isRecord(data) ? data.items : undefined);
}

/** koda's `hasNext`, read as the flag it is: only `true` promises another page. */
function hasNextPage(data: unknown): boolean {
  return isRecord(data) && data.hasNext === true;
}

/** The first record of this page that is this slug's own row of this scope. */
function matchOf(records: readonly KodaMemoryItem[], slug: string, scope: MemoryScope): KodaMemoryItem | undefined {
  return records.find((record) => record.subject === slug && record.scope === scope);
}

/** The ceiling being reached: transient, because another attempt may page differently. */
function exhausted(input: FindActiveKodaNoteInput): NaxError {
  return new NaxError(
    `[memory] koda lookup for "${input.slug}" in project "${input.project}" read ${MEMORY_KODA_LOOKUP_MAX_PAGES} pages without a match`,
    "MEMORY_KODA_LOOKUP_EXHAUSTED",
    {
      stage: STAGE,
      project: input.project,
      scope: input.scope,
      slug: input.slug,
      pages: MEMORY_KODA_LOOKUP_MAX_PAGES,
      retryable: true,
    },
  );
}

/**
 * The active row `slug` has in `scope`, or `null` when koda holds none.
 *
 * @param input - The client, the project slug, and the scope and slug to find
 */
export async function findActiveKodaNote(input: FindActiveKodaNoteInput): Promise<KodaMemoryItem | null> {
  const { client, project, scope, slug } = input;
  for (let page = 1; page <= MEMORY_KODA_LOOKUP_MAX_PAGES; page += 1) {
    const answer = await client.get(`projects/${project}/memory`, {
      kind: NOTE_KIND,
      subject: slug,
      scope,
      status: STATUS_ACTIVE,
      size: LOOKUP_PAGE_SIZE,
      current: page,
    });
    const match = matchOf(itemsOf(answer.data), slug, scope);
    if (match !== undefined) return match;
    if (!hasNextPage(answer.data)) return null;
  }
  throw exhausted(input);
}
