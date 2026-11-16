/**
 * A destructive esc asks twice.
 *
 * Stopping a running turn — or closing the question card that also stops it — is the one thing
 * escape does that cannot be undone, so the screen makes it a two-press gesture: the first press
 * only offers it, and the offer lapses after `ESC_CONFIRM_MS`. Everything else escape does
 * (denying an approval, cancelling a choice, closing a picker or a menu) stays a single press.
 *
 * `press()` decides from the arm time it writes synchronously, never from the rendered `armed`:
 * a terminal can deliver two escapes in one input batch with no render between them, and the
 * second one must still be the second press of the same gesture. The arm is stamped with the
 * esc target it was earned on, so a press on another target — a replacement question of the
 * same kind — is a first press even before the screen redraws. `armed` is what the screen
 * draws — the footer's "esc again to …" hint — and it is cleared by the window's expiry, by
 * the turn ending, by the top esc layer changing, and by the screen's own `reset()` at a turn
 * boundary it claims itself (a drained queue can end one turn and start the next without ever
 * drawing an idle frame).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EscLayer } from "./esc-layer";
import { _chatKeyDeps } from "./useChatKeys";

/** How long an armed escape waits for its second press before the offer lapses. */
export const ESC_CONFIRM_MS = 2_000;

/**
 * A timer's handle. Not `typeof setTimeout`'s return type: three libraries declare the global,
 * so that is an overload set returning `Timer`, `Timeout` and `number`, which no injectable
 * implementation can satisfy. `globalThis.setTimeout`'s handle and a fake clock's id both fit.
 */
type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * The expiry's timer seam. `setTimeout` rather than `setInterval` or `Bun.sleep` because the
 * handle must be cancellable mid-flight — every way an arm ends clears it (forbidden-patterns-source).
 */
export const _escConfirmDeps = {
  setTimeout: (callback: () => void, delayMs: number): TimerHandle => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: TimerHandle): void => globalThis.clearTimeout(handle),
};

/** What the hook offers the screen: the rendered arm, the press that decides, and the reset. */
export interface EscConfirm {
  /** Whether the first escape is still waiting for its second — what the footer's hint reads. */
  readonly armed: boolean;
  /** True when this press is the second of a timely pair, so the destructive action may run. */
  press(): boolean;
  /**
   * End the arm now, whatever the rendered frame says. The screen calls this at a turn
   * boundary it claims itself — a queued line starting the next turn can end one turn and
   * begin the next without ever drawing an idle frame, so no render-based trigger would see it.
   */
  reset(): void;
}

/**
 * How two layers differ for the arm's purposes. A card replacing the bare turn is a different
 * layer, a stopping question is not the same layer as a question that stops nothing, and two
 * questions are two targets: the arm belongs to the card it was earned on, by its request id.
 */
function layerKey(layer: EscLayer): string {
  switch (layer.kind) {
    case "question":
      return `question:${layer.stops}:${layer.id ?? ""}`;
    case "picker":
      return `picker:${layer.picker}`;
    default:
      return layer.kind;
  }
}

/**
 * The confirmed-escape gesture of the screen drawing `layer` while `turnRunning` is what it
 * reports. Both are read on every render and only ever *clear* the arm: the press itself decides
 * from the ref, so a batched key is never answered by a stale render.
 */
export function useEscConfirm(layer: EscLayer, turnRunning: boolean): EscConfirm {
  /** When this arm was stamped. Written by `press()` before it returns, ahead of any render. */
  const armedAt = useRef<number | undefined>(undefined);
  /** Which esc target the stamp belongs to: another layer or another question is another arm. */
  const armedKey = useRef<string | undefined>(undefined);
  /** The armed window's expiry, cleared whenever the arm ends for any other reason. */
  const expiry = useRef<TimerHandle | undefined>(undefined);
  const [armed, setArmed] = useState(false);

  /** End the arm now: the timer, the stamp and the drawn hint, wherever they stand. */
  const clearArm = useCallback((): void => {
    if (expiry.current !== undefined) {
      _escConfirmDeps.clearTimeout(expiry.current);
      expiry.current = undefined;
    }
    armedAt.current = undefined;
    armedKey.current = undefined;
    setArmed(false);
  }, []);

  const key = layerKey(layer);
  // A different layer, or a turn that has ended, never inherits an arm earned elsewhere: the
  // arm belongs to the gesture that started it. `key` and `turnRunning` are the whole point of
  // the effect — they are what a new turn or a new layer changes — even though the body reads
  // neither.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layer and the turn are the reset's triggers.
  useEffect(() => {
    clearArm();
  }, [clearArm, key, turnRunning]);

  const press = useCallback((): boolean => {
    const now = _chatKeyDeps.now();
    // The arm this press may confirm is only this layer's own: a press on another target —
    // a replacement question of the same kind, a card that replaced the turn — is a first
    // press, decided here rather than by a render the screen may not have made yet.
    const stampedAt = armedKey.current === key ? armedAt.current : undefined;
    // Exclusive, as ctrl+c's double interrupt is: a press exactly `ESC_CONFIRM_MS` later is a
    // new offer, not the confirmation of an offer that has already lapsed.
    if (stampedAt !== undefined && now - stampedAt < ESC_CONFIRM_MS) {
      clearArm();
      return true;
    }
    if (expiry.current !== undefined) _escConfirmDeps.clearTimeout(expiry.current);
    armedAt.current = now;
    armedKey.current = key;
    setArmed(true);
    expiry.current = _escConfirmDeps.setTimeout(() => {
      expiry.current = undefined;
      armedAt.current = undefined;
      armedKey.current = undefined;
      setArmed(false);
    }, ESC_CONFIRM_MS);
    return false;
  }, [clearArm, key]);

  // A pending window must not outlive the screen: nothing is drawn after unmount, so the timer
  // is cleared rather than allowed to fire into it.
  useEffect(
    () => () => {
      if (expiry.current !== undefined) _escConfirmDeps.clearTimeout(expiry.current);
    },
    [],
  );

  return { armed, press, reset: clearArm };
}
