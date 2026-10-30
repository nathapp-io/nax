import type {
  CommandRunResult,
  SandboxState,
  SessionEvent,
  SessionMeta,
  SessionStorage,
  ToolProvider,
} from "@nathapp/nax-agent";
import { lookupContextWindow } from "@/agents/catalog";
import { getProjectKey, type NaxConfig } from "@/config";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { NaxError } from "@/errors";
import type { InteractionChain } from "@/interaction";
import type { Logger } from "@/logger";
import { projectOutputDir } from "@/runtime";
import {
  ACP_RUN_COMMAND_UNSUPPORTED,
  type AcpCatalog,
  acpRefusal,
  assertAcpInstalled,
  isChatAcpModel,
  reportAcpOpens,
} from "./acp";
import { createAgentsProvider } from "./agents-provider";
import { type ChatAskController, createChatAskController } from "./ask-controller";
import { type AskFallback, createAskFallback } from "./ask-fallback";
import { type ChatBackgroundTasks, createHostTasks } from "./background";
import { type ChatAgentRow, listAgentRows } from "./chat-agents-listing";
import { clampModelEffort, EFFORT_LEVELS, type EffortLevel, withEffort } from "./chat-effort";
import { type ChatLedger, createChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import { tierModels } from "./chat-models";
import { createCloseConfirm } from "./close-confirm";
import { type ChatJobs, type ChatRunAsks, createHostJobs } from "./jobs";
import { type ChatHistory, type ChatSessionHandle, openChatSession } from "./open-chat-session";
import type { ChatResources } from "./resources";
import { closeChatResources, createSessionHygiene, resumableRows } from "./session-hygiene";
import { latestResumableId, listCwdSessions } from "./session-listing";
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

export interface ChatHostState {
  readonly sessionId: string;
  readonly mode: ChatMode;
  readonly model: string;
  readonly meta: SessionMeta;
  readonly sandbox?: SandboxState;
  /** The session model's catalog context window; absent when the catalog cannot say. */
  readonly contextWindow?: number;
}

export interface ChatSessionRow {
  readonly sessionId: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
  readonly heldByPid?: number;
}

export interface ChatSendOptions {
  readonly title?: string;
}

/** Shared-session chat lifecycle, independent of the terminal shell. */
export interface ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  readonly jobs?: ChatJobs;
  readonly runAsks?: ChatRunAsks;
  readonly tasks?: ChatBackgroundTasks;
  readonly confirmBeforeClose?: () => Promise<boolean>;
  current(): ChatHostState;
  history?(): ChatHistory;
  effortLevels?(model: string): readonly EffortLevel[];
  /** Why the model cannot be used right now (an ACP agent that is not installed or not logged in), if it cannot. */
  modelNote?(model: string): string | undefined;
  /** One row per catalog agent in catalog order, resolved against the chat session's current model. */
  agents?(): readonly ChatAgentRow[];
  start(input: { mode: ChatMode; model: string }): Promise<void>;
  clear(): Promise<void>;
  resume(input: { id?: string }): Promise<void>;
  notice(): string | undefined;
  resourceNotice?(): string | undefined;
  switchTo(input: { mode?: ChatMode; model?: string }): Promise<void>;
  send(message: string, onEvent: (event: SessionEvent) => void, options?: ChatSendOptions): Promise<void>;
  runCommand?(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult>;
  cancel(): void;
  listSessions(): Promise<readonly ChatSessionRow[]>;
  close(): Promise<void>;
}

export interface ChatHostDeps {
  readonly naxEntry?: readonly string[];
  readonly resources?: ChatResources;
  readonly models?: readonly string[];
  /** The ACP agents offered as chat models; absent on a host that offers native models only. */
  readonly acp?: AcpCatalog;
  readonly effortLevels?: ReadonlyMap<string, readonly EffortLevel[]>;
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly chain: InteractionChain | null;
  readonly open?: typeof openChatSession;
  readonly storage: SessionStorage;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

class NativeChatHost implements ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
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
  private readonly loopHandlers: ReturnType<typeof createRuleDeliveryHandlers>;
  private readonly projectKey: string;
  private readonly outputDir: string;
  private readonly runs?: SubagentRuns;
  private readonly toolProviders?: readonly ToolProvider[];
  /** Catalog context window per model string; `undefined` records a model whose window the catalog cannot state. */
  private readonly contextWindows = new Map<string, number | undefined>();
  private turnListener?: (event: SessionEvent) => void;
  private sending = false;
  private handle?: ChatSessionHandle;
  private ledger?: ChatLedger;
  private resumeNotice?: string;
  private resourceNoticeRead = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly sessionOperations = new Set<Promise<void>>();

  constructor(private readonly deps: ChatHostDeps) {
    this.hygiene = createSessionHygiene(deps);
    this.open = reportAcpOpens(deps.open ?? openChatSession, deps.acp);
    this.repoRoot = deps.repoRoot;
    this.catalog = deps.resources?.catalog;
    this.naxPlugins = deps.resources?.naxPlugins;
    this.mcp = deps.resources?.mcp;
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
            now: deps.now,
            logger: deps.logger,
            sessionId: () => this.current().sessionId,
          })
        : undefined;
    this.hostJobs = hostJobs;
    this.jobs = hostJobs?.jobs;
    this.runAsks = hostJobs?.runAsks;
    const rules = deps.config.context.rules;
    this.loopHandlers = Object.freeze([
      ...(deps.resources?.pluginHandlers ?? []),
      ...createRuleDeliveryHandlers({
        repoRoot: deps.repoRoot,
        overrideDir: rules?.overrideDir,
        overrideMode: rules?.overrideMode,
      }),
      ...(hostJobs?.guard ?? []),
    ]);
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

  /**
   * Remember the session model's catalog context window, read once per model
   * string: a mode switch reopens on the same model, whose window cannot have
   * changed, and re-reading it per switch would cost a catalog load per toggle.
   * A model string with no non-empty `<provider>/` prefix names no catalog
   * entry, so it is not looked up at all (US-003 AC-10).
   */
  private async primeContextWindow(model: string): Promise<void> {
    if (this.contextWindows.has(model)) return;
    // An ACP model names no nax-ai catalog entry: the agent owns its context window.
    const split = model.indexOf("/");
    if (split <= 0 || isChatAcpModel(model)) {
      this.contextWindows.set(model, undefined);
      return;
    }
    let contextWindow: number | undefined;
    try {
      contextWindow = await _chatHostDeps.lookupContextWindow(model.slice(0, split), model.slice(split + 1));
    } catch {
      // Fail-open (US-003 AC-8): an unavailable catalog leaves the window
      // unknown rather than failing the session operation that read it.
    }
    this.contextWindows.set(model, contextWindow);
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
    const next = await this.open({
      ...input,
      storage: this.deps.storage,
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
      ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
      ...(this.tasks ? { backgroundCommands: this.tasks } : {}),
    });
    await this.replace(next);
    await this.jobs?.attach();
    this.resumeNotice = undefined;
    await this.primeContextWindow(next.meta.model);
  }

  private async replace(next: ChatSessionHandle): Promise<void> {
    // A late open must release its handle before the operation drain can finish.
    if (this.closed) {
      await this.hygiene.close(next);
      this.assertOpen();
    }
    const previous = this.handle;
    if (previous) this.hostJobs?.sessionChanged();
    this.handle = next;
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
    const id =
      input.id ??
      (await latestResumableId({ storage: this.deps.storage, cwd: this.deps.cwd, logger: this.deps.logger }));
    if (this.handle?.meta.sessionId !== id) {
      let next: ChatSessionHandle;
      try {
        next = await this.open({
          storage: this.deps.storage,
          cwd: this.deps.cwd,
          repoRoot: this.repoRoot,
          config: this.deps.config,
          loopHandlers: this.loopHandlers,
          ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
          ...(this.tasks ? { backgroundCommands: this.tasks } : {}),
          resumeId: id,
        });
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
      await this.replace(next);
    }
    await this.jobs?.attach();
    const resumed = this.requireHandle();
    this.resumeNotice =
      resumed.session.lastTurn?.status === "interrupted"
        ? "The last turn was interrupted. Send a message to continue it."
        : undefined;
    await this.primeContextWindow(resumed.meta.model);
  }

  private async reopen(
    input: { mode: ChatMode; model: string },
    previous: ChatSessionHandle,
  ): Promise<ChatSessionHandle> {
    // Reopens own per-open cleanup, but share the original storage lock. Even a
    // failed open must drain its shadow without releasing the active host's lock.
    const storage: SessionStorage = { ...this.deps.storage, acquireLock: async () => async () => {} };
    const next = await this.open({
      ...input,
      storage,
      resumeId: previous.meta.sessionId,
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
      ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
      ...(this.tasks ? { backgroundCommands: this.tasks } : {}),
    });
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
    try {
      await previous.session.close();
    } finally {
      await previous.release({ retainLock: true });
    }
    let next: ChatSessionHandle | undefined;
    try {
      next = await this.reopen(target, previous);
      await this.deps.storage.writeMeta(next.meta);
    } catch (error) {
      if (next) {
        try {
          await next.session.close();
        } finally {
          await next.release({ retainLock: true });
        }
      }
      this.handle = await this.reopen(from, previous);
      throw error;
    }
    this.handle = next;
    this.asks.setMode(target.mode);
    await this.primeContextWindow(next.meta.model);
  }

  async clear(): Promise<void> {
    const { mode, model } = this.current();
    await this.start({ mode, model });
  }

  async send(message: string, onEvent: (event: SessionEvent) => void, options?: ChatSendOptions): Promise<void> {
    const handle = this.requireHandle();
    const ledger = this.ledger;
    if (!ledger) throw new NaxError("[chat] ledger is not initialized", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    // Reject before touching the shared listener and nested-spend state: they belong to
    // the active send until its metadata is persisted.
    if (this.sending) {
      throw new NaxError("[chat] a turn is already running", "CHAT_TURN_BUSY", { stage: "chat" });
    }
    this.hygiene.markSent(handle.meta.sessionId);
    this.sending = true;
    this.turnListener = onEvent;
    const runs = this.runs;
    let meta: SessionMeta;
    try {
      meta = await runChatTurn({
        handle,
        storage: this.deps.storage,
        message,
        title: options?.title,
        asks: this.asks,
        ledger,
        onEvent,
        now: this.deps.now().toISOString(),
        ...(runs ? { extraCostUsd: () => runs.takeCost(), settleNested: () => runs.settle() } : {}),
      });
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
    if (this.handle === handle) this.handle = { ...handle, meta };
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
    // closed blocks new operations. Drain existing opens, replacements and rollback
    // reopens (including late-handle cleanup) before releasing the final handle.
    await Promise.all(this.sessionOperations);
    this.jobs?.dispose();
    try {
      await this.runs?.closeAll();
    } finally {
      await closeChatResources({
        hygiene: this.hygiene,
        handle: this.handle,
        tasks: this.tasks,
        resources: this.deps.resources,
        chain: this.deps.chain,
      });
    }
  }
}

/** Headless composition root: one handler set, ask controller, fallback and process ledger. */
export function createChatHost(deps: ChatHostDeps): ChatHost {
  return new NativeChatHost(deps);
}
