/**
 * US-007 (nax#2534): which nax-tracked paths a `.gitignore` rule hides.
 *
 * The real-git behaviour — which paths `check-ignore` reports in an actual
 * repository — is covered in `test/integration/workflow/ledger-ignored.test.ts`.
 * Here the `git` seam is stubbed, so the argv, the parser and the failure arm
 * are pinned without a repository.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _ignoredNaxPathsDeps, findIgnoredNaxTrackedPaths } from "@/utils/ignored-nax-paths";

const originalDeps = { ..._ignoredNaxPathsDeps };
let calls: string[][] = [];

afterEach(() => {
  Object.assign(_ignoredNaxPathsDeps, originalDeps);
  calls = [];
});

/** Answer `check-ignore` with `stdout`/`exitCode`, recording every argv and cwd. */
function stubGit(stdout: string, exitCode: number): void {
  _ignoredNaxPathsDeps.git = async (args, cwd) => {
    calls.push([...args, cwd]);
    return { stdout, exitCode };
  };
}

/** One `check-ignore -v` output line: `<source>:<line>:<pattern><TAB><path>`. */
const line = (rule: string, path: string): string => `${rule}\t${path}\n`;

describe("findIgnoredNaxTrackedPaths", () => {
  test("asks git for the ledger, spec.md and prd.json of one probe feature", async () => {
    stubGit("", 1);
    await findIgnoredNaxTrackedPaths("/repo");

    const argv = calls[0] ?? [];
    expect(argv.slice(0, 4)).toEqual(["check-ignore", "-v", "--no-index", "--"]);
    expect(argv.at(-1)).toBe("/repo");
    const paths = argv.slice(4, -1);
    expect(paths.map((p) => p.split("/").at(-1))).toEqual(["decisions.jsonl", "spec.md", "prd.json"]);
    // All three belong to the same feature directory, so one rule answers for the tree.
    expect(new Set(paths.map((p) => p.split("/").slice(0, -1).join("/"))).size).toBe(1);
  });

  test("reports each ignored path with the rule that hides it", async () => {
    stubGit(line(".gitignore:1:**/.nax/features/*/", ".nax/features/_probe/spec.md"), 0);

    expect(await findIgnoredNaxTrackedPaths("/repo")).toEqual([
      { path: ".nax/features/_probe/spec.md", rule: ".gitignore:1:**/.nax/features/*/" },
    ]);
  });

  test("AC-9: a non-zero exit other than 1 (not a repository) reports nothing", async () => {
    stubGit("", 128);

    expect(await findIgnoredNaxTrackedPaths("/repo")).toEqual([]);
  });

  test("a git that cannot be spawned reports nothing", async () => {
    _ignoredNaxPathsDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };

    expect(await findIgnoredNaxTrackedPaths("/repo")).toEqual([]);
  });

  test("a negated rule means the path is re-included, so it is not reported", async () => {
    stubGit(line(".gitignore:2:!.nax/features/*/decisions.jsonl", ".nax/features/_probe/decisions.jsonl"), 0);

    expect(await findIgnoredNaxTrackedPaths("/repo")).toEqual([]);
  });
});
