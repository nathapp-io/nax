import { beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import type { CommandInterceptor, InterceptResult } from "@/execution/command-interceptor";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import { buildGitArgv, DEFAULT_LOG_MAX_COUNT, GIT_ESCAPE_FLAGS } from "@/tools";
import { _gitToolDeps, gitTool } from "@/tools/git";
import { compileToolPolicy } from "@/tools/policy";
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

function argvOf(input: Record<string, unknown>): string[] {
  const built = buildGitArgv(input);
  if ("error" in built) throw new Error(`expected argv, got error: ${built.error}`);
  return built;
}

const GIT_SCOPE = { pathFields: [], arrayPathFields: ["paths"] };

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

/**
 * `git log` was the one read verb with no bound on how much it returns: the
 * pathspec selects which commits to show, and every selected commit then prints
 * in full. In nax#2009 a single `log --name-only` on ONE test file returned
 * 79KB from 7 commits, because `--name-only` lists every file in each matching
 * commit rather than the path that selected it. It was the largest call in a
 * 267-call session.
 *
 * The bound is a commit count, not a byte cap -- `truncate()` already clips
 * bytes, but only after git has produced them and after the model has been
 * handed a result whose shape it cannot predict.
 */
describe("buildGitArgv — log output bounds", () => {
  test("emits --max-count=<n> for log", () => {
    expect(argvOf({ subcommand: "log", maxCount: 5 })).toContain("--max-count=5");
  });

  // An unscoped `log` walks the entire history of HEAD -- that is the shape
  // with no bound at all, and the one the default exists for.
  test("bounds a log that names no range", () => {
    expect(argvOf({ subcommand: "log" })).toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
  });

  /**
   * A `refs` range is already a scope the caller chose, so a default on top of
   * it silently discards commits they asked for -- and unlike `truncate()`,
   * which appends "... [truncated at N bytes]", a commit cap appends nothing.
   * The model cannot tell 12 commits from 200-capped-to-20.
   *
   * This is not hypothetical: the reviewer prompt asks for a story's commit
   * history as `log <ref>..HEAD --oneline` (protocol-region.ts), and
   * `--max-count` keeps the NEWEST n -- so a long fix-cycle run would have lost
   * exactly the initial implementation commits, unmarked. Caught in review.
   */
  test("does not bound a log the caller has already scoped with refs", () => {
    const argv = argvOf({ subcommand: "log", refs: ["abc123..HEAD"] });
    expect(argv.some((arg) => arg.startsWith("--max-count="))).toBe(false);
  });

  test("the reviewer prompt's story-history call keeps its full range", () => {
    // The exact shape built by src/prompts/sections/protocol-region.ts.
    const argv = argvOf({ subcommand: "log", refs: ["abc123..HEAD"], oneline: true });
    expect(argv.some((arg) => arg.startsWith("--max-count="))).toBe(false);
    expect(argv).toContain("--oneline");
  });

  test("an explicit maxCount still applies when refs are given", () => {
    expect(argvOf({ subcommand: "log", refs: ["abc123..HEAD"], maxCount: 5 })).toContain("--max-count=5");
  });

  test("an explicit maxCount overrides the default", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 3 });
    expect(argv).toContain("--max-count=3");
    expect(argv).not.toContain(`--max-count=${DEFAULT_LOG_MAX_COUNT}`);
  });

  // `show`, `diff`, `blame` and `status` each name what they operate on, so
  // none of them is unbounded in the way `log` is. Defaulting them would invent
  // a truncation the caller never asked for.
  test("bounds log only — no other verb gains a default", () => {
    for (const subcommand of ["diff", "show", "status", "blame"]) {
      expect(argvOf({ subcommand }).some((arg) => arg.startsWith("--max-count="))).toBe(false);
    }
  });

  test("rejects maxCount on a verb it does not apply to", () => {
    const built = buildGitArgv({ subcommand: "diff", maxCount: 5 });
    expect(built).toEqual({ error: '"maxCount" is not valid for "diff" (valid for: log)' });
  });

  // A non-integer reaches git as `--max-count=1.5` / `--max-count=NaN`, which
  // git rejects with its own error the model then has to interpret. Refusing
  // here is the clearer of the two, and matches how diffFilter is gated.
  // The exact message is asserted, not merely that SOMETHING was refused: a
  // bare `"error" in built` cannot tell "refused for the right reason" from
  // "refused by an unrelated guard", and would keep passing if the maxCount
  // check were deleted.
  test("rejects a maxCount that is not a positive integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, true, {}, []]) {
      expect(buildGitArgv({ subcommand: "log", maxCount: value })).toEqual({
        error: '"maxCount" must be a positive integer',
      });
    }
  });

  /**
   * `Number.isInteger(1e21)` is true and template interpolation renders it as
   * `1e+21`, so both of these reached git as `--max-count=1e+21` /
   * `--max-count=2147483648` and came back as `fatal: not an integer` -- the
   * exact "a git usage error the model has to interpret" class this field
   * exists to prevent. git's ceiling is INT_MAX. Caught in review.
   */
  test("rejects a maxCount above git's integer ceiling", () => {
    for (const value of [2_147_483_648, 1e21, Number.MAX_SAFE_INTEGER]) {
      expect(buildGitArgv({ subcommand: "log", maxCount: value })).toEqual({
        error: '"maxCount" must be a positive integer',
      });
    }
    expect(argvOf({ subcommand: "log", maxCount: 2_147_483_647 })).toContain("--max-count=2147483647");
  });

  test("does not fall back to the default when maxCount is invalid", () => {
    const built = buildGitArgv({ subcommand: "log", maxCount: 0 });
    expect("error" in built).toBe(true);
  });

  test("declares maxCount in the input schema so a model can reach it", () => {
    expect(gitTool.inputSchema).toMatchObject({
      properties: { maxCount: { type: "integer" } },
    });
  });

  test("a bounded log argv contains no repo-escape flag", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 5, nameOnly: true, refs: ["HEAD"], paths: ["src"] });
    for (const flag of GIT_ESCAPE_FLAGS) {
      expect(argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
  });

  // Flags precede the refs for the same reason the existing flags do: a flag
  // after a revision list reads as a pathspec in the tool-audit ledger.
  test("places --max-count before the refs", () => {
    const argv = argvOf({ subcommand: "log", maxCount: 2, refs: ["HEAD"], paths: ["src/a.ts"] });
    // Asserted present first: indexOf returns -1 when absent, which would make
    // a bare "is before" comparison pass vacuously.
    expect(argv).toContain("--max-count=2");
    expect(argv.indexOf("--max-count=2")).toBeLessThan(argv.indexOf("HEAD"));
  });
});

