import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGitArgv,
  compileToolPolicy,
  createCodingToolRuntime,
  GIT_ESCAPE_FLAGS,
  GIT_READ_VERBS,
  gitTool,
} from "@/tools";
import { _gitDeps } from "@/utils/git";

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
    expect(argvOf({ subcommand: "diff" })).toEqual(["diff", "--relative", "--", "."]);
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
