/**
 * createAgentSession: the conversational session facade (S3 spec 4, 5.1).
 * One NativeSessionAdapter per session. The facade fills the S1
 * OpenSessionOpts itself and talks to the backend through the S1 contract
 * only (openSession, sendTurn, closeSession), so the acpx backend (S4) slots
 * in behind the same API. resumeAgentSession reopens a stored session
 * (spec 4.2, 6.4).
 */
import { DEFAULT_SPIN_BREAKER_SETTINGS } from "#src/infra/spin-breaker/index";
import { NATIVE_AGENT } from "#src/native/models";
import type { TranscriptStore } from "#src/native/session/transcript-types";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError } from "./agent-session-errors.ts";
import { type ResolvedAgentSessionOptions, resolveAgentSessionOptions } from "./agent-session-options.ts";
import { interruptedTurnOf, loadResumable, resumeInput } from "./agent-session-resume.ts";
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
import { createSessionAskLink, createSessionAskResolver, type SessionAskDeps } from "./session-ask-link.ts";
import { createSessionInteractionHandler, embedderToolDescriptor } from "./session-interaction.ts";
import { buildSessionToolSupport, defaultProtectedPaths, resolveSessionLauncher } from "./session-tool-support.ts";

/** The running turn and the tool call being answered: what the ask link and the handler read. */
interface LiveSlot {
  turn: LiveTurn | undefined;
  callId: string | undefined;
}

type LastTurn = { readonly turnId: string; readonly status: TurnEndStatus };

/** How the backend session is opened, and the lastTurn a resume reports. */
interface Opening {
  readonly resume: boolean;
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
  readonly cleanup: () => Promise<void>;
}

class NativeAgentSession implements AgentSession {
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
    this.parts.table.close();
    active?.cancel("session closed");
    await active?.settled;
    try {
      await this.parts.ctx.adapter.closeSession(this.parts.ctx.handle);
    } finally {
      await this.parts.cleanup();
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

function createAdapter(options: ResolvedAgentSessionOptions): NativeSessionAdapter {
  const overrides = options.raw.catalogOverrides ?? [];
  const credentials = options.raw.credentials;
  // A session with its own catalog or credentials owns its client; the rest share the process memo.
  const owns = overrides.length > 0 || credentials !== undefined;
  return new NativeSessionAdapter(overrides, {
    ...(credentials !== undefined ? { credentials } : {}),
    ...(owns ? { ownClient: true } : {}),
  });
}

async function assemble(
  options: ResolvedAgentSessionOptions,
  sessionId: string,
  root: SessionRoot,
  opening: Opening,
): Promise<NativeAgentSession> {
  const raw = options.raw;
  // A supplied policy is merged over the default, so enabling GitCommit never drops the credential read-deny.
  const protectedPaths = { ...defaultProtectedPaths(raw.credentials !== undefined), ...raw.hostPorts?.protectedPaths };
  const launcher = await resolveSessionLauncher({
    profile: raw.profile,
    root: root.dir,
    protectedPaths,
    bashApproval: options.bashApproval,
    allowUnsandboxed: options.allowUnsandboxed,
  });
  const table = createPendingAskTable(options.approvalTimeoutMs);
  const slot: LiveSlot = { turn: undefined, callId: undefined };
  const asks: SessionAskDeps = { table, emit: (body) => slot.turn?.emit(body), currentCallId: () => slot.callId };
  const { support, grants } = buildSessionToolSupport({
    profile: raw.profile,
    root: root.dir,
    sessionName: sessionId,
    protectedPaths,
    bashApproval: options.bashApproval,
    launcher,
    askResolver: createSessionAskResolver(createSessionAskLink(asks)),
    interceptor: raw.hostPorts?.commandInterceptor,
  });
  const interactionHandler = createSessionInteractionHandler({
    sessionId,
    runtime: support.runtime,
    embedderTools: new Map(options.tools.map((tool) => [tool.name, tool])),
    asks,
    turnSignal: () => slot.turn?.signal ?? IDLE_SIGNAL,
    setCurrentCallId: (callId) => {
      slot.callId = callId;
    },
  });
  const adapter = createAdapter(options);
  const handle = await adapter.openSession(sessionId, {
    agentName: NATIVE_AGENT,
    workdir: root.dir,
    resolvedPermissions: { mode: "default", toolGrants: grants, bashApproval: options.bashApproval },
    modelDef: { provider: options.provider, model: raw.model },
    timeoutSeconds: options.turnTimeoutSeconds,
    transcriptStore: raw.transcriptStore,
    retainOnClose: true,
    resume: opening.resume,
    spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
    // An empty instructions is no system prompt: `system: ""` on the wire invites provider quirks.
    ...(raw.instructions !== undefined && raw.instructions !== "" ? { systemPrompt: raw.instructions } : {}),
  });
  const ctx: TurnRunContext = {
    sessionId,
    adapter,
    handle,
    store: raw.transcriptStore,
    codingTools: [...support.tools, ...options.tools.map(embedderToolDescriptor)],
    interactionHandler,
    loopHandlers: raw.loopHandlers,
    loopHandlerContext: { sessionName: sessionId, workdir: root.dir, model: raw.model, provider: options.provider },
    turnTimeoutSeconds: options.turnTimeoutSeconds,
    metadata: options.metadata,
  };
  return new NativeAgentSession({ ctx, table, slot, cleanup: root.cleanup }, opening.lastTurn);
}

/** Opens the backend session under a fresh root; a failure removes the root. */
async function open(
  options: ResolvedAgentSessionOptions,
  sessionId: string,
  opening: Opening,
): Promise<NativeAgentSession> {
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
  return open(options, sessionId, { resume: false, lastTurn: undefined });
}

/**
 * Spec 6.4: the turn a dead process left running is marked ended, so the next
 * send starts clean. A failure closes the session and rethrows the store's
 * error; a close failure would only mask it.
 */
async function endInterruptedTurn(
  session: NativeAgentSession,
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
  const interrupted = interruptedTurnOf(await loadResumable(store, sessionId, options.raw.model));
  const session = await open(options, sessionId, {
    resume: true,
    lastTurn: interrupted === undefined ? undefined : { turnId: interrupted, status: "interrupted" },
  });
  if (interrupted !== undefined) await endInterruptedTurn(session, store, sessionId, interrupted);
  return session;
}
