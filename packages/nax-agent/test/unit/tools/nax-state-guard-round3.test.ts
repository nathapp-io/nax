/**
 * Review round 2 of the #2493 bundle. Real-git semantics these tests rest on (git 2.50, verified by the
 * reviewer): `:(exclude,glob)**` + `/.nax` matches only the `.nax` directory ENTRY, not the files in it, so
 * only the form that also ends in `/**` and starts at the top (`:(top,exclude,glob)**` + `/.nax/**`) keeps
 * `.nax/` out of a whole-tree restore or stash; git does not abbreviate long pathspec magic, and an
 * `attr:` element makes a `:(...)` spec an attribute filter, not an exclusion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileToolPolicy } from "#src/tools/index";
import { type NaxGuardContext, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

let root: string;
let withNax: NaxGuardContext;

beforeEach(() => {
  root = makeTempDir("nax-guard-r3-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "x\n");
  withNax = { frames: [root], root };
});
afterEach(() => cleanupTempDir(root));

const text = (command: string, ctx: NaxGuardContext = withNax) => naxStateRefusalInText(command, ctx);
const nested = (): NaxGuardContext => {
  mkdirSync(join(root, "pkg/a/.nax"), { recursive: true });
  return withNax;
};
const COVER = "':(top,exclude,glob)**/.nax/**'";

describe("C1: only the top, /**-suffixed glob exclusion covers the files inside .nax", () => {
  test.each([
    "git checkout -- . ':(exclude,glob)**/.nax'",
    "git checkout -- . ':(exclude,glob)**/.nax/**'",
    "git checkout -- . ':(top,exclude,glob)**/.nax'",
    "git restore -- . ':(glob,exclude)**/.nax'",
    "git stash push -- . ':(exclude,glob)**/.nax'",
  ])("does not count: %s", (command) => {
    expect(text(command, nested())).toBeDefined();
  });

  test.each([
    `git checkout -- . ${COVER}`,
    "git checkout -- . ':(exclude,top,glob)**/.nax/**'",
    "git restore -- . ':(glob,exclude,top)**/.nax/**'",
    `git stash push -- . ${COVER}`,
  ])("counts: %s", (command) => {
    expect(text(command, nested())).toBeUndefined();
  });

  test("the advice names exactly that form", () => {
    expect(text("git checkout .", nested())).toContain(COVER);
  });
});

describe("N1: attr magic is not an exclusion", () => {
  test.each([
    "git checkout -- . ':(attr:!exclude).nax'",
    "git checkout -- . ':(attr:exclude).nax'",
    "git restore -- . ':(icase,attr:x-exclude).nax'",
    "git checkout -- . ':(excluded).nax'",
    "git checkout -- . ':(exclud).nax'",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each(["git checkout -- . ':!.nax'", "git checkout -- . ':^.nax'", "git checkout -- . ':(exclude).nax'"])(
    "short and plain long forms still exclude the root .nax: %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
});

describe("N2: from a subdirectory, :/ needs the top-anchored exclusion", () => {
  const fromSrc: () => NaxGuardContext = () => ({ frames: [join(root, "src")], root });
  test("without top it reaches the root .nax", () => {
    expect(text("git checkout -- :/ ':(exclude,glob)**/.nax/**'", fromSrc())).toBeDefined();
  });
  test("with top it is covered", () => {
    expect(text(`git checkout -- :/ ${COVER}`, fromSrc())).toBeUndefined();
  });
});

describe("N3: operands of checkout-index, read-tree and clean", () => {
  test.each([
    "git checkout-index -f .nax/features/x/prd.json",
    "git checkout-index -f -- .nax/features/x/prd.json",
    "git checkout-index --force -u .nax/features/x/prd.json",
    "git checkout-index .nax/features/x/prd.json",
    "git clean -fd .nax",
    "git clean -fd -- .nax/features",
    "git read-tree --prefix=.nax/ HEAD",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
  test("a source file is fine", () => {
    expect(text("git checkout-index -f src/x.ts")).toBeUndefined();
  });
});

describe("H-new-1: abbreviated long options", () => {
  test.each([
    "git reset --k",
    "git reset --ke",
    "git reset --me HEAD~1",
    "git reset --har",
    "git checkout --f main",
    "git checkout --fo main",
    "git checkout-index --a --f",
    "git checkout-index --al --fo",
    "git switch --fo main",
    "git switch --d main",
    "git switch --discard main",
    "git read-tree -u --res HEAD",
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
  test.each([
    "git reset --mi",
    "git reset --so HEAD~1",
    "git reset --mixed",
    "git checkout --detach main",
    "git switch --detach main",
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });
});

describe("LOW: git clean as a dry run", () => {
  test.each(["git clean -n", "git clean --dry-run", "git clean -nd", "git clean -dn", "git clean --dry"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
  test("a real clean stays refused", () => {
    expect(text("git clean -fd")).toBeDefined();
    expect(text("git clean -f -d")).toBeDefined();
  });
});

describe("M-new-1: the quoted-string scan covers shells, interpreters and exec wrappers only", () => {
  test.each([
    `grep -rn "git stash" src`,
    `gh pr create --body "avoid git stash in agents"`,
    `gh issue comment 1 --body "ran git checkout . and lost it"`,
    `sed -i '' 's/git stash/safe/' README.md`,
    `printf '%s\\n' "git checkout ."`,
    `echo "git stash"`,
    `cat notes.md "git reset --hard"`,
    `git commit -m "git stash is refused"`,
    `git tag -a v1 -m "no git checkout . here"`,
    `rg "git stash" docs`,
  ])("allows %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test.each([
    `ssh host "git stash"`,
    `env "git" "stash"`,
    `nohup sh -c "git stash"`,
    `time bash -c 'git stash'`,
    `watch "git stash"`,
    `stdbuf -o0 bash -c "git checkout ."`,
    `sudo -u x sh -c "git reset --hard"`,
    `xargs -I{} sh -c "git stash"`,
    `awk 'BEGIN{system("git stash")}'`,
    `eval "git stash"`,
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
});

describe("H-new-4: gated mode accepts the exact covering pathspec", () => {
  const gated = (command: string) =>
    compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy }).check(
      "Bash",
      { pathFields: [], commandField: "command" },
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

  test("with a nested .nax a safe whole-tree discard is possible", () => {
    nested();
    expect(gated(`git checkout -- . ${COVER}`).allowed).toBe(true);
    expect(gated(`git stash push -- . ${COVER}`).allowed).toBe(true);
    expect(raw(`git checkout -- . ${COVER}`).kind).toBe("allow");
  });

  test("without the exclusion, or with a wrong one, it is still denied", () => {
    nested();
    expect(gated("git checkout -- .").allowed).toBe(false);
    expect(gated("git checkout -- . ':(exclude,glob)**/.nax'").allowed).toBe(false);
  });

  test("any other quoted glob is still an unmodelled expansion", () => {
    expect(gated("git checkout -- 'src/*'").allowed).toBe(false);
  });
});
