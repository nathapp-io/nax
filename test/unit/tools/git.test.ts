import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildGitArgv,
  compileToolPolicy,
  createCodingToolRuntime,
  DEFAULT_LOG_MAX_COUNT,
  GIT_ESCAPE_FLAGS,
  GIT_READ_VERBS,
  gitTool,
} from "@/tools";
import { GIT_DIFF_FILTERS } from "@/tools/git";
import { _gitDeps } from "@/utils/git";
import { NAX_OWNED_GIT_EXCLUDE_PATHSPECS } from "@/utils/nax-owned-paths";

function contentOf(result: { kind: string; content?: string }): string {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  return result.content ?? "";
}

function argvOf(input: Record<string, unknown>): string[] {
  const built = buildGitArgv(input);
  if ("error" in built) throw new Error(`expected argv, got error: ${built.error}`);
  return built;
}

describe("buildGitArgv", () => {
  // A bare verb is NOT a bare argv: `--` terminates the revision list so no
  // argument can be reinterpreted as a pathspec, and `.` scopes the command to
  // the cwd, which is the permitted root. See the root-boundary tests below for
  // the two escapes this shape closes.
  test("scopes a plain diff to the root and terminates the revision list", () => {
    expect(argvOf({ subcommand: "diff" })).toEqual([
      "diff",
      "--relative",
      "--",
      ".",
      ...NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    ]);
  });

  test("appends refs then paths after a '--' separator", () => {
    expect(argvOf({ subcommand: "diff", refs: ["HEAD~1", "HEAD"], paths: ["src/a.ts"] })).toEqual([
      "diff",
      "--relative",
      "HEAD~1",
      "HEAD",
      "--",
      "src/a.ts",
    ]);
  });

  // #1807 — git frames diff-style "a/<path>"/"b/<path>" headers relative to the
  // repository top-level regardless of cwd, which disagrees with Read/Grep/Glob
  // whenever the permitted root is a package subdir. `--relative` makes git
  // apply that offset itself, so it belongs only on the verbs that print those
  // headers -- `status` rejects the flag outright, and `blame` never prints one.
  test("adds --relative only to the verbs that print diff-style path headers", () => {
    expect(argvOf({ subcommand: "diff" })).toContain("--relative");
    expect(argvOf({ subcommand: "log" })).toContain("--relative");
    expect(argvOf({ subcommand: "show" })).toContain("--relative");
    expect(argvOf({ subcommand: "status" })).not.toContain("--relative");
    expect(argvOf({ subcommand: "blame", paths: ["src/a.ts"] })).not.toContain("--relative");
  });

  test("rejects a subcommand outside the read-only verb list", () => {
    const built = buildGitArgv({ subcommand: "commit" });
    expect("error" in built).toBe(true);
  });

  test("rejects a ref that looks like a flag", () => {
    const built = buildGitArgv({ subcommand: "log", refs: ["--exec-path=/tmp/evil"] });
    expect("error" in built).toBe(true);
  });

  test("rejects a path that looks like a flag", () => {
    const built = buildGitArgv({ subcommand: "diff", paths: ["-C/etc"] });
    expect("error" in built).toBe(true);
  });

  // Asserted rather than merely not-written: a later refactor could reintroduce
  // one, and each of these reaches outside the repository or executes code.
  test("no built argv ever contains a repo-escape flag", () => {
    const inputs = [
      { subcommand: "diff", refs: ["HEAD"], paths: ["src"] },
      { subcommand: "log" },
      { subcommand: "show", refs: ["HEAD"] },
      { subcommand: "status" },
      { subcommand: "blame", paths: ["src/a.ts"] },
    ];
    for (const input of inputs) {
      const argv = argvOf(input);
      for (const flag of GIT_ESCAPE_FLAGS) {
        expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
      }
    }
  });

  test("mutating verbs are absent from the read-only verb list", () => {
    for (const verb of ["commit", "push", "checkout", "reset", "clean"]) {
      expect(GIT_READ_VERBS).not.toContain(verb);
    }
  });
});

