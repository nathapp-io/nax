/**
 * Cross-run provenance for the approvals cache (#2199).
 *
 * THE PROBLEM. `approvals.json` is project-scoped and outlives the run. A run
 * with any `bashApproval: raw` stage and no sandbox ("forge-capable") has a
 * shell that can append arbitrary entries, and a LATER run that trusts the
 * cache would auto-allow them as `decidedBy: "cache"`. Checking only the
 * current run's stage modes cannot see that history.
 *
 * WHY NOT A SIGNATURE. An unsandboxed raw shell runs as the same OS user as
 * nax. Any key nax can read from disk -- under ~/.nax or anywhere else -- that
 * shell can read too, and then mint valid signatures. Signing would look
 * stronger than it is, so it is deliberately not done (ADR-030 said the same).
 *
 * THE DESIGN: a taint marker that only nax writes, at points no agent runs.
 *  1. A forge-capable run TAINTS the store before its story's agents start and
 *     again after they finish: every entry is dropped and a `taint` record is
 *     written. The end-of-story re-taint wipes whatever the story's agents
 *     wrote, even an agent that knew to strip the first marker.
 *  2. The cache link ABSTAINS on a tainted store, whatever it contains.
 *  3. A run that trusts the cache clears a taint before building its link by
 *     dropping every entry with it, so a trusted epoch starts empty. It leaves
 *     the taint alone while the tainting run may still be writing: the same
 *     run (a sibling story in a forge-capable package), or another nax process
 *     that is still alive.
 *
 * RESIDUAL RISK, stated so it is not overclaimed. The guarantee is against an
 * agent that forges entries during its turn, not against a hostile one that
 * understands this scheme. Out of reach of any on-disk mechanism:
 *  - a process the agent leaves running past its story (e.g. a detached
 *    `sleep; rewrite`) that strips the marker and forges after the last
 *    re-taint;
 *  - a forge-capable run killed between an agent stripping the marker and the
 *    end-of-story re-taint;
 *  - agents outside the execution stage (acceptance, post-run) in a
 *    forge-capable run, which run after the last re-taint.
 * An unsandboxed raw shell can equally edit shell rc files or git hooks, so
 * this sits inside the posture ADR-030 already discloses; the sandbox, which
 * always write-denies this file, is the real boundary.
 */
import { getSafeLogger } from "../logger";
import { withPathFileLock } from "../utils/path-file-lock";
import { type ApprovalsTaint, readApprovalsFile, writeApprovalsFile } from "./approvals-store";

/** `kill(pid, 0)` failing with EPERM means the process exists but is not ours. */
const ERRNO_NO_PERMISSION = "EPERM";

export const _approvalsTaintDeps = {
  pid: (): number => process.pid,
  now: (): Date => new Date(),
  isProcessAlive: (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as { code?: unknown }).code === ERRNO_NO_PERMISSION;
    }
  },
};

/**
 * A run can forge the approvals file when any stage runs a raw shell outside
 * the sandbox. With the sandbox enabled the file is always in `denyWrite`, and
 * a raw stage is either wrapped or refused. Config-only: no probe dependency.
 */
export function isForgeCapable(stageModes: readonly string[], sandboxEnabled: boolean): boolean {
  return stageModes.includes("raw") && !sandboxEnabled;
}

/** Drop every entry and record who tainted the store. */
export async function taintApprovals(path: string, runId: string): Promise<void> {
  const taint = { since: _approvalsTaintDeps.now().toISOString(), runId, pid: _approvalsTaintDeps.pid() };
  await withPathFileLock(path, async () => writeApprovalsFile(path, { taint, entries: [] }));
}

/** `held`: a still-running forge-capable nax process owns the taint. */
export type ClearTaintOutcome = "clean" | "cleared" | "held";

/**
 * Whether the tainting run may still be writing. A taint from THIS run is held:
 * stories can resolve different sandbox settings per package, so a trusted
 * story must not clear the marker a forge-capable sibling story just wrote. A
 * taint from an earlier run in this same process is not held.
 */
function taintIsHeld(taint: ApprovalsTaint, runId: string): boolean {
  if (taint.runId === runId) return true;
  const owner = taint.pid;
  if (owner === undefined || owner === _approvalsTaintDeps.pid()) return false;
  return _approvalsTaintDeps.isProcessAlive(owner);
}

/**
 * Start a trusted epoch. Entries that sat beside a taint are dropped, never
 * promoted: nothing distinguishes a forged one from a human's.
 */
export async function clearApprovalsTaint(path: string, runId: string): Promise<ClearTaintOutcome> {
  return withPathFileLock(path, async () => {
    const { taint } = await readApprovalsFile(path);
    if (taint === undefined) return "clean";
    if (taintIsHeld(taint, runId)) return "held";
    await writeApprovalsFile(path, { taint: undefined, entries: [] });
    return "cleared";
  });
}

export interface PrepareApprovalsStoreOptions {
  readonly approvalsFile: string;
  readonly runId: string;
  readonly storyId: string;
  readonly forgeCapable: boolean;
}

/**
 * Taint (forge-capable) or clear (trusted) the store. Never throws: a failed
 * clear leaves the taint in place, so the link abstains and the cost is
 * prompts; a failed taint is logged, since a later run may then trust entries.
 */
export async function prepareApprovalsStore(opts: PrepareApprovalsStoreOptions): Promise<void> {
  const logger = getSafeLogger();
  try {
    if (opts.forgeCapable) {
      await taintApprovals(opts.approvalsFile, opts.runId);
      return;
    }
    const outcome = await clearApprovalsTaint(opts.approvalsFile, opts.runId);
    if (outcome === "held") {
      logger?.warn(
        "permissions",
        "[approvals] store tainted by a forge-capable run still in progress; cache stays off",
        {
          storyId: opts.storyId,
          approvalsFile: opts.approvalsFile,
        },
      );
    } else if (outcome === "cleared") {
      logger?.info("permissions", "[approvals] discarded entries written under a forge-capable run", {
        storyId: opts.storyId,
        approvalsFile: opts.approvalsFile,
      });
    }
  } catch (error) {
    logger?.warn("permissions", "[approvals] could not update the store's taint marker", {
      storyId: opts.storyId,
      approvalsFile: opts.approvalsFile,
      forgeCapable: opts.forgeCapable,
      error,
    });
  }
}
