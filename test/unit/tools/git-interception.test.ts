import { beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
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
    // US-008: a ledger row for a rewritten command carries both forms even on
    // the failure path — replay fidelity is exactly where it matters.
    expect(result.audit?.executed?.[0]).toBe("rtk");
    expect(result.audit?.executed).toContain("git");
  });

  test("a rewritten command that fails with output still ledges what executed", async () => {
    // Non-zero exit with non-empty stdout does not hit the isError branch, but
    // the rewritten argv must still reach the ledger.
    _gitDeps.spawn = makeSpawn(() => ({ stdout: "some log output", stderr: "warning", exitCode: 128 })).spawn;
    _gitToolDeps.interceptor = prefixer();

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.content).toContain("some log output");
    expect(result.audit?.executed?.[0]).toBe("rtk");
  });

  test("an internal gitWithTimeout caller is NEVER intercepted", async () => {
    // The guard on this task's whole reason for existing. Internal callers
    // machine-parse their stdout; compacting it breaks them silently.
    _gitToolDeps.interceptor = fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" });

    const { gitWithTimeout } = await import("@/utils/git");
    await gitWithTimeout(["diff", "--name-only"], "/repo");

    expect(calls.at(-1)?.[0]).toBe("git");
  });

  test("a throwing postProcess degrades to the raw output", async () => {
    _gitDeps.spawn = makeSpawn(() => "body\n[full diff: rtk git diff --no-compact]").spawn;
    _gitToolDeps.interceptor = {
      provider: "rtk",
      intercept: async (r) => ({ kind: "rewritten", argv: ["rtk", ...r.argv], provider: "rtk" }),
      postProcess: () => {
        throw new Error("post-process blew up");
      },
    };

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("body");
  });

  test("postProcess is never consulted for a command that was not rewritten", async () => {
    let called = false;
    _gitDeps.spawn = makeSpawn(() => "body").spawn;
    _gitToolDeps.interceptor = {
      provider: "rtk",
      intercept: async () => ({ kind: "unchanged" }),
      postProcess: () => {
        called = true;
        return { output: "" };
      },
    };

    await gitTool.run({ subcommand: "log" }, ctx());

    expect(called).toBe(false);
  });

  test("a hint is stripped from output that also needs trimming", async () => {
    // The call site runs postProcess BEFORE trimEnd, so it must strip a hint
    // even when the hint is not the final characters — the trailing whitespace
    // after it is exactly what trimEnd would otherwise remove.
    _gitDeps.spawn = makeSpawn(() => "body\n[full diff: rtk git diff --no-compact]\n   ").spawn;
    _gitToolDeps.interceptor = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} },
    });

    const result = await gitTool.run({ subcommand: "log" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("body");
  });
});
