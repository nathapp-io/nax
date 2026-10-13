/** Review round 1 of the #2493 bundle: the bypasses the reviewer proved against real git. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNaxDirIndex, type NaxGuardContext, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let root: string;
let bare: string;
let withNax: NaxGuardContext;
let withoutNax: NaxGuardContext;

beforeEach(() => {
  root = makeTempDir("nax-guard-r2-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "x\n");
  withNax = { frames: [root], root };
  bare = makeTempDir("nax-guard-r2-bare-");
  withoutNax = { frames: [bare], root: bare };
});
afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(bare);
});

const text = (command: string, ctx: NaxGuardContext = withNax) => naxStateRefusalInText(command, ctx);
const chain = (final: string, depth: number): string => {
  const defs = Array.from({ length: depth }, (_, i) => `-c alias.a${i + 1}=${i + 1 === depth ? final : `a${i + 2}`}`);
  return `git ${defs.join(" ")} a1`;
};

describe("S1: alias chains have no depth limit", () => {
  test.each([
    [chain("stash", 9)],
    [chain("stash", 40)],
    [`${chain("reset", 12)} --hard`],
    [`${chain("checkout", 12)} .`],
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test("a cycle is refused outright when a .nax exists", () => {
    expect(text("git -c alias.a1=a1 a1")).toBeDefined();
    expect(text("git -c alias.a=b -c alias.b=a a")).toBeDefined();
    expect(text("git -c alias.a1=a1 a1", withoutNax)).toBeUndefined();
  });

  test("a long chain that ends in a harmless verb is allowed", () => {
    expect(text(chain("status", 12))).toBeUndefined();
  });
});

describe("S2: backslash-built words", () => {
  test.each([
    "g\\it stash",
    "git st\\ash",
    "git re\\set --hard",
    "git check\\out .",
    "git config alias.s sta\\sh",
    "git st\\\nash",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test("single-quoted backslashes stay literal, and harmless ones are allowed", () => {
    expect(text("git log --grep='a\\b'")).toBeUndefined();
    expect(text("git sta\\tus")).toBeUndefined();
  });
});

describe("S3: restore flag abbreviations", () => {
  test.each([
    "git restore --staged --wor .",
    "git restore --staged --work .",
    "git restore -SW .",
    "git restore -WS .",
    "git restore -S -W .",
    "git restore --staged --worktree .",
    "git restore --staged --frobnicate .",
    "git restore --staged --source=HEAD~1 .",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each(["git restore --staged .", "git restore -S .", "git restore --st .", "git restore -S -q ."])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
});

describe("S4: interpreters and quoted strings", () => {
  test.each([
    `bun -e "require('child_process').execSync('git stash')"`,
    `deno eval "Deno.run({cmd:['git','stash']})"`,
    `deno -e "Deno.run({cmd:['git','stash']})"`,
    `php -r "system('git stash');"`,
    `awk 'BEGIN{system("git stash")}'`,
    `gawk 'BEGIN{system("git stash")}'`,
    `lua -e "os.execute('git stash')"`,
    `osascript -e 'do shell script "git stash"'`,
    `pwsh -c "git stash"`,
    `pwsh -Command "git reset --hard"`,
    `tclsh <<< 'exec git stash'`,
    `ssh host "git stash"`,
    `xargs -I{} sh -c "git stash"`,
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "python3 -c 'print(1)'",
    `ssh host "ls -la"`,
    `awk 'BEGIN{print 1}'`,
    `git commit -m "fix: git stash handling"`,
    `php -r "echo 1;"`,
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });
});

describe("S5: command-executing git config", () => {
  test.each([
    "git -c core.fsmonitor=x status",
    "git -c core.fsmonitor='git stash' status",
    "git -c diff.external=x diff",
    "git -c core.hooksPath=/tmp/h commit -m x",
    "git -c core.pager=x log",
    "git -c core.editor=x commit",
    "git -c core.sshCommand=x fetch",
    "git -c sequence.editor=x rebase -i HEAD~2",
    "git -c include.path=/tmp/e.cfg status",
    "git -c includeIf.gitdir:/a.path=/tmp/e.cfg status",
    "git -c diff.foo.textconv=x diff",
    "git -c filter.lfs.clean=x add .",
    "git -c filter.lfs.smudge=x checkout main",
    "git -c merge.m.process=x status",
    "git --config-env=core.pager=VAR log",
    "git config core.hooksPath /tmp/h",
    "git config --global include.path /tmp/e.cfg",
    "git config includeIf.gitdir:/a.path /tmp/e.cfg",
    "git config --local core.fsmonitor x",
    "git config sequence.editor x",
    "git config filter.lfs.clean x",
    "git config diff.foo.textconv x",
    "git config --add core.sshCommand x",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "git -c core.quotepath=off status",
    "git -c color.ui=never log",
    "git config user.name x",
    "git config core.pager",
    "git config --get core.editor",
    "git config --unset core.hooksPath",
    "git config --get-all include.path",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("allowed when there is no .nax", () => {
    expect(text("git -c core.fsmonitor=x status", withoutNax)).toBeUndefined();
    expect(text("git config core.hooksPath /tmp/h", withoutNax)).toBeUndefined();
  });
});

describe("S6: the nested scan does not cache absence for ever", () => {
  test("a .nax that appears later is found once the TTL has passed", () => {
    let clock = 0;
    const naxDirs = createNaxDirIndex(() => clock);
    const ctx = { ...withoutNax, naxDirs };
    expect(text("git stash", ctx)).toBeUndefined();
    mkdirSync(join(bare, "pkg/.nax"), { recursive: true });
    clock = 500;
    expect(text("git stash", ctx)).toBeUndefined();
    clock = 1_500;
    expect(text("git stash", ctx)).toBeDefined();
  });

  test("a positive result is kept", () => {
    let clock = 0;
    mkdirSync(join(bare, "pkg/.nax"), { recursive: true });
    const ctx = { ...withoutNax, naxDirs: createNaxDirIndex(() => clock) };
    expect(text("git stash", ctx)).toBeDefined();
    clock = 60_000;
    expect(text("git stash", ctx)).toBeDefined();
  });
});

describe("H1: an alias never shadows a git builtin", () => {
  test.each([
    "git -c alias.stash=status stash",
    "git -c alias.checkout=status checkout .",
    "git -c alias.reset=status reset --hard",
    "git -c alias.restore=status restore .",
    "git -c alias.update-index=status update-index --skip-worktree .nax/x",
    "git -c alias.switch=status switch -f main",
    "git -c alias.clean=status clean -fd",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
});

describe("H2/H3: nested .nax and the other whole-tree discards", () => {
  const nested = (): NaxGuardContext => {
    mkdirSync(join(root, "pkg/a/.nax"), { recursive: true });
    return withNax;
  };
  const COVER = "':(top,exclude,glob)**/.nax/**'";

  test.each(["git checkout -- . ':!.nax'", "git restore -- . ':!.nax'", "git stash push -- . ':!.nax'"])(
    "a root-only exclusion does not cover a nested .nax: %s",
    (command) => {
      expect(text(command, nested())).toBeDefined();
    },
  );

  test.each([
    `git checkout -- . ${COVER}`,
    `git restore -- . ${COVER}`,
    `git stash push -- . ${COVER}`,
    "git checkout -- . ':(exclude,top,glob)**/.nax/**'",
    `git clean -fd -- . ${COVER}`,
  ])("a glob exclusion covers every .nax: %s", (command) => {
    expect(text(command, nested())).toBeUndefined();
  });

  test("the refusal advice names the covering form", () => {
    expect(text("git checkout .", nested())).toContain(COVER);
    expect(text("git stash", nested())).toContain(COVER);
  });

  test.each([
    "git checkout -f main",
    "git checkout --force main",
    "git checkout -f",
    "git checkout -fq main",
    "git switch -f main",
    "git switch --force main",
    "git switch --discard-changes main",
    "git reset --keep",
    "git reset --merge HEAD~1",
    "git clean -fd",
    "git clean",
    "git checkout-index -a -f",
    "git checkout-index --all --force",
    "git read-tree -u --reset HEAD",
    "git read-tree --reset -u HEAD",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "git checkout main",
    "git checkout -b x",
    "git switch main",
    "git switch -c y",
    "git reset --mixed",
    "git reset --soft HEAD~1",
    "git checkout-index -f src/x.ts",
    "git checkout-index src/x.ts",
    "git read-tree HEAD",
    "git status",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test("these are allowed when there is no .nax", () => {
    expect(text("git clean -fd", withoutNax)).toBeUndefined();
    expect(text("git checkout -f main", withoutNax)).toBeUndefined();
  });
});

describe("M: an expansion head needs a git token in the segment", () => {
  test.each(["$BUN_BIN test reset.test.ts", "$RUNNER checkout.test.ts", "$X reset", "$G stash"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
  test.each(["git $X reset --hard", "git $V stash", "git `echo stash`"])("still denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
});

describe("L: reset aliases", () => {
  test("a reset alias is refused only when it discards", () => {
    expect(text("git config alias.unstage 'reset HEAD --'")).toBeUndefined();
    expect(text("git config alias.hard 'reset --hard'")).toBeDefined();
    expect(text("git config alias.k 'reset --keep'")).toBeDefined();
    expect(text("git config alias.co checkout")).toBeDefined();
  });
});
