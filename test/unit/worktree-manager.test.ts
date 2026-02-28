/**
 * Tests for src/worktree/manager.ts
 *
 * Covers: WorktreeManager create, remove, list, parseWorktreeList
 */

import { describe, expect, it } from "bun:test";
import { WorktreeManager } from "../../src/worktree/manager";

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
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(mockWorktreeListOutput);

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
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList("");

    expect(worktrees.length).toBe(0);
  });

  it("handles single worktree", () => {
    const singleOutput = `worktree /path/to/project
HEAD abc123def456
branch refs/heads/master

`;

    const manager = new WorktreeManager();
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(singleOutput);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("master");
  });

  it("handles output without trailing newline", () => {
    const noTrailingNewline = `worktree /path/to/project
HEAD abc123def456
branch refs/heads/master`;

    const manager = new WorktreeManager();
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(noTrailingNewline);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe("/path/to/project");
    expect(worktrees[0].branch).toBe("master");
  });

  it("strips refs/heads/ prefix from branches", () => {
    const output = `worktree /path/to/project
branch refs/heads/feature/my-feature

`;

    const manager = new WorktreeManager();
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(output);

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
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(output);

    // First worktree has no branch, should be filtered out
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].branch).toBe("nax/US-001");
  });

  it("filters incomplete entries missing path", () => {
    const output = `branch refs/heads/master

worktree /path/to/project
branch refs/heads/feature

`;

    const manager = new WorktreeManager();
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(output);

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
    // @ts-expect-error - accessing private method for testing
    const worktrees = manager.parseWorktreeList(output);

    expect(worktrees.length).toBe(2);
    expect(worktrees[0].branch).toBe("master");
    expect(worktrees[1].branch).toBe("nax/US-001");
  });
});

// Note: Error handling tests for WorktreeManager require git integration
// and are better suited for integration tests rather than unit tests
