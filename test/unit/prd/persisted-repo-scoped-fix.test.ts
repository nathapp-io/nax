/**
 * PersistedRepoScopedFix Unit Tests (US-001 / #1654)
 *
 * Covers the durable PRD shape for repo-scoped repairs and its alignment
 * with the reset branch that already clears `storyGitRef`. The test file is
 * intentionally split from `prd-reset-failed.test.ts` because the round-trip
 * and absent-field behavior live in the loader, not the reset function.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadPRD, resetFailedStoriesToPending, savePRD } from "@/prd";
import type { PRD, PersistedRepoScopedFix, UserStory } from "@/prd/types";
import { makePRD, makeStory, makeTempDir } from "@test/helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFix(overrides: Partial<PersistedRepoScopedFix> = {}): PersistedRepoScopedFix {
  return {
    triggeringTests: ["src/foo.test.ts::reproduces bug"],
    filesChanged: ["src/foo.ts"],
    findingsCleared: true,
    ...overrides,
  };
}

function makePrdWithStories(stories: UserStory[]): PRD {
  return makePRD({ userStories: stories });
}

// ── AC1: round-trip via savePRD / loadPRD ─────────────────────────────────────

describe("PersistedRepoScopedFix — savePRD / loadPRD round-trip (AC1)", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-prsrf-");
    prdPath = join(testDir, "prd.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("savePRD then loadPRD preserves a single PersistedRepoScopedFix deep-equals", async () => {
    const fix = makeFix();
    const prd = makePrdWithStories([
      makeStory({ id: "US-001", status: "passed", passes: true, repoScopedFixes: [fix] }),
    ]);

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toEqual([fix]);
  });

  test("savePRD then loadPRD preserves multiple fixes in order", async () => {
    const fixA = makeFix({ triggeringTests: ["a.test.ts::t1"], filesChanged: ["src/a.ts"] });
    const fixB = makeFix({
      triggeringTests: ["b.test.ts::t2"],
      filesChanged: ["src/b.ts"],
      findingsCleared: false,
    });
    const prd = makePrdWithStories([
      makeStory({ id: "US-001", status: "passed", passes: true, repoScopedFixes: [fixA, fixB] }),
    ]);

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toEqual([fixA, fixB]);
    expect(loaded.userStories[0].repoScopedFixes?.[1].findingsCleared).toBe(false);
  });
});

// ── AC2: absent-field behavior ────────────────────────────────────────────────

describe("PersistedRepoScopedFix — loadPRD absent-field behavior (AC2)", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-prsrf-");
    prdPath = join(testDir, "prd.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("loadPRD leaves repoScopedFixes undefined when omitted from disk", async () => {
    const prd = makePrdWithStories([makeStory({ id: "US-001", status: "failed" })]);
    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toBeUndefined();
  });

  test("loadPRD leaves repoScopedFixes undefined for every story when none carry the field", async () => {
    const prd = makePrdWithStories([
      makeStory({ id: "US-001", status: "pending" }),
      makeStory({ id: "US-002", status: "passed", passes: true }),
    ]);
    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].repoScopedFixes).toBeUndefined();
    expect(loaded.userStories[1].repoScopedFixes).toBeUndefined();
  });
});

// ── AC3: resetFailedStoriesToPending({ resetRef: true }) clears repoScopedFixes ─

describe("PersistedRepoScopedFix — resetFailedStoriesToPending invariant (AC3/AC4/AC5/AC6)", () => {
  test("AC3: resetRef=true clears repoScopedFixes on every reset story", () => {
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "failed",
        storyGitRef: "abc123",
        repoScopedFixes: [makeFix()],
      }),
      makeStory({
        id: "US-002",
        status: "failed",
        storyGitRef: "def456",
        repoScopedFixes: [
          makeFix({ triggeringTests: ["x.test.ts::y"], filesChanged: ["src/x.ts"], findingsCleared: false }),
        ],
      }),
    ]);

    resetFailedStoriesToPending(prd, { resetRef: true });

    expect(prd.userStories[0].repoScopedFixes).toBeUndefined();
    expect(prd.userStories[0].storyGitRef).toBeUndefined();
    expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("AC4: storyIsolation='worktree' with default resetRef clears repoScopedFixes", () => {
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "failed",
        storyGitRef: "abc123",
        repoScopedFixes: [makeFix()],
      }),
    ]);

    resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });

    expect(prd.userStories[0].repoScopedFixes).toBeUndefined();
    expect(prd.userStories[0].storyGitRef).toBeUndefined();
  });

  test("AC5: empty opts leaves repoScopedFixes untouched on failed stories", () => {
    const fix = makeFix();
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "failed",
        storyGitRef: "abc123",
        repoScopedFixes: [fix],
      }),
    ]);

    resetFailedStoriesToPending(prd, {});

    expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
  });

  test("AC5: shared isolation (legacy default) leaves repoScopedFixes untouched", () => {
    const fix = makeFix();
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "failed",
        storyGitRef: "abc123",
        repoScopedFixes: [fix],
      }),
    ]);

    resetFailedStoriesToPending(prd, { storyIsolation: "shared" });

    expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
  });

  test("AC6: resetRef=true leaves repoScopedFixes untouched on passed stories", () => {
    const fix = makeFix();
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "passed",
        passes: true,
        storyGitRef: "abc123",
        repoScopedFixes: [fix],
      }),
      makeStory({
        id: "US-002",
        status: "failed",
        storyGitRef: "def456",
        repoScopedFixes: [makeFix()],
      }),
    ]);

    resetFailedStoriesToPending(prd, { resetRef: true });

    expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
    expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });

  test("worktree isolation leaves repoScopedFixes untouched on passed stories", () => {
    const fix = makeFix();
    const prd = makePrdWithStories([
      makeStory({
        id: "US-001",
        status: "passed",
        passes: true,
        storyGitRef: "abc123",
        repoScopedFixes: [fix],
      }),
      makeStory({
        id: "US-002",
        status: "failed",
        storyGitRef: "def456",
        repoScopedFixes: [makeFix()],
      }),
    ]);

    resetFailedStoriesToPending(prd, { storyIsolation: "worktree" });

    expect(prd.userStories[0].repoScopedFixes).toEqual([fix]);
    expect(prd.userStories[0].storyGitRef).toBe("abc123");
    expect(prd.userStories[1].repoScopedFixes).toBeUndefined();
    expect(prd.userStories[1].storyGitRef).toBeUndefined();
  });
});
