import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeFeatureContext, makeScriptedCallOp, makeTempDir } from "@test/helpers";
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
  test("writes package-branch.diff from the seed and branch-review.json; passes the minor ids", async () => {
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
      minorTriage: [{ id: "M1", decision: "fix-now" }],
    };
    const inputs: unknown[] = [];
    _workflowDeps.callOp = makeScriptedCallOp((op, input) => {
      expect(op.name).toBe(workflowBranchReviewOp.name);
      inputs.push(input);
      return verdict;
    });
    const out = await runBranchReview(ctx, { seed: "seed0", specPath: "spec.md", facts });
    expect(out).toEqual({ ran: true, verdict });
    expect(gitCalls.some((a) => a.includes("seed0..HEAD"))).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "package-branch.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).json()).toEqual(verdict);
    expect(inputs[0]).toMatchObject({ minorIds: ["M1"], timeoutMs: ctx.workflow.timeouts.reviewMs });
  });

  test("unparseable reply -> not run, no artifact", async () => {
    const ctx = fc();
    _workflowDeps.callOp = makeScriptedCallOp(() => null);
    expect(await runBranchReview(ctx, { seed: "s", facts })).toEqual({ ran: false, why: "unparseable reply" });
    expect(await Bun.file(join(ctx.runDir, "branch-review.json")).exists()).toBe(false);
  });
});

describe("runBranchReReview", () => {
  test("re-review op on the fix diff with the branch model; writes branch-rereview.json", async () => {
    const ctx = fc({ workflow: { ...makeFeatureContext().workflow, models: { branchReview: "powerful" } } });
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
    expect(await Bun.file(join(ctx.runDir, "package-branch-fix.diff")).exists()).toBe(true);
    expect(await Bun.file(join(ctx.runDir, "branch-rereview.json")).exists()).toBe(true);
  });
});
