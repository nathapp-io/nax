/**
 * Unit tests for src/context/engine/stage-assembler.ts — disk-backed session
 * scratch discovery (Finding 2 from the Context Engine v2 architecture review).
 *
 * Tests call `discoverSessionScratchDirsOnDisk` directly so the return value
 * is observable. The helper is exported from stage-assembler for this purpose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _stageAssemblerDeps,
  discoverSessionScratchDirsOnDisk,
  resolvePackageBudget,
} from "../../../../src/context/engine/stage-assembler";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = Date.parse("2026-04-17T12:00:00.000Z");
const WITHIN_TTL_ISO = "2026-04-17T10:00:00.000Z"; // 2h ago
const OUTSIDE_TTL_ISO = "2026-04-17T00:00:00.000Z"; // 12h ago
const TTL_4H = 4 * 60 * 60 * 1000;

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY = "US-001";
const SESSIONS_ROOT = `${PROJECT_DIR}/.nax/features/${FEATURE}/sessions`;

// ─────────────────────────────────────────────────────────────────────────────

describe("discoverSessionScratchDirsOnDisk — Finding 2", () => {
  let originalReaddir: typeof _stageAssemblerDeps.readdir;
  let originalReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let originalNow: typeof _stageAssemblerDeps.now;

  beforeEach(() => {
    originalReaddir = _stageAssemblerDeps.readdir;
    originalReadDescriptor = _stageAssemblerDeps.readDescriptor;
    originalNow = _stageAssemblerDeps.now;
    _stageAssemblerDeps.now = () => FIXED_NOW;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = originalReaddir;
    _stageAssemblerDeps.readDescriptor = originalReadDescriptor;
    _stageAssemblerDeps.now = originalNow;
  });

  test("returns scratch dirs for all descriptors matching storyId and within TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-a", "sess-b"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-a")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-a`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      if (path.includes("sess-b")) {
        return {
          storyId: STORY,
          scratchDir: `${SESSIONS_ROOT}/sess-b`,
          lastActivityAt: WITHIN_TTL_ISO,
        };
      }
      return null;
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toHaveLength(2);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-a`);
    expect(result).toContain(`${SESSIONS_ROOT}/sess-b`);
  });

  test("skips descriptors for a different story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-mine", "sess-theirs"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-mine")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-mine`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: "US-002", scratchDir: `${SESSIONS_ROOT}/sess-theirs`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-mine`]);
  });

  test("skips descriptors older than TTL", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-fresh", "sess-stale"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-fresh")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-fresh`, lastActivityAt: WITHIN_TTL_ISO };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-stale`, lastActivityAt: OUTSIDE_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-fresh`]);
  });

  test("returns empty when the sessions directory does not exist", async () => {
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    _stageAssemblerDeps.readDescriptor = async () => {
      throw new Error("should not be called");
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("skips malformed descriptors without throwing", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-broken", "sess-good"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-broken")) throw new Error("unexpected token in JSON");
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-good`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-good`]);
  });

  test("skips descriptors missing scratchDir", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-partial", "sess-full"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-partial")) return { storyId: STORY, lastActivityAt: WITHIN_TTL_ISO };
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-full`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-full`]);
  });

  test("skips descriptors with unparseable lastActivityAt", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-baddate", "sess-gooddate"];
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      if (path.includes("sess-baddate")) {
        return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-baddate`, lastActivityAt: "not-a-date" };
      }
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-gooddate`, lastActivityAt: WITHIN_TTL_ISO };
    };

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([`${SESSIONS_ROOT}/sess-gooddate`]);
  });

  test("skips descriptors missing lastActivityAt entirely", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-nodate"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: STORY,
      scratchDir: `${SESSIONS_ROOT}/sess-nodate`,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });

  test("reads descriptors under the correct sessions path", async () => {
    const calls: string[] = [];
    _stageAssemblerDeps.readdir = async (path: string) => {
      calls.push(`readdir:${path}`);
      return ["sess-a"];
    };
    _stageAssemblerDeps.readDescriptor = async (path: string) => {
      calls.push(`readDescriptor:${path}`);
      return { storyId: STORY, scratchDir: `${SESSIONS_ROOT}/sess-a`, lastActivityAt: WITHIN_TTL_ISO };
    };

    await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(calls[0]).toBe(`readdir:${SESSIONS_ROOT}`);
    expect(calls[1]).toBe(`readDescriptor:${SESSIONS_ROOT}/sess-a/descriptor.json`);
  });

  test("returns empty when no descriptors match the story", async () => {
    _stageAssemblerDeps.readdir = async () => ["sess-other"];
    _stageAssemblerDeps.readDescriptor = async () => ({
      storyId: "US-999",
      scratchDir: `${SESSIONS_ROOT}/sess-other`,
      lastActivityAt: WITHIN_TTL_ISO,
    });

    const result = await discoverSessionScratchDirsOnDisk(PROJECT_DIR, FEATURE, STORY, TTL_4H);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-59: resolvePackageBudget
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePackageBudget — AC-59 per-package stage budgets", () => {
  const DEFAULT = 8_000;
  const REPO_ROOT = "/repo";

  test("returns default budget when packageBudgets is empty", () => {
    const result = resolvePackageBudget({}, "/repo", REPO_ROOT, "execution", DEFAULT);
    expect(result).toBe(DEFAULT);
  });

  test("returns default budget for non-monorepo (packageDir === repoRoot)", () => {
    const budgets = { "": { execution: 15_000 } };
    const result = resolvePackageBudget(budgets, "/repo", REPO_ROOT, "execution", DEFAULT);
    expect(result).toBe(15_000);
  });

  test("returns package override when matching package path and stage", () => {
    const budgets = { "packages/api": { execution: 15_000 } };
    const result = resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "execution", DEFAULT);
    expect(result).toBe(15_000);
  });

  test("returns default when package is known but stage has no override", () => {
    const budgets = { "packages/api": { execution: 15_000 } };
    const result = resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "tdd-implementer", DEFAULT);
    expect(result).toBe(DEFAULT);
  });

  test("returns default when package is not in packageBudgets", () => {
    const budgets = { "packages/api": { execution: 15_000 } };
    const result = resolvePackageBudget(budgets, "/repo/packages/core", REPO_ROOT, "execution", DEFAULT);
    expect(result).toBe(DEFAULT);
  });

  test("different packages get independent overrides", () => {
    const budgets = {
      "packages/api": { execution: 15_000 },
      "packages/core": { execution: 6_000 },
    };
    expect(resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "execution", DEFAULT)).toBe(15_000);
    expect(resolvePackageBudget(budgets, "/repo/packages/core", REPO_ROOT, "execution", DEFAULT)).toBe(6_000);
  });

  test("different stages get independent overrides for same package", () => {
    const budgets = { "packages/api": { execution: 15_000, "tdd-implementer": 10_000 } };
    expect(resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "execution", DEFAULT)).toBe(15_000);
    expect(resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "tdd-implementer", DEFAULT)).toBe(10_000);
    expect(resolvePackageBudget(budgets, "/repo/packages/api", REPO_ROOT, "verify", DEFAULT)).toBe(DEFAULT);
  });
});
