import type { AgentSession, SessionMeta, SessionStorage, ToolProvider } from "@nathapp/nax-agent";
import { errorMessage, extractWebUrls } from "@nathapp/nax-agent/internal";
import type { Logger } from "@/logger";
import type { HostQueue } from "./host-queue";
import { parseMentionMessage } from "./mentions";
import type { ChatWeb } from "./web/wiring";

/** Snapshot into the storage schema's mutable-array representation without sharing state. */
export function sessionWebSnapshot(web: ChatWeb | undefined, stored: SessionMeta["web"]): SessionMeta["web"] {
  if (web === undefined) return stored;
  const snapshot = web.exposure.snapshot();
  return { ...snapshot, seenUrls: [...snapshot.seenUrls] };
}

/**
 * The one recording rule for text a person typed (US-005): the URLs an entered message names
 * become seen, so a later `web__fetch` of one of them does not ask again.
 *
 * The rule lives here, not in the session wrapper, because the wrapper cannot tell a person's
 * text from text the model or the host composed: a background command's own `curl` line once
 * counted, and pre-approving a URL a model chose defeats the unseen-URL ask. Callers are the
 * host's typed entries alone — `send` without `automatic`, and an accepted `steer` — so the
 * mention envelope is parsed here too: only the typed text counts, never an attachment's body.
 */
export function recordTypedUrls(web: ChatWeb | undefined, message: string): void {
  if (web === undefined) return;
  web.exposure.recordUrls(extractWebUrls(parseMentionMessage(message)?.text ?? message));
}

/** Only the per-open provider list changes; the host resources remain untouched. */
export function sessionWebProviders(input: {
  readonly providers: readonly ToolProvider[] | undefined;
  readonly web?: ChatWeb;
  readonly acp: boolean;
  readonly logger: Pick<Logger, "warn">;
}): readonly ToolProvider[] | undefined {
  if (!input.web && !input.acp) return input.providers;
  const providers = input.providers ?? [];
  if (input.web && providers.some((provider) => provider.id === "web"))
    input.logger.warn("chat", "dropping conflicting provider web from this session", { providerId: "web" });
  return [...providers.filter((provider) => provider.id !== "web"), ...(input.web ? [input.web.provider] : [])];
}

function wrapWebSession(session: AgentSession, drain: () => Promise<void>): AgentSession {
  const send: AgentSession["send"] = (message, ...args) => {
    // Claim synchronously, before the wrapper's iterator or metadata queue is awaited. Recording
    // what the message names is the host's decision (US-005), never the wrapper's: this seam sees
    // model- and host-composed text too.
    const events = session.send(message, ...args);
    return (async function* () {
      try {
        for await (const event of events) {
          await drain();
          yield event;
        }
      } finally {
        await drain();
      }
    })();
  };
  // Keep getters and every optional lifecycle method, binding their receiver to the real facade.
  return new Proxy(session, {
    get(target, key) {
      if (key === "send") return send;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Per-open durability, sharing the host's turn/compaction serialization point. */
export function persistSessionWeb(input: {
  readonly web: ChatWeb;
  readonly storage: SessionStorage;
  readonly sessionId: string;
  readonly queue: HostQueue;
  readonly logger: Pick<Logger, "warn">;
}): { wrap(session: AgentSession): AgentSession; release(): Promise<void> } {
  const { web, storage, sessionId, queue, logger } = input;
  let pending: Promise<void> = Promise.resolve();
  let failed: { error: unknown } | undefined;
  const unsubscribe = web.exposure.onChange(() => {
    pending = queue.run(async () => {
      const stored = await storage.readMeta(sessionId);
      if (stored !== null) await storage.writeMeta({ ...stored, web: sessionWebSnapshot(web, stored.web) });
    });
    // The callback is synchronous; retain failures for send/release without an unhandled rejection.
    void pending.catch((error) => {
      failed = { error };
      logger.warn("chat", "web exposure metadata write failed", { sessionId, error: errorMessage(error) });
    });
  });
  async function drain(): Promise<void> {
    await pending;
    if (failed) throw failed.error;
  }
  return {
    wrap: (session) => wrapWebSession(session, drain),
    release: async () => {
      unsubscribe();
      await drain();
    },
  };
}
