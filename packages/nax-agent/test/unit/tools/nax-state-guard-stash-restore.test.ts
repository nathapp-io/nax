import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _naxStateGuardDeps } from "#src/tools/nax-stash-restore";
import { type NaxGuardContext, naxStateRefusal, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const originalGit = _naxStateGuardDeps.git;
let root: string;
let ctx: NaxGuardContext;
const git = mock((_cwd: string, _args: readonly string[]): string | undefined => "src/a.ts\0");
const check = (command: string) => naxStateRefusalInText(command, ctx);
const expectStashRefusal = (reason: string | undefined) => {
  expect(reason).toBeDefined();
  expect(reason).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
};

beforeEach(() => {
  root = makeTempDir("stash-restore-");
  mkdirSync(join(root, ".nax"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "a");
  ctx = { root, frames: [root] };
  git.mockReset();
  git.mockImplementation(() => "src/a.ts\0");
  _naxStateGuardDeps.git = git;
});
afterEach(() => {
  _naxStateGuardDeps.git = originalGit;
  cleanupTempDir(root);
});

describe("stash restore acceptance", () => {
  test("AC-1: clean pop", () => expect(check("git stash pop")).toBeUndefined());
  test("AC-2: clean apply", () => expect(check("git stash apply")).toBeUndefined());
  test("AC-3: default listing argv", () => {
    check("git stash pop");
    expect(git).toHaveBeenCalledWith(root, [
      "stash",
      "show",
      "-z",
      "--name-only",
      "--no-renames",
      "--include-untracked",
      "stash@{0}",
    ]);
  });
  test("AC-4: quoted ref with index", () => expect(check("git stash pop --index 'stash@{1}'")).toBeUndefined());
  test("AC-5: quoted ref passed through", () => {
    check("git stash pop --index 'stash@{1}'");
    expect(git.mock.calls[0]?.[1].at(-1)).toBe("stash@{1}");
  });
  test("AC-6: numeric ref passed through", () => {
    check("git stash apply 2");
    expect(git.mock.calls[0]?.[1].at(-1)).toBe("2");
  });
  test("AC-7: unquoted braces refuse without git", () => {
    expectStashRefusal(check("git stash pop stash@{1}"));
    expect(git).not.toHaveBeenCalled();
  });
  test("AC-8: root .nax in stash", () => {
    git.mockReturnValue("src/a.ts\0.nax/features/f/prd.json\0");
    expectStashRefusal(check("git stash pop"));
  });
  test("AC-9: nested .nax in stash", () => {
    git.mockReturnValue("pkg/.nax/status.json\0");
    expectStashRefusal(check("git stash apply"));
  });
  test("AC-10: listing failure", () => {
    git.mockReturnValue(undefined);
    expectStashRefusal(check("git stash pop"));
  });
  test("AC-11: every frame must succeed", () => {
    git.mockImplementation((cwd) => (cwd === root ? "src/a.ts\0" : undefined));
    expect(naxStateRefusal(["git", "stash", "pop"], { ...ctx, frames: [root, join(root, "src")] })).toBeDefined();
    expect(git.mock.calls.map(([cwd]) => cwd)).toEqual([root, join(root, "src")]);
  });
  test("AC-12: unknown flag does not spawn", () => {
    expectStashRefusal(check("git stash pop --hard-flag"));
    expect(git).not.toHaveBeenCalled();
  });
  test("AC-13: extra operand does not spawn", () => {
    expectStashRefusal(check("git stash pop 'stash@{0}' extra"));
    expect(git).not.toHaveBeenCalled();
  });
  test("AC-14: uncertain git invocation refuses", () => expectStashRefusal(check("git --future-flag x stash pop")));
  test("AC-15: directory push uses an unfiltered listing", () => {
    expect(check("git stash push -- src")).toBeUndefined();
    expect(git).toHaveBeenCalledWith(root, ["ls-files", "-z", "--cached", "--others", "--", "src"]);
  });
  test("AC-16: deeply nested .nax in directory listing", () => {
    git.mockReturnValue("src/deep/a/b/c/.nax/prd.json\0");
    expectStashRefusal(check("git stash push -- src"));
  });
  test("AC-17: whole tree refuses", () => expectStashRefusal(check("git stash push -- .")));
  test("AC-18: refusal drops regular-file-only wording", () =>
    expect(check("git stash")).not.toContain("named regular files"));
  test("AC-19: refusal explains restore and quoting", () => {
    expect(check("git stash")).toContain("`pop` or `apply` of a stash that holds no `.nax` path");
    expect(check("git stash")).toContain("'stash@{1}'");
  });
});

describe("fail-closed edges", () => {
  test.each(["--quiet", "-q", "--index --quiet 'stash@{12}'"])("restore accepts %s", (args) => {
    expect(check(`git stash apply ${args}`)).toBeUndefined();
  });
  test.each(["--", "HEAD", "-1", "'stash@{x}'", "--index --index", "1 2", "--quiet --index", "--quiet --quiet"])(
    "rejects unsupported grammar %s",
    (args) => {
      expectStashRefusal(check(`git stash apply ${args}`));
      expect(git).not.toHaveBeenCalled();
    },
  );
  test("empty successful listing and similar names are clean", () => {
    for (const output of ["", "src/.nax-other/a\0src/nax/a\0"]) {
      git.mockReturnValue(output);
      expect(check("git stash pop")).toBeUndefined();
    }
  });
  test("directory listing failure in a later frame refuses", () => {
    mkdirSync(join(root, "src/src"));
    ctx = { ...ctx, frames: [root, join(root, "src")] };
    git.mockImplementation((cwd) => (cwd === root ? "src/a.ts\0" : undefined));
    expectStashRefusal(check("git stash push -- src"));
    expect(git).toHaveBeenCalledTimes(2);
  });
  test("symlink directory is not inspected or allowed", () => {
    symlinkSync(join(root, "src"), join(root, "link"));
    expectStashRefusal(check("git stash push -- link"));
    expect(git).not.toHaveBeenCalled();
  });
  test("dot in a source-only frame is a directory, not the whole repository", () => {
    ctx = { ...ctx, frames: [join(root, "src")] };
    expect(check("git stash push -- .")).toBeUndefined();
    expect(git).toHaveBeenCalledWith(join(root, "src"), ["ls-files", "-z", "--cached", "--others", "--", "."]);
  });
  test("git directory options widen the listing frames", () => {
    expect(check("git -C src stash pop")).toBeUndefined();
    expect(git.mock.calls.map(([cwd]) => cwd)).toContain(join(root, "src"));
    git.mockClear();
    expect(check("git --work-tree=src stash apply")).toBeUndefined();
    expect(git.mock.calls.map(([cwd]) => cwd)).toContain(join(root, "src"));
  });
});
