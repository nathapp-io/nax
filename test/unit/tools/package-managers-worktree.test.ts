import { describe, expect, test } from "bun:test";
import { storyExecRoot } from "@/runtime/packages";
import type { NormalizeInput } from "@/tools";
import { normalizeExec } from "@/tools";

/**
 * Boundary invariant for Exec under worktree isolation (nax#2093): when
 * `repoRoot` is the story's worktree root — the value `storyExecRoot()` supplies
 * in `src/operations/call.ts` — cwd must stay inside `.nax-wt/<storyId>/` rather
 * than escaping to the main checkout. The producer seam itself is asserted in
 * test/unit/operations/call-coding-tool-root-producer.test.ts.
 */
const mainCheckout = "/repo";
// Derived from the real producer rather than hardcoded: a hardcoded worktree
// root would keep this suite green on the very #2093 regression it guards.
const worktreeRoot = storyExecRoot({ repoRoot: mainCheckout, packageDir: ".nax-wt/US-003/packages/api" });

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
    expect(result).toEqual({ argv: ["bun", "install", "--ignore-scripts"], cwd: "/repo/.nax-wt/US-003" });
    // Producer coupling: `storyExecRoot()` must not hand back the main checkout.
    expect(worktreeRoot).toBe("/repo/.nax-wt/US-003");
  });

  test("a repo-root package collapses the package target to the worktree root", () => {
    // `packageRelPath === ""` means the story IS the repo root, so BOTH targets
    // collapse to repoRoot (src/tools/package-managers.ts:363-366). Keeping
    // packageWorkdir distinct from repoRoot is what makes this detect the
    // collapse: with the two equal, the cwd ternary's branches yield the same
    // string and the assertion cannot fail.
    const input: NormalizeInput = {
      argv: ["bun", "install"],
      target: "package",
      repoRoot: worktreeRoot,
      packageWorkdir: "/repo/.nax-wt/US-003/packages/api",
      packageRelPath: "",
      allowScripts: false,
    };
    const result = normalizeExec(input);
    expect(result).toEqual({ argv: ["bun", "install", "--ignore-scripts"], cwd: "/repo/.nax-wt/US-003" });
  });
});
