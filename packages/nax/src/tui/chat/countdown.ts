/**
 * The ask card's countdown — the `expires in m:ss` row every ask card closes on, and the
 * clock and timer seam that keeps it current.
 *
 * It sits beside the cards rather than inside one because both of them draw it: the text and
 * approval card in `AskCard.tsx` and the choice card in `ChoiceQuestionCard.tsx`. A card that
 * imported the other card's module to reach it would close an import cycle, and two
 * implementations of the label would drift.
 *
 * The tick is a `setTimeout` chain cleared with `clearTimeout` on unmount and once nothing is
 * left to count; `setInterval` is not used because the effect's cleanup could not stop a tick
 * already queued. `_askCardDeps` carries that clock, so a test moves time instead of waiting
 * for it.
 */
import { type LayoutContext, prefixedLine, styled } from "./layout-lines";
import type { StyledLine } from "./styled-line";

/** The delay between countdown redraws: one second, so `m:ss` never skips a value. */
export const COUNTDOWN_TICK_MS = 1000;
/** Under this many seconds left the countdown turns the theme's warning colour. */
export const COUNTDOWN_WARNING_SECONDS = 60;
/** One second, in milliseconds: what the countdown divides the time left by. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** A minute count of one digit, and a seconds count padded to two: `m:ss`. */
const SECONDS_PADDING = 2;

/**
 * Injected seams. `now` reads the countdown's clock, and the timer pair is the chain that
 * re-renders it: a plain `setTimeout` rather than a sleep because its handle is cancelled
 * mid-flight, by unmount and by the countdown reaching zero.
 */
export const _askCardDeps = {
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
};

/** What the card's last row says, and the colour it says it in. */
export interface AskCountdown {
  readonly text: string;
  readonly color: "muted" | "warning";
}

/**
 * Whole seconds left until an ask expires: a timestamp that does not parse, or one already
 * behind the clock, leaves none. Every fixture in the suite stamps `at: "now"`, so an
 * unparseable expiry has to read as zero rather than as `NaN` seconds.
 */
export function secondsLeft(expiresAt: string, nowMs: number): number {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.floor((expires - nowMs) / MS_PER_SECOND));
}

/** `m:ss` left, muted until the last minute and `warning` inside it. */
export function countdownLabel(expiresAt: string, nowMs: number): AskCountdown {
  const left = secondsLeft(expiresAt, nowMs);
  const minutes = Math.floor(left / SECONDS_PER_MINUTE);
  const seconds = String(left % SECONDS_PER_MINUTE).padStart(SECONDS_PADDING, "0");
  return {
    text: `expires in ${minutes}:${seconds}`,
    color: left < COUNTDOWN_WARNING_SECONDS ? "warning" : "muted",
  };
}

/**
 * The countdown's rows as a card draws them at `nowMs`: `expires in m:ss` behind the same
 * wrap every other card text takes, so a card narrower than the label draws it over two rows
 * and the measurement reserves both. It is a card's tail, so a row it counted as one while the
 * frame could only draw two would be an overflow the allocator never saw.
 */
export function countdownRows(expiresAt: string, nowMs: number, context: LayoutContext): readonly StyledLine[] {
  const countdown = countdownLabel(expiresAt, nowMs);
  return prefixedLine([styled(countdown.text, { color: countdown.color })], [], context);
}
