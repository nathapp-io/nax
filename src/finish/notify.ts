/**
 * Telegram notification for the finish phase.
 *
 * Lifted from `src/plugins/builtin/nax-finish/telegram.ts` and that
 * directory's `config.ts`, both deleted in the cutover. Independent of
 * `src/interaction/plugins/telegram.ts`: this is a fire-and-forget
 * notification, not an interactive request/response.
 *
 * Separate from `./escalate` deliberately. That module posts a comment
 * through the forge and takes `ForgeDeps`; this one takes a `fetch` and
 * knows nothing about a forge. `postEscalation`'s `preferTelegram` branch
 * returns `channel: "telegram"` without sending anything — this module is
 * what actually sends, called by the phase after it reads the result.
 */

type FetchFn = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

/** Bot API hard limit for `sendMessage` — a longer body is rejected outright. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/** Per-finding title budget, so one verbose title can't crowd out every other finding. */
const MAX_FINDING_TITLE_CHARS = 120;

interface TerminalMessageOptions {
  feature: string;
  status: string;
  detail?: string;
  url?: string;
}

/** Build a bounded plain-text terminal notification for non-escalation outcomes. */
export function buildTerminalMessage(options: TerminalMessageOptions): string {
  const lines = [`nax-finish ${options.status} ${options.feature}`];
  if (options.detail) lines.push(options.detail);
  if (options.url) lines.push(options.url);
  const message = lines.join("\n");
  return message.length <= TELEGRAM_MAX_MESSAGE_CHARS
    ? message
    : `${message.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * Compose the escalation message: the reason, then each finding by severity and
 * title.
 *
 * The reason alone is a bare count ("3 finding(s) after 3 fix attempts"), which
 * left the human no way to judge urgency without opening acpx's run bundle. The
 * list is truncated to fit the Bot API limit and says how many it dropped.
 */
export function buildEscalationMessage(
  feature: string,
  reason: string,
  findings: { severity: string; title: string }[],
): string {
  const head = `nax-finish escalated ${feature}: ${reason}`;
  if (findings.length === 0) return head;

  // Reserved up front for the worst case (every finding dropped), so adding a
  // line can never push the finished message past the limit.
  const footerReserve = `\n…and ${findings.length} more`.length;
  const lines: string[] = [];
  let used = head.length;
  for (const f of findings) {
    const title = f.title.length > MAX_FINDING_TITLE_CHARS ? `${f.title.slice(0, MAX_FINDING_TITLE_CHARS)}…` : f.title;
    const line = `\n- [${f.severity}] ${title}`;
    if (used + line.length + footerReserve > TELEGRAM_MAX_MESSAGE_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  const omitted = findings.length - lines.length;
  return `${head}${lines.join("")}${omitted > 0 ? `\n…and ${omitted} more` : ""}`;
}

/** Module-level deps for testability (`_deps` pattern). */
export const _notifyDeps: { fetch: FetchFn } = { fetch: (...a) => fetch(...a) };

/** SEC-4: 5s client-side cap for the notify fetch. Matches the interaction
 *  plugin's sendMessage pattern (src/interaction/plugins/telegram.ts:188). */
const NOTIFY_FETCH_TIMEOUT_MS = 5_000;

/**
 * POST a plain-text message to a Telegram chat via the Bot API.
 *
 * Deliberately no `parse_mode`. The body now carries model-authored review
 * titles, which routinely contain backticks and underscores
 * (`` `_calendar.py` ignores timezone ``); under `parse_mode: "Markdown"` an
 * unbalanced one makes the API reject the whole message with a 400, so the
 * escalation would be dropped silently. Escaping is not an option either —
 * legacy Markdown has no reliable escape, and stripping the characters would
 * rewrite `_calendar.py` to `calendar.py`, pointing the reader at a file that
 * isn't the one under discussion. Plain text delivers the names intact.
 *
 * SEC-4: bounded by `NOTIFY_FETCH_TIMEOUT_MS` via AbortController so a hung
 * Telegram API connection can't stall the post-run completion phase for the
 * OS TCP timeout (~75s) or forever. The interaction plugin's `sendMessage`
 * uses the same 5s pattern (src/interaction/plugins/telegram.ts:188).
 */
export async function sendTelegramNotify(cfg: { token: string; chatId: string }, text: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_FETCH_TIMEOUT_MS);
  try {
    const res = await _notifyDeps.fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve Telegram credentials from `ctx.config.interaction` — only meaningful
 * when `interaction.plugin === "telegram"`, in which case `interaction.config`
 * carries `botToken`/`chatId` (see `src/interaction/plugins/telegram.ts`).
 * Falls back to the same env vars the telegram interaction plugin itself uses.
 */
export function telegramCreds(config: unknown): { token: string; chatId: string } | null {
  const interaction = (config as { interaction?: { plugin?: string; config?: { botToken?: string; chatId?: string } } })
    ?.interaction;
  const tg = interaction?.plugin === "telegram" ? (interaction.config ?? {}) : {};
  const token = tg.botToken ?? process.env.NAX_TELEGRAM_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
  const chatId = tg.chatId ?? process.env.NAX_TELEGRAM_CHAT_ID ?? null;
  return token && chatId ? { token, chatId } : null;
}

/** Whether Telegram is configured for escalation notifications. */
export function isTelegramConfigured(config: unknown): boolean {
  return telegramCreds(config) !== null;
}
