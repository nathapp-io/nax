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
 * An answer this module cannot read is one of those failures, never an answer: a matching row
 * without a usable `id`, and a page that does not say `hasNext` as a boolean, both throw
 * `MEMORY_KODA_BAD_RESPONSE`. Reading either as a result would be worse than a retry — a
 * missing id becomes the literal `undefined` in the retire route, whose `404` reads as
 * "already retired", and a missing flag reads as "no more pages", so a malformed answer would
 * deliver a forget koda never performed.
 *
 * Internal to `src/memory/`: the forget and the proposal resolution compose it, the barrel
 * re-exports it.
 */

import type { MemoryScope } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { KodaClient } from "./koda-http";
import { type KodaMemoryItem, parseKodaRecords } from "./koda-mapping";

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

/** The answer's rows; an answer whose `records` is not an array is a response no caller can use. */
function recordsOf(data: unknown): readonly KodaMemoryItem[] {
  return parseKodaRecords(isRecord(data) ? data.records : undefined);
}

/** A lookup answer the provider cannot use: thrown as a transient rejection, never as an answer. */
function badResponse(input: FindActiveKodaNoteInput, detail: string): NaxError {
  return new NaxError(`[memory] koda ${detail} for project "${input.project}"`, "MEMORY_KODA_BAD_RESPONSE", {
    stage: STAGE,
    project: input.project,
    scope: input.scope,
    slug: input.slug,
  });
}

/**
 * koda's `hasNext`, or the reason this page's pagination cannot be read.
 *
 * Only a boolean says anything. A page with no flag is not a claim that the search ends, and
 * reading it as one would turn a malformed answer into "the slug has no note" — which a forget
 * delivers as `deleted`, dropping a queued intent for a note koda never retired.
 */
function hasNextPage(data: unknown, input: FindActiveKodaNoteInput): boolean {
  const flag = isRecord(data) ? data.hasNext : undefined;
  if (typeof flag !== "boolean") {
    throw badResponse(input, `lookup for "${input.slug}" answered without a boolean hasNext`);
  }
  return flag;
}

/**
 * The first record of this page that is this slug's own row of this scope.
 *
 * `parseKodaRecords` checks the container only, so a row that matches but carries no usable `id`
 * has to be refused here: the retire route addresses the row by id, and a missing one would be
 * sent as the literal `undefined`, whose `404` the provider would read as "already retired"
 * and report as a delivered forget for a row still active in koda.
 */
function matchOf(records: readonly KodaMemoryItem[], input: FindActiveKodaNoteInput): KodaMemoryItem | undefined {
  const { slug, scope } = input;
  const match = records.find((record) => record.subject === slug && record.scope === scope);
  if (match === undefined) return undefined;
  const id: unknown = match.id;
  if (typeof id !== "string" || id === "") {
    throw badResponse(input, `lookup for "${input.slug}" answered a matching row without an id`);
  }
  return match;
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
    const match = matchOf(recordsOf(answer.data), input);
    if (match !== undefined) return match;
    if (!hasNextPage(answer.data, input)) return null;
  }
  throw exhausted(input);
}
