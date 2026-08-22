/**
 * Telegram Interaction Plugin (v0.15.0 US-005)
 *
 * Send interaction requests via Telegram Bot API with inline keyboard.
 * Poll for callback query or reply message responses.
 */

import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";
import { TelegramConfigSchema, type TelegramMessage, type TelegramUpdate, normalizeChatId } from "./telegram-config";
import {
  MAX_MESSAGE_CHARS,
  buildBody,
  buildHeader,
  buildKeyboard,
  splitText,
  truncateIdForCallbackData,
} from "./telegram-format";

/**
 * Injectable dependencies for testing.
 * Mirrors _webhookPluginDeps in the sibling webhook plugin — tests stub this
 * rather than monkey-patching globalThis.fetch, which leaks across test files.
 */
export const _telegramPluginDeps = {
  fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
  /**
   * Base interval between getUpdates polls, and the value the exponential
   * backoff resets to on success. Injectable so poll-loop tests can exercise
   * multi-poll behaviour without burning seconds of wall-clock per test.
   */
  basePollBackoffMs: 1000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const CALLBACK_API_TIMEOUT_MS = 4000;

interface PendingReceiver {
  resolve: (response: InteractionResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface BufferedResponse {
  response: InteractionResponse;
  update: TelegramUpdate;
}

/**
 * Telegram plugin for remote interaction via Telegram Bot API
 */
export class TelegramInteractionPlugin implements InteractionPlugin {
  name = "telegram";
  private readonly logger = getSafeLogger();
  private botToken: string | null = null;
  private chatId: string | null = null;
  // requestId -> { type of the request (gates which update kinds count as an answer), sent message ids }
  private pendingMessages = new Map<string, { type: InteractionRequest["type"]; ids: number[] }>();
  private pendingReceivers = new Map<string, PendingReceiver>();
  private bufferedResponses = new Map<string, BufferedResponse>();
  private poller: Promise<void> | null = null;
  private lastUpdateId = 0;
  // Exponential backoff for getUpdates (starts at the injectable base, 1s in production)
  private backoffMs = _telegramPluginDeps.basePollBackoffMs;
  private readonly maxBackoffMs = 30000; // Max 30 seconds between retries

  /** Bound on how many getUpdates() pages drainBacklog() will consume before giving up. */
  private static readonly MAX_DRAIN_PAGES = 10;

  private static readonly INTERACTIVE_REQUEST_TYPES = new Set<InteractionRequest["type"]>([
    "confirm",
    "choose",
    "input",
    "review",
  ]);

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = TelegramConfigSchema.parse(config);
    this.botToken = cfg.botToken ?? process.env.NAX_TELEGRAM_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    const rawChatId = cfg.chatId ?? process.env.NAX_TELEGRAM_CHAT_ID ?? null;
    // Normalize before the emptiness check so an all-whitespace chatId is
    // treated as absent rather than as a configured value that matches nothing.
    const normalized = rawChatId === null ? null : normalizeChatId(rawChatId);
    this.chatId = normalized?.chatId || null;

    if (!this.botToken || !this.chatId) {
      throw new Error(
        "Telegram plugin requires botToken and chatId (env: NAX_TELEGRAM_TOKEN or TELEGRAM_BOT_TOKEN, NAX_TELEGRAM_CHAT_ID)",
      );
    }

    // Loud at startup beats silent at prompt time: with an unmatchable chatId the
    // prompt still posts and simply never accepts an answer. Warn rather than
    // throw — notify-only usage against an @channelusername never needs a reply.
    if (normalized?.unmatchable) {
      this.logger?.warn(
        "interaction",
        "Telegram chatId is not numeric — inbound updates cannot be matched, so interactive prompts will always fall back to their timeout. Use the numeric chat id (see getUpdates or @userinfobot).",
        { chatId: this.chatId },
      );
    }
    // No network call here — the backlog is drained immediately before each prompt is
    // posted (see send()), not at startup. Interactions can fire minutes into a run,
    // so draining once at init() would still leave a wide window for stale updates to
    // accumulate; draining right before send() shrinks that window to one round-trip
    // and avoids paying a Telegram round-trip on every run that never prompts at all.
  }

  /**
   * Advance lastUpdateId past any updates already queued, without processing them.
   * Pages through getUpdates() (bounded by MAX_DRAIN_PAGES) since a single call only
   * returns one page (Telegram default limit: 100) and a larger backlog would
   * otherwise leave older updates unconsumed. Prevents stale/unrelated updates from
   * being misread as the response to the next interaction request.
   */
  private async drainBacklog(): Promise<void> {
    for (let page = 0; page < TelegramInteractionPlugin.MAX_DRAIN_PAGES; page++) {
      const result = await this.fetchUpdates();
      if (!result.ok) {
        this.logger?.warn("interaction", "Telegram backlog drain failed — stale updates may be misread as a response");
        return;
      }
      // Terminate on the RAW page size, not the authorized one. A page filled
      // entirely with foreign traffic filters down to nothing while Telegram
      // still has pages left; stopping there would leave genuine stale updates
      // from the configured chat unconsumed, which is exactly what the drain
      // exists to prevent.
      if (result.rawCount === 0) return;
    }
    this.logger?.warn("interaction", "Telegram backlog drain hit page cap — stale updates may remain", {
      pages: TelegramInteractionPlugin.MAX_DRAIN_PAGES,
    });
  }

  async destroy(): Promise<void> {
    for (const requestId of this.pendingReceivers.keys()) this.resolveReceiver(requestId, "skip", "timeout");
    this.pendingMessages.clear();
    this.bufferedResponses.clear();
  }

  async send(request: InteractionRequest): Promise<void> {
    if (!this.botToken || !this.chatId) {
      throw new Error("Telegram plugin not initialized");
    }

    // Drain any backlog immediately before posting this prompt so an update that
    // predates it (stray chat message, old button tap) can never be picked up by
    // receive() as the answer. Only interactive types ever wait for a response, so
    // fire-and-forget notify/webhook sends skip the round-trip.
    if (TelegramInteractionPlugin.INTERACTIVE_REQUEST_TYPES.has(request.type) && this.pendingReceivers.size === 0) {
      await this.drainBacklog();
    }

    const header = buildHeader(request);
    // buildKeyboard rejects an id that can't round-trip the callback_data
    // grammar. Don't let that escape: InteractionChain has a fallback cascade
    // on receive() but none on send(), so throwing here aborts the run where
    // every other interaction failure degrades to the request's `fallback`.
    // Post without buttons — loud in the log, still resolvable via fallback.
    let keyboard: ReturnType<typeof buildKeyboard> = null;
    try {
      keyboard = buildKeyboard(request);
    } catch (err) {
      this.logger?.error("interaction", "Cannot build Telegram keyboard — sending prompt without buttons", {
        requestId: request.id,
        error: errorMessage(err),
      });
    }
    const body = buildBody(request);

    // Split body into chunks that fit within Telegram's 4000-char limit.
    // Header is prepended to the first chunk; subsequent chunks get a part label.
    const chunks = splitText(body, MAX_MESSAGE_CHARS - header.length - 10); // 10 = buffer for part label

    try {
      const sentIds: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const partLabel = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
        const text = `${header}\n${partLabel}${chunks[i]}`;

        // BUG-7: client-side timeout guards against network hangs. sendMessage is
        // the one Telegram call that previously lacked an AbortController — the
        // other calls (getUpdates/answerCallbackQuery/clearInlineKeyboard/
        // sendTimeoutMessage) all use 4-8s timers. A wedged TCP connection at
        // prompt time stalled the entire run before this fix.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        let response: Response;
        try {
          response = await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: this.chatId,
              text,
              reply_markup: isLast && keyboard ? { inline_keyboard: keyboard } : undefined,
              parse_mode: "Markdown",
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`Telegram API error (${response.status}): ${errorBody || response.statusText}`);
        }

        const data = (await response.json()) as { ok: boolean; result: TelegramMessage };
        if (!data.ok) {
          throw new Error(`Telegram API returned ok=false: ${JSON.stringify(data)}`);
        }

        sentIds.push(data.result.message_id);
      }

      // Store sent message IDs only for interactive requests that can receive a reply/callback.
      if (TelegramInteractionPlugin.INTERACTIVE_REQUEST_TYPES.has(request.type)) {
        this.pendingMessages.set(request.id, { type: request.type, ids: sentIds });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send Telegram message: ${msg}`);
    }
  }

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
    if (!this.botToken || !this.chatId) {
      throw new Error("Telegram plugin not initialized");
    }

    return new Promise<InteractionResponse>((resolve) => {
      const timeoutId = setTimeout(() => void this.expireReceiver(requestId), timeout);
      this.pendingReceivers.set(requestId, { resolve, timeoutId });
      const buffered = this.bufferedResponses.get(requestId);
      if (buffered) {
        this.bufferedResponses.delete(requestId);
        this.completeReceiver(requestId, buffered.response, buffered.update);
        return;
      }
      this.ensurePoller();
    });
  }

  async cancel(requestId: string): Promise<void> {
    const pending = this.pendingMessages.get(requestId);
    this.resolveReceiver(requestId, "skip", "timeout");
    void this.sendTimeoutMessage(requestId, pending);
  }

  private ensurePoller(): void {
    if (this.poller) return;
    this.poller = this.runPoller().finally(() => {
      this.poller = null;
      if (this.pendingReceivers.size > 0) this.ensurePoller();
    });
  }

  private async runPoller(): Promise<void> {
    while (this.pendingReceivers.size > 0) {
      this.dispatchUpdates(await this.getUpdates());
      if (this.pendingReceivers.size > 0) await _telegramPluginDeps.sleep(this.backoffMs);
    }
  }

  private dispatchUpdates(updates: TelegramUpdate[]): void {
    for (const update of updates) {
      if (update.callback_query) void this.answerCallbackQuery(update.callback_query.id);
      let matched = false;
      for (const requestId of this.pendingMessages.keys()) {
        const response = this.parseUpdate(requestId, update);
        if (!response) continue;
        if (this.pendingReceivers.has(requestId)) this.completeReceiver(requestId, response, update);
        else this.bufferedResponses.set(requestId, { response, update });
        matched = true;
        break;
      }
      if (!matched && update.callback_query) this.logIgnoredCallback(update);
    }
  }

  private completeReceiver(requestId: string, response: InteractionResponse, update: TelegramUpdate): void {
    if (update.callback_query) {
      this.logger?.debug("interaction", "Telegram callback matched", {
        requestId,
        updateId: update.update_id,
        action: response.action,
        value: response.value,
      });
    }
    const messageId = update.callback_query?.message?.message_id;
    if (messageId !== undefined) void this.clearInlineKeyboard(messageId);
    this.resolveReceiverWithResponse(requestId, response);
    this.backoffMs = _telegramPluginDeps.basePollBackoffMs;
  }

  private logIgnoredCallback(update: TelegramUpdate): void {
    this.logger?.debug("interaction", "Telegram callback ignored (stale/mismatched)", {
      updateId: update.update_id,
      callbackData: update.callback_query?.data,
    });
  }

  private async expireReceiver(requestId: string): Promise<void> {
    // Snapshot the pending message before resolving clears it out of
    // pendingMessages, then resolve immediately — a hung network must not
    // delay the interaction result past the configured deadline. The edit
    // below is fire-and-forget best-effort cleanup.
    const pending = this.pendingMessages.get(requestId);
    this.resolveReceiver(requestId, "skip", "timeout");
    void this.sendTimeoutMessage(requestId, pending);
  }

  private resolveReceiver(requestId: string, action: InteractionResponse["action"], respondedBy: string): void {
    this.resolveReceiverWithResponse(requestId, { requestId, action, respondedBy, respondedAt: Date.now() });
  }

  private resolveReceiverWithResponse(requestId: string, response: InteractionResponse): void {
    const receiver = this.pendingReceivers.get(requestId);
    if (!receiver) return;
    clearTimeout(receiver.timeoutId);
    this.pendingReceivers.delete(requestId);
    this.pendingMessages.delete(requestId);
    this.bufferedResponses.delete(requestId);
    receiver.resolve(response);
  }

  /**
   * Get updates from Telegram Bot API with exponential backoff on failure.
   * Failures are swallowed (returns []) so the receive() poll loop can retry —
   * callers that need to distinguish "no updates" from "the fetch failed" use
   * fetchUpdates() directly (e.g. drainBacklog(), to avoid silently no-op'ing).
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.fetchUpdates();
    return result.updates;
  }

  /**
   * Core getUpdates() implementation reporting success/failure explicitly.
   * Mutates lastUpdateId/backoffMs the same way regardless of caller.
   *
   * `rawCount` is the page size BEFORE chat-id filtering. drainBacklog() needs it
   * to tell "Telegram has nothing left" apart from "nothing on this page was ours".
   */
  private async fetchUpdates(): Promise<{ ok: boolean; updates: TelegramUpdate[]; rawCount: number }> {
    if (!this.botToken) return { ok: true, updates: [], rawCount: 0 };

    try {
      // Client-side timeout guards against network hangs (no OS TCP timeout = 75s+ stall)
      // With short-polling timeout:1, server responds in ~1s. 8s client timeout is safe headroom.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      let response: Response;
      try {
        response = await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 1, // Short polling — server holds connection up to 1s
            limit: 100, // Explicit: matches Telegram's default page size, made visible at the call site
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`Telegram getUpdates error (${response.status}): ${errorBody || response.statusText}`);
      }

      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (!data.ok || !data.result) {
        throw new Error("Telegram API returned ok=false or missing result");
      }

      const raw = data.result;
      // Advance the offset from the RAW result, before filtering. Foreign updates
      // must still be consumed -- filtering first would park the offset behind them
      // and Telegram would re-serve the same updates on every poll forever.
      if (raw.length > 0) {
        this.lastUpdateId = Math.max(...raw.map((u: TelegramUpdate) => u.update_id));
      }
      const updates = raw.filter((u: TelegramUpdate) => this.isFromConfiguredChat(u));
      if (updates.length !== raw.length) {
        this.logger?.debug("interaction", "Telegram updates rejected -- not from the configured chat", {
          rejected: raw.length - updates.length,
        });
      }

      // Reset backoff on success
      this.backoffMs = _telegramPluginDeps.basePollBackoffMs;
      return { ok: true, updates, rawCount: raw.length };
    } catch (err) {
      // Apply exponential backoff on network error
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      // Swallow the error — callers retry with backoff. Logged at debug so a
      // persistently failing poll is diagnosable rather than silent.
      this.logger?.debug("interaction", "Telegram getUpdates failed — retrying with backoff", {
        error: err instanceof Error ? err.message : String(err),
        backoffMs: this.backoffMs,
      });
      return { ok: false, updates: [], rawCount: 0 };
    }
  }

  /**
   * True when an update originates from the configured chat.
   *
   * getUpdates returns updates from EVERY chat the bot participates in, so
   * without this any third party who can message the bot could answer an input
   * prompt (injected straight into the agent's turn by the ACP interaction
   * bridge) or forge a callback_query to approve, reject, or abort a run.
   * Request ids are deterministic and guessable for some flows. See #1365.
   *
   * An update carrying neither a callback_query message nor a message has no
   * chat (edited_message, poll, my_chat_member, ...) and is rejected; parseUpdate
   * already returned null for those, so this is not a behaviour change.
   */
  private isFromConfiguredChat(update: TelegramUpdate): boolean {
    const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
    return chatId !== undefined && String(chatId) === this.chatId;
  }

  /**
   * Parse Telegram update into interaction response
   */
  private parseUpdate(requestId: string, update: TelegramUpdate): InteractionResponse | null {
    // Check callback query (button click)
    if (update.callback_query) {
      const data = update.callback_query.data;
      const parts = data.split(":");
      if (parts.length < 2) return null;

      // BUG-42 (D-26): validate parts[1] against the known action set before
      // casting. The previous `as InteractionResponse["action"]` accepted any
      // string from the configured chat; an unknown action then fell through
      // every switch arm with no observable failure. Gated by
      // isFromConfiguredChat, so the practical risk is robustness (a dropped
      // callback) rather than privilege — but a malformed callback should be
      // a no-op, not a silent switch fall-through.
      const VALID_ACTIONS: ReadonlySet<InteractionResponse["action"]> = new Set([
        "approve",
        "reject",
        "choose",
        "input",
        "skip",
        "abort",
      ]);
      if (!VALID_ACTIONS.has(parts[1] as InteractionResponse["action"])) {
        getSafeLogger()?.warn("telegram", "Ignoring callback with unknown action", {
          action: parts[1],
        });
        return null;
      }
      const action = parts[1] as InteractionResponse["action"];
      // Rejoin everything after the action: an option key may itself contain
      // ":" (e.g. "scope:api"). Taking only parts[2] truncated the value, so
      // the reconstructed suffix no longer matched the one used at build time
      // and the id comparison below failed — the tap was silently dropped and
      // the prompt could only resolve by timeout. The id segment cannot carry
      // a ":" at all; buildCallbackData rejects that at construction.
      const value = parts.length > 2 ? parts.slice(2).join(":") : undefined;

      // The id segment may have been truncated at construction time to keep
      // callback_data within Telegram's 64-byte limit (BUG-48), so compare
      // against the same truncation of the known-good requestId rather than
      // the full, untruncated id. Exact match (not startsWith) — startsWith
      // let one tap answer the wrong prompt whenever one request's id was a
      // prefix of another's (BUG-34).
      const suffix = value !== undefined ? `:${action}:${value}` : `:${action}`;
      const expectedIdPart = truncateIdForCallbackData(requestId, suffix);
      if (parts[0] !== expectedIdPart) return null;

      return {
        requestId,
        action,
        value,
        respondedBy: "telegram",
        respondedAt: Date.now(),
      };
    }

    // Check text message — only "input" requests are ever answerable by free text.
    // confirm/choose/review are button-only in the keyboard nax posts for them (see
    // buildKeyboard()), so a plain-text message can never legitimately be their answer.
    if (update.message?.text) {
      const pending = this.pendingMessages.get(requestId);
      if (!pending || pending.type !== "input") return null;

      const replyToId = update.message.reply_to_message?.message_id;
      // Accept if user replied directly to one of our messages, OR if it's the first text response
      // (handles case where user sends a plain message without explicit reply)
      if (replyToId !== undefined && !pending.ids.includes(replyToId)) return null;

      return {
        requestId,
        action: "input",
        value: update.message.text,
        respondedBy: "telegram",
        respondedAt: Date.now(),
      };
    }

    return null;
  }

  /**
   * Answer callback query to remove loading state
   */
  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    if (!this.botToken) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALLBACK_API_TIMEOUT_MS);
      try {
        await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Non-critical - fire-and-forget, no logging needed
    }
  }

  /**
   * Clear inline keyboard on a handled message so stale callbacks cannot be tapped repeatedly.
   */
  private async clearInlineKeyboard(messageId: number): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALLBACK_API_TIMEOUT_MS);
      try {
        await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/editMessageReplyMarkup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Non-critical cleanup: response already captured.
    }
  }

  /**
   * Edit message to show timeout/expired.
   *
   * Callers on the timeout/cancel path snapshot `pending` before resolving
   * the receiver (which clears pendingMessages) and pass it in here, since
   * this call is fire-and-forget and must not block resolution on a
   * potentially-hung network (TEL-1).
   */
  private async sendTimeoutMessage(
    requestId: string,
    pendingArg?: { type: InteractionRequest["type"]; ids: number[] },
  ): Promise<void> {
    const pending = pendingArg ?? this.pendingMessages.get(requestId);
    if (!pending || !this.botToken || !this.chatId) {
      this.pendingMessages.delete(requestId);
      return;
    }

    // Edit only the last message to avoid redundant notifications
    const lastId = pending.ids[pending.ids.length - 1];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALLBACK_API_TIMEOUT_MS);
      try {
        await _telegramPluginDeps.fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            message_id: lastId,
            text: "⏱ EXPIRED — Interaction timed out",
            reply_markup: { inline_keyboard: [] }, // Remove buttons so expired interactions can't be re-tapped
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Non-critical - fire-and-forget, no logging needed
    } finally {
      this.pendingMessages.delete(requestId);
    }
  }
}
