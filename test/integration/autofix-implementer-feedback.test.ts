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
import { _autofixDeps } from "@/pipeline/stages/autofix";
import { _autofixCycleDeps, runAgentRectificationV2 } from "@/pipeline/stages/autofix-cycle";
import { _cycleDeps } from "@/findings/cycle";
import type { Finding } from "@/findings";
import type { PipelineContext } from "@/pipeline/types";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";

function makeCtx(
  story = makeStory({
    description: "Service exposes getX(id: string, sha: string): Promise<Report>",
  }),
): PipelineContext {
  // biome-ignore lint/suspicious/noExplicitAny: integration test fixture
  return {
    story,
    config: makeNaxConfig({ quality: { autofix: { maxAttempts: 3, maxTotalAttempts: 12 } } }),
    reviewResult: { success: false, checks: [] },
    workdir: "/tmp",
    runtime: {
      packages: { repo: () => ({}) },
      outputDir: "/tmp/out",
    },
    prd: { feature: "f" },
    agentManager: makeMockAgentManager(),
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
    expect(opNames.filter((n) => n === "autofix-implementer").length).toBeGreaterThanOrEqual(1);
    expect(opNames.filter((n) => n === "autofix-test-writer").length).toBeGreaterThanOrEqual(1);

    // test-writer must fire AFTER the implementer (declaration emitted by implementer, consumed next iteration)
    const firstImplementerIdx = opNames.indexOf("autofix-implementer");
    const firstTestWriterAfterDeclaration = opNames.indexOf("autofix-test-writer", firstImplementerIdx + 1);
    expect(firstTestWriterAfterDeclaration).toBeGreaterThan(firstImplementerIdx);

    // Side-channel must be cleared after consumption.
    expect(ctx.testEditDeclarations).toEqual([]);
  });

  test("invalid PRD_QUOTE does not re-tag findings; emits prd_quote_mismatch advisory", async () => {
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

    // Track the findings passed to each strategy call so we can assert routing.
    const callLog: { op: string; findings: Finding[] }[] = [];

    let recheckCount = 0;
    _autofixDeps.recheckReview = async (c: any) => {
      recheckCount++;
      if (recheckCount === 1) {
        // After implementer runs: keep the same adversarial finding (unchanged)
        c.reviewResult = {
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
        };
        return false;
      }
      c.reviewResult = { success: true, checks: [] };
      return true;
    };

    _cycleDeps.callOp = (async (_c: any, op: any, input: any) => {
      const findings = (input?.failedChecks ?? []).flatMap((ch: any) => ch.findings ?? []);
      callLog.push({ op: op.name, findings });
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

    // The original adversarial finding must never be re-tagged to fixTarget=test
    // (fabricated PRD_QUOTE blocks the re-tag path).
    const allFindings = callLog.flatMap((e) => e.findings);
    const reTagged = allFindings.filter((f) => f.file === "test/y.spec.ts" && f.fixTarget === "test");
    expect(reTagged).toHaveLength(0);

    // A prd_quote_mismatch advisory is emitted and passed into the next iteration's strategies.
    // It must NOT activate the implementer (implementer.appliesTo excludes prd_quote_mismatch).
    const advisorySeenByImplementer = callLog
      .filter((e) => e.op === "autofix-implementer")
      .flatMap((e) => e.findings)
      .filter((f) => f.category === "prd_quote_mismatch");
    expect(advisorySeenByImplementer).toHaveLength(0);
  });

  test("implementer mock_structure handoff flows through to test-writer with mode mock-restructure", async () => {
    const ctx = makeCtx(
      makeStory({
        description: "Service exposes foo(x: number): void",
      }),
    );
    const initialFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "test behavior mismatch",
      file: "src/foo.ts",
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
    const saveCycleDeps = { ..._autofixCycleDeps };

    // Capture implementer and test-writer calls for assertions
    // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
    const callLog: { op: string; input: any }[] = [];
    let implementerCallCount = 0;

    _autofixDeps.recheckReview = async () => false;
    _autofixCycleDeps.fileExists = async (_path: string) => true;

    _cycleDeps.callOp = (async (_ctx: any, op: any, input: any) => {
      callLog.push({ op: op.name, input });

      if (op.name === "autofix-implementer") {
        implementerCallCount++;
        // On first call, return mock_structure declaration
        if (implementerCallCount === 1) {
          return {
            applied: true,
            testEditDeclarations: [
              {
                reason: "mock_structure",
                file: "test/foo.test.ts",
                files: ["test/foo.test.ts"],
                reasonDetail: "Mock dispatch shape must align with service interface",
              },
            ],
          };
        }
        // On subsequent calls, return applied: true without declaration
        return {
          applied: true,
          testEditDeclarations: [],
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
      Object.assign(_autofixCycleDeps, saveCycleDeps);
    }

    // Assert that implementer was called at least once
    const implementerCalls = callLog.filter((e) => e.op === "autofix-implementer");
    expect(implementerCalls.length).toBeGreaterThanOrEqual(1);

    // Assert that test-writer was called at least once
    const testWriterCalls = callLog.filter((e) => e.op === "autofix-test-writer");
    expect(testWriterCalls.length).toBeGreaterThanOrEqual(1);

    // The test-writer call must carry mode === "mock-restructure"
    const mockRestructureCalls = testWriterCalls.filter((e) => e.input.mode === "mock-restructure");
    expect(mockRestructureCalls.length).toBeGreaterThanOrEqual(1);

    // The test-writer input must have handoffFiles set to files from the mock_structure
    const callWithHandoff = mockRestructureCalls[0];
    expect(callWithHandoff.input.handoffFiles).toEqual(["test/foo.test.ts"]);
    expect(callWithHandoff.input.handoffReason).toBe(
      "Mock dispatch shape must align with service interface",
    );

    // The source finding in src/foo.ts must never be re-tagged to fixTarget: "test" in any callOp input
    const allInputs = callLog.map((e) => e.input);
    for (const inp of allInputs) {
      const failedChecks = inp.failedChecks ?? [];
      const findings = failedChecks.flatMap((c: any) => c.findings ?? []);
      const reTaggedSource = findings.filter(
        (f: any) => f.file === "src/foo.ts" && f.fixTarget === "test",
      );
      expect(reTaggedSource).toHaveLength(0);
    }

    // Side-channel must be cleared (set to empty array)
    expect(ctx.pendingMockStructureHandoffs).toEqual([]);
  });
});
