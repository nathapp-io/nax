import { beforeEach, describe, expect, test } from "bun:test";
import { withDepsRestore } from "@test/helpers";
import { unquotePorcelainPath } from "@/utils/porcelain";
import {
  _gitUtilDeps,
  clearGitRootCache,
  getChangedNonTestFiles,
  getChangedTestFiles,
} from "@/verification/smart-runner";

const QUOTED = String.raw`"src/\346\224\257\346\211\225.test.ts"`;
const TEST_RE = [/\.test\.ts$/];
const ANY_RE = [/\.test\.ts$/];

describe("unquotePorcelainPath", () => {
  test("decodes a Git-quoted octal-byte path", () => {
    expect(unquotePorcelainPath(String.raw`"src/\346\224\257\346\211\225.ts"`)).toBe("src/支払.ts");
  });
  test("returns an unquoted path unchanged", () => {
    expect(unquotePorcelainPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("smart-runner readers decode Git-quoted names", () => {
  withDepsRestore(_gitUtilDeps, ["getGitRoot", "gitWithTimeout"]);
  const stub = (stdout: string) => {
    _gitUtilDeps.getGitRoot = async () => null;
    _gitUtilDeps.gitWithTimeout = async () => ({ stdout, stderr: "", exitCode: 0 });
  };
  beforeEach(() => clearGitRootCache());

  test("getChangedTestFiles decodes quoted lines", async () => {
    stub(`${QUOTED}\nsrc/a.test.ts\n`);
    expect(await getChangedTestFiles("/repo", "/repo", "HEAD", undefined, TEST_RE)).toEqual([
      "/repo/src/支払.test.ts",
      "/repo/src/a.test.ts",
    ]);
  });

  test("getChangedNonTestFiles decodes quoted lines", async () => {
    stub(`${String.raw`"src/\346\224\257\346\211\225.ts"`}\n`);
    expect(await getChangedNonTestFiles("/repo", "HEAD", undefined, ANY_RE)).toEqual(["src/支払.ts"]);
  });

  test("stubbed paths absent from disk are still returned (control)", async () => {
    stub("src/gone.test.ts\n");
    expect(await getChangedTestFiles("/repo", "/repo", "HEAD", undefined, TEST_RE)).toEqual(["/repo/src/gone.test.ts"]);
  });

  test("getChangedTestFiles asks Git to leave out deleted paths", async () => {
    const seen: string[][] = [];
    _gitUtilDeps.getGitRoot = async () => null;
    _gitUtilDeps.gitWithTimeout = async (args: string[]) => {
      seen.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await getChangedTestFiles("/repo", "/repo", "HEAD", undefined, TEST_RE);
    expect(seen[0]).toContain("--diff-filter=d");
  });
});
