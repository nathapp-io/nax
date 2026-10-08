import { describe, expect, test } from "bun:test";
import { TITLE_DETAIL_MAX, toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

describe("toolKind (spec §4.2)", () => {
  test.each([
    ["Read", "read"],
    ["ScratchpadRead", "read"],
    ["ScratchpadList", "read"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["ScratchpadWrite", "edit"],
    ["Delete", "delete"],
    ["Bash", "execute"],
    ["RunCommand", "execute"],
    ["Git", "execute"],
    ["GitCommit", "execute"],
    ["RequestCapability", "other"],
    ["my_embedder_tool", "other"],
    ["constructor", "other"],
  ] as const)("%s -> %s", (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });
});

describe("toolTitle", () => {
  test("names the path, pattern, command, subcommand or commit subject", () => {
    expect(toolTitle("Edit", { path: "src/a.ts" })).toBe("Edit src/a.ts");
    expect(toolTitle("ScratchpadWrite", { path: "notes.md", content: "x" })).toBe("ScratchpadWrite notes.md");
    expect(toolTitle("Grep", { pattern: "TODO" })).toBe("Grep TODO");
    expect(toolTitle("Bash", { command: "bun test ./test/unit/" })).toBe("Bash: bun test ./test/unit/");
    expect(toolTitle("Git", { subcommand: "status" })).toBe("Git status");
    expect(toolTitle("GitCommit", { message: "fix: a\n\nbody", paths: ["a"] })).toBe("GitCommit: fix: a");
  });

  test("falls back to the tool name for unknown or malformed input", () => {
    expect(toolTitle("RequestCapability", { anything: 1 })).toBe("RequestCapability");
    expect(toolTitle("Edit", "not an object")).toBe("Edit");
    expect(toolTitle("Bash", { command: 42 })).toBe("Bash");
  });

  test("keeps the detail to one line of at most 60 characters, without control characters", () => {
    const title = toolTitle("Bash", { command: `echo a\n\techo b\u001b[31m ${"x".repeat(100)}` });
    const detail = title.slice("Bash: ".length);
    expect(detail.length).toBeLessThanOrEqual(TITLE_DETAIL_MAX);
    for (const control of ["\n", "\t", "\u001b"]) expect(detail).not.toContain(control);
    expect(detail.startsWith("echo a echo b[31m")).toBe(true);
    expect(detail.endsWith("...")).toBe(true);
  });
});

describe("toolTitle hygiene", () => {
  test("drops invisible and bidi-control characters", () => {
    expect(toolTitle("Bash", { command: "ls\u200b \u202egnp.exe" })).toBe("Bash: ls gnp.exe");
  });

  test("truncates by code point, never splitting a surrogate pair", () => {
    const detail = toolTitle("Bash", { command: `${"a".repeat(56)}\u{1F600}${"b".repeat(10)}` }).slice("Bash: ".length);
    expect(detail).toBe(`${"a".repeat(56)}\u{1F600}...`);
    expect(detail.isWellFormed()).toBe(true);
  });
});

describe("toolLocations", () => {
  test("resolves the path of Read, Write, Edit and Delete against the session cwd", () => {
    expect(toolLocations("Read", { path: "src/a.ts" }, "/repo")).toEqual([{ path: "/repo/src/a.ts" }]);
    expect(toolLocations("Delete", { path: "/abs/b.ts" }, "/repo")).toEqual([{ path: "/abs/b.ts" }]);
  });

  test("none for other tools or a missing path", () => {
    expect(toolLocations("ScratchpadWrite", { path: "n.md" }, "/repo")).toBeUndefined();
    expect(toolLocations("Bash", { command: "ls" }, "/repo")).toBeUndefined();
    expect(toolLocations("Edit", {}, "/repo")).toBeUndefined();
  });
});
