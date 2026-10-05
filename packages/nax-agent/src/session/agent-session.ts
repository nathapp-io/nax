/**
 * createAgentSession: the conversational session facade (S3 spec 4, 5.1). The
 * facade drives any SessionBackend: it resolves the shared options and the
 * session root, opens the backend, and runs turns through the S1
 * AgentSessionAdapter the backend returns. The native backend lives in
 * native-backend.ts and the ACP backend (S4) satisfies the same seam.
 * resumeAgentSession reopens a stored session (spec 4.2, 6.4).
 */
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import { type ResolvedAgentSessionOptions, resolveAgentSessionOptions } from "./agent-session-options.ts";
import { checkBackendKind, interruptedTurnOf, loadResumable, resumeInput } from "./agent-session-resume.ts";
import { type ClaimedTurn, claimTurn, type LiveTurn, type TurnRunContext } from "./agent-session-turn.ts";
import type {
  AgentSession,
  AnswerReply,
  AnswerStatus,
  CreateAgentSessionOptions,
  SessionEvent,
  TurnEndStatus,
} from "./agent-session-types.ts";
import { createPendingAskTable, type PendingAskTable } from "./pending-asks.ts";
import { createSessionAskPort } from "./session-ask-port.ts";
import type { BackendInfo, OpenedBackend } from "./session-backend.ts";

/** The running turn: what the ask port reads. */
interface LiveSlot {
  turn: LiveTurn | undefined;
}

type LastTurn = { readonly turnId: string; readonly status: TurnEndStatus };

/** How the backend session is opened, and the document a resume starts from. */
interface Opening {
  readonly doc: TranscriptDoc | undefined;
  readonly lastTurn: LastTurn | undefined;
}

/** The handler's turn signal between turns: never aborts. */
const IDLE_SIGNAL = new AbortController().signal;

interface SessionRoot {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

interface SessionParts {
  readonly ctx: TurnRunContext;
  readonly table: PendingAskTable;
  readonly slot: LiveSlot;
  readonly opened: OpenedBackend;
  readonly closeController: AbortController;
  readonly cleanup: () => Promise<void>;
}

class FacadeAgentSession implements AgentSession {
  private active: ClaimedTurn | undefined;
  private last: LastTurn | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly parts: SessionParts,
    last: LastTurn | undefined,
  ) {
    this.last = last;
  }

  get id(): string {
    return this.parts.ctx.sessionId;
  }

  get backend(): BackendInfo {
    return this.parts.opened.info;
  }

  get lastTurn(): LastTurn | undefined {
    return this.last;
  }

  send(message: string): AsyncIterable<SessionEvent> {
    if (this.closing !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" is closed`, "AGENT_SESSION_CLOSED", { sessionId: this.id });
    }
    if (this.active !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" already has a turn in flight`, "AGENT_SESSION_BUSY", {
        sessionId: this.id,
      });
    }
    const turn = claimTurn(this.parts.ctx, message, {
      onStart: (live) => {
        this.parts.slot.turn = live;
      },
      onSettle: (turnId, status) => {
        this.active = undefined;
        this.parts.slot.turn = undefined;
        if (status !== undefined) this.last = { turnId, status };
      },
    });
    this.active = turn;
    return turn.iterable;
  }

  answer(requestId: string, reply: AnswerReply): AnswerStatus {
    return this.parts.table.answer(requestId, reply);
  }

  cancel(reason = "cancelled"): void {
    this.active?.cancel(reason);
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const active = this.active;
    this.parts.closeController.abort();
    this.parts.table.close();
    active?.cancel("session closed");
    await active?.settled;
    try {
      await this.parts.ctx.adapter.closeSession(this.parts.ctx.handle);
    } finally {
      try {
        await this.parts.opened.close();
      } finally {
        await this.parts.cleanup();
      }
    }
  }
}

