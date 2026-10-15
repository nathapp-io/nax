import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeTempDir,
} from "@test/helpers";
import { workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import { runBranchReReview, runBranchReview } from "@/workflow/branch-review";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function fc(over = {}) {
  const runDir = makeTempDir("wf-br-");
  dirs.push(runDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeFeatureContext({ runDir, ...over });
}

const facts = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [{ id: "M1", storyId: "US-001", text: "rename tmp" }],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

describe("runBranchReview", () => {
  test("writes package-branch.diff from the seed (the machine owns branch-review.json); passes the minor ids", async () => {
    const ctx = fc();
    const gitCalls: string[][] = [];
    _workflowDeps.git = async (args) => {
      gitCalls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    const verdict: BranchReviewVerdict = {
      spec: "pass",
      quality: "approved",
      findings: [],
      cannotVerify: [],
      inspectedFiles: [],
      minorTriage: [{ id: "M1", decision: "fix-now" }],
    };
    const inputs: unknown[] = [];
    const prompts: string[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op.name).toBe(workflowBranchReviewOp.name);
      inputs.push(input);
      prompts.push((input as { prompt: string }).prompt);
      return verdict;
    });
    const out = await runBranchReview(ctx, { seed: "seed0", specPath: "spec.md", facts });
    expect(out).toEqual({ ran: true, verdict });
    expect(gitCalls.some((a) => a.includes("seed0..HEAD"))).toBe(true);
    expect(prompts[0]).toContain("git diff seed0..HEAD -- <path>");
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).text()).toContain("## Changed files (0)");
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).exists()).toBe(false);
    expect(inputs[0]).toMatchObject({ minorIds: ["M1"], timeoutMs: ctx.workflow.timeouts.reviewMs });
  });

  test("unparseable reply -> not run, no artifact", async () => {
    const ctx = fc();
    _workflowDeps.callOp = makeScriptedCallOp(() => null);
    expect(await runBranchReview(ctx, { seed: "s", facts })).toEqual({ ran: false, why: "unparseable reply" });
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).exists()).toBe(false);
  });
});

/** The two changed files the branch-package stub reports: one source, one test. */
const BRANCH_CHANGES = "M\0src/a.ts\0M\0src/a.test.ts\0";

/** Stub git so `--name-status -z` reports `BRANCH_CHANGES` and the classifier drops `.test.ts`. */
function stubBranchPackageGit(): void {
  _workflowDeps.git = async (args) => ({
    stdout: args.includes("--name-status") ? BRANCH_CHANGES : "",
    exitCode: 0,
  });
  _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [/\.test\.ts$/] });
}

/** Script `callOp` to answer the branch op with `verdict`, recording the input it received. */
function scriptVerdict(verdict: unknown, inputs: { requiredFiles?: readonly string[]; range?: string }[] = []) {
  _workflowDeps.callOp = makeScriptedCallOp((_op, input) => {
    inputs.push(input as { requiredFiles?: readonly string[]; range?: string });
    return verdict;
  });
  return inputs;
}

const PASS_VERDICT = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [] as readonly string[],
  minorTriage: [],
};

describe("runBranchReview required set and coverage", () => {
  test("the op input carries the required files the package writer returned (AC-17)", async () => {
    const ctx = fc();
    stubBranchPackageGit();
    const inputs = scriptVerdict(PASS_VERDICT);
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out.ran).toBe(true);
    expect(inputs[0]?.requiredFiles).toEqual(["src/a.ts"]);
  });

  test("the op input carries the branch range (AC-18)", async () => {
    const ctx = fc();
    stubBranchPackageGit();
    const inputs = scriptVerdict(PASS_VERDICT);
    await runBranchReview(ctx, { seed: "seed0", facts });
    expect(inputs[0]?.range).toBe("seed0..HEAD");
  });

  test("an empty inspectedFiles list makes every required file unread (AC-19)", async () => {
    const ctx = fc();
    stubBranchPackageGit();
    scriptVerdict(PASS_VERDICT);
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict.unreadFiles).toEqual(["src/a.ts"]);
  });

  test("a fully covered required set leaves the verdict without unreadFiles (AC-20)", async () => {
    const ctx = fc();
    stubBranchPackageGit();
    scriptVerdict({ ...PASS_VERDICT, inspectedFiles: ["src/a.ts"] });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect("unreadFiles" in out.verdict).toBe(false);
  });

  test("a verdict with no inspectedFiles property reads as an empty list (AC-21)", async () => {
    const ctx = fc();
    stubBranchPackageGit();
    const { inspectedFiles: _omitted, ...withoutInspected } = PASS_VERDICT;
    scriptVerdict(withoutInspected);
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict.unreadFiles).toEqual(["src/a.ts"]);
  });

  test("a failing package write skips the review and never calls the op (AC-22)", async () => {
    const ctx = fc();
    _workflowDeps.git = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });
    let called = false;
    _workflowDeps.callOp = makeScriptedCallOp(() => {
      called = true;
      return PASS_VERDICT;
    });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out.ran).toBe(false);
    if (out.ran) throw new Error("the branch review must not run");
    expect(out.why.startsWith("review package failed")).toBe(true);
    expect(called).toBe(false);
  });
});

describe("runBranchReReview", () => {
  test("re-review op on the fix diff with the branch model (AC-23: still an inline -U10 diff)", async () => {
    const ctx = fc({ workflow: { ...makeFeatureContext().workflow, models: { branchReview: "powerful" } } });
    const gitCalls: string[][] = [];
    _workflowDeps.git = async (args) => {
      gitCalls.push(args);
      return { stdout: "", exitCode: 0 };
    };
    const inputs: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op.name).toBe(workflowReReviewOp.name);
      inputs.push(input);
      return { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [] };
    });
    const out = await runBranchReReview(ctx, {
      findings: [{ id: "B1", kind: "quality", severity: "important", issue: "drift" }],
      fixBase: "fix0",
    });
    expect(out.ran).toBe(true);
    expect(inputs[0]).toMatchObject({ openIds: ["B1"], model: "powerful" });
    expect(gitCalls.flat()).toContain("--unified=10");
    expect(await Bun.file(join(ctx.runDir, "package-branch-fix.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "branch-rereview.json")).exists()).toBe(false);
  });
});
