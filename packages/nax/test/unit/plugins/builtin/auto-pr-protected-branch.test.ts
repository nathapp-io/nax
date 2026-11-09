/**
 * Auto-PR Plugin — protected-branch guard (US-007)
 *
 * The auto-PR plugin pushes `context.branch` to origin and opens a draft PR for
 * it, whatever branch the run happened to be on. On a protected branch that is
 * a direct route into the default branch, so both entry points refuse:
 * `shouldRun` (before any remote or forge lookup) and `execute` (before any
 * `git push`).
 *
 * The publishable-branch predicate is shared with the workflow publisher and
 * lives in `@/utils/git`, so the plugin can use it without importing
 * `src/workflow/`; the remote's default branch is read through the
 * `_autoPrDeps.readDefaultBranch` seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { _autoPrDeps, autoPrPlugin } from "@/plugins/builtin/auto-pr";
import type { PluginLogger, PostRunContext } from "@/plugins/types";
import { isPublishableBranch } from "@/utils/git";

/** The argv the default default-branch lookup runs. */
const DEFAULT_BRANCH_ARGV = ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"];

/** The seam's default implementation, captured before any test replaces it. */
const defaultReadDefaultBranch = _autoPrDeps.readDefaultBranch;

interface WarnCall {
  message: string;
  data?: Record<string, unknown>;
}

/** A plugin logger that records the warns the plugin emits. */
function makeLogger(warns: WarnCall[]): PluginLogger {
  return {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (message, data) => {
      warns.push(data === undefined ? { message } : { message, data });
    },
  };
}

function makeContext(overrides: Partial<PostRunContext> = {}): PostRunContext {
  return {
    runId: "run-1",
    feature: "auto-pr-protected-branch",
    workdir: "/tmp/workdir",
    prdPath: "/tmp/workdir/prd.json",
    branch: "feat/x",
    totalDurationMs: 60_000,
    totalCost: 0.42,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: makeLogger([]),
    config: { autoPr: { enabled: true, draft: true } },
    ...overrides,
  };
}

function postAction() {
  const action = autoPrPlugin.extensions.postRunAction;
  assertDefined(action, "extensions.postRunAction");
  return action;
}

/** Whether a recorded argv is a `git push`. */
function isGitPush(cmd: readonly string[]): boolean {
  return cmd[0] === "git" && cmd[1] === "push";
}

let saved: typeof _autoPrDeps;

beforeEach(() => {
  saved = {
    run: _autoPrDeps.run,
    readText: _autoPrDeps.readText,
    getRemoteUrl: _autoPrDeps.getRemoteUrl,
    detectForge: _autoPrDeps.detectForge,
    hasOpenPr: _autoPrDeps.hasOpenPr,
    openDraft: _autoPrDeps.openDraft,
    findPrTemplate: _autoPrDeps.findPrTemplate,
    readDefaultBranch: _autoPrDeps.readDefaultBranch,
  };
  _autoPrDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _autoPrDeps.readText = async () => null;
  _autoPrDeps.getRemoteUrl = async () => "https://github.com/owner/repo.git";
  _autoPrDeps.detectForge = () => "github";
  _autoPrDeps.hasOpenPr = async () => false;
  _autoPrDeps.openDraft = async () => ({ success: true, message: "ok" });
  _autoPrDeps.findPrTemplate = async () => null;
});

afterEach(() => {
  _autoPrDeps.run = saved.run;
  _autoPrDeps.readText = saved.readText;
  _autoPrDeps.getRemoteUrl = saved.getRemoteUrl;
  _autoPrDeps.detectForge = saved.detectForge;
  _autoPrDeps.hasOpenPr = saved.hasOpenPr;
  _autoPrDeps.openDraft = saved.openDraft;
  _autoPrDeps.findPrTemplate = saved.findPrTemplate;
  _autoPrDeps.readDefaultBranch = saved.readDefaultBranch;
});

describe("isPublishableBranch (src/utils/git.ts)", () => {
  test.each(["", "main", "master"])("AC-15: %p is never publishable", (branch) => {
    expect(isPublishableBranch(branch)).toBe(false);
  });

  test("AC-16: the remote's default branch is never publishable", () => {
    expect(isPublishableBranch("release", "release")).toBe(false);
  });

  test("AC-17: a feature branch is publishable when it is not the default branch", () => {
    expect(isPublishableBranch("feat/x", "main")).toBe(true);
  });
});

