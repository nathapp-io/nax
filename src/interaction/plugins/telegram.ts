/**
 * Telegram Interaction Plugin (v0.15.0 US-005)
 *
 * Send interaction requests via Telegram Bot API with inline keyboard.
 * Poll for callback query or reply message responses.
 */

import { z } from "zod";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/** Telegram plugin configuration */
interface TelegramConfig {
  /** Bot token (or env var NAX_TELEGRAM_TOKEN) */
  botToken?: string;
  /** Chat ID (or env var NAX_TELEGRAM_CHAT_ID) */
  chatId?: string;
}

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
  private pendingMessages = new Map<string, number>(); // requestId -> messageId
  private lastUpdateId = 0;
  private backoffMs = 1000; // Exponential backoff for getUpdates (starts at 1s)
  private readonly maxBackoffMs = 30000; // Max 30 seconds between retries

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = TelegramConfigSchema.parse(config);
    this.botToken = cfg.botToken ?? process.env.NAX_TELEGRAM_TOKEN ?? null;
    this.chatId = cfg.chatId ?? process.env.NAX_TELEGRAM_CHAT_ID ?? null;

    if (!this.botToken || !this.chatId) {
      throw new Error("Telegram plugin requires botToken and chatId (env: NAX_TELEGRAM_TOKEN, NAX_TELEGRAM_CHAT_ID)");
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

    const text = this.formatMessage(request);
    const keyboard = this.buildKeyboard(request);

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
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

      // Store message ID for later updates
      this.pendingMessages.set(request.id, data.result.message_id);
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
          // Reset backoff on successful response
          this.backoffMs = 1000;
          return response;
        }
      }

      // Use dynamic backoff (set by getUpdates on error)
      await Bun.sleep(this.backoffMs);
    }

    // Timeout reached — send expiration message
    await this.sendTimeoutMessage(requestId);

    return {
      requestId,
      action: "skip",
      respondedBy: "timeout",
      respondedAt: Date.now(),
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.sendTimeoutMessage(requestId);
    this.pendingMessages.delete(requestId);
  }

  /**
   * Format interaction request as Telegram message
   */
  private formatMessage(request: InteractionRequest): string {
    const emoji = this.getStageEmoji(request.stage);
    let text = `${emoji} *${request.stage.toUpperCase()}*\n\n`;
    text += `*Feature:* ${request.featureName}\n`;
    if (request.storyId) {
      text += `*Story:* ${request.storyId}\n`;
    }
    text += `\n${request.summary}\n`;

    if (request.detail) {
      text += `\n${request.detail}\n`;
    }

    if (request.options && request.options.length > 0) {
      text += "\n*Options:*\n";
      for (const opt of request.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        text += `  • ${opt.label}${desc}\n`;
      }
    }

    if (request.timeout) {
      const timeoutSec = Math.floor(request.timeout / 1000);
      text += `\n⏱ Timeout: ${timeoutSec}s | Fallback: ${request.fallback}`;
    }

    return text;
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
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: this.lastUpdateId + 1,
          timeout: 1, // Short polling
        }),
      });

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

    // Check text message (for input type)
    if (update.message?.text) {
      const messageId = this.pendingMessages.get(requestId);
      if (!messageId) return null;

      // Simple heuristic: if message is reply to our message
      // For now, accept any message as input
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
    const messageId = this.pendingMessages.get(requestId);
    if (!messageId || !this.botToken || !this.chatId) {
      // Still cleanup even if we can't send timeout message
      this.pendingMessages.delete(requestId);
      return;
    }

    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
          text: "⏱ *EXPIRED* — Interaction timed out",
          parse_mode: "Markdown",
        }),
      });
    } catch {
      // Non-critical - fire-and-forget, no logging needed
    } finally {
      this.pendingMessages.delete(requestId);
    }
  }
}
