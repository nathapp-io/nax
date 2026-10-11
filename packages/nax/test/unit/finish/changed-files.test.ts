import { afterEach, describe, expect, test } from "bun:test";
import { _finishGitDeps } from "@/finish";
import { changedFiles } from "@/finish/changed-files";

const original = _finishGitDeps.git;
afterEach(() => {
  _finishGitDeps.git = original;
});

describe("changedFiles", () => {
  test("lists files changed on the branch, three-dot range", async () => {
    let seen: string[] = [];
    _finishGitDeps.git = async (args) => {
      seen = args;
      return { exitCode: 0, stdout: "src/a.ts\nsrc/b.ts\n\n", stderr: "" };
    };
    expect(await changedFiles("/repo", "origin/main")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(seen).toEqual(["diff", "--name-only", "origin/main...HEAD"]);
  });

  test("a failing git reads as no files", async () => {
    _finishGitDeps.git = async () => ({ exitCode: 128, stdout: "", stderr: "bad ref" });
    expect(await changedFiles("/repo", "origin/main")).toEqual([]);
  });

  test("a throwing git reads as no files", async () => {
    _finishGitDeps.git = async () => {
      throw new Error("spawn failed");
    };
    expect(await changedFiles("/repo", "origin/main")).toEqual([]);
  });
});
