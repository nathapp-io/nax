/**
 * Watchdog-invoked turn cancels, tracked per session.
 *
 * When the idle watchdog fires it invokes the cancel the adapter published via
 * `onActiveCall`. `SessionManager.sendPrompt` must be able to tell that cancel
 * apart from an unrelated external kill (a plain `AbortError` or the ACP
 * `SessionTurnError(cancelled: true)`), because only the watchdog's own cancel
 * is fail-stale — the session stays warm for the immediate same-agent retry
 * (nax#2218). The grain is therefore the session, not the manager: parallel
 * runs share one manager and must not contaminate each other's classification.
 *
 * Extracted from manager.ts, which is grandfathered at its file-size limit.
 */

/**
 * Bookkeeping for one manager: which callIds had their cancel invoked by the
 * watchdog, per session name.
 */
export class WatchdogCancelTracker {
  private readonly _cancelledCallsBySession = new Map<string, Set<string>>();
  private readonly _activeCallsBySession = new Map<string, Set<string>>();
  private readonly _interruptedSessions = new Set<string>();

  /**
   * Build the `onActiveCall` callback handed to the adapter. It populates the
   * watchdog controller registry with a wrapped cancel that records the callId
   * BEFORE invoking the adapter's cancel — that way, when the adapter surfaces
   * `cancelled: true`, sendPrompt can confirm it was the watchdog.
   * Returns undefined when no registry is configured.
   */
  buildOnActiveCall(
    sessionName: string,
    registry: Map<string, () => Promise<void>> | undefined,
  ): ((callId: string, cancel: () => Promise<void>) => void) | undefined {
    if (!registry) return undefined;
    return (callId, cancel) => {
      const active = this._activeCallsBySession.get(sessionName) ?? new Set<string>();
      active.add(callId);
      this._activeCallsBySession.set(sessionName, active);
      registry.set(callId, async () => {
        const cancelledCalls = this._cancelledCallsBySession.get(sessionName) ?? new Set<string>();
        cancelledCalls.add(callId);
        this._cancelledCallsBySession.set(sessionName, cancelledCalls);
        await cancel();
      });
    };
  }

  /** Whether the watchdog invoked any cancel recorded for this session. */
  hasCancelled(sessionName: string): boolean {
    return (this._cancelledCallsBySession.get(sessionName)?.size ?? 0) > 0;
  }

  /**
   * Finish A: soft-cancel every active call of a session through the same registered
   * cancel the watchdog uses, so the turn ends fail-stale and the session stays warm.
   * False when there is no registry or no live registered call.
   */
  async interrupt(sessionName: string, registry: Map<string, () => Promise<void>> | undefined): Promise<boolean> {
    if (!registry) return false;
    const cancels = [...(this._activeCallsBySession.get(sessionName) ?? [])]
      .map((callId) => registry.get(callId))
      .filter((c): c is () => Promise<void> => c !== undefined);
    if (cancels.length === 0) return false;
    this._interruptedSessions.add(sessionName);
    await Promise.all(cancels.map((c) => c()));
    return true;
  }

  /** Whether an interrupt was requested for this session's current turn. */
  wasInterrupted(sessionName: string): boolean {
    return this._interruptedSessions.has(sessionName);
  }

  /** Forget a session's recorded cancels — after a turn settles, or on close. */
  clear(sessionName: string): void {
    this._cancelledCallsBySession.delete(sessionName);
    this._activeCallsBySession.delete(sessionName);
    this._interruptedSessions.delete(sessionName);
  }
}