describe("autoPrPlugin.shouldRun — protected branch", () => {
  test("AC-1: returns false on the main branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const ctx = makeContext({ branch: "main" });
    expect(await postAction().shouldRun(ctx)).toBe(false);
  });

  test("AC-2: neither the remote nor the PR lookup runs on the main branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    let remoteLookups = 0;
    let prLookups = 0;
    _autoPrDeps.getRemoteUrl = async () => {
      remoteLookups += 1;
      return "https://github.com/owner/repo.git";
    };
    _autoPrDeps.hasOpenPr = async () => {
      prLookups += 1;
      return false;
    };

    const ctx = makeContext({ branch: "main" });
    expect(await postAction().shouldRun(ctx)).toBe(false);
    expect(remoteLookups).toBe(0);
    expect(prLookups).toBe(0);
  });

  test("AC-3: logs exactly one warn naming the branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const warns: WarnCall[] = [];
    const ctx = makeContext({ branch: "main", logger: makeLogger(warns) });

    expect(await postAction().shouldRun(ctx)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.branch).toBe("main");
  });

  test.each(["master", ""])("AC-4: returns false on %p", async (branch) => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const ctx = makeContext({ branch });
    expect(await postAction().shouldRun(ctx)).toBe(false);
  });

  test("AC-5: returns false on the remote's default branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => "develop";
    const ctx = makeContext({ branch: "develop" });
    expect(await postAction().shouldRun(ctx)).toBe(false);
  });

  test("AC-6: returns true on a feature branch when the default branch is main", async () => {
    _autoPrDeps.readDefaultBranch = async () => "main";
    const ctx = makeContext({ branch: "feat/x" });
    expect(await postAction().shouldRun(ctx)).toBe(true);
  });

  test("AC-14: an unknown default branch does not stop the branch check", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const lookedUp: string[] = [];
    _autoPrDeps.getRemoteUrl = async (workdir: string) => {
      lookedUp.push(workdir);
      return "https://github.com/owner/repo.git";
    };

    const ctx = makeContext({ branch: "feat/x" });
    expect(await postAction().shouldRun(ctx)).toBe(true);
    expect(lookedUp).toEqual([ctx.workdir]);
  });

  test.each(["", "main", "master"])(
    "AC-18: %p stays protected when the default-branch lookup fails",
    async (branch) => {
      _autoPrDeps.readDefaultBranch = async () => undefined;
      const ctx = makeContext({ branch });
      expect(await postAction().shouldRun(ctx)).toBe(false);
    },
  );
});

describe("autoPrPlugin.execute — protected branch", () => {
  test("AC-7: refuses the main branch with a message naming it", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const ctx = makeContext({ branch: "main" });
    const result = await postAction().execute(ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain("main");
  });

  test("AC-8: never pushes a protected branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => undefined;
    const commands: string[][] = [];
    _autoPrDeps.run = async (cmd: string[]) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const ctx = makeContext({ branch: "main" });
    await postAction().execute(ctx);
    expect(commands.filter(isGitPush)).toEqual([]);
  });

  test("AC-9: refuses the remote's default branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => "develop";
    const ctx = makeContext({ branch: "develop" });
    const result = await postAction().execute(ctx);
    expect(result.success).toBe(false);
  });

  test("AC-10: never pushes the remote's default branch", async () => {
    _autoPrDeps.readDefaultBranch = async () => "develop";
    const commands: string[][] = [];
    _autoPrDeps.run = async (cmd: string[]) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const ctx = makeContext({ branch: "develop" });
    await postAction().execute(ctx);
    expect(commands.filter(isGitPush)).toEqual([]);
  });
});

describe("autoPrDeps.readDefaultBranch — the default implementation", () => {
  beforeEach(() => {
    // The default implementation, so the seam's own lookup is what answers.
    _autoPrDeps.readDefaultBranch = defaultReadDefaultBranch;
  });

  test("AC-11: reads origin/HEAD and strips the origin/ prefix", async () => {
    const calls: { cmd: string[]; cwd: string }[] = [];
    _autoPrDeps.run = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return { exitCode: 0, stdout: "origin/trunk\n", stderr: "" };
    };
    expect(await _autoPrDeps.readDefaultBranch("/repo")).toBe("trunk");
    expect(calls).toEqual([{ cmd: DEFAULT_BRANCH_ARGV, cwd: "/repo" }]);
  });

  test("AC-12: a non-zero exit means the default branch is unknown", async () => {
    _autoPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "fatal: no such ref" });
    expect(await _autoPrDeps.readDefaultBranch("/repo")).toBeUndefined();
  });

  test("AC-13: a failed lookup means the default branch is unknown", async () => {
    _autoPrDeps.run = async () => {
      throw new Error("git unavailable");
    };
    expect(await _autoPrDeps.readDefaultBranch("/repo")).toBeUndefined();
  });
});
