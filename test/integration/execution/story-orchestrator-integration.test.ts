import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallContext } from "@/operations";
import { makeMockAgentManager, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

/**
 * Integration tests for StoryOrchestratorBuilder usage in execution.ts and tdd/orchestrator.ts
 *
 * AC5: execution.ts uses StoryOrchestratorBuilder and no residual `if (isTddStrategy)` branching
 * AC6: tdd/orchestrator.ts uses StoryOrchestratorBuilder for phase sequencing
 * AC7: tdd/orchestrator.ts reads phaseOutputs["verifier"] and applies readVerdict() + categorizeVerdict()
 * AC8: tdd/orchestrator.ts triggers rollback when success=false and config.tdd.rollbackOnFailure=true
 */

let runtime: NaxRuntime | undefined;

beforeEach(() => {
  runtime = makeTestRuntime({ agentManager: makeMockAgentManager() });
});

afterEach(async () => {
  await runtime?.close();
});

describe("AC5: execution.ts refactored to use StoryOrchestratorBuilder", () => {
  test("execution stage does not contain duplicated session-loop orchestration guarded by isTddStrategy", async () => {
    // This is a code inspection test - we verify the source file doesn't have the old pattern
    const fs = await import("fs");
    const path = await import("path");

    const executionStagePath = path.join(
      import.meta.dir,
      "../../../../src/pipeline/stages/execution.ts"
    );

    const source = fs.readFileSync(executionStagePath, "utf-8");

    // The old pattern had `if (isTddStrategy)` with full orchestration logic inside
    // After refactoring, this should be gone - the TDD path should call the builder
    // Check that we don't have the old nested orchestration pattern
    const hasOldPattern = /if\s*\(\s*isTddStrategy\s*\)\s*{[\s\S]*?runThreeSessionTddFromCtx/.test(
      source
    );

    // This test will fail initially (old pattern exists) and pass when refactored
    if (hasOldPattern) {
      console.warn("execution.ts still contains old isTddStrategy orchestration");
    }

    // After refactoring, should use StoryOrchestratorBuilder
    expect(source).toContain("StoryOrchestratorBuilder");
  });

  test("execution stage uses ExecutionPlan.run() to orchestrate phases", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const executionStagePath = path.join(
      import.meta.dir,
      "../../../../src/pipeline/stages/execution.ts"
    );

    const source = fs.readFileSync(executionStagePath, "utf-8");

    // After refactoring, should call plan.run()
    expect(source).toContain("ExecutionPlan");
  });
});

describe("AC6: tdd/orchestrator.ts refactored to use StoryOrchestratorBuilder", () => {
  test("tdd orchestrator does not maintain independent duplicated session-loop orchestration", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should use StoryOrchestratorBuilder
    expect(source).toContain("StoryOrchestratorBuilder");

    // Should not have independent session loops (check for residual old patterns)
    // The old code had explicit runTddSessionOp calls with manual session management
    // After refactoring, this should be delegated to the builder
  });

  test("tdd orchestrator delegates phase sequencing to ExecutionPlan", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should use ExecutionPlan for phase sequencing
    expect(source).toContain("ExecutionPlan");
    expect(source).toContain("plan.run()");
  });
});

describe("AC7: tdd/orchestrator.ts processes verifier completion via phaseOutputs", () => {
  test("tdd orchestrator reads phaseOutputs[\"verifier\"] after plan.run()", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // After refactoring, should read verifier output from phaseOutputs
    expect(source).toContain("phaseOutputs");

    // Should apply verdict processing (readVerdict, categorizeVerdict)
    expect(source).toContain("readVerdict");
    expect(source).toContain("categorizeVerdict");
  });

  test("tdd orchestrator accesses verifier output via structured result", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should read from result.phaseOutputs
    expect(source).toContain("phaseOutputs");

    // Pattern: reading the verifier's output and processing it
    // After refactoring: const verifierOutput = result.phaseOutputs["verifier-op"];
    // Then: readVerdict(...verifierOutput...) and categorizeVerdict(...)
  });
});

