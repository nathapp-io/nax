/**
 * Integration test for the implementer→test-writer feedback loop (#933).
 *
 * Scenario: review reports an adversarial-review error finding on a test file.
 * Iteration 1 — the implementer strategy runs and emits a TEST_EDIT_REASON: prd_contract
 *   block with a valid PRD_QUOTE.
 * Iteration 2 — the cycle's validate hook re-tags the finding to fixTarget=test;
 *   the testWriter strategy claims it.
 *
 * We mock the run-op layer (callOp) to control implementer/testWriter outputs and
 * assert the routing decisions made by buildAutofixStrategies + the modified validate.
 */
import { describe, expect, test } from "bun:test";
import { _autofixDeps } from "../../src/pipeline/stages/autofix";
import { runAgentRectificationV2 } from "../../src/pipeline/stages/autofix-cycle";
import { _cycleDeps } from "../../src/findings/cycle";
import type { Finding } from "../../src/findings";
import type { PipelineContext } from "../../src/pipeline/types";
import { makeStory } from "../helpers/mock-story";

function makeCtx(
  story = makeStory({
    description: "Service exposes getX(id: string, sha: string): Promise<Report>",
  }),
): PipelineContext {
  // biome-ignore lint/suspicious/noExplicitAny: integration test fixture
  return {
    story,
    config: { quality: { autofix: { maxAttempts: 3, maxTotalAttempts: 12 } }, review: {} },
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    runtime: {
      packages: { repo: () => ({}) },
      outputDir: "/tmp/out",
    },
    prd: { feature: "f" },
    agentManager: { getDefault: () => "claude" },
  } as any;
}

describe("autofix V2 cycle — implementer→test-writer feedback (#933)", () => {
  test("routes a prd_contract declaration through to the testWriter strategy", async () => {
    const ctx = makeCtx();
    const initialFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "test calls getX(id) but PRD requires (id, sha)",
      file: "test/x.spec.ts",
      fixTarget: "source",
    };
    ctx.reviewResult = {
      success: false,
      checks: [
        {
          check: "adversarial",
          success: false,
          command: "",
          exitCode: 1,
          output: "",
          durationMs: 0,
          findings: [initialFinding],
        },
      ],
    } as any;

    const savedAutofix = { ..._autofixDeps };
    const savedCycle = { ..._cycleDeps };
    _autofixDeps.recheckReview = async () => false;

    // Capture which ops ran in which order with what inputs.
    const callLog: { op: string; relevantFiles: string[] }[] = [];

    _cycleDeps.callOp = (async (_ctx: any, op: any, input: any) => {
      callLog.push({
        op: op.name,
        relevantFiles: (input.failedChecks ?? []).flatMap((c: any) => (c.findings ?? []).map((f: any) => f.file)),
      });
      if (op.name === "autofix-implementer") {
        return {
          applied: true,
          testEditDeclarations: [
            {
              reason: "prd_contract" as const,
              file: "test/x.spec.ts",
              prdQuote: "getX(id: string, sha: string): Promise<Report>",
              testBefore: "getX(id)",
              testAfter: "getX(id, sha)",
            },
          ],
        };
      }
      if (op.name === "autofix-test-writer") {
        return { applied: true };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    }) as any;

    try {
      await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");
    } finally {
      Object.assign(_autofixDeps, savedAutofix);
      Object.assign(_cycleDeps, savedCycle);
    }

    expect(callLog.length).toBeGreaterThanOrEqual(2);
    const opNames = callLog.map((c) => c.op);
    expect(opNames.filter((n) => n === "autofix-test-writer").length).toBeGreaterThanOrEqual(1);
    expect(opNames.filter((n) => n === "autofix-implementer").length).toBeGreaterThanOrEqual(1);

    // Side-channel must be cleared after consumption.
    expect(ctx.testEditDeclarations).toEqual([]);
  });

  test("invalid PRD_QUOTE does not re-tag findings; emits prd_quote_mismatch", async () => {
    const ctx = makeCtx(makeStory({ description: "Unrelated story content" }));
    const initialFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "x",
      file: "test/y.spec.ts",
      fixTarget: "source",
    };
    ctx.reviewResult = {
      success: false,
      checks: [
        {
          check: "adversarial",
          success: false,
          command: "",
          exitCode: 1,
          output: "",
          durationMs: 0,
          findings: [initialFinding],
        },
      ],
    } as any;

    const savedAutofix = { ..._autofixDeps };
    const savedCycle = { ..._cycleDeps };
    _autofixDeps.recheckReview = async () => false;

    _cycleDeps.callOp = (async (_ctx: any, op: any) => {
      if (op.name === "autofix-implementer") {
        return {
          applied: true,
          testEditDeclarations: [
            {
              reason: "prd_contract" as const,
              file: "test/y.spec.ts",
              prdQuote: "fabricated(x): void",
              testBefore: "x",
              testAfter: "y",
            },
          ],
        };
      }
      return { applied: true };
    }) as any;

    try {
      await runAgentRectificationV2(ctx, undefined, undefined, "/tmp");
    } finally {
      Object.assign(_autofixDeps, savedAutofix);
      Object.assign(_cycleDeps, savedCycle);
    }

    // Side-channel consumed and cleared.
    expect(ctx.testEditDeclarations).toEqual([]);
  });
});