/**
 * nax#2007 — nax writes run state under `.nax/`, and during a run it is
 * git-tracked, so an unscoped Git call reported it back to the agent as its own
 * diff. The fix narrows only the DEFAULT view: a caller that names a path gets
 * exactly what it asked for. `blame` is exempt because git rejects exclude
 * pathspecs there and exits 128.
 */
describe("buildGitArgv — nax-owned paths are excluded from the default view", () => {
  const GIT_EXCLUDES = [":(exclude).nax", ":(glob,exclude)**/.nax/**"];

  test("the shared SSOT constant is the git exclude form the tool uses", () => {
    expect([...NAX_OWNED_GIT_EXCLUDE_PATHSPECS]).toEqual(GIT_EXCLUDES);
  });

  test("status with no paths ends with the root and the nax exclusions", () => {
    expect(argvOf({ subcommand: "status" })).toEqual(["status", "--", ".", ...GIT_EXCLUDES]);
  });

  test("diff with no paths gets the exclusions, with --relative still ahead of the refs", () => {
    expect(argvOf({ subcommand: "diff" })).toEqual(["diff", "--relative", "--", ".", ...GIT_EXCLUDES]);
    expect(argvOf({ subcommand: "diff", refs: ["HEAD~1", "HEAD"] })).toEqual([
      "diff",
      "--relative",
      "HEAD~1",
      "HEAD",
      "--",
      ".",
      ...GIT_EXCLUDES,
    ]);
  });

  test("blame with no paths is exempt — exclude pathspecs are a git usage error there", () => {
    expect(argvOf({ subcommand: "blame" })).toEqual(["blame", "--", "."]);
  });

  test("an explicitly named path is answered as given, with no exclusion injected", () => {
    expect(argvOf({ subcommand: "diff", paths: ["src/a.ts"] })).toEqual(["diff", "--relative", "--", "src/a.ts"]);
  });

  test("an explicitly named .nax path still reaches the file", () => {
    expect(argvOf({ subcommand: "diff", paths: [".nax/features/f/prd.json"] })).toEqual([
      "diff",
      "--relative",
      "--",
      ".nax/features/f/prd.json",
    ]);
  });

  test("log with no refs keeps the --max-count default alongside the exclusions", () => {
    const argv = argvOf({ subcommand: "log" });
    expect(argv).toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
    expect(argv.slice(-GIT_EXCLUDES.length)).toEqual(GIT_EXCLUDES);
    expect(argv[argv.length - GIT_EXCLUDES.length - 1]).toBe(".");
  });
});

/**
 * #2007 — the exclusion must hide a NESTED `.nax/` too, not just the repo-root
 * one. Proven against a real repository: a bare doublestar without `:(glob)`
 * left `packages/app/.nax/...` in the default view, so a monorepo package's
 * run state still reported as the agent's own diff.
 */
describe("gitTool — the default view hides nested and root .nax run state", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const NAX_PATHS = [".nax/features/f/prd.json", "packages/app/.nax/features/f/prd.json"];

  /** Commits the three seed files, then dirties all three. */
  async function makeRepo(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "nax-git-nax-exclude-"));
    repos.push(repo);
    for (const relativePath of [...NAX_PATHS, "src/a.ts"]) {
      const full = join(repo, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "seed\n");
    }
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;
    for (const relativePath of [...NAX_PATHS, "src/a.ts"]) {
      writeFileSync(join(repo, relativePath), "dirty\n");
    }
    return repo;
  }

  test("status reports the dirtied src/a.ts but neither .nax path", async () => {
    const repo = await makeRepo();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo) });

    const content = contentOf(await rt.callTool("Git", { subcommand: "status" }));

    expect(content).toContain("src/a.ts");
    expect(content).not.toContain(".nax/features/f/prd.json");
    expect(content).not.toContain("packages/app/.nax/features/f/prd.json");
  });

  test("diff reports the dirtied src/a.ts but neither .nax path", async () => {
    const repo = await makeRepo();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo) });

    const content = contentOf(await rt.callTool("Git", { subcommand: "diff" }));

    expect(content).toContain("src/a.ts");
    expect(content).not.toContain(".nax/features/f/prd.json");
    expect(content).not.toContain("packages/app/.nax/features/f/prd.json");
  });
});