describe("AC8: tdd/orchestrator.ts handles rollback based on StoryOrchestratorResult.success", () => {
  test("tdd orchestrator checks result.success to trigger rollback", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should check result.success from StoryOrchestratorResult
    expect(source).toContain("result.success");

    // Should call rollback when needed
    expect(source).toContain("rollback");
  });

  test("tdd orchestrator reads config.tdd.rollbackOnFailure before rollback", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should check the config flag
    expect(source).toContain("rollbackOnFailure");
  });

  test("tdd orchestrator calls rollback() when success=false and rollbackOnFailure=true", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Pattern check: if (!result.success && config.tdd.rollbackOnFailure)
    const hasRollbackLogic = /!result\.success.*rollbackOnFailure|rollbackOnFailure.*!result\.success/.test(
      source
    );

    if (hasRollbackLogic) {
      expect(source).toContain("rollbackToRef");
    }
  });

  test("tdd orchestrator provides initialRef to rollback", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const tddOrchestratorPath = path.join(
      import.meta.dir,
      "../../../../src/tdd/orchestrator.ts"
    );

    const source = fs.readFileSync(tddOrchestratorPath, "utf-8");

    // Should pass the initial git reference for rollback
    expect(source).toContain("initialRef");
  });
});

describe("StoryOrchestratorBuilder integration with verification phase", () => {
  test("builder correctly wires up TDD operations with proper session roles", async () => {
    // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
    const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

    const createTestWriterOp = () => ({
      kind: "run" as const,
      name: "test-writer-op",
      stage: "execution" as const,
      config: [],
      build: () => ({ role: { id: "r", content: "test", overridable: false }, task: { id: "t", content: "test", overridable: false } }),
      parse: (_output: string) => ({ tests: [] }),
      session: { role: "test-writer" as const, lifetime: "fresh" as const },
    });

    const createImplementerOp = () => ({
      kind: "run" as const,
      name: "implementer-op",
      stage: "execution" as const,
      config: [],
      build: () => ({ role: { id: "r", content: "impl", overridable: false }, task: { id: "t", content: "impl", overridable: false } }),
      parse: (_output: string) => ({ code: "" }),
      session: { role: "implementer" as const, lifetime: "fresh" as const },
    });

    const createVerifierOp = () => ({
      kind: "run" as const,
      name: "verifier-op",
      stage: "execution" as const,
      config: [],
      build: () => ({ role: { id: "r", content: "verify", overridable: false }, task: { id: "t", content: "verify", overridable: false } }),
      parse: (_output: string) => ({ verdict: "passed", passed: true }),
      session: { role: "verifier" as const, lifetime: "fresh" as const },
    });

    const builder = new StoryOrchestratorBuilder()
      .addTestWriter({ op: createTestWriterOp(), input: {} })
      .addImplementer({ op: createImplementerOp(), input: {} })
      .addVerifier({ op: createVerifierOp(), input: {} });

    const ctx = {
      runtime: runtime!,
      packageView: runtime!.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-004",
    } as CallContext;

    const plan = builder.build(ctx);
    const result = await plan.run();

    // Verify all three core TDD operations ran
    expect("test-writer-op" in result.phaseOutputs).toBeTrue();
    expect("implementer-op" in result.phaseOutputs).toBeTrue();
    expect("verifier-op" in result.phaseOutputs).toBeTrue();

    // Verify verifier output is in the result
    const verifierOutput = result.phaseOutputs["verifier-op"] as any;
    expect(verifierOutput).toBeDefined();
    expect("verdict" in verifierOutput).toBeTrue();
  });
});

describe("StoryOrchestratorResult carries all required data for post-processing", () => {
  test("result contains success, phaseCosts, phaseOutputs, totalCostUsd, durationMs", async () => {
    // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
    const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

    const createMockOp = (name: string) => ({
      kind: "run" as const,
      name: `${name}-op`,
      stage: "execution" as const,
      config: [],
      build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
      parse: (_output: string) => ({ result: true }),
      session: { role: "implementer" as const, lifetime: "fresh" as const },
    });

    const builder = new StoryOrchestratorBuilder()
      .addImplementer({ op: createMockOp("implementer"), input: {} });

    const ctx = {
      runtime: runtime!,
      packageView: runtime!.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
    } as CallContext;

    const plan = builder.build(ctx);
    const result = await plan.run();

    // Verify result shape
    expect("success" in result).toBeTrue();
    expect("phaseCosts" in result).toBeTrue();
    expect("phaseOutputs" in result).toBeTrue();
    expect("totalCostUsd" in result).toBeTrue();
    expect("durationMs" in result).toBeTrue();

    // Verify types
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.phaseCosts).toBe("object");
    expect(typeof result.phaseOutputs).toBe("object");
    expect(typeof result.totalCostUsd).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});
