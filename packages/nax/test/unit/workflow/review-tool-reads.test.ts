/**
 * US-005 — which changed files a review session's tool calls actually showed the model.
 *
 * The branch reviewer self-reports `inspectedFiles`; a `Read` or a `git diff` that ran and returned a
 * whole result is the same evidence, observed rather than claimed. These tests pin the extraction
 * only — no I/O, no config (the loader arrives in US-006).
 */
import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import { normalizeReviewPath } from "@/operations";
import { TOOL_READ_CREDIT_MAX_BYTES, toolReadPaths } from "@/workflow/review-tool-reads";

const AT = "2026-01-01T00:00:00.000Z";

/** A successful, whole-result call of `tool` with `input`. */
function call(tool: string, input: Record<string, unknown>, overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return { tool, outcome: "ok", input, resultBytes: 120, at: AT, truncated: false, ...overrides };
}

function read(path: string, overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return call("Read", { path }, overrides);
}

describe("toolReadPaths — Read", () => {
  test("credits the path of a whole-file read (AC-1)", () => {
    expect(toolReadPaths([read("src/a.ts")], "/repo")).toEqual(["src/a.ts"]);
  });

  test("a denied read credits nothing (AC-2)", () => {
    expect(toolReadPaths([read("src/a.ts", { outcome: "denied" })], "/repo")).toEqual([]);
  });

  test("a repo-absolute read credits its repo-relative path (AC-3)", () => {
    expect(toolReadPaths([read("/repo/src/a.ts")], "/repo")).toEqual(["src/a.ts"]);
  });

  test("a read outside the repository credits nothing (AC-4)", () => {
    expect(toolReadPaths([read("/other/x.ts")], "/repo")).toEqual([]);
  });

  test("a read with a line limit credits nothing — it saw a slice (AC-18)", () => {
    expect(toolReadPaths([call("Read", { path: "src/a.ts", limit: 120 })], "/repo")).toEqual([]);
  });

  test("a read with an offset credits nothing — a ranged read did not show the whole file (AC-19)", () => {
    expect(toolReadPaths([call("Read", { path: "src/a.ts", offset: 40 })], "/repo")).toEqual([]);
  });
});

