import { afterEach, describe, expect, test } from "bun:test";
import { expectRetryStrategy, makeTestRuntime, opSelector } from "@test/helpers";
import { ParseValidationError } from "@/agents/retry";
import { finishBranchReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(finishBranchReviewOp.config)) };
}

const input = {
  base: "origin/main",
  stories: [{ id: "US-001", title: "Add store" }],
  changedFiles: ["src/a.ts"],
  hints: [{ file: "src/b.ts", line: 3, severity: "LOW", message: "rename helper", reason: "style only" }],
};

describe("finishBranchReviewOp", () => {
  test("is a read-only review op on the finish-review-quality role", () => {
    expect(finishBranchReviewOp.name).toBe("finish-branch-review");
    expect(finishBranchReviewOp.session.role).toBe("finish-review-quality");
    expect(finishBranchReviewOp.session.lifetime).toBe("fresh");
    expect(finishBranchReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git", "Bash"]);
  });

  test("build carries stories, changed files and previously skipped hints", () => {
    const built = finishBranchReviewOp.build(input, makeCtx());
    expect(built.task.content).toContain("US-001: Add store");
    expect(built.task.content).toContain("src/a.ts");
    expect(built.task.content).toContain("Previously skipped");
  });

  test("parse stamps quality as the source", () => {
    const out = finishBranchReviewOp.parse(
      '{"findings":[{"severity":"HIGH","title":"t","problem":"p","fix":"f"}],"covered":[]}',
      input,
      makeCtx(),
    );
    expect(out.findings[0]?.source).toBe("quality");
  });

  test("parse keeps title and summary", () => {
    const out = finishBranchReviewOp.parse(
      '{"findings":[],"covered":[],"title":"feat: x","summary":"s"}',
      input,
      makeCtx(),
    );
    expect(out).toEqual({ findings: [], covered: [], title: "feat: x", summary: "s" });
  });

  test("parse of prose is a missing review, not a throw", () => {
    expect(finishBranchReviewOp.parse("looks fine to me", input, makeCtx())).toEqual({
      findings: [],
      covered: [],
      missing: true,
    });
  });
});

describe("finishBranchReviewOp exhausted retry", () => {
  const strategy = expectRetryStrategy(finishBranchReviewOp.retry);
  const retryCtx = (lastOutput?: string) => ({
    site: "run" as const,
    agentName: "claude",
    stage: "review" as const,
    lastOutput,
  });

  test("retries once on an invalid reply", () => {
    const decision = strategy.shouldRetry(new ParseValidationError("probe"), 0, retryCtx("prose"));
    expect(decision.retry).toBe(true);
  });

  test("exhaustion yields a missing review, never a pass", () => {
    const decision = strategy.shouldRetry(new ParseValidationError("probe"), 1, retryCtx("prose again"));
    if (decision.retry) throw new Error("expected the strategy to stop retrying");
    expect(decision.fallback).toEqual({ findings: [], covered: [], missing: true });
  });

  test("exhaustion on empty output also yields a missing review", () => {
    const decision = strategy.shouldRetry(new ParseValidationError("probe"), 0, retryCtx());
    if (decision.retry) throw new Error("expected the strategy to stop retrying");
    expect(decision.fallback).toEqual({ findings: [], covered: [], missing: true });
  });
});
