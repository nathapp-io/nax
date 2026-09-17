import { describe, expect, test } from "bun:test";
import { buildAgentScopeSection } from "@/prompts/sections/agent-scope";

describe("buildAgentScopeSection", () => {
  test("returns undefined when there is no root", () => {
    expect(buildAgentScopeSection(undefined, "/repo")).toBeUndefined();
    expect(buildAgentScopeSection("   ", "/repo")).toBeUndefined();
  });

  test("names the package and how to spell paths for it", () => {
    const out = buildAgentScopeSection("/repo/packages/api", "/repo");
    expect(out).toContain("packages/api");
    expect(out).toContain("src/index.ts");
    expect(out).toContain("never `packages/api/src/index.ts`");
  });

  test("says the whole repo is reachable when rooted at the repo", () => {
    const out = buildAgentScopeSection("/repo", "/repo");
    expect(out).toContain("repository root");
    expect(out).not.toContain("cannot be opened");
  });

  test("names the bare package when repoRoot is the worktree root (nax#2093)", () => {
    // The production shape after #2103: `tool-preamble.ts` passes the story's
    // worktree root as repoRoot, so the relative path never carries `.nax-wt`.
    const out = buildAgentScopeSection("/repo/.nax-wt/US-001/packages/api", "/repo/.nax-wt/US-001");
    expect(out).toContain("packages/api");
    expect(out).not.toContain(".nax-wt");
    expect(out).not.toContain("US-001");
  });

  test("defensively strips a worktree prefix when repoRoot is the main checkout", () => {
    // Defence-in-depth, not a production shape: a regression that re-pointed
    // repoRoot back at the main checkout would produce exactly this pair. The
    // strip keeps the scratch path out of the prompt if that ever happens.
    const out = buildAgentScopeSection("/repo/.nax-wt/US-001/packages/api", "/repo");
    expect(out).toContain("packages/api");
    expect(out).not.toContain(".nax-wt");
    expect(out).not.toContain("US-001");
  });

  test("strips a repo-root-relative prefix only for a multi-segment label", () => {
    // A single-segment label doubles as the first segment of a package-relative
    // path (`api/openapi.yaml`), so the instruction would delete a real prefix.
    const single = buildAgentScopeSection("/repo/api", "/repo");
    expect(single).not.toContain("starts with `api/`");

    const nested = buildAgentScopeSection("/repo/packages/api", "/repo");
    expect(nested).toContain("starts with `packages/api/`");
  });

  test("falls back to the root itself when no repo root is given", () => {
    expect(buildAgentScopeSection("/repo/packages/api", undefined)).toContain("packages/api");
  });
});
