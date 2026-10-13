/**
 * Final regressions from the #2493 bundle's verification pass. Real-git semantics (git 2.50): in a short
 * option cluster, `git clean -e` takes the rest of the cluster as its value, so `-fdenx` is `-f -d -e nx`
 * (a real clean), not a dry run; `--literal-pathspecs` / `GIT_LITERAL_PATHSPECS=1` turn every `:(...)` /
 * `:!` exclusion into a literal path, so no exclusion protects `.nax/`.
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
  root = makeTempDir("nax-guard-final-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "x\n");
  withNax = { frames: [root], root };
});
afterEach(() => cleanupTempDir(root));

const text = (command: string) => naxStateRefusalInText(command, withNax);
const raw = (command: string) =>
  screenRawBashCommand({
    tool: "Bash",
    command,
    initialPath: root,
    root,
    ownedPaths: naxOwnedPathsPolicy,
    resolvePath: (candidate, cwd) => resolve(cwd, candidate),
  });
const gated = (command: string) =>
  compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root, { ownedPaths: naxOwnedPathsPolicy }).check(
    "Bash",
    { pathFields: [], commandField: "command" },
    { command },
  );
const COVER = "':(top,exclude,glob)**/.nax/**'";

describe("a shell anywhere in the segment still triggers the nested scan", () => {
  test.each([
    `if sh -c "git stash"; then :; fi`,
    `for i in 1; do sh -c "git stash"; done`,
    `find . -exec sh -c "git reset --hard" ;`,
    `setsid bash -c "git checkout -- ."`,
    `npx -y sh -c "git checkout -f main"`,
    `su -c "git restore ." me`,
    `ionice -c3 sh -c "git stash"`,
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([`grep -rn "git stash" src`, `gh pr create --body "avoid git stash"`, `sed -i '' 's/git stash/x/' f`])(
    "still allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
});

describe("git clean dry-run detection follows git's short-cluster parsing", () => {
  test.each(["git clean -fdenx", "git clean -fdx -evenv", "git clean -fen", "git clean -fd -e n"])(
    "denies %s (the n belongs to -e)",
    (command) => {
      expect(text(command)).toBeDefined();
    },
  );
  test.each(["git clean -n", "git clean -nd", "git clean -dn", "git clean -nde x", "git clean --dry-run -fd"])(
    "allows %s",
    (command) => {
      expect(text(command)).toBeUndefined();
    },
  );
});

describe("literal pathspecs disable every exclusion", () => {
  test.each([
    `git --literal-pathspecs clean -fd -- . ${COVER}`,
    `git --literal-pathspecs checkout -- . ${COVER}`,
    `GIT_LITERAL_PATHSPECS=1 git restore -- . ${COVER}`,
    `git --literal-pathspecs stash push -- . ':!.nax'`,
    `env GIT_LITERAL_PATHSPECS=1 git checkout -- . ':!.nax'`,
  ])("denies %s", (command) => {
    expect(text(command)).toBeDefined();
  });
  test("the covering exclusion alone is still allowed", () => {
    expect(text(`git checkout -- . ${COVER}`)).toBeUndefined();
  });
  test("literal pathspecs on a non-discard command are allowed", () => {
    expect(text("git --literal-pathspecs status")).toBeUndefined();
    expect(text("git --literal-pathspecs diff -- src/x.ts")).toBeUndefined();
  });
});

describe("gated and raw modes carry the final rules", () => {
  test.each(["git clean -fdenx", 'if sh -c "git stash"; then :; fi', `git --literal-pathspecs checkout -- . ${COVER}`])(
    "denies %s",
    (command) => {
      expect(gated(command).allowed).toBe(false);
      expect(raw(command).kind).not.toBe("allow");
    },
  );
});
