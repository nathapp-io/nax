/**
 * Nested-run spend accounting for the chat's metadata writes.
 *
 * A foreground run's spend belongs to the turn that is running it. A background run belongs to
 * no turn: it cannot charge its starting turn however early it finishes, so its spend waits one
 * turn boundary (`deferred`), then waits for a metadata write to carry it (`pending`), and is
 * retired only once that write persisted (`commit`). It survives a send that throws and a write
 * that is still in flight.
 */

export interface NestedSpend {
  /** The parent-turn sequence number; a background run captures it when it starts or moves. */
  turn(): number;
  /** Charge the running turn. */
  chargeForeground(usd: number): void;
  /** Charge a background run that started (or moved) in `startTurn`. */
  chargeBackground(startTurn: number, usd: number): void;
  /** Spend of foreground nested turns since the last call; resets to 0. */
  takeCost(): number;
  /** Begin a parent turn, making spend from earlier turns' background runs eligible. */
  beginTurn(): void;
  /** Foreground spend taken now plus a snapshot of the eligible background spend. */
  costForTurn(): number;
  /** Retire exactly the background spend `costForTurn` reported. */
  commitCost(): void;
}

export function createNestedSpend(): NestedSpend {
  /** This turn's foreground nested spend, dropped when a send ends without persisting it. */
  let spentUsd = 0;
  let turnNumber = 0;
  /** Spend from background runs started this turn; ineligible even if they finish early. */
  let deferredUsd = 0;
  /** Eligible background spend no metadata write has carried yet; it outlives every turn. */
  let pendingUsd = 0;
  /** The background spend `costForTurn` reported, retired only once its write persisted. */
  let accountedUsd = 0;

  const spend: NestedSpend = {
    turn: () => turnNumber,
    chargeForeground(usd) {
      spentUsd += usd;
    },
    chargeBackground(startTurn, usd) {
      if (startTurn === turnNumber) deferredUsd += usd;
      else pendingUsd += usd;
    },
    takeCost() {
      const taken = spentUsd;
      spentUsd = 0;
      return taken;
    },
    beginTurn() {
      turnNumber += 1;
      pendingUsd += deferredUsd;
      deferredUsd = 0;
    },
    costForTurn() {
      // Snapshot the eligible background share before handing the total over: a run that finishes
      // while the write is in flight then stays pending for the next turn, instead of being
      // retired as if this write had carried it.
      accountedUsd = pendingUsd;
      return spend.takeCost() + accountedUsd;
    },
    commitCost() {
      pendingUsd -= accountedUsd;
      accountedUsd = 0;
    },
  };
  return spend;
}