/**
 * #1818 — typed flag fields.
 *
 * Every flag git needs here is emitted by nax, never supplied by the model: a
 * boolean or a closed enum in, a fixed string out. That keeps the property the
 * header comment defends -- the model supplies structure, nax constructs the
 * argv -- while making `--name-only --diff-filter=A` expressible at all. It is
 * step 1 of the adversarial reviewer's test-audit workflow, and before this the
 * only way to ask for it was to put the flags in `refs`/`paths`, where they are
 * refused. 12 of the 19 Git failures in the tool-audit ledgers are that shape.
 */
describe("buildGitArgv — typed flag fields", () => {
  test("emits --name-only for diff and log", () => {
    expect(argvOf({ subcommand: "diff", nameOnly: true })).toEqual([
      "diff",
      "--relative",
      "--name-only",
      "--",
      ".",
      ...NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    ]);
    expect(argvOf({ subcommand: "log", nameOnly: true })).toContain("--name-only");
  });

  test("emits --diff-filter=<value> for diff and log", () => {
    expect(argvOf({ subcommand: "diff", diffFilter: "A" })).toContain("--diff-filter=A");
    expect(argvOf({ subcommand: "log", diffFilter: "A" })).toContain("--diff-filter=A");
  });

  // nax#1800: `show` was in GIT_READ_VERBS but in none of the flag gates, so
  // `git show --name-only <ref>` -- plain read-only git, and the natural way to
  // ask what a commit touched -- was inexpressible. 22 rejections across 4
  // features in the tool audit, from verifier, implementer and test-writer
  // sessions alike. All three flags are valid git options on `show`.
  test("emits --name-only for show", () => {
    expect(argvOf({ subcommand: "show", nameOnly: true })).toContain("--name-only");
  });

  test("emits --diff-filter=<value> for show", () => {
    expect(argvOf({ subcommand: "show", diffFilter: "A" })).toContain("--diff-filter=A");
  });

  test("emits --oneline for show", () => {
    expect(argvOf({ subcommand: "show", oneline: true })).toContain("--oneline");
  });

  test("still refuses a flag on a verb git does not accept it for", () => {
    // `git status` has no --name-only. Widening for `show` must not widen for
    // every verb: an invented acceptance would surface as a raw git error.
    const built = buildGitArgv({ subcommand: "status", nameOnly: true });
    expect(built).toEqual({ error: '"nameOnly" is not valid for "status" (valid for: diff, log, show)' });
  });

  test("emits --oneline for log", () => {
    expect(argvOf({ subcommand: "log", oneline: true })).toContain("--oneline");
  });

  test("places flags before the refs so they are never read as revisions", () => {
    expect(argvOf({ subcommand: "diff", nameOnly: true, diffFilter: "A", refs: ["abc..HEAD"], paths: ["."] })).toEqual([
      "diff",
      "--relative",
      "--name-only",
      "--diff-filter=A",
      "abc..HEAD",
      "--",
      ".",
    ]);
  });

  test("a false or omitted boolean emits nothing", () => {
    expect(argvOf({ subcommand: "diff", nameOnly: false })).toEqual([
      "diff",
      "--relative",
      "--",
      ".",
      ...NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    ]);
    expect(argvOf({ subcommand: "log", oneline: false })).not.toContain("--oneline");
  });

  // `false` asks for nothing, so refusing it for the wrong verb would invent a
  // refusal — the failure class this change exists to reduce.
  test("an explicitly-false flag is accepted even on a verb it does not apply to", () => {
    expect(argvOf({ subcommand: "status", nameOnly: false })).toEqual([
      "status",
      "--",
      ".",
      ...NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    ]);
    expect(argvOf({ subcommand: "diff", oneline: false })).toEqual([
      "diff",
      "--relative",
      "--",
      ".",
      ...NAX_OWNED_GIT_EXCLUDE_PATHSPECS,
    ]);
  });

  // The closed enum is the whole safety property: were the value interpolated
  // as given, `--diff-filter=<anything>` would be a model-authored flag.
  test("rejects a diffFilter outside the enum", () => {
    for (const value of ["X", "A;rm -rf /", "", "AM", "--exec-path=/tmp/evil"]) {
      const built = buildGitArgv({ subcommand: "diff", diffFilter: value });
      expect("error" in built).toBe(true);
    }
  });

  test("rejects a non-boolean nameOnly rather than coercing it", () => {
    expect("error" in buildGitArgv({ subcommand: "diff", nameOnly: "yes" })).toBe(true);
  });

  test("rejects a flag field on a subcommand it does not apply to", () => {
    expect("error" in buildGitArgv({ subcommand: "diff", oneline: true })).toBe(true);
    expect("error" in buildGitArgv({ subcommand: "status", nameOnly: true })).toBe(true);
    // `show` used to be asserted here on the premise that "git itself refuses
    // show --name-only". It does not -- `git show --name-only <ref>` is valid
    // and is what agents reach for. Moved to the accepting cases above (#1800).
    expect("error" in buildGitArgv({ subcommand: "blame", diffFilter: "A" })).toBe(true);
    expect("error" in buildGitArgv({ subcommand: "status", oneline: true })).toBe(true);
  });

  test("no built argv with flag fields set contains a repo-escape flag", () => {
    const argv = argvOf({ subcommand: "diff", nameOnly: true, diffFilter: "A" });
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
  });

  test("declares the flag fields in the input schema so a model can reach them", () => {
    expect(gitTool.inputSchema).toMatchObject({
      properties: {
        nameOnly: { type: "boolean" },
        oneline: { type: "boolean" },
        diffFilter: { enum: GIT_DIFF_FILTERS },
      },
    });
  });
});

