/**
 * Resume and reconnect (S4 spec §6.9). Before anything is spawned, the stored
 * document's ACP record is checked against this backend and workdir (step 1).
 * After initialize, the agent session is restored with session/resume when the
 * agent advertises it (no replay), else session/load (its replayed updates and
 * requests reach no turn and are dropped or refused by the router), never as a
 * fresh session (step 2). Claude's adapter echoes the restored session's id
 * outside the protocol's schema; another id than the stored one is refused
 * (step 3, D6-d). The cwd is compared canonically and sent to the agent as
 * stored, because Claude keys its session store by it (D6-c). The stored cost
 * baseline seeds the session's meter (D6-a).
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LoadSessionResponse,
  McpServer,
  ResumeSessionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { AgentSessionError, type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
import type { CapabilityRecord } from "#src/client/capabilities";
import type { AcpLink } from "#src/client/connection";
import { capabilityUnsupported } from "#src/client/errors";
import type { ResolvedAcpOptions } from "#src/client/options";
import { isRecord } from "#src/client/text";

/** An agent session id longer than this is not trusted (S4-2 Review Focus 5). */
export const MAX_SESSION_ID_CHARS = 512;

/** A stored agent session to restore: from the document (resume) or the live session (reconnect). */
export interface Restore {
  readonly agentSessionId: string;
  /** The cwd the agent session was created with, spelled as stored. */
  readonly cwd: string;
  /** The meter's starting baseline (D6-a). */
  readonly costUsd: number;
}

export type RestoredWith = "resume" | "load";

export interface RestoredSession {
  readonly agentSessionId: string;
  readonly cwd: string;
  readonly configOptions: readonly SessionConfigOption[];
  readonly restoredWith: RestoredWith;
}

/** What session/new, session/resume and session/load add to `cwd`: the tool host's entry and the pre-approval `_meta` (§6.6). */
export interface SessionSetup {
  readonly mcpServers: McpServer[];
  readonly _meta?: Record<string, unknown>;
}

/** One open-phase request, bounded by initializeTimeoutMs and openSignal (open.ts). */
export type OpenStep = <T>(label: string, request: Promise<T>) => Promise<T>;

export function isUsableSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_SESSION_ID_CHARS;
}

export function canRestore(record: CapabilityRecord): boolean {
  return record.resume || record.loadSession;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function canonicalDir(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function costOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function corrupt(sessionId: string, reason: string): NaxError {
  return new NaxError(`transcript for session "${sessionId}" is unreadable: ${reason}`, "TRANSCRIPT_CORRUPT", {
    stage: "acp",
    sessionId,
  });
}

/** §6.9 step 1 (D6-b, D6-c). Throws before anything is spawned. */
export function storedSessionOf(doc: TranscriptDoc, ctx: BackendOpenContext, options: ResolvedAcpOptions): Restore {
  const sessionId = ctx.sessionId;
  const stored = doc.backend ?? "native";
  if (stored !== options.kind) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by backend "${stored}"; it cannot be resumed with "${options.kind}"`,
      "AGENT_SESSION_BACKEND_MISMATCH",
      { sessionId, stored, kind: options.kind },
    );
  }
  const acp: unknown = doc.acp;
  if (
    !isRecord(acp) ||
    !isUsableSessionId(acp.agentSessionId) ||
    !nonEmptyString(acp.agent) ||
    !nonEmptyString(acp.cwd)
  ) {
    throw corrupt(sessionId, "its ACP record is missing or malformed");
  }
  if (acp.agent !== options.agentName) throw corrupt(sessionId, "its ACP record names another agent");
  if (canonicalDir(acp.cwd) !== canonicalDir(ctx.workdir)) {
    throw new AgentSessionError(
      `Invalid agent session options: workdir "${ctx.workdir}" is not the directory session "${sessionId}" was created in; resume it with that workdir`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "workdir" },
    );
  }
  return { agentSessionId: acp.agentSessionId, cwd: acp.cwd, costUsd: costOf(acp.costUsd) };
}

/** §6.9 step 3 (D6-d): an echoed id must be the stored one. A null answer (D6-k) has no config options. */
export function checkRestored(
  restore: Restore,
  via: RestoredWith,
  response: ResumeSessionResponse | LoadSessionResponse,
): RestoredSession {
  const raw: unknown = response;
  const echoed = isRecord(raw) ? raw.sessionId : undefined;
  if (echoed !== undefined && echoed !== restore.agentSessionId) {
    throw new NaxError("The ACP agent restored a different session than the stored one", "AGENT_SESSION_TURN_FAILED", {
      stage: "acp",
      detail: "identity",
    });
  }
  return {
    agentSessionId: restore.agentSessionId,
    cwd: restore.cwd,
    configOptions: isRecord(raw) ? (response.configOptions ?? []) : [],
    restoredWith: via,
  };
}

/** §6.9 step 2: session/resume when advertised, else session/load; never a fresh session. */
export async function restoreSession(
  restore: Restore,
  record: CapabilityRecord,
  setup: SessionSetup,
  link: AcpLink,
  step: OpenStep,
): Promise<RestoredSession> {
  const params = { sessionId: restore.agentSessionId, cwd: restore.cwd, ...setup };
  if (record.resume) return checkRestored(restore, "resume", await step("session/resume", link.resumeSession(params)));
  if (record.loadSession) return checkRestored(restore, "load", await step("session/load", link.loadSession(params)));
  throw capabilityUnsupported("resume", "the agent supports neither session/resume nor session/load");
}
