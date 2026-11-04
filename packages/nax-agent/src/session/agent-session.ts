/**
 * createAgentSession: the conversational session facade (S3 spec 4, 5.1). The
 * facade drives any SessionBackend: it resolves the shared options and the
 * session root, opens the backend, and runs turns through the S1
 * AgentSessionAdapter the backend returns. The native backend lives in
 * native-backend.ts and the ACP backend (S4) satisfies the same seam.
 * resumeAgentSession reopens a stored session (spec 4.2, 6.4).
 */

import { NaxError } from "#src/infra/nax-error";
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import type { SandboxState } from "#src/sandbox/types";
import { claimCommand } from "./agent-session-command.ts";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import { AgentSessionError, type AgentSessionErrorCode } from "./agent-session-errors.ts";
import { type ResolvedAgentSessionOptions, resolveAgentSessionOptions } from "./agent-session-options.ts";
import { checkBackendKind, interruptedTurnOf, loadResumable, resumeInput } from "./agent-session-resume.ts";
import { type ClaimedTurn, claimTurn, type LiveTurn, type TurnRunContext } from "./agent-session-turn.ts";
import type {
  AgentSession,
  AnswerReply,
  AnswerStatus,
  CommandRunResult,
  CompactResult,
  CreateAgentSessionOptions,
  SessionConfigureInput,
  SessionEvent,
  TurnEndStatus,
} from "./agent-session-types.ts";
import { type SendInput, validateImageAttachments } from "./image-input.ts";
import { createPendingAskTable, type PendingAskTable } from "./pending-asks.ts";
import { createSessionAskPort } from "./session-ask-port.ts";
import type { BackendInfo, OpenedBackend } from "./session-backend.ts";
import { createSteerQueue, type SteerQueue, type SteerResult } from "./steer-channel.ts";

/** The running turn: what the ask port reads. */
interface LiveSlot {
  turn: LiveTurn | undefined;
}

/**
 * What the session's single-flight slot currently runs. `steer` reads the kind:
 * a `runCommand` (or, from US-002, a `compact`) holds the slot without being a
 * turn, and a steer needs a turn.
 */
type ClaimKind = "turn" | "command" | "compact";

interface ActiveClaim extends Pick<ClaimedTurn, "turnId" | "settled" | "cancel"> {
  readonly kind: ClaimKind;
  /** A turn claim's pending steers; absent for a claim that runs no model turn. */
  readonly steers?: SteerQueue;
}

type LastTurn = { readonly turnId: string; readonly status: TurnEndStatus };

/** How the backend session is opened, and the document a resume starts from. */
interface Opening {
  readonly doc: TranscriptDoc | undefined;
  readonly lastTurn: LastTurn | undefined;
}

/** The handler's turn signal between turns: never aborts. */
const IDLE_SIGNAL = new AbortController().signal;

interface CompactHooks {
  onStart(claim: ActiveClaim): void;
  onSettle(): void;
}

/**
 * US-002: claim the session's single slot for one compaction.
 *
 * Same shape as `claimCommand` — the slot is taken synchronously, the work
 * starts on a microtask, and the deadline timer is armed here — with one
 * difference that matters: the signal handed to the backend fans in the
 * session's own close signal as well as this call's deadline, so a `close()`
 * stops a summarizer call instead of leaving it running past the session.
 *
 * The timer is armed BEFORE the work starts (not inside the microtask) because
 * the deadline belongs to the claim: a compaction that has been claimed but not
 * yet dispatched is still bounded by it.
 */
function claimCompact(options: {
  ctx: TurnRunContext;
  closeSignal: AbortSignal;
  run: NonNullable<OpenedBackend["compact"]>;
  hooks: CompactHooks;
}): { readonly claim: ActiveClaim; readonly result: Promise<CompactResult> } {
  const { ctx, closeSignal, run, hooks } = options;
  const turnId = _agentSessionDeps.randomUUID();
  const controller = new AbortController();
  const timer = _agentSessionDeps.setTimeout(
    () =>
      controller.abort(new NaxError("compaction deadline", "AGENT_SESSION_TURN_TIMEOUT", { stage: "agent-session" })),
    ctx.turnTimeoutSeconds * 1000,
  );
  const signal = AbortSignal.any([controller.signal, closeSignal]);
  const result = Promise.resolve()
    .then(() => run({ signal }))
    .finally(() => {
      _agentSessionDeps.clearTimeout(timer);
      hooks.onSettle();
    });
  const claim: ActiveClaim = {
    kind: "compact",
    turnId,
    settled: result.then(
      () => {},
      () => {},
    ),
    cancel: (reason) => controller.abort(reason),
  };
  hooks.onStart(claim);
  return { claim, result };
}

