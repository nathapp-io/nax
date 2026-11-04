/**
 * koda-provider.ts — the koda backend of the memory provider seam.
 *
 * koda owns the memory a project's agents share; the mirror stays the store every
 * surface reads. This module is the seam between them: it answers whether koda can
 * be written to, and it hands a queued save to koda's `POST memory`.
 *
 * Every path is relative to the configured API root (`memory.koda.url`, which
 * includes koda's global prefix) and both routes this story uses address the
 * project differently: `GET projects/<slug>` takes the **slug**, `POST memory`
 * takes the project **id**. The id is learned once and memoised, and a lookup that
 * failed is *not* memoised — the next save asks again rather than repeating a
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
 * US-005 composes the shell: `pull` answers the empty finished page and `search`
 * answers nothing until US-007 and US-006 replace them.
 */

import type {
  MemoryDecision,
  MemoryHit,
  MemoryNote,
  MemoryPage,
  MemoryProvider,
  MemoryPushResult,
  MemoryScope,
  MemoryWriteRequest,
} from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { KodaApprovals } from "./koda-approvals";
import { type KodaClient, type KodaResponse, kodaStatusOf } from "./koda-http";
import type { MemoryLogger } from "./paths";

const STAGE = "memory";

/** The prefix of a koda provider's id: `koda:<project>`. */
export const MEMORY_KODA_PROVIDER_PREFIX = "koda:";

/**
 * How many recorded approvals one pull resolves, oldest record first (US-008).
 *
 * Declared here because the provider is what owns the record; the pull is what
 * spends the budget.
 */
export const MEMORY_KODA_APPROVAL_CHECKS_MAX = 20;

/** The write modes koda's probe answers with when the calling agent may write. */
const KODA_WRITE_MODES: ReadonlySet<string> = new Set(["direct", "proposal"]);

/** The save statuses koda answers with when this write will never be accepted. */
const REJECTED_SAVE_STATUSES: ReadonlySet<number> = new Set([400, 403, 409, 413, 422]);

/** The kind every save sends: koda's own note kind. */
const KODA_SAVE_KIND = "NOTE";

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

/** The refusal a save koda will never accept is thrown as, quoting koda's own answer. */
function refusedSave(project: string, slug: string, cause: NaxError): NaxError {
  return new NaxError(
    `[memory] koda refused the save for "${slug}" in project "${project}": ${cause.message}`,
    "MEMORY_PUSH_REJECTED",
    { stage: STAGE, project, slug, status: kodaStatusOf(cause), cause },
  );
}

/** The write this story cannot deliver yet, as a transient failure so the outbox keeps the entry. */
function undeliverableWrite(project: string, request: MemoryWriteRequest): NaxError {
  return new NaxError(
    `[memory] koda provider cannot deliver a ${request.kind} for "${request.slug}" yet`,
    "MEMORY_KODA_WRITE_UNSUPPORTED",
    { stage: STAGE, project, kind: request.kind, slug: request.slug, retryable: true },
  );
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
      if (error instanceof NaxError && status !== undefined && REJECTED_SAVE_STATUSES.has(status)) {
        throw refusedSave(project, slug, error);
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

  return {
    id: `${MEMORY_KODA_PROVIDER_PREFIX}${project}`,
    // The export feed is US-007's: until then the provider has nothing to give, which is
    // the page sync drains without moving a note.
    pull: async (): Promise<MemoryPage> => ({ notes: [], done: true }),
    async push(request: MemoryWriteRequest): Promise<MemoryPushResult> {
      if (request.kind === "save") return await save(request);
      // US-006 adds the forget. A permanent refusal would retire a write that is not wrong, only
      // undelivered yet, so it fails transiently and the outbox keeps the entry.
      throw undeliverableWrite(project, request);
    },
    // koda's full-text search is US-006's.
    search: async (): Promise<readonly MemoryHit[]> => [],
    reachable,
  };
}
