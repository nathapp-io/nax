// RE-ARCH: keep
/**
 * PRD Auto-Default Tests (US-006 / BUG-004)
 *
 * Tests for PRD loader auto-defaulting and router defensive fallbacks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config";
import { loadPRD, savePRD } from "../../src/prd";
import type { PRD } from "../../src/prd/types";
import { routeTask } from "../../src/routing";

describe("PRD Auto-Default (BUG-004)", () => {
  let testDir: string;
  let prdPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-test-prd-"));
    prdPath = join(testDir, "test-prd.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("loadPRD auto-defaults missing tags to []", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          // tags intentionally omitted
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        } as any, // Cast to bypass type check for missing field
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].tags).toEqual([]);
  });

  test("loadPRD auto-defaults missing status to pending", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          // status intentionally omitted
          passes: false,
          escalations: [],
          attempts: 0,
        } as any,
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].status).toBe("pending");
  });

  test("loadPRD auto-defaults missing acceptanceCriteria to []", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          // acceptanceCriteria intentionally omitted
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        } as any,
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].acceptanceCriteria).toEqual([]);
  });

  test("loadPRD auto-defaults missing storyPoints to 1", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
          // storyPoints intentionally omitted
        } as any,
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].storyPoints).toBe(1);
  });

  test("loadPRD preserves existing values", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1", "AC2"],
          tags: ["security", "auth"],
          dependencies: ["US-000"],
          status: "in-progress",
          passes: false,
          escalations: [],
          attempts: 2,
          storyPoints: 5,
        },
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].acceptanceCriteria).toEqual(["AC1", "AC2"]);
    expect(loaded.userStories[0].tags).toEqual(["security", "auth"]);
    expect(loaded.userStories[0].dependencies).toEqual(["US-000"]);
    expect(loaded.userStories[0].status).toBe("in-progress");
    expect(loaded.userStories[0].attempts).toBe(2);
    expect(loaded.userStories[0].storyPoints).toBe(5);
  });

  test("loadPRD does not modify PRD file on disk", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC1"],
          // tags intentionally omitted
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
        } as any,
      ],
    };

    await savePRD(prd, prdPath);
    const originalContent = await Bun.file(prdPath).text();

    // Load the PRD (which will auto-default in-memory)
    await loadPRD(prdPath);

    // Verify file content unchanged
    const afterLoadContent = await Bun.file(prdPath).text();
    expect(afterLoadContent).toBe(originalContent);
  });

  test("loadPRD handles all missing fields simultaneously", async () => {
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          // All optional fields omitted
          passes: false,
        } as any,
      ],
    };

    await savePRD(prd, prdPath);
    const loaded = await loadPRD(prdPath);

    expect(loaded.userStories[0].tags).toEqual([]);
    expect(loaded.userStories[0].status).toBe("pending");
    expect(loaded.userStories[0].acceptanceCriteria).toEqual([]);
    expect(loaded.userStories[0].dependencies).toEqual([]);
    expect(loaded.userStories[0].attempts).toBe(0);
    expect(loaded.userStories[0].priorErrors).toEqual([]);
    expect(loaded.userStories[0].escalations).toEqual([]);
    expect(loaded.userStories[0].storyPoints).toBe(1);
  });
});

describe("Router Tags Defensive Fallback (BUG-004)", () => {
  test("routeTask handles undefined tags gracefully", () => {
    const result = routeTask(
      "Fix typo",
      "Fix a typo in README",
      ["Typo fixed"],
      undefined as any, // Simulate missing tags
      DEFAULT_CONFIG,
    );

    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("routeTask handles null tags gracefully", () => {
    const result = routeTask(
      "Fix typo",
      "Fix a typo in README",
      ["Typo fixed"],
      null as any, // Simulate null tags
      DEFAULT_CONFIG,
    );

    expect(result.complexity).toBe("simple");
    expect(result.modelTier).toBe("fast");
    expect(result.testStrategy).toBe("three-session-tdd-lite");
  });

  test("routeTask with undefined tags does not crash on spread operation", () => {
    // This test specifically verifies line ~277 in router.ts doesn't crash
    expect(() => {
      routeTask("Add feature", "Add new feature", ["AC1", "AC2", "AC3"], undefined as any, DEFAULT_CONFIG);
    }).not.toThrow();
  });

  test("routeTask preserves existing tags behavior", () => {
    const result = routeTask("Auth fix", "Fix JWT auth bypass", ["Auth works"], ["security", "auth"], DEFAULT_CONFIG);

    expect(result.complexity).toBe("complex");
    expect(result.testStrategy).toBe("three-session-tdd");
    expect(result.reasoning).toContain("security-critical");
  });
});
