import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
