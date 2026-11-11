/**
 * US-012 (branch-review-coverage): `runPrReview` credits the files a settled `verified` ruling already
 * covered at a commit they have not changed since. The credit narrows what the op is asked to read and
 * is named in the prompt; when the comparison itself fails, nothing is credited and the failure is
 * logged rather than silently excusing the files.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeScriptedCallOp } from "@test/helpers";
import { _reviewStepDeps, runPrReview } from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import type { PrInfo } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { botPrReviewOp, type PrReviewVerdict } from "@/operations";
import type { BotSettledRuling } from "@/prompts";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { parseItemFiles, renderItemOpener } from "@/workflow/item-threads";
import { _workflowDeps } from "@/workflow/step-context";

const originalWorkflow = { ..._workflowDeps };
const originalReview = { ..._reviewStepDeps };

/** The commit the ruling was made at; the review compares against it, never against HEAD. */
const SHA = "abc1234";
const HEADING = "## Files covered by settled rulings";

const info: PrInfo = {
  number: 42,
  title: "Change",
  body: "Adds X",
  author: { login: "alice", id: 123 },
  url: "https://example.test/pull/42",
  state: "open",
  draft: false,
  baseRef: "main",
  headRef: "feature",
  headSha: "head",
  crossRepo: false,
};

function verifiedRuling(files: readonly string[]): BotSettledRuling {
  return {
    id: "w-1",
    kind: "cannot-verify",
    issue: "coverage gap",
    disposition: "verified",
    reason: "read",
    sha: SHA,
    files,
  };
}

let ctx: PrStepContext;
let calls: { op: unknown; input: unknown }[];
let gitCalls: { args: string[]; cwd: string }[];
let gitResult: { stdout: string; stderr?: string; exitCode: number };
/** The paths the (stubbed) package writer reports as changed in the PR. */
let packagePaths: string[];
let verdict: PrReviewVerdict;

const baseInput = {
  mergeBase: "merge-base",
  info,
  issues: [],
  threads: [],
  comments: [],
  staticMode: false,
};

function promptOf(): string {
  const value = calls[0]?.input;
  if (typeof value !== "object" || value === null || !("prompt" in value) || typeof value.prompt !== "string")
    throw new Error("missing prompt");
  return value.prompt;
}

beforeEach(() => {
  const config = structuredClone(makeNaxConfig({ workflow: { timeouts: { reviewMs: 12_345 } } }));
  ctx = {
    config,
    workflow: resolveWorkflowConfig(config),
    callCtx: makeMockCallContext(),
    projectDir: "/review/worktree",
    runDir: "/review/artifacts",
    reportPath: "/review/artifacts/report.md",
    feature: "bot-pr-42",
    packageDirs: [],
    dryRun: false,
    pr: { forge: "github", number: 42, base: "base", head: "head" },
  };
  calls = [];
  gitCalls = [];
  gitResult = { stdout: "", exitCode: 0 };
  packagePaths = ["src/a.ts", "src/b.ts"];
  verdict = {
    intent: "pass",
    quality: "approved",
    findings: [],
    threads: [],
    comments: [],
    cannotVerify: [],
    inspectedFiles: ["src/b.ts"],
  };
  _reviewStepDeps.writeBranchReviewPackage = async () => packagePaths;
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.loadProjectContextOverride = async () => undefined;
  _workflowDeps.git = async (args: string[], cwd: string) => {
    gitCalls.push({ args, cwd });
    return gitResult;
  };
  _workflowDeps.callOp = makeScriptedCallOp((op, value) => {
    calls.push({ op, input: value });
    return verdict;
  });
});
afterEach(() => {
  Object.assign(_workflowDeps, originalWorkflow);
  Object.assign(_reviewStepDeps, originalReview);
  resetLogger();
});

describe("runPrReview credits settled verified rulings (US-012)", () => {
  test("AC-11 the op is asked only for the files the ruling did not cover", async () => {
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe(botPrReviewOp);
    expect(calls[0]?.input).toMatchObject({ requiredFiles: ["src/b.ts"] });
    expect(gitCalls).toEqual([{ args: ["diff", "--name-only", `${SHA}..HEAD`], cwd: ctx.projectDir }]);
  });

  test("AC-12 the prompt names the credited file", async () => {
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(promptOf()).toContain(HEADING);
    expect(promptOf()).toContain("- src/a.ts");
  });

  test("AC-13 a verdict that read the remaining file leaves no unreadFiles", async () => {
    const outcome = await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(outcome).toEqual({ ran: true, verdict });
    expect(outcome).not.toHaveProperty("unreadFiles");
  });

  test("AC-14 a file the ruling's commit changed is still required", async () => {
    gitResult = { stdout: "src/a.ts\n", exitCode: 0 };
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(calls[0]?.input).toMatchObject({ requiredFiles: ["src/a.ts", "src/b.ts"] });
    expect(promptOf()).not.toContain(HEADING);
  });

  test("AC-15/21 a failed comparison credits nothing and is logged with the sha", async () => {
    gitResult = { stdout: "", stderr: "bad revision", exitCode: 128 };
    const warn = spyOn(initLogger({ level: "silent" }), "warn");
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(calls[0]?.input).toMatchObject({ requiredFiles: ["src/a.ts", "src/b.ts"] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("bot", expect.any(String), { storyId: "_run", sha: SHA });
    expect(promptOf()).not.toContain(HEADING);
  });

  test("AC-16 with no settled rulings nothing is credited", async () => {
    await runPrReview(ctx, baseInput);
    expect(calls[0]?.input).toMatchObject({ requiredFiles: ["src/a.ts", "src/b.ts"] });
    expect(promptOf()).not.toContain(HEADING);
  });

  test("AC-20 a path that does not survive the opener round trip earns no credit", async () => {
    const lost = "src/a`b.ts";
    const opener = renderItemOpener({ id: "w-1", kind: "cannot-verify", issue: "coverage gap", files: [lost] });
    const listed = parseItemFiles(opener);
    // The premise: the opener does list a path, but not the one the review requires.
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toEqual([lost]);
    packagePaths = [lost, "src/b.ts"];
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(listed)] });
    expect(calls[0]?.input).toMatchObject({ requiredFiles: [lost, "src/b.ts"] });
    expect(promptOf()).not.toContain(HEADING);
  });

  test("the credited set never leaves the op with an empty requiredFiles", async () => {
    packagePaths = ["src/a.ts"];
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(calls[0]?.input).not.toHaveProperty("requiredFiles");
  });
});
