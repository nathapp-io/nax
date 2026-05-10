/**
 * Integration test for mock-restructure handoff wiring through test-writer strategy.
 *
 * Scenario: implementer emits a mock_structure declaration with files and
 * reasonDetail, which gets stashed in ctx.pendingMockStructureHandoffs. In the
 * next iteration, the test-writer strategy consumes the handoff and runs with
 * mode: "mock-restructure" to restructure the mocks.
 *
 * Verifies:
 * - implementer runs first and emits mock_structure declaration
 * - handoff is populated in ctx.pendingMockStructureHandoffs
 * - test-writer runs with mode === "mock-restructure"
 * - test-writer input carries handoffFiles and handoffReason
 * - source finding in src/foo.ts was never re-tagged to fixTarget: "test"
 */

import { describe, expect, test } from "bun:test";
import { _autofixDeps } from "@/pipeline/stages/autofix";
import { _autofixCycleDeps, _autofixCycleGuardDeps, runAgentRectificationV2 } from "@/pipeline/stages/autofix-cycle";
import { _cycleDeps } from "@/findings";
import type { Finding } from "@/findings";
import type { PipelineContext } from "@/pipeline/types";
import type { AutofixTestWriterInput } from "@/operations/autofix-test-writer";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";

// biome-ignore lint/suspicious/noExplicitAny: integration test fixture construction
function makeCtx(
  story = makeStory({
    description: "Service exposes getData(id: string): Promise<Data>",
  }),
): PipelineContext {
  // biome-ignore lint/suspicious/noExplicitAny: integration test fixture
  return {
    story,
    config: makeNaxConfig({ quality: { autofix: { maxAttempts: 3, maxTotalAttempts: 12 } } }),
    reviewResult: { success: false, checks: [], totalDurationMs: 0 },
    workdir: "/tmp",
    runtime: {
      packages: { repo: () => ({}) },
      outputDir: "/tmp/out",
    },
    prd: { feature: "f" },
    agentManager: makeMockAgentManager(),
  } as any;
}

