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
