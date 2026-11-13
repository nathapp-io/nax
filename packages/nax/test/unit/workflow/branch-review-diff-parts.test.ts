import { afterEach, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { workflowBranchReviewOp } from "@/operations";
import { _branchReviewDeps, runBranchReview } from "@/workflow/branch-review";
import { _reviewToolReadsDeps } from "@/workflow/review-tool-reads";
import { _workflowDeps } from "@/workflow/step-context";

const saved = { ..._branchReviewDeps };
const workflow = { ..._workflowDeps };
const audit = { ..._reviewToolReadsDeps };
const dirs: string[] = [];
const facts = { stories: [], minors: [], parked: [], cannotVerify: [], gateFindings: [] };
const reply = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const files = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
const parts = [1, 2, 3].map((n) => ({
  path: `/run/package-branch-part-0${n}.diff`,
  files: n < 3 ? ["f0.ts"] : ["f1.ts"],
}));

afterEach(async () => {
  Object.assign(_branchReviewDeps, saved);
  Object.assign(_workflowDeps, workflow);
  Object.assign(_reviewToolReadsDeps, audit);
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

function setup() {
  const runDir = makeTempDir("whole-review-");
  dirs.push(runDir);
  const ctx = makeFeatureContext({ runDir });
  _branchReviewDeps.writeBranchReviewPackage = async () => files;
  _branchReviewDeps.reviewRequiredFiles = async () => files;
  _workflowDeps.appendChangedFileRules = async () => {};
  _workflowDeps.loadProjectContextOverride = async () => undefined;
  _workflowDeps.now = () => 100;
  return ctx;
}

function inputField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? new Map(Object.entries(value)).get(key) : undefined;
}

test("one whole-diff session carries all files and parts and records metadata", async () => {
  const ctx = setup();
  const writerCalls: unknown[] = [];
  const packageCalls: unknown[] = [];
  _branchReviewDeps.writeBranchReviewPackage = async (...args) => {
    packageCalls.push(args);
    return files;
  };
  _branchReviewDeps.writeBranchDiffParts = async (...args) => {
    writerCalls.push(args);
    return parts;
  };
  const calls: { op: unknown; input: unknown }[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
    calls.push({ op, input });
    return reply;
  });
  const out = await runBranchReview(ctx, { seed: "seed", facts });
  expect(writerCalls).toEqual([[ctx.projectDir, "seed", join(ctx.runDir, "package-branch.diff")]]);
  expect(packageCalls[0]).toEqual([
    ctx.projectDir,
    "seed",
    join(ctx.runDir, "package-branch.diff"),
    { readingNote: false },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0].op).toBe(workflowBranchReviewOp);
  expect(inputField(calls[0].input, "requiredFiles")).toEqual(files);
  expect(inputField(calls[0].input, "diffParts")).toEqual(parts);
  for (const part of parts) expect(inputField(calls[0].input, "prompt")).toContain(part.path);
  if (!out.ran) throw new Error(out.why);
  expect(out.verdict.diffParts).toEqual(parts.map((p) => ({ part: basename(p.path), files: p.files })));
  expect(out.verdict).not.toHaveProperty("slices");
});

test("empty parts preserve the pull-diff prompt and omit metadata", async () => {
  const ctx = setup();
  _branchReviewDeps.writeBranchDiffParts = async () => [];
  let received: unknown;
  _workflowDeps.callOp = makeScriptedCallOp((_op, input) => {
    received = input;
    return reply;
  });
  const out = await runBranchReview(ctx, { seed: "seed", facts });
  expect(inputField(received, "diffParts")).toBeUndefined();
  expect(inputField(received, "prompt")).toContain("git diff seed..HEAD -- <path>");
  if (!out.ran) throw new Error(out.why);
  expect(out.verdict).not.toHaveProperty("diffParts");
});

test("part writer failure skips dispatch with a reason", async () => {
  const ctx = setup();
  _branchReviewDeps.writeBranchDiffParts = async () => {
    throw new NaxError("part failure", "WORKFLOW_REVIEW_PACKAGE_FAILED", { stage: "workflow" });
  };
  let called = false;
  _workflowDeps.callOp = makeScriptedCallOp(() => {
    called = true;
    return reply;
  });
  expect(await runBranchReview(ctx, { seed: "seed", facts })).toEqual({
    ran: false,
    why: "review package failed: part failure",
  });
  expect(called).toBe(false);
});

test.each([
  ["both whole", [{ path: parts[0].path }, { path: parts[1].path }], false],
  ["one whole", [{ path: parts[0].path }], true],
  ["no calls", [], true],
  ["offset", [{ path: parts[0].path, offset: 1 }, { path: parts[1].path }], true],
  ["limit", [{ path: parts[0].path, limit: 100 }, { path: parts[1].path }], true],
])("audit %s credits only complete holdings", async (_name, inputs, unread) => {
  const ctx = setup();
  _branchReviewDeps.writeBranchDiffParts = async () => parts;
  _workflowDeps.callOp = makeScriptedCallOp(() => reply);
  _reviewToolReadsDeps.glob = async () => [`${ctx.runId}-101-${ctx.feature}-wf-branch-review.json`];
  _reviewToolReadsDeps.readText = async () =>
    JSON.stringify({
      calls: inputs.map((input) => ({ tool: "Read", outcome: "ok", truncated: false, resultBytes: 10, input })),
    });
  const out = await runBranchReview(ctx, { seed: "seed", facts });
  if (!out.ran) throw new Error(out.why);
  expect(out.verdict.unreadFiles?.includes("f0.ts") ?? false).toBe(unread);
  expect(out.verdict.inspectedFiles).toEqual([]);
});

test("unreadable audit and truncated part earn no credit", async () => {
  const ctx = setup();
  _branchReviewDeps.reviewRequiredFiles = async () => ["f0.ts"];
  _branchReviewDeps.writeBranchDiffParts = async () => [parts[0]];
  _workflowDeps.callOp = makeScriptedCallOp(() => reply);
  _reviewToolReadsDeps.glob = async () => {
    throw new Error("unreadable");
  };
  let out = await runBranchReview(ctx, { seed: "seed", facts });
  if (!out.ran) throw new Error(out.why);
  expect(out.verdict.unreadFiles).toEqual(["f0.ts"]);
  _reviewToolReadsDeps.glob = async () => [`${ctx.runId}-101-${ctx.feature}-wf-branch-review.json`];
  _reviewToolReadsDeps.readText = async () =>
    JSON.stringify({
      calls: [{ tool: "Read", outcome: "ok", truncated: true, resultBytes: 10, input: { path: parts[0].path } }],
    });
  out = await runBranchReview(ctx, { seed: "seed", facts });
  if (!out.ran) throw new Error(out.why);
  expect(out.verdict.unreadFiles).toEqual(["f0.ts"]);
});