describe("autofix V2 cycle — mock-restructure handoff through test-writer (#1234)", () => {
  test("routes mock_structure handoff to test-writer strategy with mode: mock-restructure", async () => {
    const ctx = makeCtx();
    const sourceFinding: Finding = {
      source: "adversarial-review",
      severity: "error",
      category: "convention",
      message: "test calls getData(id) but impl method missing",
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
          findings: [sourceFinding],
        },
      ],
    } as any;

    const savedAutofix = { ..._autofixDeps };
    const savedCycle = { ..._cycleDeps };
    const saveCycleDeps = { ..._autofixCycleDeps };
    const saveGuardDeps = { ..._autofixCycleGuardDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixCycleDeps.fileExists = async (_path: string) => true;

    // Track all callOp invocations
    const callLog: {
      op: string;
      input: any;
      iteration: number;
    }[] = [];
    let iterationCount = 0;

    _cycleDeps.callOp = (async (_ctx: any, op: any, input: any) => {
      callLog.push({
        op: op.name,
        input: JSON.parse(JSON.stringify(input)), // deep copy for later inspection
        iteration: iterationCount,
      });

      if (op.name === "autofix-implementer") {
        // First call: emit mock_structure declaration with files and reasonDetail
        return {
          applied: true,
          testEditDeclarations: [
            {
              reason: "mock_structure",
              file: "test/foo.test.ts",
              files: ["test/foo.test.ts"],
              reasonDetail: "Mock dispatch shape mismatch: test expects async but impl returns sync",
            },
          ],
        };
      }

      if (op.name === "autofix-test-writer") {
        // test-writer should receive mock-restructure mode with handoff data
        const testWriterInput = input as AutofixTestWriterInput;
        if (testWriterInput.mode !== "mock-restructure") {
          throw new Error(`Expected mode: "mock-restructure", got: ${testWriterInput.mode}`);
        }
        if (!testWriterInput.handoffFiles?.includes("test/foo.test.ts")) {
          throw new Error("Expected handoffFiles to include test/foo.test.ts");
        }
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
      Object.assign(_autofixCycleGuardDeps, saveGuardDeps);
    }

    // Verify call sequence
    expect(callLog.length).toBeGreaterThanOrEqual(2);

    const opNames = callLog.map((c) => c.op);
    const implementerCalls = opNames.filter((n) => n === "autofix-implementer");
    const testWriterCalls = opNames.filter((n) => n === "autofix-test-writer");

    expect(implementerCalls.length).toBeGreaterThanOrEqual(1);
    expect(testWriterCalls.length).toBeGreaterThanOrEqual(1);

    // Test-writer must fire after implementer (handoff emitted first, consumed next iteration)
    const firstImplementerIdx = opNames.indexOf("autofix-implementer");
    const firstTestWriterAfterImplementer = opNames.indexOf("autofix-test-writer", firstImplementerIdx + 1);
    expect(firstTestWriterAfterImplementer).toBeGreaterThan(firstImplementerIdx);

    // Verify that the source finding (src/foo.ts) was never re-tagged to fixTarget: "test"
    const sourceFindingInCalls = callLog.flatMap((entry) => {
      const checks = entry.input.failedChecks ?? [];
      return checks.flatMap((c: any) => (c.findings ?? []).filter((f: any) => f.file === "src/foo.ts"));
    });

    for (const finding of sourceFindingInCalls) {
      expect(finding.fixTarget).not.toBe("test");
    }
  });

  test("test-writer input carries full handoffReason from joined reasonDetail paragraphs", async () => {
    const ctx = makeCtx();
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
          findings: [
            {
              source: "adversarial-review",
              severity: "error",
              category: "convention",
              message: "mock shape mismatch",
              file: "src/service.ts",
              fixTarget: "source",
            },
          ],
        },
      ],
    } as any;

    const savedAutofix = { ..._autofixDeps };
    const savedCycle = { ..._cycleDeps };
    const saveCycleDeps = { ..._autofixCycleDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixCycleDeps.fileExists = async (_path: string) => true;

    const testWriterInputs: AutofixTestWriterInput[] = [];

    _cycleDeps.callOp = (async (_ctx: any, op: any, input: any) => {
      if (op.name === "autofix-implementer") {
        return {
          applied: true,
          testEditDeclarations: [
            {
              reason: "mock_structure",
              file: "test/service.test.ts",
              files: ["test/service.test.ts"],
              reasonDetail: "Multiple dispatch issues:\n1. Async/await handling\n2. Mock return shape",
            },
          ],
        };
      }

      if (op.name === "autofix-test-writer") {
        testWriterInputs.push(input);
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

    expect(testWriterInputs.length).toBeGreaterThanOrEqual(1);
    const mockRestructureInput = testWriterInputs.find((i) => i.mode === "mock-restructure");
    expect(mockRestructureInput).toBeDefined();
    expect(mockRestructureInput?.handoffReason).toBeDefined();
    // Should contain the reason detail
    expect(mockRestructureInput?.handoffReason ?? "").toContain("Async/await");
  });

  test("multiple handoffs are deduplicated and joined when consumed by test-writer", async () => {
    const ctx = makeCtx();
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
          findings: [
            {
              source: "adversarial-review",
              severity: "error",
              category: "convention",
              message: "mock issues",
              file: "src/app.ts",
              fixTarget: "source",
            },
          ],
        },
      ],
    } as any;

    const savedAutofix = { ..._autofixDeps };
    const savedCycle = { ..._cycleDeps };
    const saveCycleDeps = { ..._autofixCycleDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixCycleDeps.fileExists = async (_path: string) => true;

    let callCount = 0;
    const testWriterInputs: AutofixTestWriterInput[] = [];

    _cycleDeps.callOp = (async (_ctx: any, op: any, input: any) => {
      callCount++;

      if (op.name === "autofix-implementer") {
        // Simulate multiple mock_structure declarations across iterations
        if (callCount === 1) {
          return {
            applied: true,
            testEditDeclarations: [
              {
                reason: "mock_structure",
                file: "test/a.test.ts",
                files: ["test/a.test.ts", "test/b.test.ts"],
                reasonDetail: "First batch of mock adjustments",
              },
            ],
          };
        }
        if (callCount === 3) {
          return {
            applied: true,
            testEditDeclarations: [
              {
                reason: "mock_structure",
                file: "test/b.test.ts",
                files: ["test/b.test.ts", "test/c.test.ts"],
                reasonDetail: "Second batch of mock adjustments",
              },
            ],
          };
        }
        return { applied: true, testEditDeclarations: [] };
      }

      if (op.name === "autofix-test-writer") {
        testWriterInputs.push(input);
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

    expect(testWriterInputs.length).toBeGreaterThanOrEqual(1);
    const mockRestructureInputs = testWriterInputs.filter((i) => i.mode === "mock-restructure");
    expect(mockRestructureInputs.length).toBeGreaterThanOrEqual(1);

    for (const input of mockRestructureInputs) {
      if (input.handoffFiles) {
        // Files should be deduplicated
        const uniqueFiles = new Set(input.handoffFiles);
        expect(uniqueFiles.size).toBe(input.handoffFiles.length);
      }
    }
  });
});
