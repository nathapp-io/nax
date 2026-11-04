/**
 * koda-provider.ts — the koda backend of the memory provider seam.
 *
 * koda owns the memory a project's agents share; the mirror stays the store every
 * surface reads. This module is the seam between them: it answers whether koda can
 * be written to, hands a queued save to koda's `POST memory`, retires the row a
 * forget names, and asks koda's full-text search what a query matches.
 *
 * Every path is relative to the configured API root (`memory.koda.url`, which
 * includes koda's global prefix) and both routes this story uses address the
 * project differently: `GET projects/<slug>` takes the **slug**, `POST memory`
 * takes the project **id**. The id is learned once and memoised, and a lookup that
 * failed is *not* memoised — the next write asks again rather than repeating a
 * failure for the life of the provider.
 *
 * Write mode is koda's, not nax's: the request's `writeMode` is never sent. koda
 * decides direct versus proposal from its own approval policy, so a `201` is
 * active and a `202` is pending whatever `memory.writeMode` says locally. A `202`
 * wrote no row; the approval it opened is recorded in `koda-approvals.json` so a
 * later pull can resolve the proposal (US-008).
 *
 * Error classification is what the outbox drain reads. `400`, `403`, `409`, `413`
 * and `422` are permanent — koda will never take this write, so the entry is
 * marked rejected and the drain continues. Everything else is transient and is
 * rethrown unchanged: `401` because fixing the key delivers everything queued,
 * `404` because a wrong slug or a lost membership is a config problem rather than
 * a fact about this write, and a timeout, an unreachable host, a bad response,
 * `408`, `429` and `5xx` because they say nothing about the write itself. The
 * drain stops at the first transient failure, so a transient `403` would block
 * every later write behind it.
 *
 * A forget reads the classification differently, because it names a row that may
 * already be gone: its retire resolves `404` and `409` as `deleted`, and a slug
 * koda holds no active row for resolves `deleted` without a retire at all
 * (`koda-lookup.ts`). A `404` from the lookup or from `GET projects/<slug>` is not
 * that fact, so it stays transient like any other failure of those two requests.
 *
 * US-005 composes the shell, US-006 the forget and the search, and US-007 the pull — which
 * lives in `koda-pull.ts` because this file is at its size cap.
 */

import type {
  MemoryDecision,
  MemoryHit,
  MemoryNote,
  MemoryNoteStatus,
  MemoryProvider,
  MemoryPushResult,
  MemoryScope,
  MemoryWriteRequest,
} from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { KodaApprovals } from "./koda-approvals";
import { type KodaClient, type KodaResponse, kodaStatusOf } from "./koda-http";
import { findActiveKodaNote } from "./koda-lookup";
import { type KodaMemoryItem, kodaHitOf, parseKodaItems } from "./koda-mapping";
import { pullKodaPage } from "./koda-pull";
import type { MemoryLogger } from "./paths";

const STAGE = "memory";

/** The prefix of a koda provider's id: `koda:<project>`. */
export const MEMORY_KODA_PROVIDER_PREFIX = "koda:";

/**
 * How many recorded approvals one pull resolves, oldest record first (US-008).
 *
 * Declared in `koda-pull.ts`, which is what spends the budget, and re-exported here because
 * the provider is what owns the record: this module imports `pullKodaPage` from the pull at
 * runtime, so the constant travelling the other way would close a runtime cycle.
 */
export { MEMORY_KODA_APPROVAL_CHECKS_MAX } from "./koda-pull";

/** The write modes koda's probe answers with when the calling agent may write. */
const KODA_WRITE_MODES: ReadonlySet<string> = new Set(["direct", "proposal"]);

/** The write statuses koda answers with when this write will never be accepted. */
const REJECTED_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 409, 413, 422]);

/** The retire statuses that say the row is no longer active: the note is gone, or going. */
const RETIRED_WRITE_STATUSES: ReadonlySet<number> = new Set([404, 409]);

/** What a write koda refused is, for the refusal's message. */
type WriteAction = "save" | "forget";

/** The kind every save sends: koda's own note kind. */
const KODA_SAVE_KIND = "NOTE";

/** The longest query text koda is asked for: a query is a phrase, not a document. */
const SEARCH_TEXT_MAX_CHARS = 100;

/** The largest page koda's search honours, whatever limit the caller asks for. */
const SEARCH_SIZE_MAX = 100;

