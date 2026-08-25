/**
 * US-001: Manifest retention — purgeStaleManifests
 *
 * purgeStaleManifests() scans the project's `.nax/features/` tree for
 * `context-manifest-*.json` and `rebuild-manifest.json` files, and deletes
 * any whose mtime is older than `retentionDays`. After processing a story
 * dir it attempts a non-recursive directory removal on it.
 *
 * All I/O is injected via `_manifestPurgeDeps` for test isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _manifestPurgeDeps, MAX_MANIFEST_SCAN, purgeStaleManifests } from "@/context/engine";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origNow: typeof _manifestPurgeDeps.now;
let origScan: typeof _manifestPurgeDeps.scan;
let origStatMtime: typeof _manifestPurgeDeps.statMtime;
let origUnlink: typeof _manifestPurgeDeps.unlink;
let origRmdirIfEmpty: typeof _manifestPurgeDeps.rmdirIfEmpty;
let origDebugLog: typeof _manifestPurgeDeps.debugLog;

beforeEach(() => {
  origNow = _manifestPurgeDeps.now;
  origScan = _manifestPurgeDeps.scan;
  origStatMtime = _manifestPurgeDeps.statMtime;
  origUnlink = _manifestPurgeDeps.unlink;
  origRmdirIfEmpty = _manifestPurgeDeps.rmdirIfEmpty;
  origDebugLog = _manifestPurgeDeps.debugLog;
});

afterEach(() => {
  _manifestPurgeDeps.now = origNow;
  _manifestPurgeDeps.scan = origScan;
  _manifestPurgeDeps.statMtime = origStatMtime;
  _manifestPurgeDeps.unlink = origUnlink;
  _manifestPurgeDeps.rmdirIfEmpty = origRmdirIfEmpty;
  _manifestPurgeDeps.debugLog = origDebugLog;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/repo";
const NOW_MS = 1_700_000_000_000;
const DAY_MS = 86_400_000;

interface FakeManifest {
  /** Path relative to projectDir (the scan returns relative paths). */
  relPath: string;
  /** Absolute path on disk, used by statMtime and unlink. */
  absPath: string;
  /** Story dir (absolute), used for rmdirIfEmpty grouping. */
  storyDir: string;
  /** Age in days (negative = newer than now, positive = older than now). */
  ageDays: number;
}

