/**
 * Telegram Interaction Plugin (v0.15.0 US-005)
 *
 * Send interaction requests via Telegram Bot API with inline keyboard.
 * Poll for callback query or reply message responses.
 */

import { z } from "zod";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/** Telegram message length limit (4096 max, keep buffer) */
const MAX_MESSAGE_CHARS = 4000;

/** Zod schema for validating telegram plugin config */
const TelegramConfigSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

/** Telegram API response types */
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    message: TelegramMessage;
  };
  message?: TelegramMessage;
}

/**
 * Telegram plugin for remote interaction via Telegram Bot API
 */
export class TelegramInteractionPlugin implements InteractionPlugin {
  name = "telegram";
  private botToken: string | null = null;
  private chatId: string | null = null;
  private pendingMessages = new Map<string, number[]>(); // requestId -> messageId[]
  private lastUpdateId = 0;
  private backoffMs = 1000; // Exponential backoff for getUpdates (starts at 1s)
  private readonly maxBackoffMs = 30000; // Max 30 seconds between retries

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = TelegramConfigSchema.parse(config);
    this.botToken = cfg.botToken ?? process.env.NAX_TELEGRAM_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    this.chatId = cfg.chatId ?? process.env.NAX_TELEGRAM_CHAT_ID ?? null;

