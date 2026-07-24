/**
 * nax-finish Plugin — Telegram Escalation Notifier
 *
 * Sends a one-shot Telegram message when the nax-finish flow escalates
 * (e.g. ambiguous design call requiring human input). Independent of the
 * `src/interaction/plugins/telegram.ts` interaction plugin — this is a
 * fire-and-forget notification, not an interactive request/response.
 */

type FetchFn = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

/** Module-level deps for testability (`_deps` pattern). */
export const _telegramDeps: { fetch: FetchFn } = { fetch: (...a) => fetch(...a) };

/** POST a Markdown-formatted message to a Telegram chat via the Bot API. */
export async function sendTelegramNotify(cfg: { token: string; chatId: string }, text: string): Promise<boolean> {
  const res = await _telegramDeps.fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "Markdown" }),
  });
  return res.ok;
}
