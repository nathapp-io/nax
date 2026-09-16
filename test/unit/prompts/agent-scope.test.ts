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

  test("strips the worktree prefix so the label is the package, not the scratch path", () => {
    const out = buildAgentScopeSection("/repo/.nax-wt/US-001/packages/api", "/repo");
    expect(out).toContain("packages/api");
    expect(out).not.toContain(".nax-wt");
    expect(out).not.toContain("US-001");
  });

  test("falls back to the root itself when no repo root is given", () => {
    expect(buildAgentScopeSection("/repo/packages/api", undefined)).toContain("packages/api");
  });
});
