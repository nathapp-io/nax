import { describe, expect, test } from "bun:test";
import { _workspaceTestDeps, runWorkspaceTests, workspaceTestCommands } from "#scripts/run-workspace-tests";

describe("workspaceTestCommands", () => {
  test("keeps the all-workspace test gate when no file paths are supplied", () => {
    expect(workspaceTestCommands([], "/repo")).toEqual([["bun", "run", "--filter", "*", "test"]]);
  });

  test("F2 routes absolute repo-tooling test paths only to repo-tooling", () => {
    const files = [
      "/repo/packages/repo-tooling/test/unit/scripts/check-coverage.test.ts",
      "/repo/packages/repo-tooling/test/unit/scripts/coverage-gate-mode.test.ts",
    ];
    expect(workspaceTestCommands(files, "/repo")).toEqual([
      ["bun", "run", "--filter", "./packages/repo-tooling", "test", ...files],
    ]);
  });

  test("groups relative and absolute files by workspace without forwarding sibling paths", () => {
    expect(
      workspaceTestCommands(
        [
          "packages/nax-ai/test/client.test.ts",
          "/repo/packages/repo-tooling/test/unit/scripts/check-coverage.test.ts",
          "packages/nax-ai/test/auth.test.ts",
        ],
        "/repo",
      ),
    ).toEqual([
      [
        "bun",
        "run",
        "--filter",
        "./packages/nax-ai",
        "test",
        "/repo/packages/nax-ai/test/client.test.ts",
        "/repo/packages/nax-ai/test/auth.test.ts",
      ],
      [
        "bun",
        "run",
        "--filter",
        "./packages/repo-tooling",
        "test",
        "/repo/packages/repo-tooling/test/unit/scripts/check-coverage.test.ts",
      ],
    ]);
  });

  test.each([
    ["--timeout=60000"],
    ["client"],
    ["/other/packages/repo-tooling/test/a.test.ts"],
    ["packages/nax-ai/src/client.ts"],
  ])("preserves legacy dispatch for non-file arguments %j", (arg) => {
    expect(workspaceTestCommands([arg], "/repo")).toEqual([["bun", "run", "--filter", "*", "test", arg]]);
  });
});

describe("runWorkspaceTests", () => {
  test.each([0, 1, 2])("preserves a workspace exit code of %s", (exitCode) => {
    const previous = _workspaceTestDeps.run;
    const calls: string[][] = [];
    _workspaceTestDeps.run = (command, cwd) => {
      expect(cwd).toBe("/repo");
      calls.push(command);
      return exitCode;
    };
    try {
      expect(
        runWorkspaceTests(["packages/repo-tooling/test/a.test.ts", "packages/nax-ai/test/b.test.ts"], "/repo"),
      ).toBe(exitCode);
      expect(calls).toHaveLength(exitCode === 0 ? 2 : 1);
      expect(calls[0]).toEqual([
        "bun",
        "run",
        "--filter",
        "./packages/repo-tooling",
        "test",
        "/repo/packages/repo-tooling/test/a.test.ts",
      ]);
    } finally {
      _workspaceTestDeps.run = previous;
    }
  });
});
