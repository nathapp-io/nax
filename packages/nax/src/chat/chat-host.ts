import type { SandboxState, SessionEvent, SessionMeta, SessionStorage } from "@nathapp/nax-agent";
import { getProjectKey, type NaxConfig } from "@/config";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { NaxError } from "@/errors";
import type { InteractionChain } from "@/interaction";
import type { Logger } from "@/logger";
import { projectOutputDir } from "@/runtime";
import { type ChatAskController, createChatAskController } from "./ask-controller";
import { type AskFallback, createAskFallback } from "./ask-fallback";
import { type ChatLedger, createChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import { type ChatSessionHandle, openChatSession } from "./open-chat-session";
import { runChatTurn } from "./turn-runner";

const DEFAULT_CHAT_ASK_FALLBACK_MS = 60_000;

export interface ChatHostState {
  readonly sessionId: string;
  readonly mode: ChatMode;
  readonly model: string;
  readonly meta: SessionMeta;
  readonly sandbox?: SandboxState;
}

export interface ChatSessionRow {
  readonly sessionId: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
  readonly heldByPid?: number;
}

/** Resume, notice and transactional switches are added by US-011. */
export interface ChatHost {
  readonly repoRoot: string;
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  current(): ChatHostState;
  start(input: { mode: ChatMode; model: string }): Promise<void>;
  clear(): Promise<void>;
  send(message: string, onEvent: (event: SessionEvent) => void): Promise<void>;
  cancel(): void;
  listSessions(): Promise<readonly ChatSessionRow[]>;
  close(): Promise<void>;
}

export interface ChatHostDeps {
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly chain: InteractionChain | null;
  readonly open?: typeof openChatSession;
  readonly storage: SessionStorage;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

function nativeModels(config: NaxConfig): readonly string[] {
  const tiers = config.models.native;
  const models = (["fast", "balanced", "powerful"] as const).flatMap((tier) => {
    const entry = tiers?.[tier];
    return entry === undefined ? [] : [typeof entry === "string" ? entry : `${entry.provider}/${entry.model}`];
  });
  return Object.freeze([...new Set(models)]);
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
  readonly models: readonly string[];
  readonly asks: ChatAskController;
  private readonly fallback: AskFallback;
  private readonly loopHandlers: ReturnType<typeof createRuleDeliveryHandlers>;
  private readonly projectKey: string;
  private readonly outputDir: string;
  private handle?: ChatSessionHandle;
  private ledger?: ChatLedger;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly deps: ChatHostDeps) {
    this.repoRoot = deps.repoRoot;
    this.models = nativeModels(deps.config);
    this.projectKey = getProjectKey(deps.config, deps.repoRoot);
    this.outputDir = projectOutputDir(this.projectKey, deps.config.outputDir);
    const rules = deps.config.context.rules;
    this.loopHandlers = createRuleDeliveryHandlers({
      repoRoot: deps.repoRoot,
      overrideDir: rules?.overrideDir,
      overrideMode: rules?.overrideMode,
    });
    this.asks = createChatAskController({
      mode: "guarded",
      answer: (id, reply) => {
        this.requireHandle().session.answer(id, reply);
      },
    });
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
    const { session, meta } = this.requireHandle();
    return {
      sessionId: meta.sessionId,
      mode: meta.mode === "full" ? "full" : "guarded",
      model: meta.model,
      meta,
      ...(session.backend.sandbox === undefined ? {} : { sandbox: session.backend.sandbox }),
    };
  }

  async start(input: { mode: ChatMode; model: string }): Promise<void> {
    this.assertOpen();
    const next = await (this.deps.open ?? openChatSession)({
      ...input,
      storage: this.deps.storage,
      cwd: this.deps.cwd,
      repoRoot: this.repoRoot,
      config: this.deps.config,
      loopHandlers: this.loopHandlers,
    });
    // An open that completes after final teardown must not leak its new lock.
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
    this.asks.setMode(input.mode);
    if (previous) await closeHandle(previous);
  }

  async clear(): Promise<void> {
    const { mode, model } = this.current();
    await this.start({ mode, model });
  }

  async send(message: string, onEvent: (event: SessionEvent) => void): Promise<void> {
    const handle = this.requireHandle();
    const ledger = this.ledger;
    if (!ledger) throw new NaxError("[chat] ledger is not initialized", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
    const meta = await runChatTurn({
      handle,
      storage: this.deps.storage,
      message,
      asks: this.asks,
      ledger,
      onEvent,
      now: this.deps.now().toISOString(),
    });
    if (this.handle === handle) this.handle = { ...handle, meta };
  }

  cancel(): void {
    this.requireHandle().session.cancel();
  }

  async listSessions(): Promise<readonly ChatSessionRow[]> {
    const { sessions } = await this.deps.storage.list({ cwd: this.deps.cwd });
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
    this.asks.reset();
    this.closing = this.teardown();
    return this.closing;
  }

  private async teardown(): Promise<void> {
    try {
      if (this.handle) await closeHandle(this.handle);
    } finally {
      await this.deps.chain?.destroy();
    }
  }
}

/** Headless composition root: one handler set, ask controller, fallback and process ledger. */
export function createChatHost(deps: ChatHostDeps): ChatHost {
  return new NativeChatHost(deps);
}
