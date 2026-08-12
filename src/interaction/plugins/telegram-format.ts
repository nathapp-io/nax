/**
 * Telegram message formatting — pure presentation helpers.
 *
 * Extracted from telegram.ts so the plugin stays under the 600-line source
 * limit. No I/O, no instance state: every function here is a pure function of
 * its arguments.
 */

import { NaxError } from "../../errors";
import type { InteractionRequest } from "../types";

/** Telegram message length limit (4096 max, keep buffer) */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Telegram's hard limit on `callback_data` byte length. Exceeding it makes
 * `answerCallbackQuery`/`sendMessage` fail with a 400 error, which throws the
 * whole send (BUG-48). `request.id` is the only unbounded component of the
 * strings built below (option keys are short, fixed, in-repo literals), so
 * it is the part we truncate to keep every callback_data within budget.
 */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** A Telegram inline keyboard: rows of buttons. */
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/**
 * Truncate `text` (UTF-8 byte-safe — never split a multi-byte codepoint) so
 * it fits within `maxBytes`.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;

  // Cut at the byte budget, then walk back off any UTF-8 continuation byte
  // (0b10xxxxxx) so the cut lands on a codepoint boundary. At most 3 steps —
  // no UTF-8 sequence is longer than 4 bytes. Slicing the *string* one
  // character at a time and re-encoding the prefix each iteration was O(n^2),
  // which is invisible at id lengths but pathological if this is ever reused
  // for longer text.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) {
    end--;
  }
  return encoded.toString("utf8", 0, end);
}

/**
 * Truncate `id` so that `${id}${suffix}` fits within Telegram's 64-byte
 * callback_data limit. `suffix` must include its leading separator (e.g.
 * `:approve`, `:choose:my-key`). Deterministic: parsing code (telegram.ts
 * parseUpdate) must apply this same function with the same suffix to
 * recover the expected id segment — see BUG-48.
 *
 * Request ids are `trigger-<name>-<timestamp>-<uuid8>` — a plain prefix
 * truncation drops the trailing UUID first, i.e. exactly the entropy, so two
 * prompts from the same trigger in the same second would truncate to the
 * same id and collide (re-opening the cross-prompt mixup this was meant to
 * fix). Hash instead so truncation can't destroy uniqueness.
 */
export function truncateIdForCallbackData(id: string, suffix: string): string {
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const maxIdBytes = Math.max(0, TELEGRAM_CALLBACK_DATA_MAX_BYTES - suffixBytes);
  if (Buffer.byteLength(id, "utf8") <= maxIdBytes) return id;
  const digest = new Bun.CryptoHasher("sha256").update(id).digest("hex");
  return truncateUtf8Bytes(`h${digest}`, maxIdBytes);
}

/**
 * Build a `callback_data` string bounded to Telegram's 64-byte limit.
 *
 * `callback_data` is a `:`-delimited grammar (`<id>:<action>[:<value>]`), and
 * `parseUpdate` recovers the id as the segment before the FIRST `:`. A colon
 * inside `id` therefore makes the id unrecoverable: every tap fails the id
 * comparison, `parseUpdate` returns null, and the prompt can only ever resolve
 * by timing out into its fallback — a silent failure with no diagnostic. Reject
 * it here, at the point the malformed id enters the system.
 *
 * Colons in the *value* segment are fine — `parseUpdate` rejoins everything
 * after the action, so multi-segment option keys round-trip intact.
 */
function buildCallbackData(id: string, suffix: string): string {
  if (id.includes(":")) {
    throw new NaxError(
      `Interaction request id must not contain ":" — it is the callback_data field separator, and an id containing it can never be matched back to its prompt (id: ${id})`,
      "INTERACTION_INVALID_REQUEST_ID",
      { stage: "interaction", requestId: id },
    );
  }
  return `${truncateIdForCallbackData(id, suffix)}${suffix}`;
}

/**
 * Build the fixed header portion of an interaction message (stage, feature, story).
 * Uses Markdown bold for visual clarity; safe characters only.
 * This is prepended to the first chunk when splitting long content.
 */
export function buildHeader(request: InteractionRequest): string {
  const emoji = getStageEmoji(request.stage);
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
export function buildBody(request: InteractionRequest): string {
  let text = `${sanitizeMarkdown(request.summary)}\n`;

  if (request.detail) {
    text += `\n${sanitizeMarkdown(request.detail)}\n`;
  }

  if (request.options && request.options.length > 0) {
    text += "\n*Options:*\n";
    for (const opt of request.options) {
      const desc = opt.description ? ` - ${sanitizeMarkdown(opt.description)}` : "";
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
export function sanitizeMarkdown(text: string): string {
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
export function splitText(text: string, maxChars: number): string[] {
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
export function buildKeyboard(request: InteractionRequest): InlineKeyboard | null {
  switch (request.type) {
    case "confirm":
      return [
        [
          { text: "✅ Approve", callback_data: buildCallbackData(request.id, ":approve") },
          { text: "❌ Reject", callback_data: buildCallbackData(request.id, ":reject") },
        ],
        [
          { text: "⏭ Skip", callback_data: buildCallbackData(request.id, ":skip") },
          { text: "🛑 Abort", callback_data: buildCallbackData(request.id, ":abort") },
        ],
      ];

    case "choose": {
      if (!request.options || request.options.length === 0) return null;
      const rows: InlineKeyboard = [];
      for (const opt of request.options) {
        rows.push([{ text: opt.label, callback_data: buildCallbackData(request.id, `:choose:${opt.key}`) }]);
      }
      rows.push([
        { text: "⏭ Skip", callback_data: buildCallbackData(request.id, ":skip") },
        { text: "🛑 Abort", callback_data: buildCallbackData(request.id, ":abort") },
      ]);
      return rows;
    }

    case "review":
      return [
        [
          { text: "✅ Approve", callback_data: buildCallbackData(request.id, ":approve") },
          { text: "❌ Reject", callback_data: buildCallbackData(request.id, ":reject") },
        ],
        [
          { text: "⏭ Skip", callback_data: buildCallbackData(request.id, ":skip") },
          { text: "🛑 Abort", callback_data: buildCallbackData(request.id, ":abort") },
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
export function getStageEmoji(stage: string): string {
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
