import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODING_TOOLS } from "@/config/permissions";
import { GIT_ESCAPE_FLAGS } from "@/tools/git";
import { buildCommitArgvs, gitCommitTool } from "@/tools/git-commit";
import { _resetRegistryForTest, getCodingTool } from "@/tools/registry";
import { _resetBuiltinsForTest, registerBuiltinCodingTools } from "@/tools/runtime";
import { _gitDeps } from "@/utils/git";

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "nax-git-commit-"));
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  const run = async (args: string[]) =>
    _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["init", "-q"]);
  await run(["config", "user.email", "test@nax.local"]);
  await run(["config", "user.name", "Nax Test"]);
  return repo;
}

const toolContext = (root: string) => ({ root, resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

describe("buildCommitArgvs", () => {
  test("stages the named paths and commits with the message", () => {
    const built = buildCommitArgvs({ message: "feat(US-1): thing", paths: ["src/a.ts"] });
    expect(built).toEqual({
      add: ["add", "--", "src/a.ts"],
      commit: ["commit", "-m", "feat(US-1): thing"],
    });
  });

  test("supports a multi-line body, which the implementer prompt requires", () => {
    const built = buildCommitArgvs({ message: "feat: x\n\nException (b): contract drift.", paths: ["a.ts"] });
    expect(built).toMatchObject({ commit: ["commit", "-m", "feat: x\n\nException (b): contract drift."] });
  });

  test("refuses a path that would parse as a flag", () => {
    expect(buildCommitArgvs({ message: "m", paths: ["--git-dir=/etc"] })).toEqual({
      error: 'path "--git-dir=/etc" may not begin with "-"',
    });
  });

  test("refuses an empty message rather than committing an empty subject", () => {
    expect(buildCommitArgvs({ message: "  ", paths: ["a.ts"] })).toEqual({
      error: "message must be a non-empty string",
    });
  });

  test("requires at least one path -- it never stages the whole tree implicitly", () => {
    expect(buildCommitArgvs({ message: "m", paths: [] })).toEqual({ error: "paths must name at least one file" });
  });

  test("emits no escape flag in either argv", () => {
    const built = buildCommitArgvs({ message: "-c core.pager=id", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(built.add).not.toContain(flag);
      expect(built.commit).not.toContain(flag);
    }
  });

  test("a message that looks like a flag is still a message, never an argv element of its own", () => {
    const built = buildCommitArgvs({ message: "--work-tree=/etc", paths: ["a.ts"] });
    if ("error" in built) throw new Error("expected success");
    expect(built.commit).toEqual(["commit", "-m", "--work-tree=/etc"]);
    expect(built.commit.indexOf("--work-tree=/etc")).toBe(2);
  });

  test("registers as a builtin", () => {
    _resetRegistryForTest();
    _resetBuiltinsForTest();
    registerBuiltinCodingTools();
    expect(getCodingTool("GitCommit")?.name).toBe("GitCommit");
  });

  test("is NOT in the default grant -- mutation is always explicit", () => {
    expect(DEFAULT_CODING_TOOLS).not.toContain("GitCommit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3: GitCommit must not stage nax-owned run artifacts (NAX_GITIGNORE_ENTRIES)
// ─────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 };
}

/** True when `relPath` is tracked in the repo's index. */
function isTracked(repo: string, relPath: string): boolean {
  return git(repo, "ls-files", "--error-unmatch", relPath).exitCode === 0;
}

describe("gitCommitTool — nax-owned artifact filtering (Fix 3)", () => {
  test("a normal source path is untouched — pass-through unchanged", async () => {
    const repo = await makeRepo();

    const result = await gitCommitTool.run({ message: "feat: plain commit", paths: ["a.ts"] }, toolContext(repo));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("commit");
    expect(result.content).not.toContain("Skipped");
    expect(isTracked(repo, "a.ts")).toBe(true);
  });

  test("filters a nax-owned path out of the add argv and never stages it", async () => {
    const repo = await makeRepo();
    const scratchDir = join(repo, ".nax", "scratchpad");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(scratchDir, "notes.md"), "scratch note\n");

    const result = await gitCommitTool.run(
      { message: "feat: commit with a nax artifact mixed in", paths: ["a.ts", ".nax/scratchpad/notes.md"] },
      toolContext(repo),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("commit");
    expect(isTracked(repo, "a.ts")).toBe(true);
    expect(isTracked(repo, ".nax/scratchpad/notes.md")).toBe(false);
  });

  test("the partial case reports which paths were skipped, plainly, in the result", async () => {
    const repo = await makeRepo();
    const scratchDir = join(repo, ".nax", "scratchpad");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(scratchDir, "notes.md"), "scratch note\n");

    const result = await gitCommitTool.run(
      { message: "feat: partial", paths: ["a.ts", ".nax/scratchpad/notes.md"] },
      toolContext(repo),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(".nax/scratchpad/notes.md");
    expect(result.content.toLowerCase()).toContain("skip");
  });

  test("the total case (every path nax-owned) runs no git command and stages nothing", async () => {
    const repo = await makeRepo();
    const scratchDir = join(repo, ".nax", "scratchpad");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(scratchDir, "notes.md"), "scratch note\n");

    const result = await gitCommitTool.run(
      { message: "feat: only nax artifacts", paths: [".nax/scratchpad/notes.md"] },
      toolContext(repo),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("nax-owned");
    // No commit happened at all.
    expect(git(repo, "log", "--oneline").stdout.trim()).toBe("");
    // The file was never staged — still untracked, not in the index.
    expect(isTracked(repo, ".nax/scratchpad/notes.md")).toBe(false);
    expect(git(repo, "status", "--porcelain").stdout).toContain("?? .nax/");
  });

  test("does not false-positive on a path that merely looks similar to a nax-owned one", async () => {
    // Guards the substring-matching bug src/worktree/manager.ts already warns
    // about: "packages/app/.nax/scratchpad-backup/x" must not be treated as
    // matched by the "**/.nax/scratchpad/" entry.
    const repo = await makeRepo();
    const lookalikeDir = join(repo, "packages", "app", ".nax", "scratchpad-backup");
    mkdirSync(lookalikeDir, { recursive: true });
    writeFileSync(join(lookalikeDir, "x"), "not actually nax-owned\n");

    const result = await gitCommitTool.run(
      { message: "feat: lookalike path", paths: ["packages/app/.nax/scratchpad-backup/x"] },
      toolContext(repo),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).not.toContain("Skipped");
    expect(isTracked(repo, "packages/app/.nax/scratchpad-backup/x")).toBe(true);
  });
});

describe("gitCommitTool", () => {
  test("stages the approved paths and returns the commit output", async () => {
    const result = await gitCommitTool.run(
      { message: "feat: commit through tool", paths: ["a.ts"] },
      toolContext(await makeRepo()),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("commit");
  });

  test("returns the git add failure without attempting a commit", async () => {
    const result = await gitCommitTool.run(
      { message: "feat: missing", paths: ["missing.ts"] },
      toolContext(await makeRepo()),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("git add failed:");
  });

  test("returns the git commit failure after a successful stage", async () => {
    const repo = await makeRepo();
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await gitCommitTool.run({ message: "feat: rejected by hook", paths: ["a.ts"] }, toolContext(repo));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("git commit failed:");
  });
});
