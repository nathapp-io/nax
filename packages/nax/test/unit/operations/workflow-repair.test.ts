/**
 * US-001 (SPEC-ci-repair-and-review-sandbox) — `workflowRepairOp`.
 *
 * A repair is the branch fix under its own session role, so the token meter
 * books it apart from `wf-branch-fix` with no meter change. The op is therefore
 * *defined* as the branch fix op with a different name and session role, and
 * these ACs pin the two things that differ plus the ones that must NOT: tools,
 * model resolution, timeout margin, writable report, soft-interrupt hop body,
 * parser and recover.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opModelResolver, opSelector } from "@test/helpers";
import { SessionFailureError } from "@/agents";
import { workflowConfigSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import {
  parseImplementerReply,
  WORKFLOW_INTERRUPT_MARKER,
  type WorkflowBranchFixInput,
  workflowBranchFixOp,
  workflowRepairOp,
} from "@/operations";
import type { HopBodyContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const runtime = makeTestRuntime({ config });
  createdRuntimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchFixInput = { prompt: "repair B1", timeoutMs: 1000, reportPath: "/r/feature-report.md" };

const interrupted: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  reason: "interrupted",
  message: "interrupted",
};

describe("workflowRepairOp — the two things that differ from the branch fix", () => {
  test("AC-3: its name is 'workflow-repair'", () => {
    expect(workflowRepairOp.name).toBe("workflow-repair");
  });

  test("AC-4: its session is the fresh wf-repair role", () => {
    expect(workflowRepairOp.session).toEqual({ role: "wf-repair", lifetime: "fresh" });
  });

  test("it is a run-kind op on the run stage, like the branch fix", () => {
    expect(workflowRepairOp.kind).toBe("run");
    expect(workflowRepairOp.stage).toBe("run");
    expect(workflowRepairOp.keepOpen).toBeUndefined();
  });
});

describe("workflowRepairOp — the inherited behaviours", () => {
  test("AC-5: its tools equal the branch fix op's tools", () => {
    expect(workflowRepairOp.tools).toEqual(workflowBranchFixOp.tools);
    expect(workflowRepairOp.tools).toContain("Write");
    expect(workflowRepairOp.tools).toContain("Bash");
  });

  test("AC-6: no input.model falls back to workflow.models.branchFix", () => {
    const model = opModelResolver(workflowRepairOp)(
      input,
      buildCtx({ workflow: { models: { branchFix: "powerful" } } }),
    );
    expect(model).toBe("powerful");
  });

  test("AC-6 boundary: config with no branchFix tier reads undefined, as the branch fix does", () => {
    const ctx = buildCtx({ workflow: { models: { branchFix: undefined } }, finish: { reviewers: { fix: undefined } } });
    expect(opModelResolver(workflowRepairOp)(input, ctx)).toBe(opModelResolver(workflowBranchFixOp)(input, ctx));
  });

  test("AC-7: input.model wins over the configured tier", () => {
    const model = opModelResolver(workflowRepairOp)(
      { ...input, model: "fast" },
      buildCtx({ workflow: { models: { branchFix: "powerful" } } }),
    );
    expect(model).toBe("fast");
  });

  test("AC-8: the agent timeout trails the step limit by the margin", () => {
    expect(workflowRepairOp.timeoutMs?.({ ...input, timeoutMs: 1000 }, buildCtx())).toBe(1000 + STEP_TIMEOUT_MARGIN_MS);
  });

  test("AC-9: the writable output is the feature report path", () => {
    expect(workflowRepairOp.writableOutput?.({ ...input, reportPath: "/r/feature-report.md" })).toBe(
      "/r/feature-report.md",
    );
  });

  test("AC-10: recover() returns exactly what parseImplementerReply('') returns", async () => {
    const verifyCtx = { ...buildCtx(), readFile: async () => null, fileExists: async () => false };
    const recovered = await workflowRepairOp.recover(input, verifyCtx);
    expect(recovered).toEqual(parseImplementerReply(""));
  });

  test("parse is the implementer reply contract", () => {
    const parsed = workflowRepairOp.parse(
      '```json\n{"status":"DONE","commits":["a1"],"testSummary":"3 pass"}\n```',
      input,
      buildCtx(),
    );
    expect(parsed.status).toBe("DONE");
    expect(parsed.commits).toEqual(["a1"]);
  });

  test("hopBody is the shared soft-interrupt turn: an interrupted turn returns the marker", async () => {
    const send = async (_prompt: string, opts?: { interrupt?: AbortSignal }) => {
      await new Promise((resolve) => opts?.interrupt?.addEventListener("abort", resolve, { once: true }));
      throw new SessionFailureError("interrupted", interrupted);
    };
    const ctx: HopBodyContext<WorkflowBranchFixInput> = { send, sendWithParseRetry: send, input };
    expect((await workflowRepairOp.hopBody("go", ctx)).output).toBe(WORKFLOW_INTERRUPT_MARKER);
  });
});
