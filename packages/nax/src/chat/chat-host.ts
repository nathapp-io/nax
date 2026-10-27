import type {
  CommandRunResult,
  SandboxState,
  SessionEvent,
  SessionListEntry,
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
import { createAgentsProvider } from "./agents-provider";
import { type ChatAskController, createChatAskController } from "./ask-controller";
import { type AskFallback, createAskFallback } from "./ask-fallback";
import { type ChatAgentRow, listAgentRows } from "./chat-agents-listing";
import { type ChatLedger, createChatLedger } from "./chat-ledger";
import { type ChatMode, chatModeOfMeta } from "./chat-mode";
import { tierModels } from "./chat-models";
import { type ChatSessionHandle, openChatSession } from "./open-chat-session";
import type { ChatResources } from "./resources";
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

/** Shared-session chat lifecycle, independent of the terminal shell. */
export interface ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  current(): ChatHostState;
  /** One row per catalog agent in catalog order, resolved against the chat session's current model. */
  agents?(): readonly ChatAgentRow[];
  start(input: { mode: ChatMode; model: string }): Promise<void>;
  clear(): Promise<void>;
  resume(input: { id?: string }): Promise<void>;
  notice(): string | undefined;
  resourceNotice?(): string | undefined;
  switchTo(input: { mode?: ChatMode; model?: string }): Promise<void>;
  send(message: string, onEvent: (event: SessionEvent) => void): Promise<void>;
  runCommand?(command: string, onEvent: (event: SessionEvent) => void): Promise<CommandRunResult>;
  cancel(): void;
  listSessions(): Promise<readonly ChatSessionRow[]>;
  close(): Promise<void>;
}

export interface ChatHostDeps {
  readonly resources?: ChatResources;
  readonly models?: readonly string[];
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly chain: InteractionChain | null;
  readonly open?: typeof openChatSession;
  readonly storage: SessionStorage;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

async function closeHandle(handle: ChatSessionHandle): Promise<void> {
  try {
    await handle.session.close();
  } finally {
    await handle.release();
  }
}

class NativeChatHost implements ChatHost {
  readonly repoRoot: string;
  readonly catalog?: ChatResources["catalog"];
  readonly naxPlugins?: ChatResources["naxPlugins"];
  readonly mcp?: ChatResources["mcp"];
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  private readonly fallback: AskFallback;
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
    this.repoRoot = deps.repoRoot;
    this.catalog = deps.resources?.catalog;
    this.naxPlugins = deps.resources?.naxPlugins;
    this.mcp = deps.resources?.mcp;
    this.models = deps.models ?? tierModels(deps.config);
    this.projectKey = getProjectKey(deps.config, deps.repoRoot);
    this.outputDir = projectOutputDir(this.projectKey, deps.config.outputDir);
    const rules = deps.config.context.rules;
    this.loopHandlers = Object.freeze([
      ...(deps.resources?.pluginHandlers ?? []),
      ...createRuleDeliveryHandlers({
        repoRoot: deps.repoRoot,
        overrideDir: rules?.overrideDir,
        overrideMode: rules?.overrideMode,
      }),
    ]);
    this.asks = createChatAskController({
      mode: "guarded",
      answer: (id, reply) => {
        (this.runs?.sessionFor(id) ?? this.requireHandle().session).answer(id, reply);
      },
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
      });
      this.toolProviders = resources.catalog.agents.length
        ? [...resources.toolProviders, createAgentsProvider({ catalog: resources.catalog, run: this.runs.run })]
        : resources.toolProviders;
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
    const split = model.indexOf("/");
    if (split <= 0) {
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
    const next = await (this.deps.open ?? openChatSession)({
      ...input,
      storage: this.deps.storage,
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
      ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
    });
    await this.replace(next);
    this.resumeNotice = undefined;
    await this.primeContextWindow(next.meta.model);
  }

  private async replace(next: ChatSessionHandle): Promise<void> {
    // A late open must release its handle before the operation drain can finish.
    if (this.closed) {
      await closeHandle(next);
      this.assertOpen();
    }
    const previous = this.handle;
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
    if (previous) await closeHandle(previous);
  }

  notice(): string | undefined {
    return this.resumeNotice;
  }

