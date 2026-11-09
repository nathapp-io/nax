/** nax#2838: the head gate reader uses the real filesystem and never looks above the worktree. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeadGateNames } from "@/bot/head-gates";

let root: string;
let worktree: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "head-gates-"));
  worktree = join(root, "wt");
  await mkdir(worktree, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function writeConfig(dir: string, content: string): Promise<void> {
  await mkdir(join(dir, ".nax"), { recursive: true });
  await writeFile(join(dir, ".nax", "config.json"), content);
}

describe("readHeadGateNames", () => {
  test("returns the configured gates in gate order", async () => {
    await writeConfig(worktree, JSON.stringify({ quality: { commands: { e2e: "bun e2e", test: ["bun", "test"] } } }));
    expect(await readHeadGateNames(worktree)).toEqual(["test", "e2e"]);
  });

  test("no head config gives none, even when a parent directory configures e2e (no walk-up)", async () => {
    await writeConfig(root, JSON.stringify({ quality: { commands: { e2e: "bun e2e" } } }));
    expect(await readHeadGateNames(worktree)).toEqual([]);
  });

  test("ignores blank commands, unknown keys and non-command values", async () => {
    await writeConfig(
      worktree,
      JSON.stringify({ quality: { commands: { e2e: "  ", lint: ["", " "], test: 5, custom: "x", build: "make" } } }),
    );
    expect(await readHeadGateNames(worktree)).toEqual(["build"]);
  });

  test("a config without quality commands gives none", async () => {
    await writeConfig(worktree, JSON.stringify({ name: "x" }));
    expect(await readHeadGateNames(worktree)).toEqual([]);
  });

  test("invalid JSON throws so ready holds", async () => {
    await writeConfig(worktree, "{ not json");
    await expect(readHeadGateNames(worktree)).rejects.toThrow();
  });
});
