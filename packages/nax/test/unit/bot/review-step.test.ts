import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeScriptedCallOp } from "@test/helpers";
import { _reviewStepDeps, type PrReviewInput, runPrReview } from "@/bot/review-step";
import { resolveWorkflowConfig } from "@/config";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._reviewStepDeps };
const workflow = { ..._workflowDeps };
const config = makeNaxConfig();
const ctx: PrStepContext = {
  config,
  workflow: resolveWorkflowConfig(config),
  callCtx: makeMockCallContext(),
  projectDir: "/checkout",
  runDir: "/artifacts",
  reportPath: "/report",
  feature: "bot",
  pr: { forge: "github", number: 7, base: "merge", head: "head" },
  packageDirs: [],
  dryRun: false,
};
const input: PrReviewInput = {
  mergeBase: "merge",
  staticMode: false,
  issues: [],
  threads: [],
  comments: [],
  info: {
    number: 7,
    title: "PR",
    body: "body",
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: "head",
    crossRepo: false,
  },
};
const write = mock<typeof _reviewStepDeps.writeBranchReviewPackage>(async () => ["changed"]);
const rules = mock<typeof _workflowDeps.appendChangedFileRules>(async () => {});
let calls: unknown[];
beforeEach(() => {
  calls = [];
  write.mockClear();
  rules.mockClear();
  _reviewStepDeps.writeBranchReviewPackage = write;
  _workflowDeps.appendChangedFileRules = rules;
  _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
    calls.push(value);
    return {
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    };
  });
});
afterEach(() => {
  Object.assign(_reviewStepDeps, original);
  Object.assign(_workflowDeps, workflow);
});

describe("runPrReview", () => {
  test.each([false, true])("review depth AC-8 forwards new sections to the op (static=%s)", async (staticMode) => {
    const result = await runPrReview(ctx, { ...input, staticMode });
    expect(result).toMatchObject({ ran: true, verdict: { quality: "approved" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prompt: expect.stringMatching(/## Beyond the diff[\s\S]*## Tests/) });
  });
  test("settled AC-15 forwards rulings into the operation prompt", async () => {
    await runPrReview(ctx, {
      ...input,
      settled: [
        {
          id: "_run:cv1",
          kind: "cannot-verify",
          issue: "Live logs",
          disposition: "verified",
          reason: "ran live calls",
        },
      ],
    });
    expect(calls[0]).toMatchObject({ prompt: expect.stringMatching(/## Settled rulings[\s\S]*_run:cv1/) });
  });
  test.each([false, true])(
    "US-015 AC-6/9 classifies changed paths and reports unread files, static=%s",
    async (staticMode) => {
      _reviewStepDeps.writeBranchReviewPackage = async () => [
        "pkg/main.go",
        "pkg/main_test.go",
        "README.md",
        "settings.json",
      ];
      _workflowDeps.resolveTestPatterns = async () => ({
        regex: [/_test\.go$/],
        globs: [],
        testDirs: [],
        pathspec: [],
        resolution: "per-package",
      });
      const result = await runPrReview(
        { ...ctx, packageDirs: ["pkg"] },
        { ...input, rangeBase: "reviewed", staticMode },
      );
      expect(calls[0]).toMatchObject({
        requiredFiles: ["pkg/main.go", "pkg/main_test.go", "settings.json"],
        repoRoot: "/checkout",
        range: "reviewed..HEAD",
      });
      expect(result).toMatchObject({ ran: true, unreadFiles: ["pkg/main.go", "pkg/main_test.go", "settings.json"] });
    },
  );
  test.each([false, true])(
    "US-004 AC-8/9 reports an unread test but retains the exhausted approved verdict, static=%s",
    async (staticMode) => {
      _reviewStepDeps.writeBranchReviewPackage = async () => [
        "pkg/main.go",
        "pkg/main_test.go",
        "README.md",
        "settings.json",
      ];
      _workflowDeps.resolveTestPatterns = async () => ({
        regex: [/_test\.go$/],
        globs: [],
        testDirs: [],
        pathspec: [],
        resolution: "per-package",
      });
      // The op owns retry exhaustion; this is its final usable result, not a new retry in runPrReview.
      const verdict = {
        intent: "pass",
        quality: "approved",
        findings: [],
        threads: [],
        comments: [],
        cannotVerify: [],
        inspectedFiles: ["pkg/main.go", "settings.json"],
      };
      _workflowDeps.callOp = makeScriptedCallOp(() => verdict);
      const result = await runPrReview({ ...ctx, packageDirs: ["pkg"] }, { ...input, staticMode });
      expect(result).toMatchObject({ ran: true, unreadFiles: ["pkg/main_test.go"] });
      if (!result.ran) throw new Error("Expected a usable review verdict");
      expect(result.verdict).toBe(verdict);
      expect(result.verdict.quality).toBe("approved");
    },
  );
  test("US-015 AC-9 reports only required paths not inspected", async () => {
    _workflowDeps.callOp = makeScriptedCallOp(() => ({
      intent: "pass",
      quality: "approved",
      findings: [],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: ["/checkout/changed"],
    }));
    expect(await runPrReview(ctx, input)).not.toHaveProperty("unreadFiles");
    _reviewStepDeps.writeBranchReviewPackage = async () => ["changed", "unread"];
    expect(await runPrReview(ctx, input)).toMatchObject({ ran: true, unreadFiles: ["unread"] });
  });
  test("US-015 AC-7 omits empty coverage requirements", async () => {
    _reviewStepDeps.writeBranchReviewPackage = async () => ["README.md"];
    const result = await runPrReview(ctx, input);
    expect(result.ran).toBe(true);
    expect(calls[0]).not.toHaveProperty("requiredFiles");
    expect(result).not.toHaveProperty("unreadFiles");
  });
  test("AC-9 rangeBase controls actual package and prompt", async () => {
    const result = await runPrReview(ctx, { ...input, rangeBase: "reviewed" });
    expect(result.ran).toBe(true);
    expect(write).toHaveBeenCalledWith("/checkout", "reviewed", "/artifacts/package-pr.diff");
    expect(calls[0]).toMatchObject({
      prompt: expect.stringContaining("range reviewed..HEAD, diff package /artifacts/package-pr.diff"),
    });
  });
  test("AC-12 conversation-only skips package and rules writes, still dispatches triage", async () => {
    const result = await runPrReview(ctx, {
      ...input,
      conversationOnly: true,
      threads: [{ id: "t", replyTo: "t", comments: [], resolved: false, outdated: false }],
    });
    expect(result.ran).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(rules).not.toHaveBeenCalled();
    expect(calls[0]).not.toHaveProperty("requiredFiles");
    expect(result).not.toHaveProperty("unreadFiles");
    expect(calls[0]).toMatchObject({ threadIds: ["t"], prompt: expect.stringContaining("workflow's branch review") });
  });
  test.each([undefined, false])(
    "AC-14 default range and package preserved with conversationOnly=%s",
    async (conversationOnly) => {
      expect((await runPrReview(ctx, { ...input, conversationOnly })).ran).toBe(true);
      expect(write).toHaveBeenCalledWith("/checkout", "merge", "/artifacts/package-pr.diff");
      expect(calls[0]).toMatchObject({
        prompt: expect.stringContaining("range merge..HEAD, diff package /artifacts/package-pr.diff"),
      });
    },
  );
  test("static incremental review preserves restricted package options", async () => {
    await runPrReview(ctx, { ...input, rangeBase: "reviewed", staticMode: true });
    expect(write).toHaveBeenCalledWith("/checkout", "reviewed", "/artifacts/package-pr.diff", { staticMode: true });
  });
});
