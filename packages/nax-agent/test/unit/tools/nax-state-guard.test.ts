import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { redirectForCommand } from "#src/tools/denial-redirect";
import { compileToolPolicy } from "#src/tools/index";
import { naxStateRefusal } from "#src/tools/nax-state-guard";
import { screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;
const words = (command: string) => command.split(/\s+/);

describe("naxStateRefusal: update-index (#2490)", () => {
  test.each(["--skip-worktree", "--assume-unchanged", "--no-skip-worktree", "--no-assume-unchanged"])(
    "denies %s on a .nax path",
    (flag) => {
      expect(naxStateRefusal(words(`git update-index ${flag} .nax/features/f/prd.json`), false)).toContain(".nax/");
    },
  );

  test("denies a nested .nax path", () => {
    expect(
      naxStateRefusal(words("git update-index --skip-worktree pkg/.nax/features/f/prd.json"), false),
    ).toBeDefined();
  });

  test("allows the same flag on a source file", () => {
    expect(naxStateRefusal(words("git update-index --skip-worktree src/x.ts"), true)).toBeUndefined();
  });

  test("allows update-index --refresh and a name that only contains nax", () => {
    expect(naxStateRefusal(words("git update-index --refresh"), true)).toBeUndefined();
    expect(naxStateRefusal(words("git update-index --skip-worktree src/nax-helpers.ts"), true)).toBeUndefined();
  });
});

describe("naxStateRefusal: stash (#2490)", () => {
  test.each([
    "git stash",
    "git stash push",
    "git stash --keep-index",
    "git stash push -m wip",
    "git stash pop",
    "git stash apply",
  ])("denies %s when the repo has a .nax directory", (command) => {
    const reason = naxStateRefusal(words(command), true);
    expect(reason).toContain("git diff HEAD");
    expect(reason).toContain("git show HEAD:");
  });

  test("allows a stash when there is no .nax directory", () => {
    expect(naxStateRefusal(words("git stash"), false)).toBeUndefined();
  });

  test("allows list, show and a pathspec that excludes .nax", () => {
    expect(naxStateRefusal(words("git stash list"), true)).toBeUndefined();
    expect(naxStateRefusal(words("git stash show -p"), true)).toBeUndefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", ".", ":!.nax"], true)).toBeUndefined();
  });
});

describe("naxStateRefusal: revert", () => {
  test("denies a checkout of a .nax path and leaves other paths alone", () => {
    expect(naxStateRefusal(words("git checkout -- .nax/features/f/prd.json"), false)).toContain("run state");
    expect(naxStateRefusal(words("git checkout -- src/x.ts"), true)).toBeUndefined();
  });
});

describe("redirectForCommand reads every segment", () => {
  const AVAILABLE = new Set(["Git"]);
  const NONE = new Set<string>();

  test.each([
    "true; git checkout -- .nax/features/f/prd.json",
    "true && git restore .nax/features/f/prd.json",
    "a || b | git checkout -- .nax/x",
  ])("explains a .nax revert in a later segment: %s", (command) => {
    expect(redirectForCommand(command, AVAILABLE, NONE)).toContain("run state");
  });
});

describe("gated and raw Bash enforce the guard on every segment", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("nax-state-guard-");
    mkdirSync(join(root, ".nax"), { recursive: true });
  });
  afterEach(() => cleanupTempDir(root));

  const gated = (command: string) =>
    compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy }).check(
      "Bash",
      BASH_SCOPE,
      { command },
    );
  const raw = (command: string) =>
    screenRawBashCommand({
      tool: "Bash",
      command,
      initialPath: root,
      root,
      ownedPaths: naxOwnedPathsPolicy,
      resolvePath: (candidate, cwd) => resolve(cwd, candidate),
    });

  const DENIED = [
    "git update-index --skip-worktree .nax/features/f/prd.json",
    "git checkout -- .nax/features/f/prd.json 2>&1; git stash pop",
    "echo hi && git checkout -- .nax/features/f/prd.json",
    "true || git restore .nax/features/f/prd.json",
    "cat x | git update-index --assume-unchanged .nax/features/f/prd.json",
    "git stash --keep-index; git diff HEAD x",
  ];

  test.each(DENIED)("gated denies: %s", (command) => {
    expect(gated(command).allowed).toBe(false);
  });

  test.each(DENIED)("raw denies: %s", (command) => {
    expect(raw(command).kind).toBe("deny");
  });

  test("both modes still allow ordinary git on source files", () => {
    for (const command of ["git update-index --skip-worktree src/x.ts", "git checkout -- src/x.ts; git stash list"]) {
      expect(gated(command).allowed).toBe(true);
      expect(raw(command).kind).toBe("allow");
    }
  });
});
