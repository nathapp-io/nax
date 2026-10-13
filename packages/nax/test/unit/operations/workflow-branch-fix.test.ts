import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { SessionFailureError } from "@/agents";
import { workflowConfigSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { WORKFLOW_INTERRUPT_MARKER, type WorkflowBranchFixInput, workflowBranchFixOp } from "@/operations";
import type { HopBodyContext } from "@/operations/types";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchFixInput = { prompt: "fix B1", timeoutMs: 1, reportPath: "/r.md" };
const interrupted: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  reason: "interrupted",
  message: "interrupted",
};

function modelFor(i: WorkflowBranchFixInput, overrides: Record<string, unknown>) {
  const m = workflowBranchFixOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchFixOp", () => {
  test("shape: fresh wf-branch-fix, stage run, write tools, not kept open", () => {
    expect(workflowBranchFixOp.session).toEqual({ role: "wf-branch-fix", lifetime: "fresh" });
    expect(workflowBranchFixOp.stage).toBe("run");
    expect(workflowBranchFixOp.tools).toContain("Write");
    expect(workflowBranchFixOp.tools).toContain("Bash");
    expect(workflowBranchFixOp.keepOpen).toBeUndefined();
  });

  test("model: input, then workflow.models.branchFix, then finish.reviewers.fix", () => {
    expect(modelFor(input, { finish: { reviewers: { fix: "fast" } } })).toBe("fast");
    expect(
      modelFor(input, { finish: { reviewers: { fix: "fast" } }, workflow: { models: { branchFix: "powerful" } } }),
    ).toBe("powerful");
  });

  test("hopBody: an interrupted turn returns the marker (shared softInterruptTurn)", async () => {
    const send = async (_prompt: string, opts?: { interrupt?: AbortSignal }) => {
      await new Promise((resolve) => opts?.interrupt?.addEventListener("abort", resolve, { once: true }));
      throw new SessionFailureError("interrupted", interrupted);
    };
    const ctx: HopBodyContext<WorkflowBranchFixInput> = { send, sendWithParseRetry: send, input };
    expect((await workflowBranchFixOp.hopBody("go", ctx)).output).toBe(WORKFLOW_INTERRUPT_MARKER);
  });

  test("parse uses the implementer reply contract; an empty reply recovers to DONE_WITH_CONCERNS", async () => {
    const out = workflowBranchFixOp.parse(
      '```json\n{"status":"DONE","commits":["a1"],"testSummary":"3 pass"}\n```',
      input,
      buildCtx(),
    );
    expect(out.status).toBe("DONE");
    expect(out.commits).toEqual(["a1"]);
    const verifyCtx = { ...buildCtx(), readFile: async () => null, fileExists: async () => false };
    expect((await workflowBranchFixOp.recover(input, verifyCtx))?.status).toBe("DONE_WITH_CONCERNS");
  });
});
