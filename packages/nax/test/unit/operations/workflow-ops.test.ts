import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodingToolSupport } from "@nathapp/nax-agent/internal";
import { makeNaxConfig, makeStory, makeTempDir, makeTestRuntime, opSelector } from "@test/helpers";
import { SessionFailureError } from "@/agents";
import { naxOwnedPathsPolicy } from "@/agents/nax-owned-writes";
import { ParseValidationError } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import type { WorkflowBranchFixInput, WorkflowImplementInput } from "@/operations";
import {
  WORKFLOW_INTERRUPT_MARKER,
  workflowBranchFixOp,
  workflowImplementOp,
  workflowReReviewOp,
  workflowStoryReviewOp,
} from "@/operations";
import type { HopBodyContext } from "@/operations/types";

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const story = makeStory({
  id: "US-001",
  title: "t",
  description: "d",
  acceptanceCriteria: ["a"],
  status: "in-progress",
  attempts: 1,
  routing: { complexity: "medium", modelTier: "balanced", testStrategy: "tdd-simple", reasoning: "" },
});

function hopCtx(
  send: HopBodyContext<WorkflowImplementInput>["send"],
  timeoutMs: number,
): HopBodyContext<WorkflowImplementInput> {
  return { send, sendWithParseRetry: send, input: { story, prompt: "go", timeoutMs, reportPath: "/r.md" } };
}

const interrupted: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  reason: "interrupted",
  message: "interrupted",
};

describe("workflowImplementOp", () => {
  test("shape: warm wf-implementer, stage run, write tools, kept open", () => {
    expect(workflowImplementOp.session).toEqual({ role: "wf-implementer", lifetime: "warm" });
    expect(workflowImplementOp.stage).toBe("run");
    expect(workflowImplementOp.tools).toContain("Write");
    expect(workflowImplementOp.tools).toContain("GitCommit");
    const ctx = buildCtx();
    expect(workflowImplementOp.keepOpen?.({ story, prompt: "p", timeoutMs: 1, reportPath: "/r.md" }, ctx)).toBe(true);
  });

  test("model: explicit override wins, else the story's routed tier", () => {
    const ctx = buildCtx();
    const resolve = workflowImplementOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolve({ story, prompt: "p", timeoutMs: 1, reportPath: "/r.md" }, ctx)).toBe("balanced");
    expect(resolve({ story, prompt: "p", timeoutMs: 1, model: "powerful" }, ctx)).toBe("powerful");
  });

  test("agent timeout trails the step limit by the margin", () => {
    const ctx = buildCtx();
    const t = workflowImplementOp.timeoutMs as (i: unknown, c: unknown) => number;
    expect(t({ story, prompt: "p", timeoutMs: 1000 }, ctx)).toBe(61_000);
  });

  test("hopBody: an interrupted turn returns the marker instead of throwing", async () => {
    // Throw only once the interrupt has really fired, like a soft-cancelled turn does.
    const send = async (_prompt: string, opts?: { interrupt?: AbortSignal }) => {
      await new Promise((resolve) => opts?.interrupt?.addEventListener("abort", resolve, { once: true }));
      throw new SessionFailureError("interrupted", interrupted);
    };
    const out = await workflowImplementOp.hopBody("go", hopCtx(send, 1));
    expect(out.output).toBe(WORKFLOW_INTERRUPT_MARKER);
  });

  test("hopBody: a non-interrupt failure is rethrown", async () => {
    const send = async () => {
      throw new Error("boom");
    };
    await expect(workflowImplementOp.hopBody("go", hopCtx(send, 60_000))).rejects.toThrow("boom");
  });
});

