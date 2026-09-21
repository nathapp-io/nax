/**
 * buildRunId — run-attribution helper for the "Run attribution across
 * checkouts" story (US-005).
 *
 * Two worktrees of one project can both produce `run-<iso>` IDs at the same
 * ISO timestamp and clobber each other's log file and status.json. A single
 * producer keyed on (workdir hash, timestamp) makes the ID unique per
 * checkout while keeping filename safety (no path separators).
 *
 * AC-3: buildRunId returns different identifiers for two working directories
 *       that share a basename but differ in their absolute paths, given the
 *       same timestamp.
 * AC-4: buildRunId returns the same identifier for the same working
 *       directory and timestamp.
 * AC-5: buildRunId returns an identifier retaining millisecond precision
 *       from its timestamp.
 * AC-6: buildRunId returns an identifier containing no path separator and
 *       no character outside [A-Za-z0-9._-].
 */

import { describe, expect, test } from "bun:test";
import { buildRunId } from "@/execution/run-id";

describe("buildRunId — US-005 workdir-aware run ID", () => {
  test("AC-3: returns different identifiers for two workdirs that share a basename but differ in absolute path", () => {
    const now = new Date("2026-02-25T10:00:00.123Z");
    const idA = buildRunId("/Users/william/worktrees/repo-feat-a", now);
    const idB = buildRunId("/Users/william/worktrees/repo-feat-b", now);
    expect(idA).not.toBe(idB);
  });

  test("AC-3: also produces different IDs when only the parent directory differs", () => {
    const now = new Date("2026-02-25T10:00:00.123Z");
    // Same basename ("repo"), different parent dirs.
    const idA = buildRunId("/Users/william/parentA/repo", now);
    const idB = buildRunId("/Users/william/parentB/repo", now);
    expect(idA).not.toBe(idB);
  });

  test("AC-4: returns the same identifier for the same workdir and timestamp", () => {
    const now = new Date("2026-02-25T10:00:00.123Z");
    const idA = buildRunId("/Users/william/worktrees/repo", now);
    const idB = buildRunId("/Users/william/worktrees/repo", now);
    expect(idA).toBe(idB);
  });

  test("AC-4: returns the same identifier regardless of equivalent path forms", () => {
    const now = new Date("2026-02-25T10:00:00.123Z");
    // Trailing slashes / slashes that path.normalize would have folded.
    const idA = buildRunId("/Users/william/worktrees/repo", now);
    const idB = buildRunId("/Users/william/worktrees/repo/", now);
    expect(idA).toBe(idB);
  });

  test("AC-5: identifier retains millisecond precision from the timestamp", () => {
    const base = new Date("2026-02-25T10:00:00.000Z");
    const plus1 = new Date("2026-02-25T10:00:00.001Z");
    const plus10 = new Date("2026-02-25T10:00:00.010Z");
    const plus100 = new Date("2026-02-25T10:00:00.100Z");
    const id0 = buildRunId("/workdir/repo", base);
    const id1 = buildRunId("/workdir/repo", plus1);
    const id10 = buildRunId("/workdir/repo", plus10);
    const id100 = buildRunId("/workdir/repo", plus100);
    // Every one must differ — the implementation cannot collapse to second
    // resolution, because then two runs 1ms apart at the same workdir would
    // collide and clobber each other's log file.
    expect(id1).not.toBe(id0);
    expect(id10).not.toBe(id0);
    expect(id100).not.toBe(id0);
    expect(id1).not.toBe(id10);
    expect(id10).not.toBe(id100);
  });

  test("AC-6: identifier contains no path separator", () => {
    const id = buildRunId("/Users/william/worktrees/repo", new Date("2026-02-25T10:00:00.123Z"));
    expect(id).not.toContain("/");
    expect(id).not.toContain("\\");
  });

  test("AC-6: identifier contains no character outside [A-Za-z0-9._-]", () => {
    const id = buildRunId("/Users/william/worktrees/repo", new Date("2026-02-25T10:00:00.123Z"));
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("AC-6: safety character class holds for any reasonable workdir string", () => {
    // Even when the workdir is given in a form the implementation might try
    // to embed in the ID directly, the result must still match the safe
    // character class — the spec disallows using the basename because two
    // worktrees can share one (e.g. `git worktree add ../repo-feat`).
    const now = new Date("2026-02-25T10:00:00.123Z");
    const id = buildRunId("/weird/space dir/with-symbols!@#", now);
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id).not.toContain("/");
  });
});
