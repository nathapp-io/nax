import type { TelegramInteractionPlugin } from "@/interaction/plugins/telegram";
import type { WebhookInteractionPlugin } from "@/interaction/plugins/webhook";

/**
 * Private surface of `TelegramInteractionPlugin` that
 * `interaction-network-failures.test.ts` drives directly. The cast is contained
 * here once instead of at every site — see #1514 §11 Group A.
 */
export type TelegramInternals = {
  getUpdates: () => Promise<unknown[]>;
  backoffMs: number;
};

export function telegramInternals(p: TelegramInteractionPlugin): TelegramInternals {
  return p as unknown as TelegramInternals;
}

/**
 * Private surface of `WebhookInteractionPlugin` that
 * `interaction-network-failures.test.ts` drives directly. The cast is contained
 * here once instead of at every site — see #1514 §11 Group A.
 */
export type WebhookInternals = {
  handleRequest: (req: Request) => Promise<Response>;
  startServer: () => Promise<void>;
  server: unknown;
  serverStartPromise: Promise<void> | null;
  pendingResponses: Map<string, unknown>;
  receiveCallbacks: Map<string, unknown>;
  receiveTimers: Map<string, unknown>;
  registeredRequestIds: Set<string>;
};

export function webhookInternals(p: WebhookInteractionPlugin): WebhookInternals {
  return p as unknown as WebhookInternals;
}
