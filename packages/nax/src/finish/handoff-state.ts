/** Finish A: which handoffs still leave their half-edit in the worktree (restore failed, not yet set aside). */

import type { HandoffRecord } from "./types";

/** True while the handoff's restore failed and no later handoff has set its leftover dirt aside. */
export const restorePending = (h: HandoffRecord): boolean => !h.restored && h.settledBy === undefined;

/** Handoff numbers whose half-edit may still be in the worktree, oldest first. */
export const restorePendingNumbers = (handoffs: readonly HandoffRecord[]): number[] =>
  handoffs.filter(restorePending).map((h) => h.n);

/** The handoffs with `settledBy: n` for every unsettled restore-failed one. */
export function settleAll(handoffs: readonly HandoffRecord[], n: number): HandoffRecord[] {
  return handoffs.map((h) => (restorePending(h) ? { ...h, settledBy: n } : h));
}
