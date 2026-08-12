/**
 * Telegram plugin config validation and Bot API wire types.
 *
 * Split out of telegram.ts so that file stays under the 600-line source limit
 * and keeps to plugin behaviour (send/poll/receive). Nothing here does I/O or
 * holds instance state.
 */

import { z } from "zod";

/** Telegram numeric chat ids; negative for groups and supergroups. */
const NUMERIC_CHAT_ID = /^-?\d+$/;

/**
 * Normalize a configured chat id and report whether it can ever match an
 * inbound update.
 *
 * The ingestion filter compares `String(update.chat.id)` against the configured
 * value, and getUpdates only ever reports NUMERIC chat ids. An `@channelusername`
 * is accepted by sendMessage — which is precisely why a mismatch here is silent:
 * outbound posting keeps working, so nothing looks broken until an answer never
 * arrives and every interactive prompt quietly falls through to its timeout
 * fallback. Same for a chat id that picked up whitespace from a .env file.
 *
 * Whitespace is stripped (unambiguously a typo). A non-numeric id is reported
 * as `unmatchable` rather than rejected, because send-only usage — `notify`
 * requests, which never wait for a response — is legitimate against an
 * `@channelusername`.
 */
export function normalizeChatId(raw: string): { chatId: string; unmatchable: boolean } {
  const chatId = raw.trim();
  return { chatId, unmatchable: !NUMERIC_CHAT_ID.test(chatId) };
}

/** Zod schema for validating telegram plugin config */
export const TelegramConfigSchema = z.object({
  botToken: z.string().optional(),
  chatId: z.string().optional(),
});

/** Telegram API response types */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    message: TelegramMessage;
  };
  message?: TelegramMessage;
}
