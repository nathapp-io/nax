import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { locateGit } from "#src/tools/git-flags/locate";
import { compileToolPolicy } from "#src/tools/index";
import { createNaxDirIndex, type NaxGuardContext, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

let root: string;
let bare: string;
let withNax: NaxGuardContext;
let withoutNax: NaxGuardContext;

beforeEach(() => {
  root = makeTempDir("nax-guard-2493-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "x\n");
  withNax = { frames: [root], root };
  bare = makeTempDir("nax-guard-2493-bare-");
  mkdirSync(join(bare, "src"), { recursive: true });
  withoutNax = { frames: [bare], root: bare };
});
afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(bare);
});

const text = (command: string, ctx: NaxGuardContext = withNax) => naxStateRefusalInText(command, ctx);

describe("#2493 item 1: whole-tree reverts", () => {
  test.each([
    "git reset --hard",
    "git reset --hard HEAD~1",
    "git reset --hard origin/main",
    "git reset -q --hard",
    "git checkout .",
    "git checkout -- .",
    "git checkout HEAD -- .",
    "git checkout HEAD .",
    "git checkout -f .",
    "git checkout -- :/",
    "git checkout -- ':(top)'",
    "git checkout -- '*'",
    "git checkout -- ./",
    "git restore .",
    "git restore -- .",
    "git restore --source=HEAD~1 .",
    "git restore --source HEAD -- .",
    "git restore -s HEAD .",
    "git restore --worktree .",
    "git restore --staged --worktree .",
    "git -C . checkout .",
    "time git checkout .",
  ])("denies %s", (command) => {
    const reason = text(command);
    expect(reason).toBeDefined();
    expect(reason).toContain(".nax");
  });

  test("denies the root directory spelled absolutely, and .. from a subdirectory", () => {
    expect(text(`git checkout -- ${root}`)).toBeDefined();
    expect(text("git checkout -- ..", { frames: [join(root, "src")], root })).toBeDefined();
  });

  test("the denial text names the safe forms", () => {
    expect(text("git checkout .")).toContain("git checkout -- . ':(exclude,glob)**/.nax'");
    expect(text("git restore .")).toContain("git restore -- . ':(exclude,glob)**/.nax'");
    const reset = text("git reset --hard") as string;
    expect(reset).toContain("git checkout -- . ':(exclude,glob)**/.nax'");
    expect(reset).toContain("git reset");
  });

  test.each([
    "git reset",
    "git reset --mixed",
    "git reset --soft HEAD~1",
    "git reset -- src/x.ts",
    "git reset HEAD src/x.ts",
    "git checkout -- src/x.ts",
    "git checkout HEAD -- src/x.ts",
    "git checkout -- . ':!.nax'",
    "git checkout -- . :!.nax",
    "git checkout HEAD -- . ':(exclude).nax'",
    "git restore -- . ':!.nax'",
    "git restore --source=HEAD~1 -- . ':^.nax/'",
    "git restore --staged .",
    "git restore -S .",
    "git restore src/x.ts",
    "git checkout main",
    "git checkout -b topic",
    "git status",
    "git stash list",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("a full exclusion only counts AFTER --", () => {
    expect(text("git checkout . ':!.nax'")).toBeDefined();
  });

  test("a partial exclusion does not count", () => {
    expect(text("git checkout -- . ':!.nax/features'")).toBeDefined();
  });

  test.each(["git reset --hard", "git checkout .", "git restore .", "git checkout -- ."])(
    "allows %s when there is no .nax",
    (command) => {
      expect(text(command, withoutNax)).toBeUndefined();
    },
  );
});

describe("#2493 item 2: nested .nax", () => {
  const nestedOnly = (relative: string): NaxGuardContext => {
    mkdirSync(join(bare, relative, ".nax"), { recursive: true });
    return withoutNax;
  };

  test.each(["pkg/a", "a/b/c"])("finds %s/.nax for the stash rule", (relative) => {
    expect(text("git stash", nestedOnly(relative))).toBeDefined();
  });

  test("does not look deeper than three levels", () => {
    expect(text("git stash", nestedOnly("a/b/c/d"))).toBeUndefined();
  });

  test.each(["node_modules/x", ".cache/x", ".hidden/pkg"])("skips %s", (relative) => {
    expect(text("git stash", nestedOnly(relative))).toBeUndefined();
  });

  test("a whole-tree revert is refused when only a nested .nax exists", () => {
    expect(text("git checkout .", nestedOnly("pkg/a"))).toBeDefined();
  });
});

describe("#2493 item 3: backslash git", () => {
  test.each(["\\git stash", "\\git checkout .", "env \\git stash", "\\git update-index --skip-worktree .nax/x"])(
    "denies %s",
    (command) => {
      expect(text(command)).toBeDefined();
    },
  );
  test("allows \\git status", () => {
    expect(text("\\git status")).toBeUndefined();
  });
});

describe("#2493 item 4: git config alias definitions", () => {
  test.each([
    "git config alias.s stash",
    "git config --global alias.co checkout",
    "git config --local alias.x 'reset --hard'",
    "git config --add alias.x '!git stash'",
    "git config --replace-all alias.r restore",
    "git config --file x.cfg alias.u update-index",
    "git config set alias.co checkout",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "git config alias.st status",
    "git config user.name x",
    "git config --get alias.co",
    "git config alias.co",
    "git config --unset alias.co",
    "git config --global alias.lg 'log --oneline'",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("allows a stash alias definition when there is no .nax", () => {
    expect(text("git config alias.s stash", withoutNax)).toBeUndefined();
  });
});

describe("#2493 item 5: unknown globals fail closed", () => {
  test.each(["git --future-flag value stash", "git --attr-source HEAD stash", "git --attr-source=HEAD stash"])(
    "denies %s",
    (command) => {
      expect(text(command)).toBeDefined();
    },
  );

  test.each(["git --future-flag value status", "git --attr-source HEAD status", "git --bare status"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );

  test("locateGit marks an unknown global as uncertain and a known one as certain", () => {
    expect(locateGit(["git", "--future-flag", "value", "stash"])?.uncertain).toBe(true);
    expect(locateGit(["git", "--attr-source", "HEAD", "stash"])).toMatchObject({
      uncertain: false,
      subcommand: "stash",
    });
    expect(locateGit(["git", "--no-pager", "-C", "x", "stash"])?.uncertain).toBe(false);
  });
});

describe("#2493 item 6: aliases", () => {
  test.each([
    "git -c 'alias.s=-C . stash' s",
    "git -c 'alias.s=--no-pager stash' s",
    "git -c 'alias.s=-c core.pager=x stash' s",
    "git -c 'alias.s=!git stash' s",
    "git -c 'alias.s=!f() { git stash; }; f' s",
    "git -c 'alias.s=!git update-index --skip-worktree .nax/x' s",
    "git -c 'alias.s=!git checkout .' s",
    "git -c 'alias.s=checkout' s .",
    "git -c alias.a=s -c alias.s=stash a",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each(["git -c alias.st=status st", "git -c 'alias.s=-C pkg status' s", "git -c 'alias.l=!echo hi' l"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
});

describe("#2493 item 7: interpreter wrappers", () => {
  test.each([
    `python3 -c 'import os; os.system("git stash")'`,
    `python -c 'import subprocess; subprocess.run(["git", "stash"])'`,
    `node -e 'require("child_process").execSync("git stash")'`,
    `perl -e 'system("git stash")'`,
    `ruby -e 'system("git", "stash")'`,
    `env python3 -c 'import os; os.system("git checkout .")'`,
    `python3 -c 'import os; os.system("git update-index --skip-worktree .nax/x")'`,
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    "python3 script.py",
    `python3 -c 'import os; os.system("git status")'`,
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("allows an interpreter that runs git stash when there is no .nax", () => {
    expect(text(`python3 -c 'import os; os.system("git stash")'`, withoutNax)).toBeUndefined();
  });
});

describe("#2493 item 8: GIT_* environment overrides", () => {
  test.each([
    "GIT_WORK_TREE=.nax git checkout -- prd.json",
    "env GIT_WORK_TREE=.nax git checkout -- prd.json",
    "GIT_DIR=.nax git restore prd.json",
    "GIT_WORK_TREE=.nax GIT_DIR=.git git update-index --skip-worktree prd.json",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.s GIT_CONFIG_VALUE_0=stash git s",
    "GIT_CONFIG_PARAMETERS=alias.s=stash git s",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.c GIT_CONFIG_VALUE_0=checkout git c .",
    "GIT_CONFIG_COUNT=0 git stash",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "GIT_AUTHOR_NAME=x git commit -m wip",
    "GIT_CONFIG_COUNT=0 git status",
    "GIT_WORK_TREE=src git checkout -- x.ts",
    "env GIT_DIR=.git git status",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("a stash alias through GIT_CONFIG is allowed when there is no .nax", () => {
    expect(text("GIT_CONFIG_PARAMETERS=alias.s=stash git s", withoutNax)).toBeUndefined();
  });
});

describe("#2493 item 9: expansion in the command head or subcommand", () => {
  test.each([
    "git $X reset --hard",
    "git $X stash",
    "git `echo stash`",
    "git $(echo stash)",
    "git $V update-index --skip-worktree x",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "git $X",
    "$EDITOR file.txt",
    "echo $HOME",
    "git status $X",
    "git log --format=$FMT",
    "$G status",
    "$G stash",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("allows the same when there is no .nax", () => {
    expect(text("$G stash", withoutNax)).toBeUndefined();
  });
});

describe("#2493 item 10: checkout of a branch whose name has a .nax segment", () => {
  test.each(["git checkout feature/.nax", "git checkout -b feature/.nax", "git checkout -B topic/.nax origin/main"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );

  test.each([
    "git checkout -- feature/.nax",
    "git checkout -- .nax/features/f/prd.json",
    "git checkout .nax/features/f",
    "git checkout .nax/missing.json",
    "git checkout HEAD -- .nax",
    "git restore feature/.nax",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test("an operand that exists on disk is a path", () => {
    mkdirSync(join(root, "feature/.nax"), { recursive: true });
    expect(text("git checkout feature/.nax")).toBeDefined();
  });
});

describe("gated and raw Bash carry the new rules", () => {
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

  const DENIED = ["git reset --hard", "git checkout .", "git restore .", "\\git stash", "git config alias.s stash"];

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

  test("both allow the safe forms", () => {
    for (const command of [
      "git reset -- src/x.ts",
      "git checkout -- . ':!.nax'",
      "git -C src status",
      "git stash list",
    ]) {
      expect(gated(command).allowed).toBe(true);
      expect(raw(command).kind).toBe("allow");
    }
  });
});

describe("the nested .nax scan is cached per index", () => {
  test("a shared index scans the tree once; no index scans each time", () => {
    mkdirSync(join(bare, "pkg/a/.nax"), { recursive: true });
    const index = createNaxDirIndex();
    const ctx = { ...withoutNax, naxDirs: index };
    expect(text("git stash", ctx)).toBeDefined();
    // Removing the directory is not seen through the cache, and is seen without one.
    rmSync(join(bare, "pkg/a/.nax"), { recursive: true });
    expect(text("git stash", ctx)).toBeDefined();
    expect(text("git stash", withoutNax)).toBeUndefined();
  });
});
