import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  editDiff,
  fsReadOldText,
  type OldText,
  type ReadOldText,
  toolDiff,
  WRITE_DIFF_OLD_MAX_BYTES,
} from "#src/server/translate/diff";

const fixed =
  (old: OldText): ReadOldText =>
  async () =>
    old;

describe("editDiff", () => {
  test("old_string and new_string as the diff, path resolved against cwd", () => {
    expect(editDiff({ path: "src/a.ts", old_string: "a", new_string: "b" }, "/repo")).toEqual({
      type: "diff",
      path: "/repo/src/a.ts",
      oldText: "a",
      newText: "b",
    });
  });

  test("no diff when a field is missing or the input is not an object", () => {
    expect(editDiff({ path: "a", old_string: "a" }, "/repo")).toBeUndefined();
    expect(editDiff("Edit a", "/repo")).toBeUndefined();
  });
});

describe("toolDiff", () => {
  test("Edit ignores the reader", async () => {
    const never: ReadOldText = async () => {
      throw new Error("must not read");
    };
    expect(await toolDiff("Edit", { path: "a", old_string: "x", new_string: "y" }, "/r", never)).toMatchObject({
      oldText: "x",
      newText: "y",
    });
  });

  test("Write over an existing file carries the current content as old text", async () => {
    expect(
      await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind: "text", text: "old" })),
    ).toEqual({ type: "diff", path: "/r/a.ts", oldText: "old", newText: "new" });
  });

  test("Write of a new file has null old text", async () => {
    expect(await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind: "missing" }))).toEqual({
      type: "diff",
      path: "/r/a.ts",
      oldText: null,
      newText: "new",
    });
  });

  test.each(["too-large", "unreadable"] as const)("Write with %s old text marks the omission", async (kind) => {
    expect(await toolDiff("Write", { path: "a.ts", content: "new" }, "/r", fixed({ kind }))).toEqual({
      type: "diff",
      path: "/r/a.ts",
      oldText: null,
      newText: "new",
      _meta: { naxAgent: { oldTextOmitted: kind } },
    });
  });

  test("no diff for other tools or a Write without content", async () => {
    const reader = fixed({ kind: "missing" });
    expect(await toolDiff("Read", { path: "a" }, "/r", reader)).toBeUndefined();
    expect(await toolDiff("Write", { path: "a" }, "/r", reader)).toBeUndefined();
  });
});

describe("fsReadOldText", () => {
  test("text, missing, unreadable (a directory) and too-large on a real filesystem", async () => {
    const dir = makeTempDir("acp-diff-");
    try {
      writeFileSync(join(dir, "small.txt"), "hello");
      writeFileSync(join(dir, "big.txt"), "x".repeat(WRITE_DIFF_OLD_MAX_BYTES + 1));
      mkdirSync(join(dir, "sub"));
      const read = fsReadOldText();
      expect(await read(join(dir, "small.txt"))).toEqual({ kind: "text", text: "hello" });
      expect(await read(join(dir, "absent.txt"))).toEqual({ kind: "missing" });
      expect(await read(join(dir, "sub"))).toEqual({ kind: "unreadable" });
      expect(await read(join(dir, "big.txt"))).toEqual({ kind: "too-large" });
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("an error other than ENOENT is unreadable", async () => {
    const read = fsReadOldText({
      stat: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      readFile: async () => "",
    });
    expect(await read("/x")).toEqual({ kind: "unreadable" });
  });
});