async function sessionRoot(options: ResolvedAgentSessionOptions): Promise<SessionRoot> {
  const workdir = options.raw.workdir;
  if (workdir === undefined) {
    const dir = await _agentSessionDeps.makeScratchRoot();
    return { dir, cleanup: () => _agentSessionDeps.removeScratchRoot(dir) };
  }
  if (!(await _agentSessionDeps.isDirectory(workdir))) {
    throw new AgentSessionError(
      `Invalid agent session options: workdir "${workdir}" is not a directory`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "workdir" },
    );
  }
  return { dir: workdir, cleanup: async () => {} };
}

async function assemble(
  options: ResolvedAgentSessionOptions,
  sessionId: string,
  root: SessionRoot,
  opening: Opening,
): Promise<FacadeAgentSession> {
  const raw = options.raw;
  const table = createPendingAskTable(options.approvalTimeoutMs);
  const slot: LiveSlot = { turn: undefined };
  const closeController = new AbortController();
  const asks = createSessionAskPort({ table, emit: (body) => slot.turn?.emit(body), turn: () => slot.turn });
  const opened = await raw.backend.open({
    sessionId,
    workdir: root.dir,
    profile: raw.profile,
    instructions: raw.instructions,
    tools: options.tools,
    transcriptStore: raw.transcriptStore,
    resume: opening.doc === undefined ? undefined : { doc: opening.doc },
    asks,
    turnSignal: () => slot.turn?.signal ?? IDLE_SIGNAL,
    currentTurnId: () => slot.turn?.turnId,
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
    openSignal: closeController.signal,
  });
  const ctx: TurnRunContext = {
    sessionId,
    adapter: opened.adapter,
    handle: opened.handle,
    store: raw.transcriptStore,
    turnOpts: () => opened.turnOpts(),
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
  };
  return new FacadeAgentSession({ ctx, table, slot, opened, closeController, cleanup: root.cleanup }, opening.lastTurn);
}

/** Opens the backend session under a fresh root; a failure removes the root. */
async function open(
  options: ResolvedAgentSessionOptions,
  sessionId: string,
  opening: Opening,
): Promise<FacadeAgentSession> {
  const root = await sessionRoot(options);
  try {
    return await assemble(options, sessionId, root, opening);
  } catch (err) {
    await root.cleanup();
    throw err;
  }
}

export async function createAgentSession(input: CreateAgentSessionOptions): Promise<AgentSession> {
  const options = resolveAgentSessionOptions(input);
  const sessionId = options.raw.sessionId ?? _agentSessionDeps.randomUUID();
  if ((await options.raw.transcriptStore.load(sessionId)) !== null) {
    throw new AgentSessionError(
      `Session "${sessionId}" already exists in the transcript store; resume it instead`,
      "AGENT_SESSION_EXISTS",
      { sessionId },
    );
  }
  return open(options, sessionId, { doc: undefined, lastTurn: undefined });
}

/**
 * Spec 6.4: the turn a dead process left running is marked ended, so the next
 * send starts clean. A failure closes the session and rethrows the store's
 * error; a close failure would only mask it.
 */
async function endInterruptedTurn(
  session: FacadeAgentSession,
  store: TranscriptStore,
  sessionId: string,
  turnId: string,
): Promise<void> {
  try {
    await store.markTurn(sessionId, { turnId, state: "ended" });
  } catch (err) {
    await session.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Reopens a stored session (spec 4.2). `options` are a create's options; the
 * session id is the argument. Instructions, tools and profile are not stored:
 * pass them again.
 */
export async function resumeAgentSession(sessionId: string, input: CreateAgentSessionOptions): Promise<AgentSession> {
  const options = resolveAgentSessionOptions(resumeInput(sessionId, input));
  const store = options.raw.transcriptStore;
  const doc = await loadResumable(store, sessionId);
  checkBackendKind(doc, sessionId, options.raw.backend.kind);
  const interrupted = interruptedTurnOf(doc);
  const session = await open(options, sessionId, {
    doc,
    lastTurn: interrupted === undefined ? undefined : { turnId: interrupted, status: "interrupted" },
  });
  if (interrupted !== undefined) await endInterruptedTurn(session, store, sessionId, interrupted);
  return session;
}
