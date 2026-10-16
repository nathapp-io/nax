import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redirectForCommand } from "#src/tools/denial-redirect";
import { compileToolPolicy } from "#src/tools/index";
import { _naxStateGuardDeps } from "#src/tools/nax-stash-restore";
import { type NaxGuardContext, naxStateRefusal, naxStateRefusalInText } from "#src/tools/nax-state-guard";
import { screenRawBashCommand } from "#src/tools/policy-bash-raw";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;
const words = (command: string) => command.split(/\s+/);

const originalGit = _naxStateGuardDeps.git;

let root: string;
let bare: string;
let withNax: NaxGuardContext;
let withoutNax: NaxGuardContext;

beforeEach(() => {
  _naxStateGuardDeps.git = () => undefined;
  root = makeTempDir("nax-state-guard-");
  mkdirSync(join(root, ".nax/features/f"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "pkg/sub"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "x\n");
  writeFileSync(join(root, "src/a.ts"), "a\n");
  writeFileSync(join(root, "data.json"), "{}\n");
  withNax = { frames: [root], root };
  bare = makeTempDir("nax-state-guard-bare-");
  withoutNax = { frames: [bare], root: bare };
});
afterEach(() => {
  _naxStateGuardDeps.git = originalGit;
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
    "git stash save -- src/x.ts",
    "git stash -- src/x.ts",
    "git stash push -m :!.nax",
    "git stash save :!.nax",
    "git stash push -- *.json",
    "git stash push -- data.json *.json",
    "git stash push -- missing.ts",
    "git stash push -- :(glob)src/*",
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

  test("allows a push whose every pathspec is a plain existing file, refuses the rest", () => {
    expect(naxStateRefusal(["git", "stash", "push", "--", "src/x.ts"], withNax)).toBeUndefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", "src/x.ts", ".nax/a"], withNax)).toBeDefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", "."], withNax)).toBeDefined();
    expect(naxStateRefusal(["git", "stash", "push", "src/x.ts"], withNax)).toBeUndefined();
  });

  test("an exclusion must name <root>/.nax from every frame", () => {
    const fromSrc = { frames: [join(root, "src")], root };
    expect(naxStateRefusal(["git", "stash", "push", "--", ".", ":!.nax"], fromSrc)).toBeDefined();
    expect(naxStateRefusal(["git", "stash", "push", "--", ".", ":!../.nax"], fromSrc)).toBeUndefined();
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
    "git -P stash",
    "git --paginate stash",
    "git --no-optional-locks stash",
    "git --work-tree . stash",
    "git --work-tree=. stash pop",
    "git -c alias.s=stash s",
    "git update-index --sk .nax/x",
    "git update-index --no-sk .nax/x",
    "git update-index --as .nax/x",
    "git -C .nax update-index --skip-worktree prd.json",
    "git -C .nax checkout -- prd.json",
    "git --work-tree .nax checkout -- prd.json",
    "git update-index --skip-worktree --stdin src/x.ts",
    "git update-index --assume-unchanged --index-info src/x.ts",
    "xargs git update-index --skip-worktree src/x.ts",
    "eval git stash",
    "eval git update-index --skip-worktree .nax/x",
    "bash -c 'cd .nax && git update-index --skip-worktree prd.json'",
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

  test.each([
    "bash -c 'echo hi'",
    "bash -c 'npm test && echo ok'",
    "git -C pkg status",
    "git -C pkg stash list",
    "git stash list",
    "git stash show -p",
    "git update-index --refresh",
    "git update-index --assume-unchanged src/a.ts",
    'git commit -m "fix stash handling"',
    "echo stash",
    "time git stash list",
    "git stash push -- src/x.ts",
    "git stash push -- src/x.ts src/a.ts",
    "git stash push -- . :!.nax",
  ])("does not flag %s", (command) => {
    expect(refuse(command)).toBeUndefined();
  });
});

