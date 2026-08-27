// RE-ARCH: keep
/**
 * Tests for src/worktree/manager.ts
 *
 * Covers: WorktreeManager create, remove, list, parseWorktreeList
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { WorktreeManager } from "@/worktree/manager";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockWorktreeListOutput = `worktree /path/to/project
HEAD abc123def456
branch refs/heads/master

worktree /path/to/project/.nax-wt/US-001
HEAD 123456abcdef
branch refs/heads/nax/US-001

worktree /path/to/project/.nax-wt/US-002
HEAD 789012abcdef
branch refs/heads/nax/US-002

`;

// ─────────────────────────────────────────────────────────────────────────────
// WorktreeManager.parseWorktreeList
// ─────────────────────────────────────────────────────────────────────────────

describe("WorktreeManager.parseWorktreeList", () => {
  it("parses git worktree list --porcelain output", () => {
    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](mockWorktreeListOutput);

    expect(worktrees.length).toBe(3);

    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("master");

    expect(worktrees[1].path).toBe("/path/to/project/.nax-wt/US-001");
    expect(worktrees[1].branch).toBe("nax/US-001");

    expect(worktrees[2].path).toBe("/path/to/project/.nax-wt/US-002");
    expect(worktrees[2].branch).toBe("nax/US-002");
  });

  it("handles empty output", () => {
    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"]("");

    expect(worktrees.length).toBe(0);
  });

  it("handles single worktree", () => {
    const singleOutput = `worktree /path/to/project
HEAD abc123def456
branch refs/heads/master

`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](singleOutput);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("master");
  });

  it("handles output without trailing newline", () => {
    const noTrailingNewline = `worktree /path/to/project
HEAD abc123def456
branch refs/heads/master`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](noTrailingNewline);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("master");
  });

  it("strips refs/heads/ prefix from branches", () => {
    const output = `worktree /path/to/project
branch refs/heads/feature/my-feature

`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](output);

    expect(worktrees[0].branch).toBe("feature/my-feature");
  });

  it("handles worktrees with detached HEAD", () => {
    const output = `worktree /path/to/project
HEAD abc123def456

worktree /path/to/project/.nax-wt/US-001
HEAD 123456abcdef
branch refs/heads/nax/US-001

`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](output);

    // BUG-24 (D-17): detached-HEAD worktrees are kept with branch: null
    // rather than silently dropped. Rebase/bisect worktrees would otherwise
    // vanish from list() and their leaked dirs would compound MEM-6.
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBeNull();
    expect(worktrees[1].branch).toBe("nax/US-001");
  });

  it("filters incomplete entries missing path", () => {
    const output = `branch refs/heads/master

worktree /path/to/project
branch refs/heads/feature

`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](output);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("feature");
  });

  it("handles multiple empty lines between entries", () => {
    const output = `worktree /path/to/project
branch refs/heads/master


worktree /path/to/project/.nax-wt/US-001
branch refs/heads/nax/US-001

`;

    const manager = new WorktreeManager();
    const worktrees = manager["parseWorktreeList"](output);

    expect(worktrees.length).toBe(2);
    expect(worktrees[0].branch).toBe("master");
    expect(worktrees[1].branch).toBe("nax/US-001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorktreeManager.ensureGitExcludes
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure file I/O (mkdir + a path-file-locked read-modify-write of
// .git/info/exclude) — no real git repo required, so this belongs at unit
// scope alongside parseWorktreeList rather than only in the integration
// suite's git-backed fixtures.

describe("WorktreeManager.ensureGitExcludes", () => {
  let projectRoot: string;

  it("creates .git/info/exclude with nax entries when absent", async () => {
    projectRoot = makeTempDir("worktree-excludes-");
    try {
      const manager = new WorktreeManager();
      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(projectRoot, ".git", "info", "exclude");
      const content = await Bun.file(excludePath).text();
      for (const entry of NAX_GITIGNORE_ENTRIES) {
        expect(content).toContain(entry);
      }
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  it("is idempotent — a second call does not duplicate entries", async () => {
    projectRoot = makeTempDir("worktree-excludes-");
    try {
      const manager = new WorktreeManager();
      await manager.ensureGitExcludes(projectRoot);
      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(projectRoot, ".git", "info", "exclude");
      const content = await Bun.file(excludePath).text();
      for (const entry of NAX_GITIGNORE_ENTRIES) {
        const occurrences = content.split("\n").filter((line) => line.trim() === entry).length;
        expect(occurrences).toBe(1);
      }
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  // BUG-39: `existing.includes(entry)` used to treat a substring match (e.g.
  // an existing `/foo/runs/` line) as covering a distinct shorter entry
  // (`runs/`), silently skipping it. Line-aware matching must not do that.
  it("does not skip an entry that is only a substring of an existing line", async () => {
    projectRoot = makeTempDir("worktree-excludes-");
    try {
      const [firstEntry] = NAX_GITIGNORE_ENTRIES;
      const infoDir = join(projectRoot, ".git", "info");
      await Bun.write(join(infoDir, "exclude"), `/some/prefix/${firstEntry}\n`);

      const manager = new WorktreeManager();
      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(infoDir, "exclude");
      const content = await Bun.file(excludePath).text();
      const exactLine = content.split("\n").some((line) => line.trim() === firstEntry);
      expect(exactLine).toBe(true);
    } finally {
      cleanupTempDir(projectRoot);
    }
  });

  it("preserves pre-existing unrelated exclude entries", async () => {
    projectRoot = makeTempDir("worktree-excludes-");
    try {
      const infoDir = join(projectRoot, ".git", "info");
      await Bun.write(join(infoDir, "exclude"), "*.local\n");

      const manager = new WorktreeManager();
      await manager.ensureGitExcludes(projectRoot);

      const excludePath = join(infoDir, "exclude");
      const content = await Bun.file(excludePath).text();
      expect(content).toContain("*.local");
    } finally {
      cleanupTempDir(projectRoot);
    }
  });
});

// Note: Error handling tests for WorktreeManager require git integration
// and are better suited for integration tests rather than unit tests
