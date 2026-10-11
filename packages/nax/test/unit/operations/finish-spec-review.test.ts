import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime, opSelector } from "@test/helpers";
import type { RetryStrategy } from "@/agents/retry";
import { ParseValidationError } from "@/agents/retry";
import { finishSpecReviewOp } from "@/operations";
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
  return { packageView: view, config: view.select(opSelector(finishSpecReviewOp.config)) };
}

const input = {
  base: "origin/main",
  specPath: ".nax/features/f/spec.md",
  prdPath: ".nax/features/f/prd.json",
  changedFiles: ["src/a.ts"],
};

describe("finishSpecReviewOp", () => {
  test("is a read-only review op on the finish-review-spec role", () => {
    expect(finishSpecReviewOp.name).toBe("finish-spec-review");
    expect(finishSpecReviewOp.session.role).toBe("finish-review-spec");
    expect(finishSpecReviewOp.session.lifetime).toBe("fresh");
    expect(finishSpecReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
  });

  test("build carries the spec, PRD and changed files", () => {
    const built = finishSpecReviewOp.build(input, makeCtx());
    expect(built.task.content).toContain(".nax/features/f/prd.json");
    expect(built.task.content).toContain(".nax/features/f/spec.md");
    expect(built.task.content).toContain("src/a.ts");
  });

  test("parse stamps spec as the source", () => {
    const out = finishSpecReviewOp.parse(
      '{"findings":[{"severity":"HIGH","title":"t","problem":"p","fix":"f"}],"covered":[]}',
      input,
      makeCtx(),
    );
    expect(out.findings[0]?.source).toBe("spec");
  });

  test("parse of prose is a missing review, not a throw", () => {
    expect(finishSpecReviewOp.parse("looks fine to me", input, makeCtx())).toEqual({
      findings: [],
      covered: [],
      missing: true,
    });
  });
});

describe("finishSpecReviewOp exhausted retry", () => {
  const strategy = finishSpecReviewOp.retry as RetryStrategy;
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
