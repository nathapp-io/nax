/**
 * US-012 (branch-review-coverage): `runPrReview` credits the files a settled `verified` ruling already
 * covered at a commit they have not changed since. The credit narrows what the op is asked to read and
 * is named in the prompt; when the comparison itself fails, nothing is credited and the failure is
 * logged rather than silently excusing the files.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeScriptedCallOp, makeTempDir } from "@test/helpers";
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

function verifiedRuling(files: readonly string[], sha: string = SHA): BotSettledRuling {
  return {
    id: "w-1",
    kind: "cannot-verify",
    issue: "coverage gap",
    disposition: "verified",
    reason: "read",
    sha,
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
    expect(gitCalls).toEqual([{ args: ["diff", "--name-only", "-z", `${SHA}..HEAD`], cwd: ctx.projectDir }]);
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
    gitResult = { stdout: "src/a.ts\0", exitCode: 0 };
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

// ── B2: the changed-path comparison is exact ────────────────────────────────
//
// Under the default `core.quotePath` git quotes any path holding a non-ASCII byte, a quote or a
// control character: `src/é.ts` comes back as `"src/\303\251.ts"`. Compared as raw strings the
// quoted form never equals the path a ruling lists, so a file the ruling's commit DID change drops
// out of the changed set — the credit survives and the file is excused from review. That is the
// exclusion path failing open, which is why `git diff --name-only -z` (verbatim, NUL-terminated)
// is the contract, not a formatting preference.

/** `git <args>` in `cwd`, with stdout collected. Test-side: the comparison itself goes through `_workflowDeps`. */
async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

/** A fresh repository with one commit that adds `path`; returns that commit's sha. */
async function repoWithCommittedFile(root: string, path: string): Promise<string> {
  for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test User"]]) {
    await git(args, root);
  }
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), "first\n");
  await git(["add", "-A"], root);
  await git(["commit", "-m", "first"], root);
  return (await git(["rev-parse", "HEAD"], root)).trim();
}

describe("the changed-path comparison is exact (B2)", () => {
  test.each([
    ["a non-ASCII path", "src/é.ts"],
    ["a path holding a double quote", 'src/a"b.ts'],
    ["a path holding a newline", "src/a\nb.ts"],
  ])("AC-14 %s the ruling's commit changed stays required and earns no credit", async (_label, path) => {
    packagePaths = [path, "src/b.ts"];
    gitResult = { stdout: `${path}\0`, exitCode: 0 };
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling([path])] });
    expect(calls[0]?.input).toMatchObject({ requiredFiles: [path, "src/b.ts"] });
    expect(promptOf()).not.toContain(HEADING);
  });

  test("an unchanged path is still credited from a NUL-separated list", async () => {
    packagePaths = ["src/a.ts", "src/b.ts"];
    gitResult = { stdout: "src/b.ts\0", exitCode: 0 };
    await runPrReview(ctx, { ...baseInput, settled: [verifiedRuling(["src/a.ts"])] });
    expect(calls[0]?.input).toMatchObject({ requiredFiles: ["src/b.ts"] });
    expect(promptOf()).toContain("- src/a.ts");
  });

  test("real git: a modified non-ASCII path stays required under the default core.quotePath", async () => {
    // The end of the chain the stubs cannot reach: what `git diff --name-only -z` really prints for
    // a path git would otherwise quote. `_workflowDeps.git` is put back to the production command
    // for this case, so the comparison runs against a real repository.
    const root = makeTempDir("nax-credit-quotepath-");
    try {
      const path = "src/é.ts";
      const sha = await repoWithCommittedFile(root, path);
      writeFileSync(join(root, path), "changed after the ruling\n");
      await git(["add", "-A"], root);
      await git(["commit", "-m", "modify"], root);
      _workflowDeps.git = originalWorkflow.git;
      packagePaths = [path];
      await runPrReview({ ...ctx, projectDir: root }, { ...baseInput, settled: [verifiedRuling([path], sha)] });
      expect(calls[0]?.input).toMatchObject({ requiredFiles: [path] });
      expect(promptOf()).not.toContain(HEADING);
    } finally {
      cleanupTempDir(root);
    }
  });

  test("real git: an unchanged non-ASCII path is credited", async () => {
    const root = makeTempDir("nax-credit-quotepath-unchanged-");
    try {
      const path = "src/é.ts";
      const sha = await repoWithCommittedFile(root, path);
      writeFileSync(join(root, "other.ts"), "unrelated\n");
      await git(["add", "-A"], root);
      await git(["commit", "-m", "unrelated"], root);
      _workflowDeps.git = originalWorkflow.git;
      packagePaths = [path, "other.ts"];
      await runPrReview({ ...ctx, projectDir: root }, { ...baseInput, settled: [verifiedRuling([path], sha)] });
      expect(calls[0]?.input).toMatchObject({ requiredFiles: ["other.ts"] });
      expect(promptOf()).toContain(`- ${path}`);
    } finally {
      cleanupTempDir(root);
    }
  });
});
