/**
 * flow-koda.ts — the one request that creates a koda flow.
 *
 * The call goes through nax's own koda client, so it carries the configured
 * agent key and a deadline of its own: koda's create reaches GitHub for the
 * branch head and for every spec file, which the memory client's 4 s ceiling
 * would cut short.
 *
 * Only the two answers koda's contract defines count: 201 (created) and 202 (its
 * approval policy is holding the create itself). Any other 2xx, or a body that
 * lacks the fields that answer promises, is `FLOW_KODA_UNEXPECTED_RESPONSE`; a
 * non-2xx never reaches this far, because the client throws it as
 * `MEMORY_KODA_HTTP` and that error is rethrown exactly as it came.
 */

import { NaxError } from "@/errors";
import { createKodaClient } from "@/memory";
import type { KodaFlowConnection } from "./flow-connection";
import type { FlowSendFeature, FlowSendRoles } from "./flow-input";

/**
 * The create's own deadline: 30 s, because koda fetches the branch head and every
 * spec file from GitHub before it answers, and the memory client's 4 s is a
 * ceiling for a read, not for that.
 */
export const FLOW_KODA_REQUEST_TIMEOUT_MS = 30_000;

/** koda's create path, relative to the API root — the client joins with a `/`. */
const FLOW_KODA_CREATE_PATH = "fleet/flows";
/** The client joins the root and a path with `/`; the messages read as a real path. */
const FLOW_KODA_CREATE_LABEL = `/${FLOW_KODA_CREATE_PATH}`;
const STAGE = "chat-flow";
const UNEXPECTED_CODE = "FLOW_KODA_UNEXPECTED_RESPONSE";

/**
 * The seam the request is built through. It is a seam because the timeout is
 * decided here, where no fetch substitute can observe it.
 */
export const _flowKodaDeps: { createKodaClient: typeof createKodaClient } = { createKodaClient };

/** The body koda's `POST /fleet/flows` takes, assembled by the tool from its parsed input. */
export interface FlowCreateBody {
  /** The origin remote in koda's accepted form. */
  readonly remoteUrl: string;
  /** The branch koda reads the specs from and pushes feature branches onto. */
  readonly branch: string;
  /** The commit the specs are read at. */
  readonly specSha: string;
  /** The features in dependency order. */
  readonly features: readonly FlowSendFeature[];
  /** The two model strings koda passes to its review steps. */
  readonly roles: FlowSendRoles;
  /** koda's billing ceiling for the flow, in USD. */
  readonly costCapUsd: number;
}

/** koda created the flow. */
export interface FlowCreated {
  readonly kind: "created";
  /** The flow's id, as koda's answer reports it. */
  readonly id: string;
  /** The flow's state at creation. */
  readonly state: string;
  /** koda's own relative link to the flow. */
  readonly url: string;
}

/** koda's approval policy is holding the create; no flow exists until it is approved. */
export interface FlowHeld {
  readonly kind: "held";
  /** The approval request holding it. */
  readonly requestId: string;
}

/** What koda answered: a created flow, or the approval request holding it. */
export type FlowCreateOutcome = FlowCreated | FlowHeld;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The envelope's `data[field]` when it is a string. */
function stringField(data: unknown, field: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

/** The error for an answer koda's contract does not define. */
function unexpected(status: number, detail: string): NaxError {
  return new NaxError(`[${STAGE}] koda POST ${FLOW_KODA_CREATE_LABEL} answered ${status}${detail}`, UNEXPECTED_CODE, {
    stage: STAGE,
    status,
  });
}

/** The 201 outcome, or the error for a 201 body that does not carry a flow. */
function createdOutcome(data: unknown): FlowCreated {
  const id = stringField(data, "id");
  const state = stringField(data, "state");
  const url = stringField(data, "url");
  if (id === undefined || state === undefined || url === undefined) {
    throw unexpected(201, " without a string id, state and url");
  }
  return { kind: "created", id, state, url };
}

/** The 202 outcome, or the error for a 202 body that does not carry an approval request. */
function heldOutcome(data: unknown): FlowHeld {
  const requestId = stringField(data, "id");
  if (requestId === undefined) throw unexpected(202, " without a string id");
  return { kind: "held", requestId };
}

/**
 * Create a flow in koda for a pushed branch.
 *
 * @param connection - The koda API root and the headers carrying the agent key
 * @param body - The flow to create, as the request described it
 * @param signal - The turn's cancellation; a signal already aborted sends nothing
 * @returns The created flow, or the approval request holding the create
 * @throws NaxError `FLOW_KODA_UNEXPECTED_RESPONSE` for an answer koda's contract
 *   does not define; the client's own error unchanged for everything else
 */
export async function createKodaFlow(
  connection: KodaFlowConnection,
  body: FlowCreateBody,
  signal?: AbortSignal,
): Promise<FlowCreateOutcome> {
  const client = _flowKodaDeps.createKodaClient({
    url: connection.url,
    headers: connection.headers,
    timeoutMs: FLOW_KODA_REQUEST_TIMEOUT_MS,
  });
  const answer = await client.post(FLOW_KODA_CREATE_PATH, body, signal === undefined ? undefined : { signal });
  if (answer.status === 201) return createdOutcome(answer.data);
  if (answer.status === 202) return heldOutcome(answer.data);
  throw unexpected(answer.status, "; a flow create answers 201 or 202");
}
