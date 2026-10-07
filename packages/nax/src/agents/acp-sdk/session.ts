/**
 * One ACP SDK session (S4b spec §6.1): its opened backend, the state the turn
 * loop and the ask port share, and the open, re-open and close paths.
 *
 * Lifecycle parity with acpx: SessionManager owns reuse, close really closes and
 * deletes the transcript document, and a document present at open is a crash
 * leftover (an earlier process died without closing). The leftover is passed
 * to the backend as `resume`; the backend rejects a backend, agent or cwd
 * mismatch before spawning, and those rejections (or an unreadable document, or
 * an agent that no longer knows the session) discard it and open fresh (D2-j).
 */
import { stat } from "node:fs/promises";
import type {
  OpenedBackend,
  OpenSessionOpts,
  ProtocolIds,
  SessionAskPort,
  SessionBackend,
  SessionHandle,
  TranscriptDoc,
  TranscriptStore,
} from "@nathapp/nax-agent";
import { killProcessGroup } from "@nathapp/nax-agent";
import {
  type AcpAgentName,
  type AcpBackendOptions,
  type AcpProcessHooks,
  acpBackend,
  isAgentLaunchable,
} from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { cancellableDelay } from "@/utils/bun-deps";
import { type RateCard, resolveRateCard } from "../cost";
import { AWAITING_HUMAN_BEAT_MS, createAskPort } from "./ask-port";
import { backendOptions, DEFAULT_CLOSE_DEADLINE_MS, openContext, transcriptStoreFor } from "./open-context";
import type { StreamContext } from "./stream-bridge";
import { type AuditRecorder, createAuditRecorder } from "./tool-audit";
import { createTurnSlot, type TurnSlot } from "./turn-slot";

const STAGE = "acp-sdk";

/** A leftover the backend cannot restore: deleted, then the session opens fresh (D2-j). */
const DISCARD_CODES: ReadonlySet<string> = new Set([
  "AGENT_SESSION_BACKEND_MISMATCH",
  "AGENT_SESSION_INVALID_OPTIONS",
  "AGENT_SESSION_NOT_FOUND",
  "TRANSCRIPT_CORRUPT",
]);

/** Test seam. Production always uses the package functions. */
export const _acpSdkDeps = {
  acpBackend: (options: AcpBackendOptions): SessionBackend => acpBackend(options),
  isAgentLaunchable: (agent: AcpAgentName): boolean => isAgentLaunchable(agent),
  resolveRateCard: (modelId: string): Promise<RateCard> => resolveRateCard(modelId),
  /** promptRetries' backoff; rejects with the signal's reason when it aborts (D3-h). */
  delay: (ms: number, signal?: AbortSignal): Promise<void> => cancellableDelay(ms, signal),
  async cwdExists(dir: string): Promise<boolean> {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      // Missing or unreadable: the open fails SESSION_CWD_MISSING either way.
      return false;
    }
  },
};

/** The live agent process, kept current by the backend's onProcess hooks (a reconnect's process included). */
export interface ProcessTracker {
  pid: number | undefined;
}

export interface AcpSdkSession {
  readonly name: string;
  readonly agent: AcpAgentName;
  readonly opts: OpenSessionOpts;
  readonly handle: SessionHandle;
  readonly store: TranscriptStore;
  readonly slot: TurnSlot;
  readonly asks: SessionAskPort;
  readonly audit: AuditRecorder;
  /** Aborted when the session starts closing: the backend's openSignal, and an abort for a running prompt. */
  readonly closer: AbortController;
  readonly process: ProcessTracker;
  readonly rateCard: RateCard;
  readonly stream: StreamContext;
  /** Replaced by mid-turn NO_SESSION recovery (§6.2 step 3.5); the nax handle never changes. */
  opened: OpenedBackend;
  /** The running turn loop, settled (never rejects); undefined between turns. Close waits for it. */
  running: Promise<void> | undefined;
  /** Detaches the run signal from `closer`. */
  readonly unlinkRun: () => void;
}

