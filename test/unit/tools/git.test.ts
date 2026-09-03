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
    expect(argvOf({ subcommand: "diff" })).toEqual(["diff", "--", "."]);
  });

  test("appends refs then paths after a '--' separator", () => {
    expect(argvOf({ subcommand: "diff", refs: ["HEAD~1", "HEAD"], paths: ["src/a.ts"] })).toEqual([
      "diff",
      "HEAD~1",
      "HEAD",
      "--",
      "src/a.ts",
    ]);
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
