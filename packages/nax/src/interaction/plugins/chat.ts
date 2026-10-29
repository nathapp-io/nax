import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import { CHAT_ASK_POLL_MS, readChatAnswer, writeChatAsk, writeChatNotice, writeChatSettled } from "../chat-ask-files";
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
  /** Already initialized by the caller; fallback racing is implemented separately. */
  readonly fallback?: InteractionPlugin;
  readonly fallbackDelayMs?: number;
  readonly logger?: Pick<Logger, "warn">;
}

interface PendingAsk {
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
      return;
    }
    const key = await writeChatAsk(dir, request, new Date(askedAt), secret);
    this.pending.set(request.id, { key, askedAt, active: true });
  }

  async receive(requestId: string, timeout = DEFAULT_TIMEOUT_MS): Promise<InteractionResponse> {
    const ask = this.pending.get(requestId);
    if (!ask) {
      throw new NaxError(`[chat-asks] Unknown request ${requestId}`, "INTERACTION_ERROR", {
        stage: "interaction",
        requestId,
      });
    }
    if (ask.response) return ask.response;
    ask.response = new Promise((resolve, reject) => {
      ask.resolve = resolve;
      ask.reject = reject;
    });
    ask.deadlineTimer = _chatAskPluginDeps.setTimeout(
      () => {
        void this.settle(requestId, ask, this.skip(requestId, "timeout"));
      },
      Math.max(0, ask.askedAt + timeout - _chatAskPluginDeps.now()),
    );
    this.schedulePoll(requestId, ask);
    return ask.response;
  }

  private schedulePoll(requestId: string, ask: PendingAsk): void {
    if (!ask.active) return;
    ask.pollTimer = _chatAskPluginDeps.setTimeout(() => {
      void this.poll(requestId, ask);
    }, CHAT_ASK_POLL_MS);
  }

  private async poll(requestId: string, ask: PendingAsk): Promise<void> {
    try {
      const answer = await readChatAnswer(this.options.dir, ask.key, this.options.secret);
      if (!ask.active) return;
      if (answer) {
        await this.settle(requestId, ask, {
          requestId,
          action: answer.action,
          value: answer.value,
          respondedBy: answer.respondedBy,
          respondedAt: typeof answer.respondedAt === "string" ? Date.parse(answer.respondedAt) : answer.respondedAt,
        });
      } else {
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
    ask.settling = this.writeSettlement(ask, response).then(
      () => {
        this.pending.delete(requestId);
        ask.resolve?.(response);
      },
      (cause: unknown) => {
        this.pending.delete(requestId);
        ask.reject?.(cause);
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
        by: response.respondedBy ?? "timeout",
        action: response.action,
        value: response.value,
        settledAt: new Date(_chatAskPluginDeps.now()).toISOString(),
      },
      this.options.secret,
    );
  }

  async cancel(requestId: string): Promise<void> {
    const ask = this.pending.get(requestId);
    if (ask) await this.settle(requestId, ask, this.skip(requestId, "cancelled"));
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((requestId) => this.cancel(requestId)));
  }
}
