/**
 * How long ago a session was last touched, in the words the resume picker shows (US-026).
 *
 * The formatter is pure and reads the clock from its caller, so a picker's rows and a test
 * agree on the instant they measure against. A timestamp the storage layer could not supply
 * (a `null` `updatedAt`) or could not parse has no relative time at all: the row then shows
 * the rest of its columns rather than a claim about when the session was last used.
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
/** Past this age a timestamp is no longer "yesterday" but a calendar date. */
const TWO_DAYS_MS = 2 * DAY_MS;

const JUST_NOW = "just now";
const YESTERDAY = "yesterday";
/** What an unreadable timestamp renders as: nothing, leaving the row's other columns. */
const NO_TIME = "";

/** UTC month abbreviations, indexed by `Date#getUTCMonth`. */
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The coarse elapsed time between `updatedAt` and `nowMs`: `just now` under a minute, whole
 * minutes under an hour, whole hours under a day, `yesterday` under two days, and the UTC
 * `<Mon> <D>` of the timestamp beyond that. A future timestamp (a skewed clock) reads
 * `just now` rather than a negative count.
 */
export function relativeTime(updatedAt: string | null | undefined, nowMs: number): string {
  if (updatedAt === null || updatedAt === undefined) return NO_TIME;
  const thenMs = Date.parse(updatedAt);
  if (Number.isNaN(thenMs)) return NO_TIME;
  const elapsedMs = nowMs - thenMs;
  if (elapsedMs < MINUTE_MS) return JUST_NOW;
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)} min ago`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)} h ago`;
  if (elapsedMs < TWO_DAYS_MS) return YESTERDAY;
  // The calendar date is read in UTC so a session's row does not name two different days
  // depending on where the terminal is running.
  const at = new Date(thenMs);
  return `${MONTH_LABELS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}
