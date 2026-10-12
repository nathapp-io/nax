/**
 * Finish A: run one turn with a soft interrupt. When `interrupt` aborts (or is already
 * aborted on entry), `onInterrupt` (SessionManager.interruptTurn) is tried until it
 * cancels a registered call; the turn then ends fail-stale and the session stays
 * usable. Nothing outlives the turn, and a failing `onInterrupt` never fails the turn.
 */
export const INTERRUPT_RETRY_MS = 250;

export async function withInterrupt<T>(
  interrupt: AbortSignal | undefined,
  onInterrupt: () => Promise<boolean>,
  run: () => Promise<T>,
): Promise<T> {
  if (!interrupt) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  // The adapter may not have registered its active call yet (native registers after
  // client setup), so keep trying until interruptTurn reports it cancelled something.
  const attempt = (): void => {
    if (settled) return;
    void onInterrupt()
      .catch(() => false)
      .then((done) => {
        // setTimeout (not Bun.sleep): the handle must be cancellable when the turn settles.
        if (!done && !settled) timer = setTimeout(attempt, INTERRUPT_RETRY_MS);
      });
  };
  if (interrupt.aborted) queueMicrotask(attempt);
  else interrupt.addEventListener("abort", attempt, { once: true });
  try {
    return await run();
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    interrupt.removeEventListener("abort", attempt);
  }
}
