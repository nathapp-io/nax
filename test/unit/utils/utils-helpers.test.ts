// RE-ARCH: keep
/**
 * Tests for src/execution/helpers.ts
 *
 * Covers: hookCtx, getAllReadyStories, acquireLock, releaseLock, formatProgress
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type StoryCounts,
  acquireLock,
  formatProgress,
  getAllReadyStories,
  hookCtx,
  releaseLock,
} from "@/execution/helpers";
import type { PRD, UserStory } from "@/prd";
import { makeTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockStory = (
  id: string,
  passes: boolean,
  status: "pending" | "skipped",
  dependencies: string[] = [],
): UserStory => ({
  id,
  title: `Story ${id}`,
  description: `Description for ${id}`,
  acceptanceCriteria: [],
  dependencies,
  passes,
  status,
  estimatedComplexity: "medium",
});

const createMockPRD = (stories: UserStory[]): PRD => ({
  feature: "test-feature",
  userStories: stories,
});

// ─────────────────────────────────────────────────────────────────────────────
// hookCtx
// ─────────────────────────────────────────────────────────────────────────────

describe("hookCtx", () => {
  it("creates ctx with minimal args, merges optional fields, overrides defaults", () => {
    const minimal = hookCtx("my-feature");
    expect(minimal.event).toBe("on-start");
    expect(minimal.feature).toBe("my-feature");

    const withOpts = hookCtx("my-feature", { storyId: "US-001", cost: 0.42 });
    expect(withOpts.storyId).toBe("US-001");
    expect(withOpts.cost).toBe(0.42);

    expect(hookCtx("my-feature", { storyId: "US-999" }).storyId).toBe("US-999");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllReadyStories
// ─────────────────────────────────────────────────────────────────────────────

describe("getAllReadyStories", () => {
  it("returns pending stories with no dependencies", () => {
    const prd = createMockPRD([mockStory("US-001", false, "pending"), mockStory("US-002", false, "pending")]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(2);
    expect(ready.map((s) => s.id)).toEqual(["US-001", "US-002"]);
  });

  it("excludes stories that already passed", () => {
    const prd = createMockPRD([mockStory("US-001", true, "pending"), mockStory("US-002", false, "pending")]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("US-002");
  });

  it("excludes skipped stories", () => {
    const prd = createMockPRD([mockStory("US-001", false, "skipped"), mockStory("US-002", false, "pending")]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("US-002");
  });

  it("includes stories whose dependencies are complete", () => {
    const prd = createMockPRD([
      mockStory("US-001", true, "pending"),
      mockStory("US-002", false, "pending", ["US-001"]),
    ]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("US-002");
  });

  it("excludes stories with unsatisfied dependencies", () => {
    const prd = createMockPRD([
      mockStory("US-001", false, "pending"),
      mockStory("US-002", false, "pending", ["US-001"]),
    ]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("US-001");
  });

  it("handles complex dependency chains", () => {
    const prd = createMockPRD([
      mockStory("US-001", true, "pending"),
      mockStory("US-002", true, "pending", ["US-001"]),
      mockStory("US-003", false, "pending", ["US-001", "US-002"]),
      mockStory("US-004", false, "pending", ["US-002"]),
    ]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(2);
    expect(ready.map((s) => s.id).sort()).toEqual(["US-003", "US-004"]);
  });

  it("returns empty array when all stories are complete", () => {
    const prd = createMockPRD([mockStory("US-001", true, "pending"), mockStory("US-002", true, "pending")]);

    const ready = getAllReadyStories(prd);
    expect(ready.length).toBe(0);
  });

  it("handles skipped dependencies correctly", () => {
    const prd = createMockPRD([
      mockStory("US-001", false, "skipped"),
      mockStory("US-002", false, "pending", ["US-001"]),
    ]);

    const ready = getAllReadyStories(prd);
    // US-002 is ready because US-001 is skipped (treated as complete)
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("US-002");
  });

  it("external deps: fulfilled when missing from PRD; ready when internal done; blocked when internal not done", () => {
    // external-only dep is treated as fulfilled
    const extOnly = createMockPRD([mockStory("US-001", false, "pending", ["VCS-P2-001"])]);
    const extOnlyReady = getAllReadyStories(extOnly);
    expect(extOnlyReady.length).toBe(1);
    expect(extOnlyReady[0].id).toBe("US-001");

    // mixed: external + internal (done) → ready
    const mixDone = createMockPRD([
      mockStory("US-001", true, "pending"),
      mockStory("US-002", false, "pending", ["EXT-PHASE1-001", "US-001"]),
    ]);
    const mixDoneReady = getAllReadyStories(mixDone);
    expect(mixDoneReady.length).toBe(1);
    expect(mixDoneReady[0].id).toBe("US-002");

    // mixed: external + internal (not done) → blocked
    const mixBlocked = createMockPRD([
      mockStory("US-001", false, "pending"),
      mockStory("US-002", false, "pending", ["EXT-PHASE1-001", "US-001"]),
    ]);
    expect(getAllReadyStories(mixBlocked).map((s) => s.id)).toEqual(["US-001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// acquireLock / releaseLock
// ─────────────────────────────────────────────────────────────────────────────

describe("acquireLock / releaseLock", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for lock tests
    testDir = makeTempDir("nax-test-");
  });

  afterEach(async () => {
    // Clean up lock file and test directory
    await releaseLock(testDir);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("acquire → locked (no double-acquire) → release → reacquire lifecycle", async () => {
    const lockPath = path.join(testDir, "nax.lock");
    expect(await acquireLock(testDir)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(await acquireLock(testDir)).toBe(false);
    await releaseLock(testDir);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await acquireLock(testDir)).toBe(true);
  });

  it("removes stale lock from dead process", async () => {
    // Create a lock with a non-existent PID
    const lockPath = path.join(testDir, "nax.lock");
    const staleLock = {
      pid: 999999, // Non-existent process
      timestamp: Date.now() - 1000000,
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock));

    // Should acquire lock by removing stale lock
    const acquired = await acquireLock(testDir);
    expect(acquired).toBe(true);
  });

  it("handles non-existent directory gracefully during release", async () => {
    const nonExistentDir = path.join(os.tmpdir(), "nax-nonexistent");
    await expect(releaseLock(nonExistentDir)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatProgress
// ─────────────────────────────────────────────────────────────────────────────

describe("formatProgress", () => {
  it("formats progress with all stories pending", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 0,
      failed: 0,
      pending: 12,
    };

    const progress = formatProgress(counts, 0, 5.0, 0, 12);
    expect(progress).toContain("0/12 stories");
    expect(progress).toContain("0 passed");
    expect(progress).toContain("0 failed");
    expect(progress).toContain("$0.00/$5.00");
    expect(progress).toContain("calculating...");
  });

  it("formats progress with some completed stories", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 5,
      failed: 1,
      pending: 6,
    };

    const progress = formatProgress(counts, 0.45, 5.0, 600000, 12);
    expect(progress).toContain("6/12 stories");
    expect(progress).toContain("5 passed");
    expect(progress).toContain("1 failed");
    expect(progress).toContain("$0.45/$5.00");
    expect(progress).toContain("min remaining");
  });

  it("formats progress when all stories complete", () => {
    const counts: StoryCounts = {
      total: 12,
      passed: 10,
      failed: 2,
      pending: 0,
    };

    const progress = formatProgress(counts, 4.5, 5.0, 3600000, 12);
    expect(progress).toContain("12/12 stories");
    expect(progress).toContain("10 passed");
    expect(progress).toContain("2 failed");
    expect(progress).toContain("$4.50/$5.00");
    expect(progress).toContain("complete");
  });

  it("calculates ETA correctly; handles zero elapsed time", () => {
    // 5 completed in 600000ms = ~10 min remaining for 5 more
    expect(formatProgress({ total: 10, passed: 5, failed: 0, pending: 5 }, 1.0, 5.0, 600000, 10)).toContain(
      "~10 min remaining",
    );
    expect(formatProgress({ total: 10, passed: 1, failed: 0, pending: 9 }, 0.1, 5.0, 0, 10)).toContain(
      "~0 min remaining",
    );
  });
});
