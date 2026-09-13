import { beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { _gitToolDeps, gitTool } from "@/tools/git";
import { _gitDeps } from "@/utils/git";

function fake(result: InterceptResult): CommandInterceptor {
  return { provider: "rtk", intercept: async () => result };
}

/** A rewriter that actually passes validateRewrite: prefix, derived from the request. */
function prefixer(): CommandInterceptor {
  return {
    provider: "rtk",
    intercept: async (req) => ({ kind: "rewritten", argv: ["rtk", ...req.argv], provider: "rtk" }),
  };
}

describe("Git tool interception", () => {
  const calls: string[][] = [];

  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_gitToolDeps, ["interceptor"]);
  beforeEach(() => {
    calls.length = 0;
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return "out";
    }).spawn;
  });

  // ToolRunContext requires all four (src/tools/registry.ts:35-55). This shape is
  // lifted from test/unit/tools/git-commit.test.ts:23 — reuse it, do not invent one.
  const ctx = () => ({ root: "/repo", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 });

  test("spawns the original argv when no interceptor is installed", async () => {
    _gitToolDeps.interceptor = undefined;
    await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("git");
  });

  test("spawns the rewritten argv and reports what executed", async () => {
    // The fake MUST derive argv from the request. A hardcoded literal fails
    // validateRewrite's length check, silently degrades to "declined", and the
    // test then passes for the wrong reason.
    _gitToolDeps.interceptor = prefixer();
    const result = await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("rtk");
    expect(result.audit?.executed?.[0]).toBe("rtk");
  });

  test("spawns the original argv when the interceptor declines", async () => {
    _gitToolDeps.interceptor = fake({ kind: "declined", reason: "no binary" });
    const result = await gitTool.run({ subcommand: "log" }, ctx());
    expect(calls[0]?.[0]).toBe("git");
    expect(result.audit).toBeUndefined();
  });

  test("a rewritten command that runs and fails keeps its non-zero exit code", async () => {
    // R3's other half: nax never re-runs raw to disambiguate an exit code.
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push([...cmd]);
      return { stdout: "", stderr: "fatal: bad revision", exitCode: 128 };
    }).spawn;
    _gitToolDeps.interceptor = prefixer();

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBe(true);
    expect(calls[0]?.[0]).toBe("rtk"); // it really was the rewritten command that ran
    expect(calls).toHaveLength(1); // and it was NOT re-run raw
  });

  test("an internal gitWithTimeout caller is NEVER intercepted", async () => {
    // The guard on this task's whole reason for existing. Internal callers
    // machine-parse their stdout; compacting it breaks them silently.
    _gitToolDeps.interceptor = fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" });

    const { gitWithTimeout } = await import("@/utils/git");
    await gitWithTimeout(["diff", "--name-only"], "/repo");

    expect(calls.at(-1)?.[0]).toBe("git");
  });
});
