import { describe, expect, test } from "bun:test";
import { PINNED_BASE_NOTE, renderCheckoutState } from "@/prompts";

const base = { phase: "fresh", headSha: "abcdef1234567890", setup: [], ciFiles: [] } as const;
const warning =
  "Git-ignored outputs (generated code, build output, caches) may be missing. If a check fails for missing setup, run the setup steps CI runs (see the CI config files); changes to git-ignored files are kept and are not part of your commit.";

const pinnedNote =
  "Agent configuration (CLAUDE.md, AGENTS.md and the other instruction files, .claude/, .mcp.json and each agent's config directory) holds the base branch's versions for this session; nax restores the PR's versions afterwards. Do not edit, stage or commit those files.";

describe("renderCheckoutState", () => {
  test("pinned AC-9 appends the pinned note as the last line", () => {
    expect(PINNED_BASE_NOTE).toBe(pinnedNote);
    expect(
      renderCheckoutState({ ...base, pinnedBase: true })
        .split("\n")
        .at(-1),
    ).toBe(PINNED_BASE_NOTE);
  });
  test("pinned AC-10 omits the pinned note by default", () => {
    expect(renderCheckoutState(base).split("\n")).not.toContain(pinnedNote);
  });
  test("AC-5/6: barrel export renders fresh checkout with exactly the short SHA", () => {
    const text = renderCheckoutState(base);
    expect(text.split("\n")[0]).toBe(
      "This is a fresh git worktree of the PR head abcdef1: tracked files plus the setup below.",
    );
    expect(text).not.toContain(base.headSha);
  });
  test("AC-7: renders the after-fix checkout", () => {
    expect(renderCheckoutState({ ...base, phase: "after-fix" }).split("\n")[0]).toBe(
      "This git worktree holds the fix commit on top of the PR head abcdef1, plus the setup below.",
    );
  });
  test.each([
    { setup: ["bun install"], expected: "Setup nax ran: bun install — all succeeded" },
    {
      setup: ["bun install", "bun run codegen"],
      expected: "Setup nax ran: bun install, bun run codegen — all succeeded",
    },
    {
      setup: ["bun install"],
      setupFailed: "bun install",
      expected: "Setup nax ran: bun install — failed at bun install",
    },
    { setup: [], expected: "Setup nax ran: none" },
  ])("AC-8/9/10: $expected", ({ expected, ...input }) => {
    expect(renderCheckoutState({ ...base, ...input }).split("\n")[1]).toBe(expected);
  });
  test.each([
    { ciFiles: [".github/workflows/ci.yml"], expected: "CI config files: .github/workflows/ci.yml" },
    {
      ciFiles: [".github/workflows/ci.yml", ".gitlab-ci.yml"],
      expected: "CI config files: .github/workflows/ci.yml, .gitlab-ci.yml",
    },
    { ciFiles: [], expected: "CI config files: none found" },
  ])("AC-11/12: $expected", ({ ciFiles, expected }) => {
    expect(renderCheckoutState({ ...base, ciFiles }).split("\n")[2]).toBe(expected);
  });
  test.each(["fresh", "after-fix"] as const)("AC-13: always includes setup guidance for %s", (phase) => {
    for (const setup of [[], ["bun install"]]) {
      const lines = renderCheckoutState({ ...base, phase, setup }).split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[3]).toBe(warning);
    }
  });
});
