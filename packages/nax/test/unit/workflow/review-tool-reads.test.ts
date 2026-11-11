/**
 * US-005 — which changed files a review session's tool calls actually showed the model.
 *
 * The branch reviewer self-reports `inspectedFiles`; a `Read` or a `git diff` that ran and returned a
 * whole result is the same evidence, observed rather than claimed.
 *
 * `toolReadPaths` is pure: no I/O, no config, no ordering surprises — it turns a list of
 * already-recorded calls into repo-relative paths. The one block that drives the production pair
 * (a real `Read` through the coding-tool runtime producing the records this module reads) exists
 * because a synthetic fixture cannot prove the runtime states a cut the tool made itself.
 */
import { describe, expect, test } from "bun:test";
import {
  compileToolPolicy,
  createCodingToolRuntime,
  registerBuiltinCodingTools,
  type ToolCallRecord,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
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

describe("toolReadPaths over a real Read through the coding-tool runtime (B1)", () => {
  // The synthetic fixtures above can say `truncated: false` and be right by
  // construction; this block drives the production pair instead. `Read` caps its
  // own whole-file body at the model-facing ceilings and names the delivered range
  // in a cap footer, so `applyModelTruncationPolicy` is a no-op on what it returns
  // — unless the tool states its cut, the row reads as complete and the whole file
  // is credited from a file the reviewer saw two thirds of. A real probe hit this
  // with `[Showing lines 1-909 of 2121. Use offset=910 to continue.]` recorded as
  // `truncated: false` / `resultBytes: 39528`.
  const LINES = 2_121;

  function bigFile(root: string, name: string): Promise<number> {
    // Short lines, so the line ceiling is the binding cap and the delivered body
    // stays well under the byte ceiling — the shape size alone cannot detect.
    return Bun.write(`${root}/${name}`, Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join("\n"));
  }

  function runtimeAt(root: string, calls: ToolCallRecord[]) {
    registerBuiltinCodingTools();
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      sink: { record: (entry) => calls.push(entry), flush: async () => {} },
    });
    runtime.advertised(["Read"]);
    return runtime;
  }

  test("a file past the display cap is recorded incomplete and credits nothing", async () => {
    const root = makeTempDir("nax-read-credit-");
    try {
      await bigFile(root, "big.md");
      const calls: ToolCallRecord[] = [];
      const outcome = await runtimeAt(root, calls).callTool("Read", { path: "big.md" });
      expect(outcome.kind).toBe("ok");
      // The premise: the model saw a cut body that still fits every byte cap.
      expect(calls[0]?.resultBytes).toBeLessThanOrEqual(TOOL_READ_CREDIT_MAX_BYTES);
      expect(calls[0]?.truncated).toBe(true);
      expect(toolReadPaths(calls, root)).toEqual([]);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("the deferred audit path records the same cut", async () => {
    const root = makeTempDir("nax-read-credit-deferred-");
    try {
      await bigFile(root, "big.md");
      const calls: ToolCallRecord[] = [];
      const outcome = await runtimeAt(root, calls).callTool("Read", { path: "big.md" }, { deferModelTruncation: true });
      if (outcome.kind !== "ok") throw new Error("unexpected outcome");
      // Nothing is ledged until the native `after_tool` handler settles it; the
      // policy then returns this within-cap body unchanged.
      expect(calls).toHaveLength(0);
      outcome.finalizeAudit?.(outcome.content);
      expect(calls[0]?.truncated).toBe(true);
      expect(toolReadPaths(calls, root)).toEqual([]);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("a whole read under the display cap still credits its file", async () => {
    const root = makeTempDir("nax-read-credit-small-");
    try {
      await Bun.write(`${root}/small.ts`, "export const a = 1;\n");
      const calls: ToolCallRecord[] = [];
      await runtimeAt(root, calls).callTool("Read", { path: "small.ts" });
      expect(calls[0]?.truncated).toBe(false);
      expect(toolReadPaths(calls, root)).toEqual(["small.ts"]);
    } finally {
      cleanupTempDir(root);
    }
  });
});
