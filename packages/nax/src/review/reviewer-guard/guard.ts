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
  /** Sessions currently inside the snapshot; re-registering one id is a no-op. */
  readonly ids: Set<string>;
}

export class ReviewerTreeGuard {
  private readonly active = new Map<string, Entry>();
  private readonly keyBySession = new Map<string, string>();
  /** Per-toplevel restore in flight; a new snapshot must wait for it to settle. */
  private readonly restoring = new Map<string, Promise<void>>();

  async beforeTurn(desc: SessionDescriptor): Promise<void> {
    if (!REVIEWER_SESSION_ROLES.has(desc.role)) return;
    try {
      const key = await _reviewerGuardDeps.toplevel(desc.workdir);
      for (let pending = this.restoring.get(key); pending !== undefined; pending = this.restoring.get(key)) {
        await pending;
      }
      this.keyBySession.set(desc.id, key);
      const entry = this.active.get(key);
      if (entry !== undefined) {
        entry.ids.add(desc.id);
        await entry.snapshot;
        return;
      }
      const snapshot = _reviewerGuardDeps.take(key).catch((err: unknown) => {
        this.unguarded(desc, key, err);
        return undefined;
      });
      this.active.set(key, { snapshot, ids: new Set([desc.id]) });
      // The turn must not start until the snapshot is captured, or its edits could land in it.
      await snapshot;
    } catch (err) {
      this.unguarded(desc, this.keyBySession.get(desc.id), err);
    }
  }

  async afterTurn(desc: SessionDescriptor): Promise<void> {
    const key = this.keyBySession.get(desc.id);
    if (key === undefined) return;
    this.keyBySession.delete(desc.id);
    const entry = this.active.get(key);
    if (entry === undefined) return;
    entry.ids.delete(desc.id);
    if (entry.ids.size > 0) return;
    this.active.delete(key);
    const restore = this.restoreEntry(desc, entry).finally(() => this.restoring.delete(key));
    this.restoring.set(key, restore);
    await restore;
  }

  private async restoreEntry(desc: SessionDescriptor, entry: Entry): Promise<void> {
    try {
      const snap = await entry.snapshot;
      if (snap === undefined) return;
      const report = await _reviewerGuardDeps.restore(snap);
      const touched =
        report.paths.length > 0 ||
        report.indexRestored ||
        report.headRestored ||
        report.refsLeft.length > 0 ||
        report.stashLeft.length > 0 ||
        report.failures.length > 0;
      if (touched) {
        getSafeLogger()?.warn("review", "reviewer-tree-reverted", {
          storyId: desc.storyId,
          role: desc.role,
          paths: report.paths,
          indexRestored: report.indexRestored,
          headRestored: report.headRestored,
          refsLeft: report.refsLeft,
          stashLeft: report.stashLeft,
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

  /**
   * A failed snapshot leaves the turn running without a restore (nax#2500 R16: accepted,
   * refusing the turn is out of scope), so it is logged at ERROR rather than WARN.
   */
  private unguarded(desc: SessionDescriptor, toplevel: string | undefined, err: unknown): void {
    getSafeLogger()?.error("review", "reviewer-guard-unguarded-turn", {
      storyId: desc.storyId,
      role: desc.role,
      toplevel,
      error: errorMessage(err),
    });
  }

  private warn(desc: SessionDescriptor, what: string, err: unknown): void {
    getSafeLogger()?.warn("review", `[WARN] reviewer guard: ${what}`, {
      storyId: desc.storyId,
      role: desc.role,
      error: errorMessage(err),
    });
  }
}
