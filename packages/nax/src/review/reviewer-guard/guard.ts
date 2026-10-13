/**
 * nax#2500: reviewer turns may run Bash; whatever they change in the repository is
 * restored after the turn. Reviewers can run concurrently in one checkout (finish
 * spec + branch review), so the snapshot is shared per git toplevel: the first
 * reviewer in takes it, the last one out restores it. Never throws.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { SessionDescriptor } from "@/session";
import { runHardenedGit } from "@/utils/hardened-git";
import { guardGitError } from "./deps";
import { type RepoSnapshot, restoreRepoSnapshot, takeRepoSnapshot } from "./snapshot";

export const REVIEWER_SESSION_ROLES: ReadonlySet<string> = new Set([
  "reviewer-semantic",
  "reviewer-adversarial",
  "finish-review-spec",
  "finish-review-quality",
  "wf-story-review",
  "wf-rereview",
  "wf-branch-review",
]);

export const _reviewerGuardDeps = {
  take: takeRepoSnapshot,
  restore: restoreRepoSnapshot,
  toplevel: async (workdir: string): Promise<string> => {
    const r = await runHardenedGit(["rev-parse", "--show-toplevel"], workdir);
    if (r.exitCode !== 0)
      throw guardGitError(["rev-parse", "--show-toplevel"], workdir, r.stderr || "not a git repository");
    return r.stdout.trim();
  },
};

interface Entry {
  readonly snapshot: Promise<RepoSnapshot | undefined>;
  count: number;
}

export class ReviewerTreeGuard {
  private readonly active = new Map<string, Entry>();
  private readonly keyBySession = new Map<string, string>();

  async beforeTurn(desc: SessionDescriptor): Promise<void> {
    if (!REVIEWER_SESSION_ROLES.has(desc.role)) return;
    try {
      const key = await _reviewerGuardDeps.toplevel(desc.workdir);
      this.keyBySession.set(desc.id, key);
      const entry = this.active.get(key);
      if (entry !== undefined) {
        entry.count += 1;
        await entry.snapshot;
        return;
      }
      const snapshot = _reviewerGuardDeps.take(key).catch((err: unknown) => {
        this.warn(desc, "snapshot failed", err);
        return undefined;
      });
      this.active.set(key, { snapshot, count: 1 });
      // The turn must not start until the snapshot is captured, or its edits could land in it.
      await snapshot;
    } catch (err) {
      this.warn(desc, "snapshot failed", err);
    }
  }

  async afterTurn(desc: SessionDescriptor): Promise<void> {
    const key = this.keyBySession.get(desc.id);
    if (key === undefined) return;
    this.keyBySession.delete(desc.id);
    const entry = this.active.get(key);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.active.delete(key);
    try {
      const snap = await entry.snapshot;
      if (snap === undefined) return;
      const report = await _reviewerGuardDeps.restore(snap);
      const touched =
        report.paths.length > 0 ||
        report.indexRestored ||
        report.headRestored ||
        report.stashesDropped > 0 ||
        report.failures.length > 0;
      if (touched) {
        getSafeLogger()?.warn("review", "reviewer-tree-reverted", {
          storyId: desc.storyId,
          role: desc.role,
          paths: report.paths,
          indexRestored: report.indexRestored,
          headRestored: report.headRestored,
          stashesDropped: report.stashesDropped,
          failures: report.failures,
        });
      }
      if (report.failures.length > 0) {
        getSafeLogger()?.warn("review", "[WARN] reviewer guard: restore incomplete", {
          storyId: desc.storyId,
          role: desc.role,
          failures: report.failures,
        });
      }
    } catch (err) {
      this.warn(desc, "restore failed", err);
    }
  }

  private warn(desc: SessionDescriptor, what: string, err: unknown): void {
    getSafeLogger()?.warn("review", `[WARN] reviewer guard: ${what}`, {
      storyId: desc.storyId,
      role: desc.role,
      error: errorMessage(err),
    });
  }
}