export interface CreateKodaMemoryProviderInput {
  readonly client: KodaClient;
  /** The koda project **slug**: every route takes it in the path. */
  readonly project: string;
  readonly approvals: KodaApprovals;
  readonly readNote: (scope: MemoryScope, slug: string) => Promise<MemoryNote | null>;
  readonly readDecisions: () => Promise<readonly MemoryDecision[]>;
  readonly logger: MemoryLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The non-empty string `value[key]` holds, or `undefined` when it holds anything else. */
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** The rejection a koda answer the provider cannot use is thrown as; transient by nature. */
function badResponse(project: string, detail: string, status: number): NaxError {
  return new NaxError(`[memory] koda ${detail} for project "${project}"`, "MEMORY_KODA_BAD_RESPONSE", {
    stage: STAGE,
    project,
    status,
  });
}

/** The refusal a write koda will never accept is thrown as, quoting koda's own answer. */
function refusedWrite(project: string, slug: string, action: WriteAction, cause: NaxError): NaxError {
  return new NaxError(
    `[memory] koda refused the ${action} for "${slug}" in project "${project}": ${cause.message}`,
    "MEMORY_PUSH_REJECTED",
    { stage: STAGE, project, slug, status: kodaStatusOf(cause), cause },
  );
}

/**
 * The retire body: the project id, and the reason unless the forget carried none.
 *
 * An absent reason is omitted rather than sent empty, so koda records a retirement with
 * no justification instead of one justifying nothing.
 */
function retireBody(projectId: string, reason: string | undefined): Readonly<Record<string, string>> {
  if (reason === undefined || reason === "") return { projectId };
  return { projectId, reason };
}

/** A save without its note, which is a request no provider could deliver: permanent, not transient. */
function missingNote(project: string, request: MemoryWriteRequest): NaxError {
  return new NaxError(`[memory] memory save for "${request.slug}" carries no note`, "MEMORY_PUSH_REJECTED", {
    stage: STAGE,
    project,
    slug: request.slug,
  });
}

/**
 * The body koda's `POST memory` takes: every key always present, with exactly these names.
 *
 * `projectId` is sent for a user-scope note too — koda requires it for membership — and
 * `writeMode` is never sent, because the mode is koda's to decide.
 */
function saveBody(projectId: string, request: MemoryWriteRequest, note: MemoryNote): Readonly<Record<string, string>> {
  return {
    projectId,
    kind: KODA_SAVE_KIND,
    subject: request.slug,
    predicate: note.type,
    object: note.body,
    description: note.description,
    scope: request.scope,
    sourceType: note.source,
    sourceId: request.clientId,
  };
}

/**
 * Create the provider for one koda project.
 *
 * @param input - The client, the project slug, the proposal record and the reads later stories use
 */
export function createKodaMemoryProvider(input: CreateKodaMemoryProviderInput): MemoryProvider {
  const { client, project, approvals, logger } = input;

  /** The project id, learned once: every route takes the slug, but a save body takes the id. */
  let projectIdLookup: Promise<string> | undefined;

  /** Ask koda for the project id; an answer without a string `data.id` is not one the provider may use. */
  async function fetchProjectId(): Promise<string> {
    const answer = await client.get(`projects/${project}`);
    const id = stringField(answer.data, "id");
    if (id === undefined) {
      throw badResponse(project, `GET projects/${project} answered without a project id`, answer.status);
    }
    return id;
  }

  /**
   * The project id for this save, looked up at most once.
   *
   * The in-flight promise is what is memoised, so two saves in flight share one
   * request, and a failed lookup is cleared before it is rethrown — a config problem
   * the user has since fixed must not be remembered as this provider's answer.
   */
  function projectId(): Promise<string> {
    projectIdLookup ??= fetchProjectId().catch((error: unknown) => {
      projectIdLookup = undefined;
      throw error;
    });
    return projectIdLookup;
  }

  async function reachable(): Promise<boolean> {
    try {
      // A 2xx is the client's own precondition for resolving at all; the mode says the
      // agent may write, which is the fact a sync needs.
      const answer: KodaResponse = await client.get(`projects/${project}/memory/write-mode`);
      const mode = stringField(answer.data, "mode");
      return mode !== undefined && KODA_WRITE_MODES.has(mode);
    } catch {
      // A refused key, a lost membership and an unreachable host are one fact here: nothing
      // can be delivered, so the sync records `unreachable` and the session reads the mirror.
      return false;
    }
  }

  const save = async (request: MemoryWriteRequest): Promise<MemoryPushResult> => {
    const note = request.note;
    if (note === undefined) throw missingNote(project, request);
    const projectIdValue = await projectId();
    const answer = await postSave(saveBody(projectIdValue, request, note), request.slug);
    const answered = answeredId(answer, request.slug);
    return answer.status === 202 ? await recordProposal(request, answered) : { id: answered, status: "active" };
  };

  /**
   * Post one save, translating the statuses koda will never accept and rethrowing the rest.
   *
   * Only `MEMORY_KODA_HTTP` failures carry a status; a timeout, an unreachable host and a
   * bad response are transient by construction and reach the caller unchanged.
   */
  async function postSave(body: Readonly<Record<string, string>>, slug: string): Promise<KodaResponse> {
    try {
      return await client.post("memory", body);
    } catch (error) {
      const status = kodaStatusOf(error);
      if (error instanceof NaxError && status !== undefined && REJECTED_WRITE_STATUSES.has(status)) {
        throw refusedWrite(project, slug, "save", error);
      }
      throw error;
    }
  }

  /** The id koda answered with; an answer without one is a response the provider cannot use. */
  function answeredId(answer: KodaResponse, slug: string): string {
    const id = stringField(answer.data, "id");
    if (id === undefined) {
      throw badResponse(project, `POST memory answered a save for "${slug}" without an id`, answer.status);
    }
    return id;
  }

  /**
   * A forget: find the row the slug is active as, then retire it.
   *
   * A slug koda holds no active row for is already forgotten, so the answer is `deleted`
   * and no second request is made — the common case of forgetting a note that only ever
   * lived in the mirror. Only a found row needs the project id and the retire, which is
   * why the id is looked up here rather than up front.
   */
  const forget = async (request: MemoryWriteRequest): Promise<MemoryPushResult> => {
    const found = await findActiveKodaNote({ client, project, scope: request.scope, slug: request.slug });
    if (found === null) return { id: request.clientId, status: "deleted" };
    const projectIdValue = await projectId();
    return { id: request.clientId, status: await retire(found.id, projectIdValue, request) };
  };

  /**
   * Retire one row, reading the answers that say it is already gone as the fact they are.
   *
   * A `404` or `409` here means the note is no longer active — the row was retired by a
   * concurrent write, or a retry of this very forget arrived after the first one landed —
   * so it resolves rather than throwing. The refusals that mean koda will never take this
   * write are translated; everything else, a `404` from anything else included, is transient
   * and reaches the outbox unchanged.
   */
  async function retire(
    noteId: string,
    projectIdValue: string,
    request: MemoryWriteRequest,
  ): Promise<MemoryNoteStatus> {
    try {
      const answer = await client.post(`memory/notes/${noteId}/retire`, retireBody(projectIdValue, request.reason));
      return answer.status === 202 ? "pending" : "deleted";
    } catch (error) {
      const status = kodaStatusOf(error);
      if (status !== undefined && RETIRED_WRITE_STATUSES.has(status)) return "deleted";
      if (error instanceof NaxError && status !== undefined && REJECTED_WRITE_STATUSES.has(status)) {
        throw refusedWrite(project, request.slug, "forget", error);
      }
      throw error;
    }
  }

  /**
   * A `202`: koda wrote no row and opened an approval request instead.
   *
   * The approval is recorded, because a pull cannot resolve a proposal it never heard of, and
   * the caller gets its own client id back — the mirror keys the pending note by scope and slug
   * and carries that id, so the row koda eventually writes replaces it by slug.
   */
  async function recordProposal(request: MemoryWriteRequest, approvalId: string): Promise<MemoryPushResult> {
    await approvals.record({
      approvalId,
      scope: request.scope,
      slug: request.slug,
      clientId: request.clientId,
    });
    logger.debug(STAGE, "koda accepted the save as a proposal", { project, slug: request.slug, approvalId });
    return { id: request.clientId, status: "pending" };
  }

  /**
   * koda's full-text search for one scope, mapped to hits in koda's own rank order.
   *
   * Blank text asks nothing: a query of spaces is no query, and koda would answer the whole
   * scope. The text is cut to what the index searches and the page to what it honours, so a
   * caller's `limit` decides how many hits are kept, never how many koda is asked to rank.
   * A record the mirror could not hold a note for is dropped by `kodaHitOf` before the cut,
   * so the cut counts hits rather than rows.
   */
  async function search(input: {
    readonly scope: MemoryScope;
    readonly text: string;
    readonly limit: number;
  }): Promise<readonly MemoryHit[]> {
    const text = input.text.trim().slice(0, SEARCH_TEXT_MAX_CHARS);
    if (text === "") return [];
    const answer = await client.get(`projects/${project}/memory`, {
      kind: KODA_SAVE_KIND,
      scope: input.scope,
      text,
      size: Math.min(input.limit, SEARCH_SIZE_MAX),
    });
    const records = parseKodaItems(isRecord(answer.data) ? answer.data.items : undefined);
    return hitsOf(records, input.limit);
  }

  return {
    id: `${MEMORY_KODA_PROVIDER_PREFIX}${project}`,
    // The export feed: one reconciled page per call, read in `koda-pull.ts` because this
    // file is at its size cap.
    pull: (request) => pullKodaPage(input, request),
    async push(request: MemoryWriteRequest): Promise<MemoryPushResult> {
      if (request.kind === "save") return await save(request);
      return await forget(request);
    },
    search,
    reachable,
  };
}

/** The answer's records as hits, in koda's order, cut to the caller's limit. */
function hitsOf(records: readonly KodaMemoryItem[], limit: number): readonly MemoryHit[] {
  const hits: MemoryHit[] = [];
  for (const [index, record] of records.entries()) {
    const hit = kodaHitOf(record, index, records.length);
    if (hit !== null) hits.push(hit);
  }
  return hits.slice(0, Math.max(0, limit));
}
