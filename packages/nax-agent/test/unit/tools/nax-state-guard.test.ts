import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { redirectForCommand } from "#src/tools/denial-redirect";
import { compileToolPolicy } from "#src/tools/index";
import { type NaxGuardContext, naxStateRefusal, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;
const words = (command: string) => command.split(/\s+/);

let root: string;
let bare: string;
let withNax: NaxGuardContext;
let withoutNax: NaxGuardContext;

beforeEach(() => {
  root = makeTempDir("nax-state-guard-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "pkg/sub"), { recursive: true });
  withNax = { frames: [root], root };
  bare = makeTempDir("nax-state-guard-bare-");
  withoutNax = { frames: [bare], root: bare };
});
afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(bare);
});

const refuse = (command: string, ctx: NaxGuardContext = withNax) => naxStateRefusal(words(command), ctx);

describe("update-index", () => {
  test.each([
    "--skip-worktree",
    "--assume-unchanged",
    "--no-skip-worktree",
    "--no-assume-unchanged",
    "--skip-work",
    "--assume-u",
    "--no-skip-w",
  ])("denies %s on a .nax path", (flag) => {
    expect(refuse(`git update-index ${flag} .nax/features/f/prd.json`, withoutNax)).toContain(".nax/");
  });

  test("denies a nested .nax path and a dot-dot spelling", () => {
    expect(refuse("git update-index --skip-worktree pkg/.nax/features/f/prd.json")).toBeDefined();
    expect(refuse("git update-index --skip-worktree foo/../.nax/features/f/prd.json")).toBeDefined();
  });

  test("allows the same flag on a source file, and --refresh", () => {
    expect(refuse("git update-index --skip-worktree src/x.ts")).toBeUndefined();
    expect(refuse("git update-index --skip-worktree src/nax-helpers.ts")).toBeUndefined();
    expect(refuse("git update-index --refresh")).toBeUndefined();
  });

  test("denies --stdin and --index-info (no inspectable path) when a .nax exists", () => {
    expect(refuse("git update-index --skip-worktree --stdin")).toBeDefined();
    expect(refuse("git update-index --assume-unchanged --index-info")).toBeDefined();
    expect(refuse("git update-index --skip-worktree --stdin", withoutNax)).toBeUndefined();
  });

  test("resolves operands against the working directory (cd .nax)", () => {
    const ctx = { frames: [join(root, ".nax")], root };
    expect(naxStateRefusal(words("git update-index --skip-worktree status.json"), ctx)).toBeDefined();
  });
});

describe("stash", () => {
  test.each([
    "git stash",
    "git stash push",
    "git stash --keep-index",
    "git stash push -m wip",
    "git stash pop",
    "git stash apply",
    "git stash branch fix",
    "git stash save wip",
  ])("denies %s when a .nax exists", (command) => {
    const reason = refuse(command);
    expect(reason).toContain("git diff HEAD");
    expect(reason).toContain("git show HEAD:");
  });

  test("allows a stash when there is no .nax directory", () => {
    expect(refuse("git stash", withoutNax)).toBeUndefined();
  });

  test("allows the bookkeeping allowlist", () => {
    for (const sub of ["list", "show -p", "create", "store abc", "drop", "clear"]) {
      expect(refuse(`git stash ${sub}`)).toBeUndefined();
    }
  });

  test.each([":!.nax", ":^.nax", ":(exclude).nax", ":!.nax/", ":!.nax/**"])("allows a full exclusion %s", (spec) => {
    expect(naxStateRefusal(["git", "stash", "push", "--", ".", spec], withNax)).toBeUndefined();
  });

  test("does not accept a partial exclusion", () => {
    expect(naxStateRefusal(["git", "stash", "push", "--", ".", ":!.nax/features"], withNax)).toBeDefined();
  });

  test("allows a push whose every pathspec lies outside .nax, refuses the rest", () => {
    expect(naxStateRefusal(["git", "stash", "push", "--", "src/x.ts"], withNax)).toBeUndefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", "src/x.ts", ".nax/a"], withNax)).toBeDefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", "."], withNax)).toBeDefined();
    expect(naxStateRefusal(["git", "stash", "push", "src/x.ts"], withNax)).toBeDefined();
  });

  test("finds the .nax from a subdirectory frame (cd src && git stash)", () => {
    expect(naxStateRefusal(["git", "stash"], { frames: [join(root, "src")], root })).toBeDefined();
  });
});

