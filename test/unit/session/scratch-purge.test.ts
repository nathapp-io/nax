/**
 * AC-20: Session scratch retention — purgeStaleScratch
 *
 * purgeStaleScratch() scans <projectDir>/.nax/features/<featureName>/sessions/,
 * reads each session's descriptor.json for lastActivityAt, and:
 *   - Deletes dirs older than retentionDays (default behaviour)
 *   - Moves to _archive/sessions/<id> when archiveInsteadOfDelete=true
 *
 * All I/O is injected via _scratchPurgeDeps for test isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _scratchPurgeDeps, purgeStaleScratch } from "../../../src/session/scratch-purge";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origListSessionDirs: typeof _scratchPurgeDeps.listSessionDirs;
let origFileExists: typeof _scratchPurgeDeps.fileExists;
let origReadFile: typeof _scratchPurgeDeps.readFile;
let origRemove: typeof _scratchPurgeDeps.remove;
let origMove: typeof _scratchPurgeDeps.move;
let origNow: typeof _scratchPurgeDeps.now;

beforeEach(() => {
  origListSessionDirs = _scratchPurgeDeps.listSessionDirs;
  origFileExists = _scratchPurgeDeps.fileExists;
  origReadFile = _scratchPurgeDeps.readFile;
  origRemove = _scratchPurgeDeps.remove;
  origMove = _scratchPurgeDeps.move;
  origNow = _scratchPurgeDeps.now;
});

afterEach(() => {
  _scratchPurgeDeps.listSessionDirs = origListSessionDirs;
  _scratchPurgeDeps.fileExists = origFileExists;
  _scratchPurgeDeps.readFile = origReadFile;
  _scratchPurgeDeps.remove = origRemove;
  _scratchPurgeDeps.move = origMove;
  _scratchPurgeDeps.now = origNow;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const NOW_MS = 1_000_000_000_000; // fixed "now"
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

interface FakeSession {
  id: string;
  lastActivityAt: string;
}

function setupDeps(sessions: FakeSession[], removed: string[] = [], moved: Array<[string, string]> = []) {
  _scratchPurgeDeps.now = () => NOW_MS;
  _scratchPurgeDeps.listSessionDirs = async () => sessions.map((s) => s.id);
  _scratchPurgeDeps.fileExists = async (path: string) => {
    return sessions.some((s) => path.includes(s.id));
  };
  _scratchPurgeDeps.readFile = async (path: string) => {
    const session = sessions.find((s) => path.includes(s.id));
    if (!session) throw new Error(`file not found: ${path}`);
    return JSON.stringify({ lastActivityAt: session.lastActivityAt });
  };
  _scratchPurgeDeps.remove = async (path: string) => {
    removed.push(path);
  };
  _scratchPurgeDeps.move = async (src: string, dest: string) => {
    moved.push([src, dest]);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("purgeStaleScratch", () => {
  test("returns 0 when no session dirs exist", async () => {
    setupDeps([]);
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
  });

  test("returns 0 when all sessions are within retention window", async () => {
    setupDeps([
      { id: "sess-aaa", lastActivityAt: daysAgo(3) },
      { id: "sess-bbb", lastActivityAt: daysAgo(6) },
    ]);
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
  });

  test("deletes session dir when lastActivityAt is older than retentionDays", async () => {
    const removed: string[] = [];
    setupDeps([{ id: "sess-old", lastActivityAt: daysAgo(10) }], removed);
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("sess-old");
  });

  test("skips sessions exactly at the retention boundary (age < retentionDays)", async () => {
    const removed: string[] = [];
    // exactly 7 days ago — not yet expired (boundary is strictly >)
    setupDeps([{ id: "sess-boundary", lastActivityAt: daysAgo(7) }], removed);
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
    expect(removed).toHaveLength(0);
  });

  test("returns count of deleted sessions", async () => {
    const removed: string[] = [];
    setupDeps(
      [
        { id: "sess-old1", lastActivityAt: daysAgo(8) },
        { id: "sess-new", lastActivityAt: daysAgo(2) },
        { id: "sess-old2", lastActivityAt: daysAgo(14) },
      ],
      removed,
    );
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(2);
    expect(removed).toHaveLength(2);
  });

  test("moves to _archive/ when archiveInsteadOfDelete=true", async () => {
    const moved: Array<[string, string]> = [];
    setupDeps([{ id: "sess-old", lastActivityAt: daysAgo(10) }], [], moved);
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7, true);
    expect(count).toBe(1);
    expect(moved).toHaveLength(1);
    const [src, dest] = moved[0]!;
    expect(src).toContain("sess-old");
    expect(dest).toContain("_archive");
    expect(dest).toContain("sess-old");
  });

  test("archive destination path: <projectDir>/.nax/features/<feature>/_archive/sessions/<id>", async () => {
    const moved: Array<[string, string]> = [];
    setupDeps([{ id: "sess-abc", lastActivityAt: daysAgo(9) }], [], moved);
    await purgeStaleScratch(PROJECT_DIR, FEATURE, 7, true);
    const [_src, dest] = moved[0]!;
    expect(dest).toBe(`${PROJECT_DIR}/.nax/features/${FEATURE}/_archive/sessions/sess-abc`);
  });

  test("does not call remove when archiveInsteadOfDelete=true", async () => {
    const removed: string[] = [];
    setupDeps([{ id: "sess-old", lastActivityAt: daysAgo(10) }], removed);
    await purgeStaleScratch(PROJECT_DIR, FEATURE, 7, true);
    expect(removed).toHaveLength(0);
  });

  test("skips session dir when descriptor.json does not exist", async () => {
    _scratchPurgeDeps.now = () => NOW_MS;
    _scratchPurgeDeps.listSessionDirs = async () => ["sess-nodesc"];
    _scratchPurgeDeps.fileExists = async () => false;
    _scratchPurgeDeps.readFile = async () => {
      throw new Error("should not be called");
    };
    const removed: string[] = [];
    _scratchPurgeDeps.remove = async (path: string) => {
      removed.push(path);
    };
    _scratchPurgeDeps.move = async () => {};
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
    expect(removed).toHaveLength(0);
  });

  test("skips session dir with unparseable descriptor.json", async () => {
    _scratchPurgeDeps.now = () => NOW_MS;
    _scratchPurgeDeps.listSessionDirs = async () => ["sess-bad"];
    _scratchPurgeDeps.fileExists = async () => true;
    _scratchPurgeDeps.readFile = async () => "NOT JSON {{{";
    const removed: string[] = [];
    _scratchPurgeDeps.remove = async (path: string) => {
      removed.push(path);
    };
    _scratchPurgeDeps.move = async () => {};
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
    expect(removed).toHaveLength(0);
  });

  test("skips session dir with missing lastActivityAt in descriptor", async () => {
    _scratchPurgeDeps.now = () => NOW_MS;
    _scratchPurgeDeps.listSessionDirs = async () => ["sess-nots"];
    _scratchPurgeDeps.fileExists = async () => true;
    _scratchPurgeDeps.readFile = async () => JSON.stringify({ id: "sess-nots" });
    const removed: string[] = [];
    _scratchPurgeDeps.remove = async (path: string) => {
      removed.push(path);
    };
    _scratchPurgeDeps.move = async () => {};
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(0);
    expect(removed).toHaveLength(0);
  });

  test("processes only sessions older than retentionDays — mixed batch", async () => {
    const removed: string[] = [];
    setupDeps(
      [
        { id: "sess-fresh", lastActivityAt: daysAgo(1) },
        { id: "sess-stale1", lastActivityAt: daysAgo(8) },
        { id: "sess-stale2", lastActivityAt: daysAgo(30) },
        { id: "sess-recent", lastActivityAt: daysAgo(6) },
      ],
      removed,
    );
    const count = await purgeStaleScratch(PROJECT_DIR, FEATURE, 7);
    expect(count).toBe(2);
    expect(removed.some((p) => p.includes("sess-stale1"))).toBe(true);
    expect(removed.some((p) => p.includes("sess-stale2"))).toBe(true);
    expect(removed.every((p) => !p.includes("sess-fresh"))).toBe(true);
    expect(removed.every((p) => !p.includes("sess-recent"))).toBe(true);
  });
});