function setupDefaults(manifests: FakeManifest[] = []) {
  _manifestPurgeDeps.now = () => NOW_MS;
  _manifestPurgeDeps.scan = async (_pattern: string, _cwd: string, _cap: number) => manifests.map((m) => m.relPath);
  _manifestPurgeDeps.statMtime = async (absPath: string) => {
    const m = manifests.find((x) => x.absPath === absPath);
    if (!m) throw new Error(`stat failed: ${absPath}`);
    return NOW_MS - m.ageDays * DAY_MS;
  };
  _manifestPurgeDeps.unlink = async () => {};
  _manifestPurgeDeps.rmdirIfEmpty = async () => true;
  _manifestPurgeDeps.debugLog = () => {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("purgeStaleManifests", () => {
  test("AC-4: returns 0 when no manifests are found", async () => {
    setupDefaults([]);
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(0);
  });

  test("AC-4: returns 0 when scan returns no entries (no .nax/features dir)", async () => {
    setupDefaults([]);
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(0);
  });

  test("AC-5: deletes context-manifest-*.json file older than retentionDays", async () => {
    const unlinked: string[] = [];
    const manifest: FakeManifest = {
      relPath: ".nax/features/feat-a/stories/US-001/context-manifest-review-semantic.json",
      absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-review-semantic.json",
      storyDir: "/repo/.nax/features/feat-a/stories/US-001",
      ageDays: 31,
    };
    setupDefaults([manifest]);
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(1);
    expect(unlinked).toContain(manifest.absPath);
  });

  test("AC-6: leaves context-manifest-*.json file present when within retention window", async () => {
    const unlinked: string[] = [];
    const manifest: FakeManifest = {
      relPath: ".nax/features/feat-a/stories/US-001/context-manifest-context.json",
      absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-context.json",
      storyDir: "/repo/.nax/features/feat-a/stories/US-001",
      ageDays: 29,
    };
    setupDefaults([manifest]);
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(0);
    expect(unlinked).toHaveLength(0);
  });

  test("AC-7: returns the number of manifest files it deleted", async () => {
    const unlinked: string[] = [];
    const manifests: FakeManifest[] = [
      {
        relPath: ".nax/features/feat-a/stories/US-001/context-manifest-1.json",
        absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-1.json",
        storyDir: "/repo/.nax/features/feat-a/stories/US-001",
        ageDays: 40,
      },
      {
        relPath: ".nax/features/feat-a/stories/US-001/context-manifest-2.json",
        absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-2.json",
        storyDir: "/repo/.nax/features/feat-a/stories/US-001",
        ageDays: 1,
      },
      {
        relPath: ".nax/features/feat-a/stories/US-002/rebuild-manifest.json",
        absPath: "/repo/.nax/features/feat-a/stories/US-002/rebuild-manifest.json",
        storyDir: "/repo/.nax/features/feat-a/stories/US-002",
        ageDays: 50,
      },
    ];
    setupDefaults(manifests);
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(2);
    expect(unlinked).toHaveLength(2);
  });

  test("AC-8: deletes rebuild-manifest.json older than retentionDays", async () => {
    const unlinked: string[] = [];
    const manifest: FakeManifest = {
      relPath: ".nax/features/feat-a/stories/US-003/rebuild-manifest.json",
      absPath: "/repo/.nax/features/feat-a/stories/US-003/rebuild-manifest.json",
      storyDir: "/repo/.nax/features/feat-a/stories/US-003",
      ageDays: 31,
    };
    setupDefaults([manifest]);
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(1);
    expect(unlinked).toContain(manifest.absPath);
  });

  test("AC-9: leaves a manifest on disk when statMtime throws", async () => {
    const unlinked: string[] = [];
    setupDefaults([]);
    _manifestPurgeDeps.scan = async () => [".nax/features/feat-a/stories/US-001/context-manifest-context.json"];
    _manifestPurgeDeps.statMtime = async () => {
      throw new Error("EACCES");
    };
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(0);
    expect(unlinked).toHaveLength(0);
  });

  test("AC-10: excludes a manifest from the count when statMtime throws", async () => {
    setupDefaults([]);
    _manifestPurgeDeps.scan = async () => [
      ".nax/features/feat-a/stories/US-001/context-manifest-context.json",
      ".nax/features/feat-a/stories/US-002/context-manifest-context.json",
    ];
    let callCount = 0;
    _manifestPurgeDeps.statMtime = async (absPath: string) => {
      callCount++;
      if (callCount === 1) throw new Error("EACCES");
      return NOW_MS - 31 * DAY_MS;
    };
    const unlinked: string[] = [];
    _manifestPurgeDeps.unlink = async (path: string) => {
      unlinked.push(path);
    };
    const count = await purgeStaleManifests(PROJECT_DIR, 30);
    expect(count).toBe(1);
    expect(unlinked).toHaveLength(1);
  });

  test("AC-11: removes the story directory after deleting the last manifest", async () => {
    const rmdirs: string[] = [];
    const manifest: FakeManifest = {
      relPath: ".nax/features/feat-a/stories/US-001/context-manifest-context.json",
      absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-context.json",
      storyDir: "/repo/.nax/features/feat-a/stories/US-001",
      ageDays: 31,
    };
    setupDefaults([manifest]);
    _manifestPurgeDeps.unlink = async () => {};
    _manifestPurgeDeps.rmdirIfEmpty = async (storyDir: string) => {
      rmdirs.push(storyDir);
      return true;
    };
    await purgeStaleManifests(PROJECT_DIR, 30);
    expect(rmdirs).toContain("/repo/.nax/features/feat-a/stories/US-001");
  });

  test("AC-12: leaves story directory in place when a non-manifest file remains", async () => {
    const rmdirs: Array<{ dir: string; removed: boolean }> = [];
    const manifest: FakeManifest = {
      relPath: ".nax/features/feat-a/stories/US-001/context-manifest-context.json",
      absPath: "/repo/.nax/features/feat-a/stories/US-001/context-manifest-context.json",
      storyDir: "/repo/.nax/features/feat-a/stories/US-001",
      ageDays: 31,
    };
    setupDefaults([manifest]);
    _manifestPurgeDeps.unlink = async () => {};
    _manifestPurgeDeps.rmdirIfEmpty = async (storyDir: string) => {
      rmdirs.push({ dir: storyDir, removed: false });
      return false;
    };
    await purgeStaleManifests(PROJECT_DIR, 30);
    expect(rmdirs).toHaveLength(1);
    expect(rmdirs[0]?.removed).toBe(false);
  });

  test("AC-13: stops examining entries at MAX_MANIFEST_SCAN and emits debug log", async () => {
    const debugLogs: Array<{ stage: string; message: string; data?: unknown }> = [];
    const seen: string[] = [];
    _manifestPurgeDeps.now = () => NOW_MS;
    _manifestPurgeDeps.scan = async (_pattern: string, _cwd: string, _cap: number): Promise<string[]> => {
      const results: string[] = [];
      for (let i = 0; i < MAX_MANIFEST_SCAN + 10; i++) {
        const rel = `.nax/features/feat-a/stories/US-${String(i).padStart(3, "0")}/context-manifest-context.json`;
        results.push(rel);
      }
      return results;
    };
    _manifestPurgeDeps.statMtime = async (absPath: string) => {
      seen.push(absPath);
      return NOW_MS - 31 * DAY_MS;
    };
    _manifestPurgeDeps.unlink = async () => {};
    _manifestPurgeDeps.rmdirIfEmpty = async () => true;
    _manifestPurgeDeps.debugLog = (stage, message, data) => {
      debugLogs.push({ stage, message, data });
    };
    await purgeStaleManifests(PROJECT_DIR, 30);
    expect(seen.length).toBeLessThanOrEqual(MAX_MANIFEST_SCAN);
    expect(debugLogs.some((l) => l.message.includes(String(MAX_MANIFEST_SCAN)))).toBe(true);
  });

  test("scan is called with cwd=projectDir and a positive cap", async () => {
    const calls: Array<{ pattern: string; cwd: string; cap: number }> = [];
    setupDefaults([]);
    _manifestPurgeDeps.scan = async (pattern, cwd, cap) => {
      calls.push({ pattern, cwd, cap });
      return [];
    };
    await purgeStaleManifests(PROJECT_DIR, 30);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(PROJECT_DIR);
    expect(calls[0]?.cap).toBeGreaterThan(0);
    expect(calls[0]?.pattern).toContain(".nax/features");
  });
});