describe("revert", () => {
  test("denies a checkout of a .nax path, resolved from the working directory", () => {
    expect(refuse("git checkout -- .nax/features/f/prd.json", withoutNax)).toContain("run state");
    expect(naxStateRefusal(words("git checkout -- prd.json"), { frames: [join(root, ".nax")], root })).toBeDefined();
    expect(refuse("git checkout -- src/x.ts")).toBeUndefined();
  });
});

describe("wrappers, global options and nested shells", () => {
  test.each([
    "git -C . stash",
    "git -c core.pager=x stash pop",
    "git --no-pager stash",
    "FOO=1 git stash",
    "env git stash",
    "env FOO=1 git stash",
    "command git stash",
    "nice -n 5 git stash",
    "timeout 30 git stash",
    "xargs git update-index --skip-worktree",
    "xargs -n 1 git update-index --assume-unchanged",
    "git --git-dir=.git stash",
  ])("denies %s", (command) => {
    expect(refuse(command)).toBeDefined();
  });

  test.each([
    "bash -c 'git stash'",
    'sh -c "git update-index --skip-worktree .nax/features/f/prd.json"',
    "bash -lc 'echo hi; git stash pop'",
    "env FOO=1 bash -c 'git checkout -- .nax/x'",
  ])("recurses into %s", (command) => {
    expect(refuse(command)).toBeDefined();
  });

  test("does not flag an unrelated shell command", () => {
    expect(refuse("bash -c 'echo hi'")).toBeUndefined();
  });
});

describe("naxStateRefusalInText (the lexer-refused path)", () => {
  test.each([
    "git stash 2>&1",
    "(git stash)",
    "{ git stash; }",
    "git stash >out.txt",
    "git stash &>/dev/null",
    "echo $(whoami) && git stash pop",
  ])("denies %s", (command) => {
    expect(naxStateRefusalInText(command, withNax)).toBeDefined();
  });

  test("allows a quoted full exclusion and plain commands", () => {
    expect(naxStateRefusalInText("git stash push -- . ':!.nax' 2>&1", withNax)).toBeUndefined();
    expect(naxStateRefusalInText("git stash list 2>&1", withNax)).toBeUndefined();
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
  const gated = (command: string, cwdRoot = root) =>
    compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], cwdRoot, { ownedPaths: naxOwnedPathsPolicy }).check(
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
    "git stash 2>&1",
    "git -C . stash",
    "git --no-pager stash",
    "FOO=1 git stash",
    "env git stash",
    "bash -c 'git stash'",
    "(git stash)",
    "cd src && git stash",
    "cd .nax && git update-index --skip-worktree status.json",
    "git update-index --skip-work .nax/features/f/prd.json",
  ];

  test.each(DENIED)("gated denies, non-escalatable: %s", (command) => {
    const verdict = gated(command);
    expect(verdict.allowed).toBe(false);
    expect((verdict as { escalatable?: boolean }).escalatable).not.toBe(true);
  });

  test.each(DENIED)("raw denies, non-escalatable: %s", (command) => {
    const verdict = raw(command);
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") expect(verdict.escalatable).toBe(false);
  });

  test("both modes still allow ordinary git on source files", () => {
    for (const command of [
      "git update-index --skip-worktree src/x.ts",
      "git checkout -- src/x.ts; git stash list",
      "git stash push -- src/x.ts",
    ]) {
      expect(gated(command).allowed).toBe(true);
      expect(raw(command).kind).toBe("allow");
    }
  });
});
