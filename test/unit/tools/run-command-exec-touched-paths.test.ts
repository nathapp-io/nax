import { afterEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import type { ToolRunContext } from "@/tools/registry";
import { createRunCommandTool, type RunCommandExecOptions } from "@/tools/run-command";
import { _argvExecDeps } from "@/utils/argv-exec";

const ctx: ToolRunContext = { root: "/repo", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 };
const origSpawn = _argvExecDeps.spawn;

afterEach(() => {
  _argvExecDeps.spawn = origSpawn;
});

function toolWithTouchedPaths(touchedPaths: string[]) {
  const exec: RunCommandExecOptions = {
    repoRoot: "/repo",
    packageWorkdir: "/repo/packages/foo",
    allowScripts: false,
    touchedPaths,
  };
  return createRunCommandTool(new Map(), { exec });
}

describe("RunCommand argv branch — Exec-touched paths (Task 10)", () => {
  test("does not grant expected paths when a successful install changed no files", async () => {
    _argvExecDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdout: "added 1 package" })).spawn;
    const touchedPaths: string[] = [];
    const result = await toolWithTouchedPaths(touchedPaths).run(
      { argv: ["bun", "add", "left-pad"], target: "repoRoot" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(touchedPaths).toEqual([]);
  });

  test("records nothing when the Exec call fails", async () => {
    _argvExecDeps.spawn = makeSpawn(() => ({ exitCode: 1, stderr: "registry unreachable" })).spawn;
    const touchedPaths: string[] = [];
    const result = await toolWithTouchedPaths(touchedPaths).run(
      { argv: ["bun", "add", "left-pad"], target: "repoRoot" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(touchedPaths).toEqual([]);
  });

  test("records nothing for a generic (non-install-shaped) call, even on success", async () => {
    _argvExecDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdout: "ok" })).spawn;
    const touchedPaths: string[] = [];
    const result = await toolWithTouchedPaths(touchedPaths).run(
      { argv: ["bun", "x", "tsc", "--noEmit"], target: "repoRoot" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(touchedPaths).toEqual([]);
  });

  test("does not grant package paths when a successful package install changed no files", async () => {
    _argvExecDeps.spawn = makeSpawn(() => ({ exitCode: 0, stdout: "added 1 package" })).spawn;
    const touchedPaths: string[] = [];
    const result = await toolWithTouchedPaths(touchedPaths).run(
      { argv: ["bun", "add", "left-pad"], target: "package" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(touchedPaths).toEqual([]);
  });
});
