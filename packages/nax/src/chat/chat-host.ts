import type {
  CommandRunResult,
  CompactResult,
  LoopHandlerSet,
  SessionEvent,
  SessionStorage,
  SteerResult,
  ToolProvider,
} from "@nathapp/nax-agent";
import { lookupContextWindow } from "@/agents/catalog";
import { getProjectKey } from "@/config";
import { NaxError } from "@/errors";
import { projectOutputDir } from "@/runtime";
import {
  ACP_RUN_COMMAND_UNSUPPORTED,
  type AcpRefreshResult,
  acpRefusal,
  assertAcpInstalled,
  isChatAcpModel,
  reportAcpOpens,
} from "./acp";
import { createAgentsProvider } from "./agents-provider";
import { type ChatAskController, createChatAskController } from "./ask-controller";
import { type AskFallback, createAskFallback } from "./ask-fallback";
import { type ChatBackgroundTasks, createHostTasks } from "./background";
import { withAgentCallModel } from "./agent-call-model";
import { type ChatAgentRow, listAgentRows } from "./chat-agents-listing";
import { clampModelEffort, EFFORT_LEVELS, type EffortLevel, withEffort } from "./chat-effort";
import type { ChatHost, ChatHostDeps, ChatHostState, ChatSendOptions, ChatSessionRow } from "./chat-host-types";
import { type ChatLedger, createChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import { tierModels } from "./chat-models";
import { createCloseConfirm } from "./close-confirm";
import { type ContextWindowCache, createContextWindowCache } from "./context-window-cache";
import { createHostMemory, type HostMemory } from "./host-memory";
import { createHostQueue, type HostQueue } from "./host-queue";
import { createHostRecents, type HostRecents } from "./host-recents";
import { createHostCompacting, createHostSteering, type HostCompacting, type HostSteering } from "./host-steer-compact";
import { closeChatHost, createChatLoopHandlers } from "./host-wiring";
import { type ChatJobs, type ChatRunAsks, createHostJobs } from "./jobs";
import {
  type ChatHistory,
  type ChatSessionHandle,
  type OpenChatSessionRequest,
  openChatSession,
} from "./open-chat-session";
import type { ChatResources } from "./resources";
import { createSessionHygiene, resumableRows } from "./session-hygiene";
import { sessionAcceptsImages } from "./session-images";
import { latestResumableId, listCwdSessions } from "./session-listing";
import { switchChatSession } from "./session-switch";
import { createSubagentRuns, type SubagentRuns } from "./subagent-runs";
import { routeAskEvent, runChatTurn } from "./turn-runner";

const DEFAULT_CHAT_ASK_FALLBACK_MS = 60_000;

/**
 * Injectable seams for the host itself — tests replace these to drive the host
 * deterministically. Distinct from `ChatHostDeps`, which is the composition
 * input a caller supplies.
 */
export const _chatHostDeps = {
  lookupContextWindow,
};

/** The host's contract lives in `chat-host-types.ts`; re-exported here so imports do not move. */
export type { ChatHost, ChatHostDeps, ChatHostState, ChatSendOptions, ChatSessionRow } from "./chat-host-types";

class NativeChatHost implements ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
  readonly memory?: ChatResources["memory"];
  private readonly nativeModels: readonly string[];
  readonly asks: ChatAskController;
  readonly jobs?: ChatJobs;
  readonly runAsks?: ChatRunAsks;
  readonly tasks?: ChatBackgroundTasks;
  readonly confirmBeforeClose?: () => Promise<boolean>;
  private readonly hostJobs?: ReturnType<typeof createHostJobs>;
  private readonly fallback: AskFallback;
  private readonly hygiene: ReturnType<typeof createSessionHygiene>;
  private readonly open: typeof openChatSession;
  private readonly loopHandlers: LoopHandlerSet;
  private readonly steering: HostSteering;
  private readonly compacting: HostCompacting;
  /**
   * Serializes every read-modify-write of the session metadata's spend — a turn's write and
   * a compaction's — so neither can replace what the other added.
   */
  private readonly accounting: HostQueue;
  private readonly projectKey: string;
  private readonly outputDir: string;
  private readonly runs?: SubagentRuns;
  private readonly toolProviders?: readonly ToolProvider[];
  private readonly contextWindows: ContextWindowCache;
  /** The index every open carries and every subagent session is told; the host only calls it. */
  private readonly hostMemory: HostMemory;
  /** US-006: the recent models, newest first; absent when the composition supplied no store. */
  readonly recentModels?: () => readonly string[];
  private readonly recents?: HostRecents;
  private turnListener?: (event: SessionEvent) => void;
  private sending = false;
  private handle?: ChatSessionHandle;
  /** The index the active session was opened with: what a subagent session inherits. */
  private activeMemoryIndex?: string;
  private ledger?: ChatLedger;
  private resumeNotice?: string;
  private resourceNoticeRead = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly sessionOperations = new Set<Promise<void>>();

  async refreshAcpModels(): Promise<readonly AcpRefreshResult[]> {
    return this.deps.acp?.refresh(this.deps.cwd) ?? [];
  }

  constructor(private readonly deps: ChatHostDeps) {
    this.hygiene = createSessionHygiene(deps);
    this.open = reportAcpOpens(deps.open ?? openChatSession, deps.acp);
    // Read through a getter: a switch, a resume and a clear all replace the handle.
    this.steering = createHostSteering({ session: () => this.handle?.session });
    this.accounting = createHostQueue();
    this.compacting = createHostCompacting({
      session: () => this.handle?.session,
      handle: () => this.handle,
      storage: deps.storage,
      ledger: () => this.ledger,
      now: deps.now,
      queue: this.accounting,
      // A switch during the compaction leaves the new handle's own metadata alone.
      adopt: (meta) => {
        const handle = this.handle;
        if (handle !== undefined && handle.meta.sessionId === meta.sessionId) this.handle = { ...handle, meta };
      },
    });
    this.repoRoot = deps.repoRoot;
    this.catalog = deps.resources?.catalog;
    this.naxPlugins = deps.resources?.naxPlugins;
    this.mcp = deps.resources?.mcp;
    this.memory = deps.resources?.memory;
    this.contextWindows = createContextWindowCache(() => _chatHostDeps.lookupContextWindow);
    this.hostMemory = createHostMemory({ memory: deps.resources?.memory, logger: deps.logger });
    this.recents =
      deps.recents === undefined
        ? undefined
        : createHostRecents({ store: deps.recents.store, initial: deps.recents.initial, logger: deps.logger });
    const recents = this.recents;
    if (recents !== undefined) this.recentModels = () => recents.recentModels();
    this.nativeModels = deps.models ?? tierModels(deps.config);
    this.projectKey = getProjectKey(deps.config, deps.repoRoot);
    this.outputDir = projectOutputDir(this.projectKey, deps.config.outputDir);
    this.asks = createChatAskController({
      mode: "guarded",
      approvalTimeoutMs: deps.config.execution.approvalTimeout,
      now: deps.now,
      answer: (id, reply) => {
        (this.runs?.sessionFor(id) ?? this.requireHandle().session).answer(id, reply);
      },
      refuse: acpRefusal({
        jobs: () => this.jobs,
        repoRoot: deps.repoRoot,
        model: () => this.handle?.meta.model ?? "",
      }),
    });
    const hostJobs =
      deps.resources && deps.naxEntry
        ? createHostJobs({
            repoRoot: this.repoRoot,
            outputDir: this.outputDir,
            naxEntry: deps.naxEntry,
            config: deps.config,
            asks: this.asks,
            // Without an open session the getter reads "guarded" (fail closed: the card is shown). No public
            // path reaches it before start().
            mode: () => (this.handle?.meta.mode === "full" ? "full" : "guarded"),
            now: deps.now,
            logger: deps.logger,
            sessionId: () => this.current().sessionId,
          })
        : undefined;
    this.hostJobs = hostJobs;
    this.jobs = hostJobs?.jobs;
    this.runAsks = hostJobs?.runAsks;
    this.loopHandlers = createChatLoopHandlers({
      pluginHandlers: deps.resources?.pluginHandlers,
      rules: deps.config.context.rules,
      repoRoot: deps.repoRoot,
      memory: this.hostMemory.handlers,
      guard: hostJobs?.guard,
    });
    const resources = deps.resources;
    if (resources) {
      this.runs = createSubagentRuns({
        current: () => this.current(),
        catalog: resources.catalog,
        config: deps.config,
        cwd: deps.cwd,
        repoRoot: deps.repoRoot,
        toolProviders: resources.toolProviders,
        loopHandlers: this.loopHandlers,
        asks: this.asks,
        ledger: () => this.ledger,
        turnListener: () => this.turnListener,
        memoryIndex: () => this.activeMemoryIndex,
      });
      const hostTasks = createHostTasks({ outputDir: this.outputDir, now: deps.now, logger: deps.logger });
      this.tasks = hostTasks.tasks;
      const providers = [...resources.toolProviders, ...(hostJobs ? [hostJobs.provider] : []), hostTasks.provider];
      this.toolProviders = resources.catalog.agents.length
        ? [...providers, createAgentsProvider({ catalog: resources.catalog, run: this.runs.run })]
        : providers;
    }
    if (hostJobs || this.tasks) {
      const closeOptions = { hostJobs, tasks: this.tasks, asks: this.asks, logger: deps.logger };
      this.confirmBeforeClose = createCloseConfirm(closeOptions);
    }
    this.fallback = createAskFallback({
      controller: this.asks,
      chain: deps.chain,
      delayMs: deps.config.interaction?.defaults.chatAskFallbackMs ?? DEFAULT_CHAT_ASK_FALLBACK_MS,
      logger: deps.logger,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new NaxError("[chat] host is closed", "CHAT_HOST_CLOSED", { stage: "chat" });
  }

  private requireHandle(): ChatSessionHandle {
    this.assertOpen();
    if (!this.handle) throw new NaxError("[chat] no session is open", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    return this.handle;
  }

  /** The native models followed by the catalog's rows, read live: the catalog learns rows as agents open. */
  get models(): readonly string[] {
    const acp = this.deps.acp;
    return acp ? [...this.nativeModels, ...acp.rows()] : this.nativeModels;
  }

  effortLevels(model: string): readonly EffortLevel[] {
    if (isChatAcpModel(model)) return this.deps.acp?.effortLevels(model) ?? ["default"];
    return this.deps.effortLevels?.get(withEffort(model, "default")) ?? EFFORT_LEVELS;
  }

  modelNote(model: string): string | undefined {
    return this.deps.acp?.unavailable(model);
  }

  history(): ChatHistory {
    return this.handle?.history ?? { messages: [] };
  }

  current(): ChatHostState {
    // Ink stays mounted during teardown and an in-flight turn may still refresh.
    // Keep the last handle readable; only operations require an open host.
    const handle = this.handle;
    if (!handle) throw new NaxError("[chat] no session is open", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    const { session, meta } = handle;
    const contextWindow = this.contextWindows.get(meta.model);
    return {
      sessionId: meta.sessionId,
      mode: meta.mode === "full" ? "full" : "guarded",
      model: meta.model,
      meta,
      ...(session.backend.sandbox === undefined ? {} : { sandbox: session.backend.sandbox }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  agents(): readonly ChatAgentRow[] {
    const agents = this.catalog?.agents ?? [];
    if (agents.length === 0) return [];
    // Read at listing time so an inherited model follows model switches.
    return listAgentRows({ catalog: this.catalog, config: this.deps.config, parentModel: this.current().model });
  }

  private async withSessionOperation(operation: () => Promise<void>): Promise<void> {
    this.assertOpen();
    // Register before invoking the operation, including its first asynchronous read/open.
    const completed = Promise.withResolvers<void>();
    this.sessionOperations.add(completed.promise);
    try {
      await operation();
    } finally {
      this.sessionOperations.delete(completed.promise);
      completed.resolve();
    }
  }

  async start(input: { mode: ChatMode; model: string }): Promise<void> {
    await this.withSessionOperation(() => this.startSession(input));
  }

  private async startSession(input: { mode: ChatMode; model: string }): Promise<void> {
    this.assertOpen();
    assertAcpInstalled(this.deps.acp, input.model);
    const memoryIndex = await this.hostMemory.prepare();
    const next = await this.open({ ...input, storage: this.deps.storage, ...this.openArgs(memoryIndex) });
    await this.replace(next, memoryIndex);
    await this.jobs?.attach();
    this.resumeNotice = undefined;
    await this.contextWindows.prime(next.meta.model);
    await this.recents?.recordOpen(next.meta.model);
  }

  /** The arguments every open shares; the memory index is passed in, never re-read, so
   * overlapping session operations cannot swap snapshots. */
  private openArgs(memoryIndex: string | undefined): Omit<OpenChatSessionRequest, "storage"> {
    return {
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
      ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
      ...(this.tasks ? { backgroundCommands: this.tasks } : {}),
      ...(memoryIndex !== undefined ? { memoryIndex } : {}),
    };
  }

  private async replace(next: ChatSessionHandle, memoryIndex: string | undefined): Promise<void> {
    // A late open must release its handle before the operation drain can finish.
    if (this.closed) {
      await this.hygiene.close(next);
      this.assertOpen();
    }
    const previous = this.handle;
    if (previous) this.hostJobs?.sessionChanged();
    this.handle = next;
    this.activeMemoryIndex = memoryIndex;
    this.ledger ??= createChatLedger({
      sessionId: next.meta.sessionId,
      model: next.meta.model,
      projectKey: this.projectKey,
      outputDir: this.outputDir,
      startedAt: this.deps.now(),
    });
    this.asks.reset();
    this.asks.setMode(next.meta.mode === "full" ? "full" : "guarded");
    if (previous) await this.hygiene.close(previous, next.meta.sessionId);
  }

  notice(): string | undefined {
    return this.resumeNotice ?? this.handle?.notice;
  }

  resourceNotice(): string | undefined {
    if (this.resourceNoticeRead) return undefined;
    this.resourceNoticeRead = true;
    const count = this.catalog?.packages.filter((pkg) => pkg.hooks.length > 0).length ?? 0;
    return count > 0 ? `hooks declared by ${count} package(s) are not executed by nax` : undefined;
  }

  async resume(input: { id?: string }): Promise<void> {
    await this.withSessionOperation(() => this.resumeSession(input));
  }

  private async resumeSession(input: { id?: string }): Promise<void> {
    this.assertOpen();
    // Prepared for every resume; this resume's own snapshot is the one its open carries.
    const memoryIndex = await this.hostMemory.prepare();
    const id =
      input.id ??
      (await latestResumableId({ storage: this.deps.storage, cwd: this.deps.cwd, logger: this.deps.logger }));
    if (this.handle?.meta.sessionId !== id) {
      let next: ChatSessionHandle;
      try {
        next = await this.open({ storage: this.deps.storage, ...this.openArgs(memoryIndex), resumeId: id });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "SESSION_LOCKED") {
          const holder = await this.deps.storage.readLockHolder(id);
          throw new NaxError(`session ${id} is in use by pid ${holder?.pid}`, "CHAT_SESSION_LOCKED", {
            stage: "chat",
            sessionId: id,
            cause: error,
          });
        }
        throw error;
      }
      await this.replace(next, memoryIndex);
    }
    await this.jobs?.attach();
    const resumed = this.requireHandle();
    this.resumeNotice =
      resumed.session.lastTurn?.status === "interrupted"
        ? "The last turn was interrupted. Send a message to continue it."
        : undefined;
    await this.contextWindows.prime(resumed.meta.model);
    await this.recents?.recordOpen(resumed.meta.model);
  }

  private async reopen(
    input: { mode: ChatMode; model: string },
    previous: ChatSessionHandle,
    memoryIndex: string | undefined,
  ): Promise<ChatSessionHandle> {
    // Reopens own per-open cleanup, but share the original storage lock. Even a
    // failed open must drain its shadow without releasing the active host's lock.
    const storage: SessionStorage = { ...this.deps.storage, acquireLock: async () => async () => {} };
    const request = { ...input, storage, resumeId: previous.meta.sessionId, ...this.openArgs(memoryIndex) };
    const next = await this.open(request);
    return {
      ...next,
      release: async (options) => {
        try {
          await next.release(options);
        } finally {
          await previous.release(options);
        }
      },
    };
  }

  async switchTo(input: { mode?: ChatMode; model?: string }): Promise<void> {
    await this.withSessionOperation(() => this.switchSession(input));
  }

  private async switchSession(input: { mode?: ChatMode; model?: string }): Promise<void> {
    const previous = this.requireHandle();
    const from = this.current();
    const model =
      input.model === undefined ? from.model : clampModelEffort(input.model, this.effortLevels(input.model));
    const target = { mode: input.mode ?? from.mode, model };
    if (target.mode === from.mode && target.model === from.model) return;
    assertAcpInstalled(this.deps.acp, target.model);
    // One prepare per switch: its reopen, rollback reopen and openFresh share this snapshot.
    const memoryIndex = await this.hostMemory.prepare();
    const outcome = await switchChatSession({
      previous,
      from: { mode: from.mode, model: from.model },
      target,
      reopen: (to) => this.reopen(to, previous, memoryIndex),
      openFresh: (to) => this.open({ ...to, storage: this.deps.storage, ...this.openArgs(memoryIndex) }),
      writeMeta: (meta) => this.deps.storage.writeMeta(meta),
    });
    this.handle = outcome.handle;
    // An in-place switch reuses the live session and the instructions it opened with, so its
    // snapshot stands; only a newly opened session (reopen or openFresh) carries the new one.
    if (outcome.inPlace !== true) this.activeMemoryIndex = memoryIndex;
    if (outcome.handle.meta.sessionId !== previous.meta.sessionId) {
      this.hostJobs?.sessionChanged();
      this.resumeNotice = outcome.notice;
    }
    this.asks.setMode(outcome.handle.meta.mode === "full" ? "full" : "guarded");
    await this.contextWindows.prime(outcome.handle.meta.model);
    await this.recents?.switched(from.model, outcome);
    if (outcome.error !== undefined) throw outcome.error;
  }

  async clear(): Promise<void> {
    const { mode, model } = this.current();
    await this.start({ mode, model });
  }

  async send(message: string, onEvent: (event: SessionEvent) => void, options?: ChatSendOptions): Promise<void> {
    // Validate before taking the shared turn state, so the error a caller gets does not
    // depend on what is queued ahead of it.
    this.requireHandle();
    const ledger = this.ledger;
    if (!ledger) throw new NaxError("[chat] ledger is not initialized", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    // Reject before touching the shared listener and nested-spend state: they belong to
    // the active send until its metadata is persisted.
    if (this.sending) {
      throw new NaxError("[chat] a turn is already running", "CHAT_TURN_BUSY", { stage: "chat" });
    }
    this.sending = true;
    this.turnListener = onEvent;
    const runs = this.runs;
    try {
      // Claim the session's turn here, before any `await`. The slot is what `steer` answers
      // from and what `cancel` acts on, and both keys can arrive in the same batch as the
      // return that started this turn: queued behind the accounting instead, the claim would
      // appear a microtask later, the key would find no turn, and the turn would then run
      // uncancelled.
      const handle = this.requireHandle();
      this.hygiene.markSent(handle.meta.sessionId);
      // Only the turn's metadata write is queued (`queue`), never the turn: the write is the
      // other read-modify-write of the same `costUsd`, and a compaction that settled a
      // moment ago must not be overwritten by this turn's base.
      const meta = await runChatTurn({
        handle,
        storage: this.deps.storage,
        queue: this.accounting,
        message,
        title: options?.title,
        images: options?.images,
        asks: this.asks,
        ledger,
        onEvent: runs ? withAgentCallModel(onEvent, runs.modelFor) : onEvent,
        now: this.deps.now().toISOString(),
        ...(runs ? { extraCostUsd: () => runs.takeCost(), settleNested: () => runs.settle() } : {}),
      });
      // Adopt the persisted accounting once the queue has written it. A same-session switch
      // keeps its settings and live session, but still receives this turn's spend; a
      // different session must never receive the retired session's metadata.
      if (this.handle === handle) this.handle = { ...handle, meta };
      else if (this.handle?.meta.sessionId === meta.sessionId) {
        this.handle = {
          ...this.handle,
          meta: { ...this.handle.meta, costUsd: meta.costUsd, title: meta.title, updatedAt: meta.updatedAt },
        };
      }
    } finally {
      try {
        // A cancelled tool batch abandons its nested run without waiting for it: drain
        // every run (a pending open included) before the listener and spend are released.
        await runs?.settle();
      } finally {
        this.turnListener = undefined;
        this.sending = false;
        // Nested spend of a send that threw is dropped, never added to the next send.
        runs?.takeCost();
      }
    }
  }

  /** Delegated so the capability read never throws when no session is open. */
  acceptsImages(): Promise<boolean> {
    return sessionAcceptsImages(this.handle?.session);
  }

  async runCommand(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult> {
    const { session, meta } = this.requireHandle();
    if (isChatAcpModel(meta.model)) return { isError: true, content: ACP_RUN_COMMAND_UNSUPPORTED };
    if (!session.runCommand) return { isError: true, content: "this session cannot run commands" };
    return session.runCommand(command, (event) => {
      routeAskEvent(event, this.asks);
      onEvent(event);
    });
  }

  /**
   * US-004: hand text to the running turn. The session's own answer travels back unchanged —
   * `no_turn` without an open session rather than the facade's not-open error, because a key
   * handler asks this on every ctrl+s and must not have to catch.
   */
  steer(text: string): SteerResult {
    return this.steering.steer(text);
  }

  /**
   * US-005: compact the conversation now, and record what it spent. The session's own result
   * travels back unchanged — `tokensBefore`/`tokensAfter` are what the screen shows and what
   * the footer's context reading becomes.
   */
  compact(): Promise<CompactResult> {
    return this.compacting.compact();
  }

  cancel(): void {
    const { session } = this.requireHandle();
    session.cancel();
    this.runs?.cancelAll();
  }

  async listSessions(): Promise<readonly ChatSessionRow[]> {
    const sessions = await listCwdSessions(this.deps.storage, this.deps.cwd);
    return resumableRows({ ...this.deps, sessions, currentId: this.handle?.meta.sessionId });
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.hostJobs?.close();
    this.fallback.dispose();
    // Leave asks intact while the shell is mounted; final close cannot reuse them.
    this.closing = this.teardown();
    return this.closing;
  }

  private async teardown(): Promise<void> {
    await this.deps.acp?.close();
    // closed blocks new operations. Drain existing opens, replacements and rollback
    // reopens (including late-handle cleanup) before releasing the final handle.
    await Promise.all(this.sessionOperations);
    this.jobs?.dispose();
    try {
      await this.runs?.closeAll();
    } finally {
      await closeChatHost({
        hygiene: this.hygiene,
        handle: this.handle,
        tasks: this.tasks,
        resources: this.deps.resources,
        chain: this.deps.chain,
        memory: this.hostMemory,
      });
    }
  }
}

/** Headless composition root: one handler set, ask controller, fallback and process ledger. */
export function createChatHost(deps: ChatHostDeps): ChatHost {
  return new NativeChatHost(deps);
}