describe("toolReadPaths — Git", () => {
  test("credits every path a diff names (AC-5)", () => {
    const git = call("Git", { subcommand: "diff", refs: ["s..HEAD"], paths: ["src/a.ts", "src/b.ts"] });
    expect(toolReadPaths([git], "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a name-only diff shows no content, so it credits nothing (AC-6)", () => {
    expect(toolReadPaths([call("Git", { subcommand: "diff", nameOnly: true, paths: ["src/a.ts"] })], "/repo")).toEqual(
      [],
    );
  });
});

describe("toolReadPaths — Bash", () => {
  test("credits the paths a git diff lists after -- (AC-7)", () => {
    const bash = call("Bash", { command: "git diff s..HEAD -- src/a.ts src/b.ts" });
    expect(toolReadPaths([bash], "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("carries a cd across segments and accepts rtk git diff (AC-8)", () => {
    const bash = call("Bash", {
      command: "cd apps/api; B=abc; rtk git diff $B..HEAD -- src/x.ts prisma/schema.prisma",
    });
    expect(toolReadPaths([bash], "/repo")).toEqual(["apps/api/src/x.ts", "apps/api/prisma/schema.prisma"]);
  });

  test("a name-only diff credits nothing (AC-9)", () => {
    expect(toolReadPaths([call("Bash", { command: "git diff --name-only s..HEAD -- src/a.ts" })], "/repo")).toEqual([]);
  });

  test("a pipe truncates the segment, not the credit (AC-10)", () => {
    expect(toolReadPaths([call("Bash", { command: "git diff s..HEAD -- src/a.ts | head -150" })], "/repo")).toEqual([
      "src/a.ts",
    ]);
  });

  test("a glob or a variable is not a path, so it credits nothing (AC-11)", () => {
    expect(toolReadPaths([call("Bash", { command: "git diff s..HEAD -- 'src/*.ts' $F" })], "/repo")).toEqual([]);
  });

  test("a command that shows no diff credits nothing (AC-12)", () => {
    expect(toolReadPaths([call("Bash", { command: "cat src/a.ts" })], "/repo")).toEqual([]);
  });

  test("quoted paths are unquoted before they are credited (AC-14)", () => {
    const bash = call("Bash", { command: `git diff s..HEAD -- 'src/a.ts' "src/b.ts"` });
    expect(toolReadPaths([bash], "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a word whose quote never closes is dropped", () => {
    const bash = call("Bash", { command: "git diff s..HEAD -- 'src/a.ts" });
    expect(toolReadPaths([bash], "/repo")).toEqual([]);
  });
});

describe("toolReadPaths — dedupe and result size", () => {
  test("a path two calls both read is credited once (AC-13)", () => {
    const git = call("Git", { subcommand: "diff", paths: ["src/a.ts"] });
    expect(toolReadPaths([read("src/a.ts"), git], "/repo")).toEqual(["src/a.ts"]);
  });

  test("first-appearance order is kept across calls", () => {
    const git = call("Git", { subcommand: "diff", paths: ["src/b.ts", "src/a.ts"] });
    expect(toolReadPaths([read("src/a.ts"), git], "/repo")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a result at the cap credits its paths, one byte over credits none (AC-16)", () => {
    const at = call("Git", { subcommand: "diff", paths: ["src/a.ts"] }, { resultBytes: TOOL_READ_CREDIT_MAX_BYTES });
    const over = call(
      "Git",
      { subcommand: "diff", paths: ["src/a.ts"] },
      { resultBytes: TOOL_READ_CREDIT_MAX_BYTES + 1 },
    );
    expect(toolReadPaths([at], "/repo")).toEqual(["src/a.ts"]);
    expect(toolReadPaths([over], "/repo")).toEqual([]);
  });

  test("a truncated bash diff credits nothing (AC-17)", () => {
    const bash = call(
      "Bash",
      { command: "git diff s..HEAD -- src/a.ts" },
      { resultBytes: TOOL_READ_CREDIT_MAX_BYTES + 1 },
    );
    expect(toolReadPaths([bash], "/repo")).toEqual([]);
  });

  test.each([
    ["Read", { path: "src/a.ts" }],
    ["Git", { subcommand: "diff", paths: ["src/a.ts"] }],
    ["Bash", { command: "git diff s..HEAD -- src/a.ts" }],
  ] as const)("a %s result the truncation policy cut credits nothing, whatever its size (F1)", (tool, input) => {
    // 2 000 short lines are cut to 1 000 by the line-count cap and stay well
    // under the byte ceiling, so size alone would credit a file the model only
    // half saw. `truncated` is the signal that says so.
    expect(toolReadPaths([call(tool, input, { resultBytes: 900, truncated: true })], "/repo")).toEqual([]);
  });

  test.each([
    ["Read", { path: "src/a.ts" }],
    ["Git", { subcommand: "diff", paths: ["src/a.ts"] }],
    ["Bash", { command: "git diff s..HEAD -- src/a.ts" }],
  ] as const)(
    "a %s record with no truncation signal credits nothing — completeness is unknown (F1 round 2)",
    (tool, input) => {
      // A row written before the field existed, or one an ACP session produced:
      // nax never shaped the result, so nothing here says the model saw it whole.
      // Only an explicit `truncated: false` is evidence of completeness.
      const unknown: ToolCallRecord = { tool, outcome: "ok", input, resultBytes: 900, at: AT };
      expect(toolReadPaths([unknown], "/repo")).toEqual([]);
    },
  );
});

describe("normalizeReviewPath (AC-15)", () => {
  test("drops a leading ./", () => {
    expect(normalizeReviewPath("./src/a.ts", "/repo")).toBe("src/a.ts");
  });

  test("drops a path that escapes the repository", () => {
    expect(normalizeReviewPath("../x.ts", "/repo")).toBeUndefined();
  });

  test("rewrites a repo-absolute path", () => {
    expect(normalizeReviewPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });
});
