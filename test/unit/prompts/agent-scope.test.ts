import { describe, expect, test } from "bun:test";
import { buildAgentScopeSection } from "@/prompts/sections/agent-scope";

/**
 * Single-frame redesign PR2: root === repoRoot after the move, so the package
 * identity comes from the new third parameter (`workdirLabel` =
 * `storyWorkdir(story)`), not from a root/repoRoot difference that no longer
 * exists. These tests render the section and assert its exact text.
 */
describe("buildAgentScopeSection", () => {
  test("returns undefined when there is no root", () => {
    expect(buildAgentScopeSection(undefined, "/repo", "packages/api")).toBeUndefined();
    expect(buildAgentScopeSection("   ", "/repo", "packages/api")).toBeUndefined();
  });

  test("roots a package story's tools at the repo root and spells paths repo-rooted", () => {
    const out = buildAgentScopeSection("/repo", "/repo", "packages/api");
    const expected = [
      "## Your file scope",
      "",
      "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root, NOT at your package.",
      "Your story's package is `packages/api`. Spell every path repo-rooted from the repository root: write",
      "`packages/api/src/index.ts`, never `src/index.ts`.",
      "",
      "Declared commands (via RunCommand) still run inside `packages/api` — only the file tools' path frame changed.",
      "You can read and, per your write authorization, edit files outside your package if a task genuinely requires it — say so rather than guessing at another package's contents from its name alone.",
    ].join("\n");
    expect(out).toBe(expected);
  });

  test("treats a repo-root story as having no package distinction", () => {
    const expected = [
      "## Your file scope",
      "",
      "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root.",
      "Every path you pass them is resolved from there.",
    ].join("\n");
    for (const label of [".", undefined, "   "] as const) {
      expect(buildAgentScopeSection("/repo", "/repo", label)).toBe(expected);
    }
  });
});
