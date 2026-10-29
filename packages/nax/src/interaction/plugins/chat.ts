import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getSafeLogger, type Logger } from "@/logger";
import {
  CHAT_ASK_POLL_MS,
  type ChatAnswer,
  chatAskKey,
  chatHeartbeatFresh,
  discardChatAgentAnswer,
  readChatAnswer,
  writeChatAsk,
  writeChatNotice,
  writeChatSettled,
} from "../chat-ask-files";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

const DEFAULT_FALLBACK_DELAY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
type TimerHandle = ReturnType<typeof setTimeout> | number;

export const _chatAskPluginDeps = {
  now: (): number => Date.now(),
  // Cancellable handles are required: settlement and teardown stop both timers.
  setTimeout: (callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms),
  clearTimeout: (handle: TimerHandle | undefined): void => clearTimeout(handle),
};

export interface ChatAskPluginOptions {
  readonly dir: string;
  readonly secret: Uint8Array;
  /** Already initialized by the caller. */
  readonly fallback?: InteractionPlugin;
  readonly fallbackDelayMs?: number;
  readonly logger?: Pick<Logger, "warn">;
}

interface PendingAsk {
  request: InteractionRequest;
  chatUnavailable: boolean;
  fallbackSend?: Promise<boolean>;
  fallbackReceiving?: boolean;
  fallbackWon?: boolean;
  deadline?: number;
  humanOnly: boolean;
  warnedInvalid: boolean;
  cancelled?: boolean;
  key: string;
  askedAt: number;
  active: boolean;
  pollTimer?: TimerHandle;
  deadlineTimer?: TimerHandle;
  response?: Promise<InteractionResponse>;
  resolve?: (response: InteractionResponse) => void;
  reject?: (cause: unknown) => void;
  settling?: Promise<void>;
}

/** Child-side authenticated direct chat transport. No chain initialization is needed. */
export class ChatAskPlugin implements InteractionPlugin {
  readonly name = "chat";
  readonly fallbackDelayMs: number;
  private readonly pending = new Map<string, PendingAsk>();

  constructor(private readonly options: ChatAskPluginOptions) {
    this.fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
  }

  async send(request: InteractionRequest): Promise<void> {
    const askedAt = _chatAskPluginDeps.now();
    const { dir, secret } = this.options;
    if (request.type === "notify") {
      await writeChatNotice(dir, request, new Date(askedAt), secret);
      if (this.options.fallback && !(await chatHeartbeatFresh(dir, _chatAskPluginDeps.now()))) {
        await this.sendFallback(request);
      }
      return;
    }
    let chatUnavailable = false;
    const key = chatAskKey(request.id);
    try {
      await writeChatAsk(dir, request, new Date(askedAt), secret);
    } catch (cause) {
      if (!this.options.fallback) throw cause;
      chatUnavailable = true;
      this.warn(request.id, "Ask write failed; using fallback", cause);
    }
    const metadata = request.metadata;
    const humanOnly =
      metadata?.safety === "red" || metadata?.trigger === "pre-merge" || metadata?.trigger === "human-review";
    const ask: PendingAsk = { request, key, askedAt, chatUnavailable, active: true, humanOnly, warnedInvalid: false };
    this.pending.set(request.id, ask);
    if (this.options.fallback && (chatUnavailable || !(await chatHeartbeatFresh(dir, _chatAskPluginDeps.now())))) {
      await this.startFallbackSend(ask);
    }
  }

  private warn(requestId: string, message: string, cause: unknown): void {
    (this.options.logger ?? getSafeLogger())?.warn("chat-asks", `[chat-asks] ${message}`, {
      requestId,
      error: errorMessage(cause),
    });
  }

  private async sendFallback(request: InteractionRequest): Promise<boolean> {
    try {
      await this.options.fallback?.send(request);
      return true;
    } catch (cause) {
      this.warn(request.id, "Fallback send failed", cause);
      return false;
    }
  }

  private startFallbackSend(ask: PendingAsk): Promise<boolean> {
    ask.fallbackSend ??= this.sendFallback(ask.request).then((sent) => {
      if (sent && !ask.active) this.cancelFallback(ask);
      return sent;
    });
    return ask.fallbackSend;
  }

  private cancelFallback(ask: PendingAsk): void {
    void this.options.fallback?.cancel?.(ask.request.id).catch((cause: unknown) => {
      this.warn(ask.request.id, "Fallback cancel failed", cause);
    });
  }

  private async receiveFallback(ask: PendingAsk): Promise<void> {
    if (!this.options.fallback || ask.fallbackReceiving || !ask.active) return;
    ask.fallbackReceiving = true;
    if (!(await this.startFallbackSend(ask)) || !ask.active) return;
    const remaining = Math.max(0, (ask.deadline ?? _chatAskPluginDeps.now()) - _chatAskPluginDeps.now());
    if (remaining === 0) return;
    try {
      const response = await this.options.fallback.receive(ask.request.id, remaining);
      if (!ask.active || ["timeout", "destroyed", "superseded"].includes(response.respondedBy ?? "")) return;
      if (_chatAskPluginDeps.now() >= (ask.deadline ?? 0)) return;
      ask.fallbackWon = true;
      await this.settle(ask.request.id, ask, response);
    } catch (cause) {
      this.warn(ask.request.id, "Fallback receive failed", cause);
    }
  }

