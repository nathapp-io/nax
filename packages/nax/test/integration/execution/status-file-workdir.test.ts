/**
 * Status File — run.workdir propagation (US-005)
 *
 * The run snapshot must carry the workdir that produced it, so external
 * readers (TUI, `nax status`) can attribute which checkout wrote a given
 * status.json without parsing log lines.
 *
 * AC-1: The status snapshot written for a run carries `run.workdir` equal to
 *       that run's working directory.
 * AC-2: Reading a status file whose `run` object has no `workdir` field
 *       resolves without throwing and reports the workdir as unknown.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { makePRD, makeStory, makeTempDir } from "@test/helpers";
import {
  buildStatusSnapshot,
  type NaxStatusFile,
  type RunStateSnapshot,
  writeStatusFile,
} from "@/execution/status-file";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
  return {
    runId: "run-2026-02-25T10-00-00-000Z",
    feature: "auth-refactor",
    startedAt: "2026-02-25T10:00:00.000Z",
    runStatus: "running",
    dryRun: false,
    pid: process.pid,
    prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "pending" })] }),
    totalCost: 0,
    costLimit: 5.0,
    currentStory: null,
    iterations: 0,
    startTimeMs: Date.now() - 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: snapshot.run.workdir equals the run's workdir
// ---------------------------------------------------------------------------

describe("buildStatusSnapshot — run.workdir propagation (US-005 AC-1)", () => {
  test("AC-1: snapshot.run.workdir equals state.workdir when provided", () => {
    const workdir = "/Users/william/worktrees/repo-feat-a";
    const snapshot = buildStatusSnapshot(makeRunState({ workdir }));

    expect(snapshot.run.workdir).toBe(workdir);
  });

  test("AC-1: snapshot.run.workdir is absent on disk when state.workdir is not provided", () => {
    // Pre-existing status files written before US-005 must round-trip
    // through `writeStatusFile` without erroring and without fabricating a
    // workdir — readers tolerate absence, so an explicit `undefined` must
    // NOT be written into the JSON.
    const snapshot = buildStatusSnapshot(makeRunState());
    expect(Object.hasOwn(snapshot.run, "workdir")).toBe(false);
  });

  test("AC-1: writeStatusFile round-trips snapshot.run.workdir unchanged", async () => {
    const dir = makeTempDir("nax-status-workdir-");
    try {
      const workdir = "/Users/william/worktrees/repo-feat-a";
      const outPath = join(dir, "status.json");
      const snapshot = buildStatusSnapshot(makeRunState({ workdir }));

      await writeStatusFile(outPath, snapshot);

      expect(existsSync(outPath)).toBe(true);
      const parsed: NaxStatusFile = JSON.parse(readFileSync(outPath, "utf8"));
      expect(parsed.run.workdir).toBe(workdir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("AC-1: a status file written before US-005 (no run.workdir) still parses", async () => {
    // The status file is a hand-crafted pre-US-005 file. Parsing it
    // must not throw — readers tolerate the field's absence.
    const dir = makeTempDir("nax-status-legacy-");
    try {
      const legacyPath = join(dir, "status.json");
      const legacy = {
        version: 1,
        run: {
          id: "run-2026-02-25T10-00-00-000Z",
          feature: "auth-refactor",
          startedAt: "2026-02-25T10:00:00.000Z",
          status: "running",
          dryRun: false,
          pid: 12345,
        },
        progress: { total: 0, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 0 },
        cost: { spent: 0, limit: null },
        current: null,
        iterations: 0,
        updatedAt: "2026-02-25T10:00:00.000Z",
        durationMs: 0,
      };
      writeFileSync(legacyPath, JSON.stringify(legacy));

      const parsed: NaxStatusFile = JSON.parse(readFileSync(legacyPath, "utf8"));

      // Reading must not throw. The optional `workdir` field is absent on
      // pre-existing files; readers must report it as "unknown" rather than
      // crashing on the missing property.
      expect(parsed.run.workdir).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