describe("workflow review ops", () => {
  test("story review: fresh wf-story-review, read tools + Git, no writes", () => {
    expect(workflowStoryReviewOp.session).toEqual({ role: "wf-story-review", lifetime: "fresh" });
    expect(workflowStoryReviewOp.stage).toBe("review");
    expect(workflowStoryReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
  });

  test("story review model: workflow.models.storyReview, else review.semantic.model", () => {
    const resolve = workflowStoryReviewOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolve({ prompt: "p", timeoutMs: 1 }, buildCtx({ review: { semantic: { model: "fast" } } }))).toBe("fast");
    expect(
      resolve({ prompt: "p", timeoutMs: 1 }, buildCtx({ workflow: { models: { storyReview: "powerful" } } })),
    ).toBe("powerful");
  });

  test("re-review: fresh wf-rereview, parse uses the open ids", () => {
    expect(workflowReReviewOp.session).toEqual({ role: "wf-rereview", lifetime: "fresh" });
    const out = workflowReReviewOp.parse(
      JSON.stringify({ findings: [], newFindings: [] }),
      { prompt: "p", timeoutMs: 1, openIds: ["F1"] },
      buildCtx(),
    );
    expect(out?.verdicts).toEqual([{ id: "F1", addressed: false, note: "(no verdict returned)" }]);
  });

  test("re-review build: the prompt is the task, no role text", () => {
    const prompt = workflowReReviewOp.build({ prompt: "check F1", timeoutMs: 1, openIds: ["F1"] }, buildCtx());
    expect(prompt.task.content).toBe("check F1");
    expect(prompt.role.content).toBe("");
  });

  test("re-review retry: one reformat prompt, then the null fallback", () => {
    const input = { prompt: "p", timeoutMs: 1, openIds: ["F1"] };
    const resolved =
      typeof workflowReReviewOp.retry === "function"
        ? workflowReReviewOp.retry(input, buildCtx())
        : workflowReReviewOp.retry;
    if (!resolved || !("shouldRetry" in resolved)) throw new Error("expected a retry strategy");
    const strategy = resolved;
    const probe = new ParseValidationError("bad");
    const ctx = { site: "run" as const, agentName: "claude", stage: "review" as const, lastOutput: "not json at all" };
    const first = strategy.shouldRetry(probe, 0, ctx);
    expect(first.retry).toBe(true);
    const last = strategy.shouldRetry(probe, 1, ctx);
    expect(last).toEqual({ retry: false, fallback: null });
  });
});

/**
 * nax#2479: the report a workflow session writes lives under the repo's `.nax/`, which
 * agents may not write. Each writing op declares its one report path as `writableOutput`,
 * and that path (and only that path) must be writable under the op's own declared tools,
 * while the reply is left alone (no `fileOutput` swap).
 */
describe("workflow writing ops can write their declared report (nax#2479)", () => {
  const root = makeTempDir("nax-2479-");
  const REPORT_REL = ".nax/features/auth/workflow/run-1/US-001/report.md";
  const reportPath = join(root, REPORT_REL);
  const implementInput: WorkflowImplementInput = { story, prompt: "p", timeoutMs: 1, reportPath };
  const branchFixInput: WorkflowBranchFixInput = { prompt: "p", timeoutMs: 1, reportPath };
  const declared = [
    ["workflow-implement", workflowImplementOp.tools ?? [], workflowImplementOp.writableOutput?.(implementInput)],
    ["workflow-branch-fix", workflowBranchFixOp.tools ?? [], workflowBranchFixOp.writableOutput?.(branchFixInput)],
  ] as const;

  test("both ops declare the report as writable output and do not swap their reply", () => {
    for (const [, , writable] of declared) expect(writable).toBe(reportPath);
    expect(workflowImplementOp.fileOutput).toBeUndefined();
    expect(workflowBranchFixOp.fileOutput).toBeUndefined();
  });

  for (const [name, tools, writable] of declared) {
    test(`${name} may write the report under its own tools, but not the brief beside it`, async () => {
      const support = buildCodingToolSupport({
        root,
        declared: [...tools],
        grants: [{ tool: "Write", patterns: ["**"] }],
        ownedPaths: naxOwnedPathsPolicy,
        ...(writable !== undefined ? { fileOutputPath: writable } : {}),
      });
      const ok = await support?.runtime.callTool("Write", { path: REPORT_REL, content: "# report" });
      expect(ok?.kind).toBe("ok");
      expect(existsSync(reportPath)).toBe(true);
      const sibling = await support?.runtime.callTool("Write", {
        path: ".nax/features/auth/workflow/run-1/US-001/brief.md",
        content: "x",
      });
      expect(sibling?.kind).toBe("denied");
    });
  }
});
