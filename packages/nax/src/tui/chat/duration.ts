/**
 * The chat's one duration format (US-002). A span reads as `42s` under a minute, `20m 05s`
 * under an hour and then `1h 06m 19s`, so a long tool call or turn states its time in the
 * units a reader counts in rather than as a four-digit second count (#2974).
 *
 * Units after the first are two digits, which keeps the seconds and minutes columns steady
 * while the span grows. Hours are the largest unit: a day-long span reads `26h 00m 00s`.
 */

/** Milliseconds in one second. */
const MILLIS_PER_SECOND = 1000;
/** Whole seconds in one minute, and in one hour. */
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
/** Columns a unit after the first pads to. */
const UNIT_PAD = 2;
const UNIT_PAD_CHAR = "0";
const SECOND_UNIT = "s";
const MINUTE_UNIT = "m";
const HOUR_UNIT = "h";

function twoDigits(value: number): string {
  return value.toString().padStart(UNIT_PAD, UNIT_PAD_CHAR);
}

/** The span's whole seconds; a negative or non-finite span counts as none. */
function wholeSeconds(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MILLIS_PER_SECOND) : 0;
}

/**
 * A duration as the chat states it: `42s` under a minute, `20m 05s` under an hour, then
 * `1h 06m 19s`. Units after the first are two digits.
 */
export function formatDuration(ms: number): string {
  const seconds = wholeSeconds(ms);
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}${SECOND_UNIT}`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = twoDigits(seconds % SECONDS_PER_MINUTE);
  if (seconds < SECONDS_PER_HOUR) return `${minutes}${MINUTE_UNIT} ${rest}${SECOND_UNIT}`;
  const hours = Math.floor(minutes / SECONDS_PER_MINUTE);
  return `${hours}${HOUR_UNIT} ${twoDigits(minutes % SECONDS_PER_MINUTE)}${MINUTE_UNIT} ${rest}${SECOND_UNIT}`;
}