type OpenBase = Pick<
  AcpSdkSession,
  "name" | "agent" | "opts" | "store" | "slot" | "asks" | "audit" | "closer" | "process"
>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDiscardable(err: unknown): err is NaxError {
  return err instanceof NaxError && DISCARD_CODES.has(err.code);
}

async function discard(store: TranscriptStore, name: string): Promise<void> {
  await store.delete(name).catch((err: unknown) => {
    getSafeLogger()?.warn(STAGE, "Could not delete the ACP session's transcript document", {
      sessionName: name,
      error: errorText(err),
    });
  });
}

/** onProcess (spec §8): remembers the live pid and feeds nax's pid registry, every process of the session. */
function processHooks(base: OpenBase): AcpProcessHooks {
  return {
    spawned: (pid) => {
      base.process.pid = pid;
      base.opts.onPidSpawned?.(pid);
    },
    exited: (pid) => {
      if (base.process.pid === pid) base.process.pid = undefined;
      base.opts.onPidExited?.(pid);
    },
  };
}

/** Kills the agent's process group now. The backend spawns it detached, so it would outlive nax otherwise. */
function killAgent(process: ProcessTracker): void {
  if (process.pid !== undefined) killProcessGroup(process.pid, "SIGKILL");
}

async function openBackend(base: OpenBase, resume: TranscriptDoc | undefined): Promise<OpenedBackend> {
  const backend = _acpSdkDeps.acpBackend(backendOptions(base.agent, base.opts, processHooks(base)));
  return backend.open(
    openContext({
      name: base.name,
      opts: base.opts,
      store: base.store,
      resume,
      asks: base.asks,
      slot: base.slot,
      openSignal: base.closer.signal,
    }),
  );
}

async function loadLeftover(store: TranscriptStore, name: string): Promise<TranscriptDoc | undefined> {
  try {
    return (await store.load(name)) ?? undefined;
  } catch (err) {
    getSafeLogger()?.info(STAGE, "A crash-leftover transcript is unreadable; discarding it", {
      sessionName: name,
      error: errorText(err),
    });
    await discard(store, name);
    return undefined;
  }
}

async function openWithLeftover(base: OpenBase): Promise<OpenedBackend> {
  const leftover = await loadLeftover(base.store, base.name);
  if (leftover === undefined) return openBackend(base, undefined);
  try {
    return await openBackend(base, leftover);
  } catch (err) {
    if (!isDiscardable(err)) throw err;
    getSafeLogger()?.info(STAGE, "A crash-leftover session cannot be restored; opening fresh", {
      sessionName: base.name,
      code: err.code,
    });
    await discard(base.store, base.name);
    return openBackend(base, undefined);
  }
}

/** acpx's record id has no ACP equivalent: both fields carry the ACP session id (spec §11 item 3). */
async function protocolIdsOf(store: TranscriptStore, name: string): Promise<ProtocolIds> {
  const doc = await store.load(name).catch(() => null);
  const id = doc?.acp?.agentSessionId ?? null;
  return { recordId: id, sessionId: id };
}

