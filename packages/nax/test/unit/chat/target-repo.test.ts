import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _targetRepoDeps, isWithinRoot, resolveTargetRepo, targetOutputDir } from "@/chat/target-repo";
import { projectOutputDir } from "@/runtime";

let tmp: string;
let root: string;
const originalDeps = { ..._targetRepoDeps };

beforeEach(() => {
  tmp = makeTempDir("target-repo-");
  root = join(tmp, "chat");
  mkdirSync(join(root, "repos", "nax", ".nax"), { recursive: true });
  mkdirSync(join(root, "plain"), { recursive: true });
});
afterEach(() => {
  Object.assign(_targetRepoDeps, originalDeps);
  cleanupTempDir(tmp);
});

function errorOf(r: { root: string } | { error: string }): string {
  return "error" in r ? r.error : "";
}

describe("resolveTargetRepo", () => {
  test("AC-1 undefined keeps the chat root", async () => {
    expect(await resolveTargetRepo(root, undefined)).toEqual({ root });
  });
  test("AC-2 relative nested project resolves to its real path", async () => {
    expect(await resolveTargetRepo(root, "repos/nax")).toEqual({
      root: join(realpathSync(root), "repos", "nax"),
    });
  });
  test("AC-3 absolute form equals relative form", async () => {
    expect(await resolveTargetRepo(root, join(root, "repos", "nax"))).toEqual(
      await resolveTargetRepo(root, "repos/nax"),
    );
  });
  test("AC-4 dot keeps the chat root spelling", async () => {
    expect(await resolveTargetRepo(root, ".")).toEqual({ root });
  });
  test.each([
    ["AC-5", 5],
    ["AC-6", ""],
    ["blank", "  "],
  ])("%s rejects non-string/blank repo", async (_l, repo) => {
    expect(await resolveTargetRepo(root, repo)).toEqual({ error: "[chat] repo must be a non-empty string" });
  });
  test("AC-7 missing", async () => {
    expect(await resolveTargetRepo(root, "missing")).toEqual({ error: "[chat] repo missing does not exist" });
  });
  test("AC-8 parent is outside", async () => {
    expect(errorOf(await resolveTargetRepo(root, ".."))).toStartWith("[chat] repo .. is outside");
  });
  test("AC-9 symlink escaping root", async () => {
    const outside = join(tmp, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "link"));
    expect(errorOf(await resolveTargetRepo(root, "link"))).toStartWith("[chat] repo link is outside");
  });
  test("AC-10 sibling with shared prefix", async () => {
    mkdirSync(join(tmp, "chat-evil", ".nax"), { recursive: true });
    expect(errorOf(await resolveTargetRepo(root, "../chat-evil"))).toStartWith("[chat] repo ../chat-evil is outside");
  });
  test("AC-11 absolute outside project", async () => {
    mkdirSync(join(tmp, "other", ".nax"), { recursive: true });
    const error = errorOf(await resolveTargetRepo(root, join(tmp, "other")));
    expect(error).toStartWith("[chat] repo");
    expect(error).toContain("is outside");
  });
  test("AC-15 no .nax directory", async () => {
    expect(await resolveTargetRepo(root, "plain")).toEqual({
      error: "[chat] repo plain is not a nax project: no .nax directory",
    });
  });
});

describe("isWithinRoot", () => {
  test("AC-12 prefix sibling is not inside", () => {
    expect(isWithinRoot("/w/chat-evil", "/w/chat")).toBe(false);
    expect(isWithinRoot("/w/chat/repos/nax", "/w/chat")).toBe(true);
    expect(isWithinRoot("/w/chat", "/w/chat")).toBe(true);
  });
});

describe("targetOutputDir", () => {
  test("AC-13 derives from loaded config", async () => {
    _targetRepoDeps.loadConfig = async () => makeNaxConfig({ name: "nested", outputDir: undefined });
    expect(await targetOutputDir(root)).toBe(projectOutputDir("nested", undefined));
  });
});
