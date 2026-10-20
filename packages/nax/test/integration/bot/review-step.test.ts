import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, makeNaxConfig, makeScriptedCallOp } from "@test/helpers";
import { _reviewStepDeps, runPrReview } from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import type { PrInfo } from "@/forge";
import { botPrReviewOp, botPrStaticReviewOp, type PrReviewVerdict } from "@/operations";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { _workflowDeps } from "@/workflow/step-context";

const originalWorkflow = { ..._workflowDeps };
const originalReview = { ..._reviewStepDeps };
const paths = ["src/b.ts", "src/a.ts"];
const writer = mock(async (_root: string, _base: string, _path: string) => paths);
const appendRules = mock(async () => {});
const loadOverride = mock(async () => undefined);
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
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
const input = {
  mergeBase: "merge-base",
  info,
  issues: [],
  staticMode: false,
  threads: ["T2", "T1"].map((id) => ({ id, replyTo: id, resolved: false, outdated: false, comments: [] })),
  comments: ["C2", "C1"].map((id) => ({ id, kind: "comment" as const, author: "bob", body: id, createdAt: "today" })),
};
let ctx: PrStepContext;
let calls: { op: unknown; input: unknown; signal: AbortSignal | undefined }[];

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
  writer.mockClear();
  appendRules.mockClear();
  loadOverride.mockClear();
  _reviewStepDeps.writeBranchReviewPackage = writer;
  _workflowDeps.appendChangedFileRules = appendRules;
  _workflowDeps.loadProjectContextOverride = loadOverride;
  _workflowDeps.callOp = makeScriptedCallOp((op, value, callCtx) => {
    calls.push({ op, input: value, signal: callCtx.signal });
    return verdict;
  });
});
afterEach(() => {
  Object.assign(_workflowDeps, originalWorkflow);
  Object.assign(_reviewStepDeps, originalReview);
});

const packagePath = "/review/artifacts/package-pr.diff";

describe("runPrReview", () => {
  test("static dispatch receives real modified preimages and deleted contents without command instructions", async () => {
    const { makeTempDir, cleanupTempDir } = await import("@test/helpers");
    const root = makeTempDir("bot-static-");
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code) throw new Error(err);
      return out.trim();
    };
    try {
      await git("init");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.com");
      await Bun.write(join(root, "modified.txt"), "before modification\n");
      await Bun.write(join(root, "deleted.txt"), "deleted secret behavior\n");
      await git("add", ".");
      await git("commit", "-m", "base");
      const base = await git("rev-parse", "HEAD");
      await Bun.write(join(root, "modified.txt"), "after modification\n");
      await git("rm", "deleted.txt");
      await git("add", ".");
      await git("commit", "-m", "head");
      _reviewStepDeps.writeBranchReviewPackage = originalReview.writeBranchReviewPackage;
      ctx = { ...ctx, projectDir: root, runDir: join(root, "artifacts") };
      expect(await runPrReview(ctx, { ...input, mergeBase: base, staticMode: true })).toEqual({ ran: true, verdict });
      const pkg = await Bun.file(join(ctx.runDir, "package-pr.diff")).text();
      expect(pkg).toContain("-before modification");
      expect(pkg).toContain("+after modification");
      expect(pkg).toContain("-deleted secret behavior");
      expect(pkg).not.toContain("git diff");
      expect(calls[0]?.op).toBe(botPrStaticReviewOp);
    } finally {
      cleanupTempDir(root);
    }
  });
  test.each([
    ["AC-1", true, botPrStaticReviewOp],
    ["AC-2", false, botPrReviewOp],
  ] as const)("%s dispatches the selected review operation", async (_ac, staticMode, op) => {
    expect(await runPrReview(ctx, { ...input, staticMode })).toEqual({ ran: true, verdict });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe(op);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("AC-3 writes the PR package from mergeBase in the checkout", async () => {
    await runPrReview(ctx, input);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(ctx.projectDir, input.mergeBase, join(ctx.runDir, "package-pr.diff"));
  });

  test.each([
    ["AC-4", { threadIds: ["T2", "T1"] }],
    ["AC-5", { commentIds: ["C2", "C1"] }],
    ["AC-6", { timeoutMs: 12_345 }],
  ])("%s forwards ordered triage ids and the configured timeout", async (_ac, expected) => {
    await runPrReview(ctx, input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject(expected);
  });

  test("AC-7 forwards the optional model", async () => {
    await runPrReview(ctx, { ...input, model: "fast" });
    expect(calls[0]?.input).toMatchObject({ model: "fast" });
  });

  test("AC-8 builds the PRD intent prompt and maps the author login", async () => {
    await runPrReview(ctx, { ...input, prdPath: "/review/intent.json" });
    const value = calls[0]?.input;
    if (typeof value !== "object" || value === null || !("prompt" in value)) throw new Error("missing prompt");
    expect(value.prompt).toContain("Intent: the PRD at /review/intent.json.");
    expect(value.prompt).toContain("PR author:\n```\nalice\n```");
    expect(value.prompt).toContain(`range merge-base..HEAD, diff package ${packagePath}`);
    expect(calls[0]?.input).not.toHaveProperty("requiredFiles");
    expect(calls[0]?.input).not.toHaveProperty("model");
  });

  test("AC-9 appends index rules with configured overrides and writer paths", async () => {
    ctx.config.context.rules = {
      ...ctx.config.context.rules,
      delivery: "index",
      overrideDir: "/base/rules",
      overrideMode: "replace",
    };
    await runPrReview(ctx, input);
    expect(appendRules).toHaveBeenCalledTimes(1);
    expect(appendRules).toHaveBeenCalledWith(packagePath, paths, {
      repoRoot: ctx.projectDir,
      overrideDir: "/base/rules",
      overrideMode: "replace",
    });
  });

  test("AC-9 defaults missing rules to index delivery and merge overrides", async () => {
    Reflect.deleteProperty(ctx.config.context, "rules");
    await runPrReview(ctx, input);
    expect(appendRules).toHaveBeenCalledTimes(1);
    expect(appendRules).toHaveBeenCalledWith(packagePath, paths, { repoRoot: ctx.projectDir, overrideMode: "merge" });
  });

  test("AC-10 skips rule mapping for push delivery", async () => {
    ctx.config.context.rules = { ...ctx.config.context.rules, delivery: "push" };
    await runPrReview(ctx, input);
    expect(calls).toHaveLength(1);
    expect(appendRules).not.toHaveBeenCalled();
  });

  test("AC-11 never loads project context overrides", async () => {
    await runPrReview(ctx, input);
    expect(calls).toHaveLength(1);
    expect(loadOverride).not.toHaveBeenCalled();
  });

  test("AC-12 returns a skipped review on package failure", async () => {
    _reviewStepDeps.writeBranchReviewPackage = async () => {
      throw new Error("package unavailable");
    };
    expect(await runPrReview(ctx, input)).toEqual({ ran: false, why: "review package failed: package unavailable" });
  });

  test("AC-13 never dispatches after package failure", async () => {
    _reviewStepDeps.writeBranchReviewPackage = async () => {
      throw new Error("package unavailable");
    };
    await runPrReview(ctx, input);
    expect(calls).toHaveLength(0);
    expect(appendRules).not.toHaveBeenCalled();
  });

  test("skips dispatch when rules delivery fails", async () => {
    _workflowDeps.appendChangedFileRules = async () => {
      throw new Error("rules unavailable");
    };
    expect(await runPrReview(ctx, input)).toEqual({ ran: false, why: "review package failed: rules unavailable" });
    expect(calls).toHaveLength(0);
  });
});
