/**
 * Finish A 4.5: what finalize does with a tree that is dirty after a set-aside whose restore failed.
 *
 * Rule: if ANY handoff has `restored: false` and the tree is dirty at finalize, the dirt is set aside
 * (never committed). Failed handoffs are processed oldest-first, each with the base its own fix
 * session recorded (`HandoffRecord.base`), so a later session that folded the half-edit into its own
 * base cannot hide it. When HEAD has moved since that session (a later fix committed), the base's
 * tracked side is the current HEAD instead (`setAside` rebases it, and drops snapshot copies of files
 * HEAD now tracks): restoring to the old base would revert committed work.
 * A failed handoff with no recorded base fails closed: nothing is committed, the dirt stays in the
 * worktree, and the draft says so. A dirty tree with no failed restore (e.g. a gate's auto-fix) is
 * still committed by the caller, hooks off, as unreviewed.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { isDirty } from "./commit";
import { removeSnapshotDir, setAside } from "./set-aside";
import type { FinishState } from "./state";

/** Fail closed: say in the draft's reason that the worktree still holds uncommitted work. */
function noteLeftDirty(state: FinishState, handoff: number): void {
  const note = `uncommitted changes left in the worktree: handoff ${handoff} did not restore and recorded no base`;
  const reason = state.resolution?.reason ? `${state.resolution.reason}; ${note}` : note;
  if (state.resolution) state.resolution = { ...state.resolution, reason };
  state.reason = reason;
}

/** Returns true when the commit must be skipped (only push what is already committed). */
export async function setAsideLeftoverDirt(state: FinishState, audit: AuditTarget): Promise<boolean> {
  const failed = state.handoffs.filter((h) => !h.restored);
  if (failed.length === 0 || !(await isDirty(state.workdir))) return false;
  for (const h of failed) {
    if (!h.base) {
      getSafeLogger()?.warn("finish", "Failed set-aside has no recorded base: leaving the dirty tree uncommitted", {
        storyId: "_run",
        handoff: h.dir,
      });
      noteLeftDirty(state, h.n);
      return true;
    }
    const record = await setAside({
      workdir: state.workdir,
      audit,
      n: state.handoffs.length + 1,
      base: h.base, // setAside moves a stale base onto the current HEAD itself
      phase: "review",
      limit: "flow",
      findingIds: [],
      now: () => new Date().toISOString(),
    }).catch((err) => {
      getSafeLogger()?.warn("finish", "Final set-aside threw: leaving the dirty tree uncommitted", {
        storyId: "_run",
        error: errorMessage(err),
      });
      return null;
    });
    if (!record) return true;
    state.handoffs = [...state.handoffs, record];
    if (!record.restored) return true;
    await removeSnapshotDir(audit.auditDir, h.base.untrackedSnapshot); // this failed handoff is now settled
    if (!(await isDirty(state.workdir))) return false;
  }
  return false;
}