  async receive(requestId: string, timeout = DEFAULT_TIMEOUT_MS): Promise<InteractionResponse> {
    const ask = this.pending.get(requestId);
    if (!ask) {
      throw new NaxError(`[chat-asks] Unknown request ${requestId}`, "CHAT_ASK_UNKNOWN", {
        stage: "interaction",
        requestId,
      });
    }
    if (ask.response) return ask.response;
    ask.response = new Promise((resolve, reject) => {
      ask.resolve = resolve;
      ask.reject = reject;
    });
    ask.deadline = ask.askedAt + timeout;
    if (ask.fallbackSend) void this.receiveFallback(ask);
    ask.deadlineTimer = _chatAskPluginDeps.setTimeout(
      () => {
        void this.settle(requestId, ask, this.skip(requestId, "timeout"));
      },
      Math.max(0, ask.askedAt + timeout - _chatAskPluginDeps.now()),
    );
    if (!ask.chatUnavailable) this.schedulePoll(requestId, ask);
    return ask.response;
  }

  private schedulePoll(requestId: string, ask: PendingAsk): void {
    if (!ask.active) return;
    ask.pollTimer = _chatAskPluginDeps.setTimeout(() => {
      void this.poll(requestId, ask);
    }, CHAT_ASK_POLL_MS);
  }

  private async readAnswer(requestId: string, ask: PendingAsk): Promise<ChatAnswer | undefined> {
    const answer = await readChatAnswer(this.options.dir, ask.key, this.options.secret, () => {
      if (ask.warnedInvalid || !ask.active) return;
      ask.warnedInvalid = true;
      (this.options.logger ?? getSafeLogger())?.warn("chat-asks", "[chat-asks] Ignoring malformed answer", {
        requestId,
        key: ask.key,
      });
    });
    if (ask.active && answer?.respondedBy === "chat-agent" && ask.humanOnly) {
      await discardChatAgentAnswer(this.options.dir, ask.key, this.options.secret);
      return undefined;
    }
    return answer;
  }

  private async poll(requestId: string, ask: PendingAsk): Promise<void> {
    try {
      const answer = await this.readAnswer(requestId, ask);
      if (!ask.active) return;
      if (answer) {
        await this.settle(requestId, ask, {
          requestId,
          action: answer.action,
          value: answer.respondedBy === "chat-agent" && answer.value === "allow-remember" ? "allow" : answer.value,
          respondedBy: answer.respondedBy,
          respondedAt: typeof answer.respondedAt === "string" ? Date.parse(answer.respondedAt) : answer.respondedAt,
        });
      } else {
        if (
          this.options.fallback &&
          !ask.fallbackReceiving &&
          (_chatAskPluginDeps.now() - ask.askedAt >= this.fallbackDelayMs ||
            !(await chatHeartbeatFresh(this.options.dir, _chatAskPluginDeps.now())))
        ) {
          void this.receiveFallback(ask);
        }
        this.schedulePoll(requestId, ask);
      }
    } catch (cause) {
      if (!ask.active) return;
      ask.active = false;
      this.clearTimers(ask);
      this.pending.delete(requestId);
      ask.reject?.(cause);
    }
  }

  private clearTimers(ask: PendingAsk): void {
    _chatAskPluginDeps.clearTimeout(ask.pollTimer);
    _chatAskPluginDeps.clearTimeout(ask.deadlineTimer);
  }

  private skip(requestId: string, respondedBy: string): InteractionResponse {
    return { requestId, action: "skip", respondedBy, respondedAt: _chatAskPluginDeps.now() };
  }

  private settle(requestId: string, ask: PendingAsk, response: InteractionResponse): Promise<void> {
    if (ask.settling !== undefined) return ask.settling;
    ask.active = false;
    this.clearTimers(ask);
    if (ask.fallbackSend && !ask.fallbackWon) this.cancelFallback(ask);
    ask.settling = this.writeSettlement(ask, response).then(
      () => {
        this.pending.delete(requestId);
        ask.resolve?.(response);
      },
      (cause: unknown) => {
        this.pending.delete(requestId);
        this.warn(requestId, "Settlement publication failed; preserving selected response", cause);
        ask.resolve?.(response);
      },
    );
    return ask.settling;
  }

  private async writeSettlement(ask: PendingAsk, response: InteractionResponse): Promise<void> {
    await writeChatSettled(
      this.options.dir,
      ask.key,
      {
        requestId: response.requestId,
        by: ask.cancelled ? "cancelled" : (response.respondedBy ?? "timeout"),
        action: response.action,
        value: response.value,
        settledAt: new Date(_chatAskPluginDeps.now()).toISOString(),
      },
      this.options.secret,
    );
  }

  async cancel(requestId: string): Promise<void> {
    const ask = this.pending.get(requestId);
    if (ask?.active) {
      ask.cancelled = true;
      await this.settle(requestId, ask, this.skip(requestId, "timeout"));
    } else if (ask?.settling) {
      await ask.settling;
    }
  }

  async destroy(): Promise<void> {
    try {
      await Promise.all([...this.pending.keys()].map((requestId) => this.cancel(requestId)));
    } finally {
      await this.options.fallback?.destroy?.();
    }
  }
}