  resourceNotice(): string | undefined {
    if (this.resourceNoticeRead) return undefined;
    this.resourceNoticeRead = true;
    const count = this.catalog?.packages.filter((pkg) => pkg.hooks.length > 0).length ?? 0;
    return count > 0 ? `hooks declared by ${count} package(s) are not executed by nax` : undefined;
  }

  /**
   * Every session this cwd has, in the store's newest-first order — not just its first page.
   * The store hands sessions back `LIST_PAGE_SIZE` at a time with a cursor, so a read that
   * stopped at the first page would hide every session past the fiftieth from `/resume`: the
   * picker's list is exactly this list, and an older free session is as resumable as a new
   * one. Both readers below go through here, so neither can forget the cursor.
   */
  private async allSessions(): Promise<readonly SessionListEntry[]> {
    const sessions: SessionListEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.storage.list({ cwd: this.deps.cwd, ...(cursor ? { cursor } : {}) });
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return sessions;
  }

  private async latestId(): Promise<string> {
    for (const { sessionId } of await this.allSessions()) {
      try {
        const meta = await this.deps.storage.readMeta(sessionId);
        if (meta === null || meta.sessionId !== sessionId || chatModeOfMeta(meta.mode) === null) continue;
        if ((await this.deps.storage.readLockHolder(sessionId))?.state !== "live") return sessionId;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "SESSION_META_UNREADABLE")) throw error;
        this.deps.logger.warn("chat", "skipping unreadable session metadata", { sessionId, cause: error });
      }
    }
    throw new NaxError(`no resumable session for ${this.deps.cwd}`, "CHAT_SESSION_NOT_FOUND", { stage: "chat" });
  }

  async resume(input: { id?: string }): Promise<void> {
    await this.withSessionOperation(() => this.resumeSession(input));
  }

  private async resumeSession(input: { id?: string }): Promise<void> {
    this.assertOpen();
    const id = input.id ?? (await this.latestId());
    if (this.handle?.meta.sessionId !== id) {
      let next: ChatSessionHandle;
      try {
        next = await (this.deps.open ?? openChatSession)({
          storage: this.deps.storage,
          cwd: this.deps.cwd,
          repoRoot: this.repoRoot,
          config: this.deps.config,
          loopHandlers: this.loopHandlers,
          ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
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
    const next = await (this.deps.open ?? openChatSession)({
      ...input,
      storage,
      resumeId: previous.meta.sessionId,
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
      ...(this.toolProviders ? { toolProviders: this.toolProviders } : {}),
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
    const target = { mode: input.mode ?? from.mode, model: input.model ?? from.model };
    if (target.mode === from.mode && target.model === from.model) return;
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

  async send(message: string, onEvent: (event: SessionEvent) => void): Promise<void> {
    const handle = this.requireHandle();
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
    let meta: SessionMeta;
    try {
      meta = await runChatTurn({
        handle,
        storage: this.deps.storage,
        message,
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
    const { session } = this.requireHandle();
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
    const sessions = await this.allSessions();
    return Promise.all(
      sessions.map(async ({ sessionId, title, updatedAt }) => {
        const holder = await this.deps.storage.readLockHolder(sessionId);
        return { sessionId, title, updatedAt, ...(holder?.state === "live" ? { heldByPid: holder.pid } : {}) };
      }),
    );
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.fallback.dispose();
    // Leave asks intact while the shell is mounted; final close cannot reuse them.
    this.closing = this.teardown();
    return this.closing;
  }

  private async teardown(): Promise<void> {
    // closed blocks new operations. Drain existing opens, replacements and rollback
    // reopens (including late-handle cleanup) before releasing the final handle.
    await Promise.all(this.sessionOperations);
    try {
      await this.runs?.closeAll();
    } finally {
      await this.closeSessionAndResources();
    }
  }

  private async closeSessionAndResources(): Promise<void> {
    try {
      if (this.handle) await closeHandle(this.handle);
    } finally {
      try {
        await this.deps.resources?.teardown();
      } finally {
        await this.deps.chain?.destroy();
      }
    }
  }
}

/** Headless composition root: one handler set, ask controller, fallback and process ledger. */
export function createChatHost(deps: ChatHostDeps): ChatHost {
  return new NativeChatHost(deps);
}