    if (!this.botToken || !this.chatId) {
      throw new Error(
        "Telegram plugin requires botToken and chatId (env: NAX_TELEGRAM_TOKEN or TELEGRAM_BOT_TOKEN, NAX_TELEGRAM_CHAT_ID)",
      );
    }
  }

  async destroy(): Promise<void> {
    // Cleanup pending messages
    this.pendingMessages.clear();
  }

  async send(request: InteractionRequest): Promise<void> {
    if (!this.botToken || !this.chatId) {
      throw new Error("Telegram plugin not initialized");
    }

    const header = this.buildHeader(request);
    const keyboard = this.buildKeyboard(request);
    const body = this.buildBody(request);

    // Split body into chunks that fit within Telegram's 4000-char limit.
    // Header is prepended to the first chunk; subsequent chunks get a part label.
    const chunks = this.splitText(body, MAX_MESSAGE_CHARS - header.length - 10); // 10 = buffer for part label

    try {
      const sentIds: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const partLabel = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
        const text = `${header}\n${partLabel}${chunks[i]}`;

        const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            reply_markup: isLast && keyboard ? { inline_keyboard: keyboard } : undefined,
            parse_mode: "Markdown",
          }),
        });

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

      // Store ALL message IDs so we can match user replies to any of them
      this.pendingMessages.set(request.id, sentIds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send Telegram message: ${msg}`);
    }
  }

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
    if (!this.botToken || !this.chatId) {
      throw new Error("Telegram plugin not initialized");
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const updates = await this.getUpdates();

      for (const update of updates) {
        const response = this.parseUpdate(requestId, update);
        if (response) {
          // Answer callback query if present
          if (update.callback_query) {
            await this.answerCallbackQuery(update.callback_query.id);
          }
          // Clean up tracking entry before returning to avoid accumulating stale entries
          this.pendingMessages.delete(requestId);
          // Reset backoff on successful response
          this.backoffMs = 1000;
          return response;
        }
      }

      // Use dynamic backoff (set by getUpdates on error), capped to remaining timeout
      const remaining = timeout - (Date.now() - startTime);
      if (remaining <= 0) break;
      await Bun.sleep(Math.min(this.backoffMs, remaining));
    }

    // Timeout reached — send expiration message
    await this.sendTimeoutMessage(requestId);

    return {
      requestId,
      action: "skip", // This will be overridden by the chain's applyFallback if respondedBy is "timeout"
      respondedBy: "timeout",
      respondedAt: Date.now(),
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.sendTimeoutMessage(requestId);
    this.pendingMessages.delete(requestId);
  }

  /**
   * Build the fixed header portion of an interaction message (stage, feature, story).
   * Uses Markdown bold for visual clarity; safe characters only.
   * This is prepended to the first chunk when splitting long content.
   */
  private buildHeader(request: InteractionRequest): string {
    const emoji = this.getStageEmoji(request.stage);
    let text = `${emoji} *${request.stage.toUpperCase()}*\n`;
    text += `*Feature:* ${request.featureName}\n`;
    if (request.storyId) {
      text += `*Story:* ${request.storyId}\n`;
    }
    text += "\n";
    return text;
  }

  /**
   * Build the variable body portion (summary, detail, options, timeout).
   * Content is sanitized to prevent Telegram Markdown parser errors from
   * unclosed/ambiguous formatting characters in agent-generated output.
   * This is the part that gets split when content exceeds the Telegram limit.
   */
  private buildBody(request: InteractionRequest): string {
    let text = `${this.sanitizeMarkdown(request.summary)}\n`;

    if (request.detail) {
      text += `\n${this.sanitizeMarkdown(request.detail)}\n`;
    }

    if (request.options && request.options.length > 0) {
      text += "\n*Options:*\n";
      for (const opt of request.options) {
        const desc = opt.description ? ` - ${this.sanitizeMarkdown(opt.description)}` : "";
        text += `  - ${opt.label}${desc}\n`;
      }
    }

    if (request.timeout) {
      const timeoutSec = Math.floor(request.timeout / 1000);
      text += `\n⏱ Timeout: ${timeoutSec}s | Fallback: ${request.fallback}`;
    }

    return text;
  }

  /**
   * Escape Telegram Markdown special characters that would cause "can't parse entities" errors.
   * Telegram's Markdown parser is strict: unclosed `_`, `` ` ``, `*`, `[`, `\` all cause parse failures.
   * We escape the opening delimiter of ambiguous pairs so Telegram displays them literally.
   * Already-balanced pairs like `__bold__` are left intact (both delimiters are escaped harmlessly).
   */
  private sanitizeMarkdown(text: string): string {
    // Order matters: escape backslashes first (they're escape chars), then other delimiters.
    // We escape the LEADING delimiter of Markdown pairs: Telegram will display \_, \`, \* literally.
    // Safe pairs: the escape is redundant but harmless; unbalanced: the escape prevents parse error.
    return text
      .replace(/\\(?=[_*`\[])/g, "\\\\") // escape existing backslashes before these chars
      .replace(/_/g, "\\_") // escape underscores (used for italic in Telegram Markdown)
      .replace(/`/g, "\\`") // escape backticks (code fences / inline code)
      .replace(/\*/g, "\\*") // escape asterisks (bold)
      .replace(/\[/g, "\\["); // escape brackets (links)
  }

  /**
   * Split text into chunks that fit within maxChars, preferring line breaks as split points.
   */
  private splitText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxChars) {
      // Try to split at a newline near the limit
      const slice = remaining.slice(0, maxChars);
      const lastNewline = slice.lastIndexOf("\n");

      if (lastNewline > maxChars * 0.5) {
        // Good split point found — break at newline
        chunks.push(remaining.slice(0, lastNewline));
        remaining = remaining.slice(lastNewline + 1);
      } else {
        // No good newline — hard break at maxChars
        chunks.push(slice);
        remaining = remaining.slice(maxChars);
      }
    }

    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  /**
   * Build inline keyboard for interaction type
   */
  private buildKeyboard(request: InteractionRequest): Array<Array<{ text: string; callback_data: string }>> | null {
    switch (request.type) {
      case "confirm":
        return [
          [
            { text: "✅ Approve", callback_data: `${request.id}:approve` },
            { text: "❌ Reject", callback_data: `${request.id}:reject` },
          ],
          [
            { text: "⏭ Skip", callback_data: `${request.id}:skip` },
            { text: "🛑 Abort", callback_data: `${request.id}:abort` },
          ],
        ];

      case "choose": {
        if (!request.options || request.options.length === 0) return null;
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (const opt of request.options) {
          rows.push([{ text: opt.label, callback_data: `${request.id}:choose:${opt.key}` }]);
        }
        rows.push([
          { text: "⏭ Skip", callback_data: `${request.id}:skip` },
          { text: "🛑 Abort", callback_data: `${request.id}:abort` },
        ]);
        return rows;
      }

      case "review":
        return [
          [
            { text: "✅ Approve", callback_data: `${request.id}:approve` },
            { text: "❌ Reject", callback_data: `${request.id}:reject` },
          ],
          [
            { text: "⏭ Skip", callback_data: `${request.id}:skip` },
            { text: "🛑 Abort", callback_data: `${request.id}:abort` },
          ],
        ];

      default:
        // input, notify, webhook don't use buttons
        return null;
    }
  }

  /**
   * Get emoji for stage
   */
  private getStageEmoji(stage: string): string {
    switch (stage) {
      case "pre-flight":
        return "🚀";
      case "execution":
        return "⚙️";
      case "review":
        return "🔍";
      case "merge":
        return "🔀";
      case "cost":
        return "💰";
      default:
        return "📌";
    }
  }

  /**
   * Get updates from Telegram Bot API with exponential backoff on failure
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    if (!this.botToken) return [];

    try {
      // Client-side timeout guards against network hangs (no OS TCP timeout = 75s+ stall)
      // With short-polling timeout:1, server responds in ~1s. 8s client timeout is safe headroom.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 1, // Short polling — server holds connection up to 1s
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

      const updates = data.result;
      if (updates.length > 0) {
        this.lastUpdateId = Math.max(...updates.map((u: TelegramUpdate) => u.update_id));
      }

      // Reset backoff on success
      this.backoffMs = 1000;
      return updates;
    } catch (err) {
      // Apply exponential backoff on network error
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      // Return empty updates and retry with backoff (logged for debugging, not exposed to user)
      return [];
    }
  }

  /**
   * Parse Telegram update into interaction response
   */
  private parseUpdate(requestId: string, update: TelegramUpdate): InteractionResponse | null {
    // Check callback query (button click)
    if (update.callback_query) {
      const data = update.callback_query.data;
      if (!data.startsWith(requestId)) return null;

      const parts = data.split(":");
      if (parts.length < 2) return null;

      const action = parts[1] as InteractionResponse["action"];
      const value = parts.length > 2 ? parts[2] : undefined;

      return {
        requestId,
        action,
        value,
        respondedBy: "telegram",
        respondedAt: Date.now(),
      };
    }

    // Check text message (for input type) — match any of our sent message IDs
    if (update.message?.text) {
      const messageIds = this.pendingMessages.get(requestId);
      if (!messageIds) return null;

      const replyToId = update.message.reply_to_message?.message_id;
      // Accept if user replied directly to one of our messages, OR if it's the first text response
      // (handles case where user sends a plain message without explicit reply)
      if (replyToId !== undefined && !messageIds.includes(replyToId)) return null;

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
      await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
        }),
      });
    } catch {
      // Non-critical - fire-and-forget, no logging needed
    }
  }

  /**
   * Edit message to show timeout/expired
   */
  private async sendTimeoutMessage(requestId: string): Promise<void> {
    const messageIds = this.pendingMessages.get(requestId);
    if (!messageIds || !this.botToken || !this.chatId) {
      this.pendingMessages.delete(requestId);
      return;
    }

    // Edit only the last message to avoid redundant notifications
    const lastId = messageIds[messageIds.length - 1];
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: lastId,
          text: "⏱ EXPIRED — Interaction timed out",
          reply_markup: { inline_keyboard: [] }, // Remove buttons so expired interactions can't be re-tapped
        }),
      });
    } catch {
      // Non-critical - fire-and-forget, no logging needed
    } finally {
      this.pendingMessages.delete(requestId);
    }
  }
}