describe("gitTool", () => {
  test("declares its verbs so the policy can gate at the tool level", () => {
    expect(gitTool.scope.verbField).toBe("subcommand");
    expect(gitTool.scope.allowedVerbs).toEqual(GIT_READ_VERBS);
  });

  test("declares no scalar path field — pathspecs are array-valued and validated by the policy", () => {
    expect(gitTool.scope.pathFields).toEqual([]);
  });

  test("declares paths and refs as containment-checked array fields", () => {
    expect(gitTool.scope.arrayPathFields).toEqual(["paths"]);
    expect(gitTool.scope.refPathFields).toEqual(["refs"]);
  });
});

/**
 * The root is a hard boundary for Git too — verified against a real repository,
 * not against the argv builder alone.
 *
 * Two distinct escapes, both live before this:
 *
 * 1. A colon-less `refs` entry was treated as "a pure revision, nothing to
 *    contain", so it never reached `resolveWithin`. But git disambiguates an
 *    argument that is not a valid revision by checking whether it names a path,
 *    and silently reinterprets it as a pathspec. `git show ../../other/secret`
 *    read a file outside the root.
 *
 * 2. Even with that closed, a whole-commit ref spans the entire repository, so
 *    `git show HEAD` returned outside-root content without naming a path at
 *    all. Nothing in the argv was wrong — the command's own scope was.
 *
 * Both are closed by the same argv shape: `--` always terminates the revision
 * list, and an unrestricted call is scoped to the root with an explicit `.`
 * pathspec.
 */
