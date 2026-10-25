import { errorMessage } from "@nathapp/nax-agent/internal";
import type { InteractionChain } from "../interaction";
import type { Logger } from "../logger";
import type { ChatApproval, ChatAskController } from "./ask-controller";

export const _askFallbackDeps = {
  // Cancellable: every handle is cleared when its ask leaves pending() or on dispose().
  setTimeout: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
};

export interface AskFallbackOptions {
  controller: ChatAskController;
  /** Null for an unavailable chain, including the headless CLI plugin. */
  chain: Pick<InteractionChain, "prompt" | "cancel"> | null;
  delayMs: number;
  logger: Pick<Logger, "warn">;
}

export interface AskFallback {
  dispose(): void;
}

interface Offer {
  event: ChatApproval;
  timer?: ReturnType<typeof _askFallbackDeps.setTimeout>;
  inFlight: boolean;
}

class PendingAskFallback implements AskFallback {
  private readonly offers = new Map<string, Offer>();
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: AskFallbackOptions) {
    this.unsubscribe = options.controller.onChange(() => this.sync());
    this.sync();
  }

  private warn = (err: unknown): void => {
    this.options.logger.warn("chat", "chat ask fallback failed", { error: errorMessage(err) });
  };

  private current(offer: Offer): boolean {
    return (
      !this.disposed &&
      this.offers.get(offer.event.requestId) === offer &&
      this.options.controller.pending().some((event) => event === offer.event)
    );
  }

  private remove(id: string, offer: Offer): void {
    this.offers.delete(id);
    if (offer.timer !== undefined) _askFallbackDeps.clearTimeout(offer.timer);
    if (offer.inFlight) {
      offer.inFlight = false;
      void this.options.chain?.cancel(`chat-${id}`).catch(this.warn);
    }
  }

  private async prompt(offer: Offer): Promise<void> {
    offer.timer = undefined;
    const { chain, controller } = this.options;
    if (!chain || !this.current(offer)) return;
    offer.inFlight = true;
    const event = offer.event;
    try {
      const response = await chain.prompt({
        id: `chat-${event.requestId}`,
        type: "confirm",
        featureName: "chat",
        stage: "custom",
        summary: event.summary,
        detail: event.command === undefined ? event.reason : `${event.command}\n${event.reason}`,
        fallback: "skip",
        createdAt: Date.now(),
      });
      offer.inFlight = false;
      if (!this.current(offer)) return;
      if (response.action === "approve") controller.resolve(event.requestId, "allow_once");
      else if (response.action === "reject" || response.action === "abort") controller.resolve(event.requestId, "deny");
    } catch (err) {
      offer.inFlight = false;
      this.warn(err);
    }
  }

  private sync(): void {
    const approvals = this.options.controller
      .pending()
      .filter((event): event is ChatApproval => event.type === "approval_requested");
    for (const [id, offer] of this.offers) {
      if (!approvals.includes(offer.event)) this.remove(id, offer);
    }
    if (!this.options.chain || this.disposed) return;
    for (const event of approvals) {
      if (this.offers.has(event.requestId)) continue;
      const offer: Offer = { event, inFlight: false };
      this.offers.set(event.requestId, offer);
      offer.timer = _askFallbackDeps.setTimeout(() => void this.prompt(offer), this.options.delayMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const [id, offer] of this.offers) this.remove(id, offer);
  }
}

/** One delayed offer per approval; the controller remains the sole answer authority. */
export function createAskFallback(options: AskFallbackOptions): AskFallback {
  return new PendingAskFallback(options);
}
