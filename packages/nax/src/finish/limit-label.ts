const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** At most one decimal, no trailing zero: 1.5 -> "1.5", 15 -> "15". */
const trimmed = (n: number): string => String(Number(n.toFixed(1)));

/**
 * The one rendering of a stop limit (resolve reasons, the PR body's Stops section, the result text).
 * Below a minute it is seconds, so a 15 s limit never reads "0 min"; whole hours and whole minutes keep
 * their short form; any other whole-second length is seconds ("90 s"), and the rest is decimal minutes.
 */
export function limitLabel(ms: number): string {
  if (ms < MS_PER_MINUTE) return `${trimmed(ms / MS_PER_SECOND)} s`;
  if (ms % MS_PER_HOUR === 0) return `${ms / MS_PER_HOUR} h`;
  if (ms % MS_PER_MINUTE === 0) return `${ms / MS_PER_MINUTE} min`;
  if (ms % MS_PER_SECOND === 0) return `${ms / MS_PER_SECOND} s`;
  return `${trimmed(ms / MS_PER_MINUTE)} min`;
}