describe("naxStateRefusalInText (the lexer-refused path)", () => {
  test.each([
    "git stash 2>&1",
    "time git stash",
    "nohup git stash",
    "stdbuf -o0 git stash",
    "time git update-index --skip-worktree .nax/x",
    "cd .nax && git update-index --skip-worktree prd.json $(true) && true",
    "cd .nax && git update-index --skip-worktree prd.json $(true)",
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

describe("round 3 (#2490)", () => {
  const text = (command: string, ctx: NaxGuardContext = withNax) => naxStateRefusalInText(command, ctx);

  test.each([
    "git commit -F - <<'EOF'\nfix: handle git stash in guard\nEOF",
    "cat > notes.md <<'EOF'\nNever run git stash here\nEOF",
    'cat <<"END"\ngit stash\nEND\necho done',
    "cat <<-TAB\n\tgit stash\n\tTAB\n",
    "cat <<A <<B\ngit stash\nA\ngit stash pop\nB",
  ])("treats a heredoc body as data: %s", (command) => {
    expect(text(command)).toBeUndefined();
  });

  test.each([
    "cat <<'EOF'\nbody\nEOF\ngit stash",
    "cat <<EOF\nbody\nEOF\ngit update-index --skip-worktree .nax/x",
    "git stash <<EOF\nbody\nEOF",
  ])("still denies a real command around a heredoc: %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test.each([
    "pushd .nax && git update-index --skip-worktree prd.json",
    "pushd .nax; git checkout -- prd.json",
    "pushd -n .nax; popd; git update-index --skip-worktree prd.json",
  ])("tracks pushd like cd: %s", (command) => {
    expect(text(command)).toBeDefined();
  });

  test("pushd into a source directory stays allowed", () => {
    expect(text("pushd src && git update-index --skip-worktree x.ts")).toBeUndefined();
  });

  test.each([
    "git update-index --skip-worktree $(git ls-files .nax)",
    "git update-index --skip-worktree `git ls-files .nax`",
    "git update-index --assume-unchanged $FILES",
  ])("an expansion operand of a hiding update-index is uninspectable: %s", (command) => {
    expect(text(command)).toBeDefined();
    expect(text(command, withoutNax)).toBeUndefined();
  });

  test.each([
    "git -c ALIAS.s=stash s",
    "git -c Alias.S=update-index S --skip-worktree .nax/x",
    "git -c alias.s=stash S",
  ])("matches alias definitions case-insensitively: %s", (command) => {
    expect(refuse(command)).toBeDefined();
  });

  test.each(["git --config-env=alias.s=SOMEVAR s", "git --config-env alias.s=SOMEVAR s"])(
    "an alias defined through --config-env is unresolvable and refused when .nax exists: %s",
    (command) => {
      expect(refuse(command)).toBeDefined();
      expect(refuse(command, withoutNax)).toBeUndefined();
    },
  );

  test("--config-env for a non-alias key stays allowed", () => {
    expect(refuse("git --config-env=http.extraheader=HDR status")).toBeUndefined();
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
    "time git stash",
    "nohup git stash",
    "stdbuf -o0 git stash",
    "git -P stash",
    "git -c alias.s=stash s",
    "git -C .nax checkout -- prd.json",
    "bash -c 'cd .nax && git update-index --skip-worktree prd.json'",
    "cd .nax && git update-index --skip-worktree prd.json $(true)",
    "git update-index --skip-worktree $(git ls-files .nax)",
    "pushd .nax && git update-index --skip-worktree prd.json",
    "git -c ALIAS.s=stash s",
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

  test("raw mode allows a heredoc whose body mentions git stash", () => {
    expect(raw("git commit -F - <<'EOF'\nfix: handle git stash in guard\nEOF").kind).toBe("allow");
    expect(raw("cat <<'EOF'\nx\nEOF\ngit stash").kind).toBe("deny");
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