describe("GitCommit containment after the root move (PR2/Task 13)", () => {
  test("a path outside the containment root cannot be staged", () => {
    // Pre-move the root was the package dir and a repo-root lockfile sat
    // outside it, where the execTouchedPaths carve-out admitted it. Post-move
    // the containment root IS the repo root, so this package-root shape is
    // simply out of root and the carve-out is retired.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const verdict = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: add bun-types",
      paths: ["/repo/bun.lockb"],
    });
    expect(verdict.allowed).toBe(false);
  });

  test("a repo-root manifest is admitted by ordinary containment, with no Exec-touched allowance", () => {
    // The root move (PR2/Task 13) retired the execTouchedPaths carve-out: a
    // GitCommit staging the repo-root manifest is admitted by isInside alone.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo");
    const allowed = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: refresh root manifest",
      paths: ["/repo/package.json"],
    });
    expect(allowed.allowed).toBe(true);

    // Ordinary containment still refuses a genuinely out-of-root path.
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: sneak",
      paths: ["/elsewhere/src/index.ts"],
    });
    expect(denied.allowed).toBe(false);
  });
});

describe("GitCommit denial messages", () => {
  test("a manifest-shaped path outside the root gets the plain denial (PR2/Task 13)", () => {
    // The GitCommit-specific manifest message existed only to explain the
    // execTouchedPaths carve-out; with that retired, a manifest-shaped path is
    // just another out-of-root path and gets the plain message.
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: add bun-types",
      paths: ["/repo/package.json"],
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      '"paths" entry "/repo/package.json" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });

  test("an ordinary out-of-root source path gets the plain denial", () => {
    const policy = compileToolPolicy([{ tool: "GitCommit", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("GitCommit", GIT_SCOPE, {
      message: "chore: sneak",
      paths: ["/repo/packages/bar/src/index.ts"],
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      '"paths" entry "/repo/packages/bar/src/index.ts" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });

  test("a manifest-shaped path gets the plain denial for a non-GitCommit tool too", () => {
    const policy = compileToolPolicy([{ tool: "Write", patterns: ["*"] }], "/repo/packages/foo");
    const denied = policy.check("Write", { pathFields: ["path"] }, { path: "/repo/package.json" });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe(
      'path "/repo/package.json" resolves outside the permitted root (/repo/packages/foo), which is the only directory this tool can reach',
    );
  });
});
