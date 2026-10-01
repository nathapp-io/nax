// tools/monorepo/test/gitignore-split.test.ts
import { describe, expect, test } from "bun:test";
import { splitGitignore } from "../lib/gitignore-split";

describe("splitGitignore", () => {
  test("moves only the explicit anchored entries, keeps comments/unanchored/.nax at root", () => {
    const input = ["# Testing", "coverage", "test/tmp/", ".nax/features/*/runs/", "**/.nax/cache/", "tmp/.ci-test-output.txt", "dist"].join("\n");
    const r = splitGitignore(`${input}\n`);
    expect(r.moved).toEqual(["test/tmp/", "tmp/.ci-test-output.txt"]);
    expect(r.root).toBe(["# Testing", "coverage", ".nax/features/*/runs/", "**/.nax/cache/", "dist"].join("\n") + "\n");
    expect(r.pkg).toBe("# Moved from the repo root by the monorepo conversion (package-anchored)\ntest/tmp/\ntmp/.ci-test-output.txt\n");
  });
  test("throws on an anchored entry under a moved dir that is not in the move list", () => {
    expect(() => splitGitignore("src/generated/\n")).toThrow(/src\/generated\/.*not in GITIGNORE_MOVE/);
  });
  test("a leading-slash entry is anchored too", () => {
    expect(() => splitGitignore("/bin/out\n")).toThrow(/\/bin\/out/);
  });
});