describe("gitTool — the permitted root bounds the repository view", () => {
  const outside = "SECRET-DATA";

  async function makeRepo(): Promise<{ repo: string; root: string }> {
    const repo = mkdtempSync(join(tmpdir(), "nax-git-bound-"));
    mkdirSync(join(repo, "inside", "sub"), { recursive: true });
    mkdirSync(join(repo, "outside"), { recursive: true });
    writeFileSync(join(repo, "inside", "sub", "f.txt"), "public\n");
    writeFileSync(join(repo, "outside", "secret.txt"), `${outside}\n`);
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;
    return { repo, root: join(repo, "inside", "sub") };
  }

  test("a colon-less ref cannot address a path outside the root", async () => {
    const { root } = await makeRepo();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "show", refs: ["../../outside/secret.txt"] });

    expect(result.kind).not.toBe("ok");
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  test("a whole-commit ref does not leak content from outside the root", async () => {
    const { root } = await makeRepo();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD"] });

    expect(JSON.stringify(result)).not.toContain(outside);
  });

  test("still returns in-root content, so the boundary has not just broken Git", async () => {
    const { root } = await makeRepo();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD"] });

    expect(result.kind).toBe("ok");
    expect(JSON.stringify(result)).toContain("f.txt");
  });
});

/**
 * #1807 — Git prints paths relative to the repository top-level regardless of
 * cwd, but Read/Grep/Glob resolve a path relative to the permitted root
 * (ctx.root). When the permitted root is a package subdir, a path copied out
 * of Git's own output is framed wrong for every other tool. Git's output must
 * be re-framed to the permitted root before it reaches the model.
 */
describe("gitTool — output paths are framed relative to the permitted root", () => {
  async function makeRepoWithPackageWorkdir(opts?: { fileName?: string }): Promise<{ repo: string; root: string }> {
    const fileName = opts?.fileName ?? "f.txt";
    const repo = mkdtempSync(join(tmpdir(), "nax-git-frame-"));
    mkdirSync(join(repo, "packages", "pkg-a"), { recursive: true });
    writeFileSync(join(repo, "packages", "pkg-a", fileName), "one\n");
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;
    writeFileSync(join(repo, "packages", "pkg-a", fileName), "two\n");
    return { repo, root: join(repo, "packages", "pkg-a") };
  }

  test("diff headers are relative to the permitted root, not the repository root", async () => {
    const { root } = await makeRepoWithPackageWorkdir();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "diff" });

    const content = contentOf(result);
    expect(content).toContain("a/f.txt");
    expect(content).toContain("b/f.txt");
    expect(content).not.toContain("packages/pkg-a");
  });

  test("show <ref> diff headers are relative to the permitted root, not the repository root", async () => {
    const { root } = await makeRepoWithPackageWorkdir();
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD"] });

    const content = contentOf(result);
    expect(content).toContain("a/f.txt");
    expect(content).toContain("b/f.txt");
    expect(content).not.toContain("packages/pkg-a");
  });

  test("is a no-op when the permitted root is the repository root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "nax-git-frame-root-"));
    writeFileSync(join(repo, "f.txt"), "one\n");
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;
    writeFileSync(join(repo, "f.txt"), "two\n");
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo) });

    const result = await rt.callTool("Git", { subcommand: "diff" });

    const content = contentOf(result);
    expect(content).toContain("a/f.txt");
    expect(content).toContain("b/f.txt");
  });

  // Git quotes and octal-escapes any non-ASCII path (core.quotePath, on by
  // default), with the quote wrapping the "a/" prefix itself. A prefix-strip
  // that assumes an unquoted "a/<path>" shape never matches this line at all.
  test("diff headers with a non-ASCII path are still relative to the permitted root", async () => {
    const { root } = await makeRepoWithPackageWorkdir({ fileName: "café.txt" });
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "diff" });

    const content = contentOf(result);
    expect(content).not.toContain("packages/pkg-a");
  });

  // A path containing a space defeats a whitespace-delimited token match, and
  // git appends a trailing tab to the "---"/"+++" lines in that case too.
  test("diff headers with a space in the path are still relative to the permitted root", async () => {
    const { root } = await makeRepoWithPackageWorkdir({ fileName: "with space.txt" });
    const rt = createCodingToolRuntime({ policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], root) });

    const result = await rt.callTool("Git", { subcommand: "diff" });

    const content = contentOf(result);
    expect(content).toContain("a/with space.txt");
    expect(content).toContain("b/with space.txt");
    expect(content).not.toContain("packages/pkg-a");
  });
});
