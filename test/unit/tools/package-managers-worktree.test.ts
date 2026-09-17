import { describe, expect, test } from "bun:test";
import type { NormalizeInput } from "@/tools";
import { normalizeExec } from "@/tools";

/**
 * Boundary invariant for Exec under worktree isolation (nax#2093): when
 * `repoRoot` is the story's worktree root — the value `storyExecRoot()` supplies
 * in `src/operations/call.ts` — cwd must stay inside `.nax-wt/<storyId>/` rather
 * than escaping to the main checkout. This pins the normalizeExec boundary, not
 * the producer; the producer seam itself is asserted in
 * test/unit/operations/call-coding-tool-repo-root-producer.test.ts.
 */
const worktreeRoot = "/repo/.nax-wt/US-003";

describe("Exec target repoRoot under worktree isolation (nax#2093)", () => {
  test("resolves cwd inside the story worktree, not the main checkout", () => {
    const input: NormalizeInput = {
      argv: ["bun", "install"],
      target: "repoRoot",
      repoRoot: worktreeRoot,
      packageWorkdir: `${worktreeRoot}/packages/api`,
      packageRelPath: "packages/api",
      allowScripts: false,
    };
    const result = normalizeExec(input);
    expect(result).toEqual({ argv: ["bun", "install", "--ignore-scripts"], cwd: worktreeRoot });
  });

  test("a root-level package does not collapse out of the worktree", () => {
    const input: NormalizeInput = {
      argv: ["bun", "install"],
      target: "package",
      repoRoot: worktreeRoot,
      packageWorkdir: worktreeRoot,
      packageRelPath: "",
      allowScripts: false,
    };
    const result = normalizeExec(input);
    expect(result).toEqual({ argv: ["bun", "install", "--ignore-scripts"], cwd: worktreeRoot });
  });
});
