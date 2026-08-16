/**
 * Auto-PR Plugin — BUG-8 fixes
 *
 *   1. defaultRun honors timeoutMs (kills the subprocess on expiry) — same
 *      pattern as nax-finish/index.ts:74-96. Without it, `git push -u origin
 *      <branch>` against a slow remote stalls the run forever.
 *
 *   2. execute() re-checks hasOpenPr after pushing but before openDraft() so
 *      a concurrent run that opened a PR between shouldRun() and the push
 *      does NOT result in a duplicate PR. hasOpenPr also no longer fails
 *      open on non-zero exit (treated as "unknown → skip with warning").
 *
 * AC1: defaultRun kills the subprocess after timeoutMs and returns 124.
 * AC2: execute() re-checks hasOpenPr; if the second check finds a PR, the
 *      plugin returns success=false without calling openDraft().
 * AC3: execute() never invokes openDraft() when the recheck returns true.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autoPrDeps, autoPrPlugin, defaultRun } from "@/plugins/builtin/auto-pr";
import type { PostRunContext } from "@/plugins/types";

function makeContext(overrides: Partial<PostRunContext> = {}): PostRunContext {
  return {
    feature: "auto-pr-bug-8",
    workdir: "/tmp/workdir",
    branch: "nax/auto-pr-bug-8",
    runId: "run-bug-8",
    totalDurationMs: 1000,
    outputDir: "/tmp/output",
    prdPath: ".nax/features/auto-pr-bug-8/prd.json",
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    config: { autoPr: { enabled: true, draft: true } },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  } as PostRunContext;
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
  };
  // Default: pretend this is a github repo so the early-exit guards in execute()
  // don't fire before the hasOpenPr recheck we're testing.
  _autoPrDeps.getRemoteUrl = async () => "https://github.com/owner/repo.git";
  _autoPrDeps.detectForge = (() => "github") as typeof _autoPrDeps.detectForge;
});

afterEach(() => {
  _autoPrDeps.run = saved.run;
  _autoPrDeps.readText = saved.readText;
  _autoPrDeps.getRemoteUrl = saved.getRemoteUrl;
  _autoPrDeps.detectForge = saved.detectForge;
  _autoPrDeps.hasOpenPr = saved.hasOpenPr;
  _autoPrDeps.openDraft = saved.openDraft;
  _autoPrDeps.findPrTemplate = saved.findPrTemplate;
});

describe("BUG-8 — defaultRun timeout", () => {
  test("AC1: defaultRun bounds a hanging subprocess via wall-clock cap", async () => {
    // Invoke the production defaultRun directly (not via _autoPrDeps.run, since
    // some tests replace it). Use a 100ms cap and `sleep 5` so the call
    // completes in well under a second.
    const start = Date.now();
    const result = await defaultRun(["sleep", "5"], { cwd: "/tmp", timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    // 124 = conventional timeout exit code; 137/143 = SIGKILL/SIGTERM. Accept any.
    expect([124, 137, 143].includes(result.exitCode)).toBe(true);
  });
});

describe("BUG-8 — execute() re-checks hasOpenPr after push", () => {
  test("AC2: returns success=false when recheck finds an open PR (no duplicate)", async () => {
    const openDraftMock = mock(async () => ({
      success: true,
      message: "should not be called",
    }));
    // First hasOpenPr call (from shouldRun) returns false; second call (from
    // execute recheck) returns true — simulating a concurrent run that opened
    // a PR between the two checks.
    let hasOpenPrCalls = 0;
    _autoPrDeps.run = (async (cmd: string[]) => {
      // git push succeeds
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _autoPrDeps.run;
    _autoPrDeps.hasOpenPr = (async () => {
      hasOpenPrCalls += 1;
      return hasOpenPrCalls > 1;
    }) as typeof _autoPrDeps.hasOpenPr;
    _autoPrDeps.openDraft = openDraftMock as typeof _autoPrDeps.openDraft;
    _autoPrDeps.findPrTemplate = (async () => null) as typeof _autoPrDeps.findPrTemplate;

    // Drive shouldRun once to consume its call.
    await autoPrPlugin.extensions.postRunAction?.shouldRun(makeContext());
    const beforeExecute = hasOpenPrCalls;

    const ctx = makeContext();
    const result = await autoPrPlugin.extensions.postRunAction?.execute(ctx);

    // After shouldRun() consumed one call, execute() added exactly one more
    // (the recheck after the push).
    expect(hasOpenPrCalls - beforeExecute).toBe(1);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/open PR.*already exists|skip/i);
    expect(openDraftMock).not.toHaveBeenCalled();
  });

  test("AC3: recheck returns false → openDraft proceeds normally", async () => {
    _autoPrDeps.run = (async (cmd: string[]) => {
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _autoPrDeps.run;
    _autoPrDeps.hasOpenPr = (async () => false) as typeof _autoPrDeps.hasOpenPr;
    const openDraftMock = mock(async () => ({ success: true, message: "opened" }));
    _autoPrDeps.openDraft = openDraftMock as typeof _autoPrDeps.openDraft;
    _autoPrDeps.findPrTemplate = (async () => null) as typeof _autoPrDeps.findPrTemplate;

    const ctx = makeContext();
    const result = await autoPrPlugin.extensions.postRunAction?.execute(ctx);

    expect(openDraftMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
