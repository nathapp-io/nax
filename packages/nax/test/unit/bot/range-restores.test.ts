import { describe, expect, test } from "bun:test";
import { readRangeRestores } from "@/bot/range-restores";

const MERGE = "m".repeat(40);
const REVIEWED = "r".repeat(40);
const NONE = { files: [], total: 0 };

/** A git stub answering `diff --numstat` per range; any other range or call fails the test. */
function fakeGit(byRange: Readonly<Record<string, string>>, exitCode = 0) {
  const calls: string[][] = [];
  const run = async (args: string[], _cwd: string) => {
    calls.push(args);
    const range = args.at(-1) ?? "";
    const stdout = byRange[range];
    if (stdout === undefined) throw new Error(`unexpected git call: ${args.join(" ")}`);
    return { stdout, exitCode };
  };
  return { run, calls };
}

/** `git diff --numstat -z --no-renames` output: one `<added>\t<deleted>\t<path>` record per NUL. */
function numstat(records: readonly (readonly [string, string, string])[]): string {
  return records.map(([added, deleted, path]) => `${added}\t${deleted}\t${path}\0`).join("");
}

describe("readRangeRestores", () => {
  test("lists a file whose net change against the merge base shrank in the range", async () => {
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat([["2", "150", "src/a.ts"]]),
      [`${MERGE}...${REVIEWED}`]: numstat([["160", "14", "src/a.ts"]]),
      [`${MERGE}..HEAD`]: numstat([["10", "2", "src/a.ts"]]),
    });
    const result = await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED });
    expect(result).toEqual({ files: [{ path: "src/a.ts", now: 12, before: 174 }], total: 1 });
  });

  test("omits a file the range grew and a file the range left the same size", async () => {
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat([
        ["30", "0", "src/grew.ts"],
        ["1", "1", "src/same.ts"],
      ]),
      [`${MERGE}...${REVIEWED}`]: numstat([
        ["5", "0", "src/grew.ts"],
        ["4", "0", "src/same.ts"],
      ]),
      [`${MERGE}..HEAD`]: numstat([
        ["35", "0", "src/grew.ts"],
        ["4", "0", "src/same.ts"],
      ]),
    });
    expect(await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual(NONE);
  });

  test("reports a file the range took fully back to the merge base as 0 lines now", async () => {
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat([["0", "40", "src/added.ts"]]),
      [`${MERGE}...${REVIEWED}`]: numstat([["40", "0", "src/added.ts"]]),
      [`${MERGE}..HEAD`]: "",
    });
    expect(await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual({
      files: [{ path: "src/added.ts", now: 0, before: 40 }],
      total: 1,
    });
  });

  test("ignores files outside the range and binary files", async () => {
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat([["-", "-", "img.png"]]),
      [`${MERGE}...${REVIEWED}`]: numstat([
        ["-", "-", "img.png"],
        ["50", "0", "src/untouched.ts"],
      ]),
      [`${MERGE}..HEAD`]: numstat([["-", "-", "img.png"]]),
    });
    expect(await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual(NONE);
  });

  test("keeps a path holding a tab whole", async () => {
    const path = "src/odd\tname.ts";
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat([["0", "9", path]]),
      [`${MERGE}...${REVIEWED}`]: numstat([["10", "0", path]]),
      [`${MERGE}..HEAD`]: numstat([["1", "0", path]]),
    });
    expect(await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual({
      files: [{ path, now: 1, before: 10 }],
      total: 1,
    });
  });

  test("measures the reviewed head against its own base, so a target-branch merge adds no file", async () => {
    const git = fakeGit({ [`${REVIEWED}..HEAD`]: "", [`${MERGE}...${REVIEWED}`]: "", [`${MERGE}..HEAD`]: "" });
    await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED });
    expect(git.calls.map((args) => args.at(-1))).toContain(`${MERGE}...${REVIEWED}`);
  });

  test("asks git for NUL-terminated numstat without rename pairing", async () => {
    const git = fakeGit({ [`${REVIEWED}..HEAD`]: "", [`${MERGE}...${REVIEWED}`]: "", [`${MERGE}..HEAD`]: "" });
    await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED });
    for (const args of git.calls) expect(args.slice(0, 4)).toEqual(["diff", "--numstat", "-z", "--no-renames"]);
  });

  test("returns no facts when a diff exits non-zero", async () => {
    const git = fakeGit(
      {
        [`${REVIEWED}..HEAD`]: numstat([["0", "9", "src/a.ts"]]),
        [`${MERGE}...${REVIEWED}`]: numstat([["10", "0", "src/a.ts"]]),
        [`${MERGE}..HEAD`]: numstat([["1", "0", "src/a.ts"]]),
      },
      128,
    );
    expect(await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual(NONE);
  });

  test("returns no facts when git throws", async () => {
    const run = async (): Promise<{ stdout: string; exitCode: number }> => {
      throw new Error("spawn failed");
    };
    expect(await readRangeRestores(run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED })).toEqual(NONE);
  });

  test("caps the list and keeps the files the range shrank most", async () => {
    const paths = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`);
    const git = fakeGit({
      [`${REVIEWED}..HEAD`]: numstat(paths.map((path) => ["0", "1", path] as const)),
      [`${MERGE}...${REVIEWED}`]: numstat(paths.map((path, index) => [String(index + 2), "0", path] as const)),
      [`${MERGE}..HEAD`]: numstat(paths.map((path) => ["1", "0", path] as const)),
    });
    const result = await readRangeRestores(git.run, "/checkout", { mergeBase: MERGE, rangeBase: REVIEWED });
    expect(result.files).toHaveLength(50);
    expect(result.total).toBe(60);
    expect(result.files[0]).toEqual({ path: "src/f59.ts", now: 1, before: 61 });
    expect(result.files.some(({ path }) => path === "src/f0.ts")).toBe(false);
  });
});