function linkRunSignal(signal: AbortSignal | undefined, closer: AbortController): () => void {
  if (signal === undefined) return () => {};
  const onAbort = (): void => closer.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function streamContextOf(
  name: string,
  opts: OpenSessionOpts,
  process: ProcessTracker,
  audit: AuditRecorder,
): StreamContext {
  const header = opts.toolAudit?.header;
  return {
    emit: opts.onStreamActivity,
    agentName: opts.agentName,
    sessionName: name,
    runId: header?.runId ?? "",
    storyId: header?.storyId,
    model: opts.modelDef.model,
    timeoutSeconds: opts.timeoutSeconds,
    pid: () => process.pid,
    audit,
  };
}

export async function createSession(name: string, agent: AcpAgentName, opts: OpenSessionOpts): Promise<AcpSdkSession> {
  const slot = createTurnSlot();
  const closer = new AbortController();
  const unlinkRun = linkRunSignal(opts.signal, closer);
  const audit = createAuditRecorder(name, opts.toolAudit);
  const base: OpenBase = {
    name,
    agent,
    opts,
    store: transcriptStoreFor(opts.transcriptDir),
    slot,
    asks: createAskPort(slot, AWAITING_HUMAN_BEAT_MS, audit),
    audit,
    closer,
    process: { pid: undefined },
  };
  try {
    const rateCard = await _acpSdkDeps.resolveRateCard(opts.modelDef.model);
    const opened = await openWithLeftover(base);
    const protocolIds = await protocolIdsOf(base.store, name);
    const handle: SessionHandle = Object.freeze({
      id: name,
      agentName: opts.agentName,
      protocolIds,
      modelDef: opts.modelDef,
      ...(opts.modelTier === undefined ? {} : { modelTier: opts.modelTier }),
    });
    return {
      ...base,
      handle,
      rateCard,
      stream: streamContextOf(name, opts, base.process, audit),
      opened,
      running: undefined,
      unlinkRun,
    };
  } catch (err) {
    unlinkRun();
    throw err;
  }
}

export function closeDeadlineMs(opts: OpenSessionOpts): number {
  return opts.trackedSpawnDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS;
}

/**
 * Waits for `work` up to `waitMs` (or until `signal` aborts). setTimeout, not
 * Bun.sleep: the timer is cleared as soon as either settles. A close that
 * outlives the wait keeps running; the caller kills the process group (killAgent).
 */
async function settleWithin(work: Promise<void>, waitMs: number, signal?: AbortSignal): Promise<"done" | "cut"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<"cut">((resolve) => {
    timer = setTimeout(() => resolve("cut"), waitMs);
    onAbort = () => resolve("cut");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const settled = work.then(
    () => "done" as const,
    (err: unknown) => {
      getSafeLogger()?.warn(STAGE, "Closing the ACP agent failed", { error: errorText(err) });
      return "done" as const;
    },
  );
  try {
    return await Promise.race([settled, cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

export interface ShutdownOptions {
  /** The teardown bound (`trackedSpawnDeadlineMs`). */
  readonly waitMs: number;
  /** Skips the cancel grace, not the kill (spec §6.1): the process group is killed first. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Spec §6.1 close: abort a running prompt, close bounded by the teardown
 * deadline (past it, kill the process group), wait for the turn loop so the
 * backend's last baseline save lands first, then delete the document.
 */
export async function shutdownSession(session: AcpSdkSession, options: ShutdownOptions): Promise<void> {
  session.closer.abort();
  session.unlinkRun();
  if (options.force === true) killAgent(session.process);
  const outcome = await settleWithin(session.opened.close(), options.waitMs, options.signal);
  if (outcome === "cut") {
    getSafeLogger()?.warn(STAGE, "The ACP agent did not close within the teardown deadline; killing it", {
      sessionName: session.name,
      waitMs: options.waitMs,
    });
    killAgent(session.process);
  }
  // The backend's sendTurn saves the cost baseline in its finally; let it land before the delete.
  if (session.running !== undefined) await settleWithin(session.running, options.waitMs);
  await session.audit.flush().catch((err: unknown) => {
    getSafeLogger()?.warn(STAGE, "Could not write the ACP session's tool audit", {
      sessionName: session.name,
      error: errorText(err),
    });
  });
  await discard(session.store, session.name);
}

/** Mid-turn NO_SESSION recovery (§6.2 step 3.5): a fresh session under the same name, never a resume (D2-l). */
export async function reopenFresh(session: AcpSdkSession): Promise<void> {
  if ((await settleWithin(session.opened.close(), closeDeadlineMs(session.opts))) === "cut") killAgent(session.process);
  await discard(session.store, session.name);
  session.opened = await openBackend(session, undefined);
}
