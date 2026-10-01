import type { CLIInteractionPlugin, CLIReadline } from "@/interaction/plugins/cli";
import type { TelegramInteractionPlugin } from "@/interaction/plugins/telegram";
import type { WebhookInteractionPlugin } from "@/interaction/plugins/webhook";
import type { InteractionRequest, InteractionResponse } from "@/interaction/types";

/**
 * Private surface of `TelegramInteractionPlugin` that
 * `interaction-network-failures.test.ts` drives directly. TypeScript's `private`
 * is compile-time only and element access (`p["_x"]`) is its sanctioned way
 * through it, so this live view reaches the real fields with no assertion —
 * see #1514 §11 Group A for why the reach is contained here once. *
 * `biome.json` turns off `complexity/useLiteralKeys` for `test/helpers/*-internals.ts`:
 * the rule wants `p.field`, but element access is precisely what makes a
 * `private` member reachable, so its "fix" would not compile. Biome marks that
 * fix unsafe for the same reason.
 */
export type TelegramInternals = {
  getUpdates: () => Promise<unknown[]>;
  backoffMs: number;
};

export function telegramInternals(p: TelegramInteractionPlugin): TelegramInternals {
  return {
    get getUpdates() {
      return p["getUpdates"];
    },
    get backoffMs() {
      return p["backoffMs"];
    },
    set backoffMs(ms) {
      p["backoffMs"] = ms;
    },
  };
}

/**
 * Private surface of `WebhookInteractionPlugin` that
 * `interaction-network-failures.test.ts` drives directly. Same live-view shape
 * as {@link telegramInternals} — element access, no assertion.
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
  return {
    get handleRequest() {
      return p["handleRequest"];
    },
    get startServer() {
      return p["startServer"];
    },
    get server() {
      return p["server"];
    },
    get serverStartPromise() {
      return p["serverStartPromise"];
    },
    set serverStartPromise(promise) {
      p["serverStartPromise"] = promise;
    },
    get pendingResponses() {
      return p["pendingResponses"];
    },
    get receiveCallbacks() {
      return p["receiveCallbacks"];
    },
    get receiveTimers() {
      return p["receiveTimers"];
    },
    get registeredRequestIds() {
      return p["registeredRequestIds"];
    },
  };
}

/**
 * Private surface of `CLIInteractionPlugin` that `plugins/cli.test.ts` drives
 * directly: the readline slot the timeout path recreates, and the prompt entry
 * point that races user input against the timer. Same live-view shape as
 * {@link telegramInternals} — element access, no assertion.
 */
export type CLIInternals = {
  rl: CLIReadline | null;
  promptUser: (request: InteractionRequest, timeout: number) => Promise<InteractionResponse>;
};

export function cliInternals(p: CLIInteractionPlugin): CLIInternals {
  return {
    get rl() {
      return p["rl"];
    },
    set rl(next) {
      p["rl"] = next;
    },
    get promptUser() {
      return p["promptUser"].bind(p);
    },
  };
}