/**
 * The sandbox state as the embedder sees it: a frozen COPY, down to the
 * `network` list an `available` state carries. Copying keeps the backend's own
 * record out of the embedder's reach; freezing keeps the embedder from editing
 * the record of what its commands ran under (US-001).
 */
function frozenSandbox(state: SandboxState): SandboxState {
  if (state.kind !== "available" || typeof state.network === "string") return Object.freeze({ ...state });
  return Object.freeze({ ...state, network: Object.freeze([...state.network]) });
}

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
  private active: ActiveClaim | undefined;
  private last: LastTurn | undefined;
  private closing: Promise<void> | undefined;
  /** True while the backend's configure is pending: send, runCommand and configure refuse BUSY. */
  private configuring = false;

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
    const info = this.parts.opened.info;
    // US-001: the sandbox state rides through the facade frozen, so an embedder
    // cannot edit the record of what its commands ran under.
    return Object.freeze({
      kind: info.kind,
      capabilities: Object.freeze({ ...info.capabilities }),
      ...(info.sandbox !== undefined ? { sandbox: frozenSandbox(info.sandbox) } : {}),
    });
  }

  get lastTurn(): LastTurn | undefined {
    return this.last;
  }

  async acceptsImages(): Promise<boolean> {
    if (this.closing !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" is closed`, "AGENT_SESSION_CLOSED", { sessionId: this.id });
    }
    return this.parts.opened.acceptsImages?.() ?? false;
  }

  send(message: string, input?: SendInput): AsyncIterable<SessionEvent> {
    if (this.closing !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" is closed`, "AGENT_SESSION_CLOSED", { sessionId: this.id });
    }
    if (this.active !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" already has a turn in flight`, "AGENT_SESSION_BUSY", {
        sessionId: this.id,
      });
    }
    if (this.configuring) {
      throw new AgentSessionError(`Session "${this.id}" is being configured`, "AGENT_SESSION_BUSY", {
        sessionId: this.id,
      });
    }
    const images = input?.images;
    const reason = images === undefined ? undefined : validateImageAttachments(images);
    if (reason !== undefined) {
      throw new AgentSessionError(reason, "AGENT_SESSION_INVALID_INPUT", { sessionId: this.id });
    }
    if (images?.length && this.parts.opened.acceptsImages === undefined) {
      throw new AgentSessionError(
        `Session "${this.id}" cannot receive images`,
        "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
        {
          sessionId: this.id,
          capability: "images",
        },
      );
    }
    // US-001: this turn's pending steers. Built only for a backend that can take
    // one mid-turn, so an ACP-backed session allocates nothing and its
    // `sendTurn` options stay identical.
    const steers = this.parts.opened.steerable === true ? createSteerQueue() : undefined;
    const turn = claimTurn(this.parts.ctx, message, {
      images,
      ...(steers !== undefined ? { steers } : {}),
      onStart: (live) => {
        this.parts.slot.turn = live;
      },
      onSettle: (turnId, status) => {
        // US-001: before `turn_end` is emitted, so a steer still pending resolves
        // `false` first and can never carry into the next `send()`.
        steers?.close();
        this.active = undefined;
        this.parts.slot.turn = undefined;
        if (status !== undefined) this.last = { turnId, status };
      },
    });
    this.active = {
      kind: "turn",
      turnId: turn.turnId,
      settled: turn.settled,
      cancel: turn.cancel,
      ...(steers !== undefined ? { steers } : {}),
    };
    return turn.iterable;
  }

  /**
   * US-001: adds text to the running turn's pending steers. The check order is
   * the documented one — the session's own state first, then the text, then the
   * backend's capability, then the claim — so a caller learns what it can fix
   * (its text) before what it cannot (the backend, the claim).
   */
  steer(text: string): SteerResult {
    if (this.closing !== undefined) {
      throw new AgentSessionError(`Session "${this.id}" is closed`, "AGENT_SESSION_CLOSED", { sessionId: this.id });
    }
    if (text.trim() === "") {
      throw new AgentSessionError(`Session "${this.id}" cannot steer empty text`, "AGENT_SESSION_INVALID_OPTIONS", {
        sessionId: this.id,
        path: "steer",
      });
    }
    if (this.parts.opened.steerable !== true) return { status: "unsupported" };
    const active = this.active;
    const steers = active?.kind === "turn" ? active.steers : undefined;
    if (steers === undefined) return { status: "no_turn" };
    const { steerId, applied } = steers.add(text);
    return { status: "accepted", steerId, applied };
  }

  async configure(input: SessionConfigureInput): Promise<void> {
    const refusal = this.configureRefusal(input);
    if (refusal !== undefined) throw refusal;
    const configure = this.parts.opened.configure;
    if (configure === undefined)
      throw this.refusal("AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "configure" });
    this.configuring = true;
    try {
      await configure.call(this.parts.opened, input);
    } finally {
      this.configuring = false;
    }
  }

  /** The refusals that precede the backend call, in the documented order; the backend check is last and separate. */
  private configureRefusal(input: SessionConfigureInput): AgentSessionError | undefined {
    if (this.closing !== undefined) return this.refusal("AGENT_SESSION_CLOSED");
    if (this.active !== undefined || this.configuring) return this.refusal("AGENT_SESSION_BUSY");
    const { model, effort } = input;
    if ((model === undefined && effort === undefined) || model === "" || effort === "") {
      return this.refusal("AGENT_SESSION_INVALID_OPTIONS", { path: "configure" });
    }
    return undefined;
  }

  private refusal(code: AgentSessionErrorCode, context: Record<string, unknown> = {}): AgentSessionError {
    return new AgentSessionError(`Session "${this.id}" cannot be configured`, code, { sessionId: this.id, ...context });
  }

  /**
   * US-002: compact the stored history now, holding the session's single slot
   * for the whole call so a `send()` during it refuses BUSY rather than running
   * a turn against a transcript the compaction is rewriting.
   *
   * The order of refusals is the documented one: the session's own state first
   * (closed), then its claim (busy), then the backend's capability (last,
   * because it is the one the caller can do nothing about). The signal the
   * backend receives aborts on this call's own deadline — the session's
   * `turnTimeoutSeconds`, the same budget a turn gets — and on `close()`.
   */
  async compact(): Promise<CompactResult> {
    const run = this.parts.opened.compact;
    const code =
      this.closing !== undefined
        ? "AGENT_SESSION_CLOSED"
        : this.active !== undefined || this.configuring
          ? "AGENT_SESSION_BUSY"
          : run === undefined
            ? "AGENT_SESSION_CAPABILITY_UNSUPPORTED"
            : undefined;
    if (code !== undefined || run === undefined) {
      throw new AgentSessionError(
        `Session "${this.id}" cannot be compacted`,
        code ?? "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
        { sessionId: this.id, capability: "compact" },
      );
    }
    const claim = claimCompact({
      ctx: this.parts.ctx,
      closeSignal: this.parts.closeController.signal,
      run: run.bind(this.parts.opened),
      hooks: {
        onStart: (claimed) => {
          this.active = claimed;
        },
        onSettle: () => {
          this.active = undefined;
        },
      },
    });
    return claim.result;
  }

  async runCommand(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult> {
    const code =
      this.closing !== undefined
        ? "AGENT_SESSION_CLOSED"
        : this.active !== undefined || this.configuring
          ? "AGENT_SESSION_BUSY"
          : this.parts.opened.runCommand === undefined
            ? "AGENT_SESSION_CAPABILITY_UNSUPPORTED"
            : undefined;
    const run = this.parts.opened.runCommand;
    if (code !== undefined || run === undefined) {
      throw new AgentSessionError(
        `Session "${this.id}" cannot run a command`,
        code ?? "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
        { sessionId: this.id },
      );
    }
    const claim = claimCommand({
      ctx: this.parts.ctx,
      command,
      onEvent,
      run: (request) => run.call(this.parts.opened, request),
      hooks: {
        onStart: (live) => {
          this.parts.slot.turn = live;
        },
        onSettle: () => {
          this.parts.slot.turn = undefined;
          this.active = undefined;
        },
      },
    });
    this.active = { kind: "command", turnId: claim.turnId, settled: claim.settled, cancel: claim.cancel };
    return claim.result;
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

/** Refuse cancellation with the session contract, not the caller's arbitrary abort reason. */
function checkOpenSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AgentSessionError("Agent session open was cancelled", "AGENT_SESSION_CLOSED");
  }
}

/** The caller owns only the open phase; never retain its signal for reconnects. */
function linkOpenSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  checkOpenSignal(signal);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
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
  const unlink = linkOpenSignal(raw.openSignal, closeController);
  let opened: OpenedBackend;
  try {
    opened = await raw.backend.open({
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
  } finally {
    unlink();
  }
  try {
    checkOpenSignal(closeController.signal);
    const ctx: TurnRunContext = {
      sessionId,
      adapter: opened.adapter,
      handle: opened.handle,
      store: raw.transcriptStore,
      turnOpts: () => opened.turnOpts(),
      turnTimeoutSeconds: options.turnTimeoutSeconds,
      metadata: options.metadata,
    };
    return new FacadeAgentSession(
      { ctx, table, slot, opened, closeController, cleanup: root.cleanup },
      opening.lastTurn,
    );
  } catch (err) {
    // Includes a backend that resolved despite cancellation. Close exactly once;
    // open() removes the root and preserves the original failure.
    await opened.close().catch(() => undefined);
    throw err;
  }
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
  checkOpenSignal(options.raw.openSignal);
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
  checkOpenSignal(options.raw.openSignal);
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
