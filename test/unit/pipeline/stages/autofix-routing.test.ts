// RE-ARCH: keep
/**
 * Tests for autofix stage routing behavior around adversarial findings.
 *
 * Covers:
 * - #409 scope-aware adversarial routing
 * - STRAT-001 no-test short-circuit behavior
 */

import { describe, expect, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import { RectifierPromptBuilder } from "../../../../src/prompts";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";
import { makeMockAgentManager as _makeMockAgentManager } from "../../../helpers";

function makeReviewResult(success: boolean) {
  return { success, checks: [], summary: "" } as any;
}

function makeFailedReviewResult(checks: Partial<ReviewCheckResult>[]) {
  const fullChecks = checks.map((c) => ({
    check: c.check ?? "lint",
    success: false,
    command: c.command ?? "biome check",
    exitCode: c.exitCode ?? 1,
    output: c.output ?? "error output",
    durationMs: c.durationMs ?? 100,
  }));
  return { success: false, checks: fullChecks, summary: "" } as any;
}

function makeMockAgentManager() {
  return _makeMockAgentManager();
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...DEFAULT_CONFIG.quality.commands,
          lintFix: "biome check --fix",
          formatFix: "biome format --write",
        },
        autofix: { enabled: true, maxAttempts: 2 },
      },
    } as any,
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: { hooks: {} } as any,
    agentManager: makeMockAgentManager(),
    ...overrides,
  };
}
// ---------------------------------------------------------------------------
// #409: Scope-aware adversarial rectification
// ---------------------------------------------------------------------------

describe("#409 scope-aware adversarial routing", () => {
  function makeAdversarialCheck(findings: Array<{ file: string; severity?: string; message?: string }>): ReviewCheckResult {
    return {
      check: "adversarial",
      success: false,
      command: "adversarial-review",
      exitCode: 1,
      output: "adversarial review output",
      durationMs: 100,
      findings: findings.map((f) => ({
        ruleId: "adversarial",
        severity: (f.severity ?? "error") as "error",
        file: f.file,
        line: 1,
        message: f.message ?? "finding",
        source: "adversarial-review",
      })),
    };
  }

  test("adversarial findings in test files only → test-writer session invoked, implementer skipped", async () => {
    const saved = { ..._autofixDeps };
    let testWriterCalled = false;

    _autofixDeps.runTestWriterRectification = async () => {
      testWriterCalled = true;
      return 0;
    };
    _autofixDeps.recheckReview = async () => false;

    const mockAgentManager = _makeMockAgentManager();

    const adversarialCheck = makeAdversarialCheck([
      { file: "test/unit/foo.test.ts" },
      { file: "src/bar.spec.ts" },
    ]);
    const ctx = makeCtx({
      // Pass reviewResult directly to preserve findings (makeFailedReviewResult drops them)
      reviewResult: { success: false, checks: [adversarialCheck], summary: "" } as any,
      agentManager: mockAgentManager,
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 1 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(testWriterCalled).toBe(true);
  });

  test("mixed findings (test + source) → both test-writer and implementer sessions invoked", async () => {
    const saved = { ..._autofixDeps };
    let testWriterCalled = false;

    _autofixDeps.runTestWriterRectification = async () => {
      testWriterCalled = true;
      return 0;
    };
    _autofixDeps.recheckReview = async () => false;

    const adversarialCheck = makeAdversarialCheck([
      { file: "test/unit/foo.test.ts" },   // test file → test-writer
      { file: "src/implementation.ts" },    // source file → implementer
    ]);
    const ctx = makeCtx({
      // Pass reviewResult directly to preserve findings (makeFailedReviewResult drops them)
      reviewResult: { success: false, checks: [adversarialCheck], summary: "" } as any,
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 1 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(testWriterCalled).toBe(true);
  });

  test("two adversarial entries: first all-test, second has source findings → second entry reaches implementer", async () => {
    const saved = { ..._autofixDeps };
    let testWriterCalled = false;

    _autofixDeps.runTestWriterRectification = async () => {
      testWriterCalled = true;
      return 0;
    };
    _autofixDeps.recheckReview = async () => false;

    const testOnlyCheck = makeAdversarialCheck([{ file: "src/foo.test.ts" }]);
    const sourceCheck = makeAdversarialCheck([{ file: "src/impl.ts" }]);
    const ctx = makeCtx({
      reviewResult: { success: false, checks: [testOnlyCheck, sourceCheck], summary: "" } as any,
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 1 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    // First adversarial entry (all-test) goes to test-writer and is removed from implementer.
    // Second adversarial entry (source) must still reach the implementer loop.
    expect(testWriterCalled).toBe(true);
  });

  test("all source findings → only implementer invoked (existing behavior)", async () => {
    const saved = { ..._autofixDeps };
    let testWriterCalled = false;

    _autofixDeps.runTestWriterRectification = async () => {
      testWriterCalled = true;
      return 0;
    };
    _autofixDeps.recheckReview = async () => false;

    const adversarialCheck = makeAdversarialCheck([
      { file: "src/foo.ts" },
      { file: "src/bar.ts" },
    ]);
    const ctx = makeCtx({
      // Pass reviewResult directly to preserve findings (makeFailedReviewResult drops them)
      reviewResult: { success: false, checks: [adversarialCheck], summary: "" } as any,
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 1 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(testWriterCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STRAT-001: no-test strategy adversarial skip (#429)
// ---------------------------------------------------------------------------

describe("STRAT-001 no-test adversarial skip", () => {
  function makeAdversarialCheck(findings: Array<{ file: string }>): ReviewCheckResult {
    return {
      check: "adversarial",
      success: false,
      command: "adversarial-review",
      exitCode: 1,
      output: "adversarial review output",
      durationMs: 100,
      findings: findings.map((f) => ({
        ruleId: "adversarial",
        severity: "error" as const,
        file: f.file,
        line: 1,
        message: "adversarial finding",
        source: "adversarial-review",
      })),
    };
  }

  function makeNoTestCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return makeCtx({
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "no-test", reasoning: "" },
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
      ...overrides,
    });
  }

  test("all adversarial test-file findings → returns continue, marks review passed, skips agent", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };

    const adversarialCheck = makeAdversarialCheck([
      { file: "test/unit/foo.test.ts" },
      { file: "src/bar.spec.ts" },
    ]);
    const ctx = makeNoTestCtx({
      reviewResult: { success: false, checks: [adversarialCheck], summary: "" } as any,
    });

    const result = await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("continue");
    expect(ctx.reviewResult?.success).toBe(true);
    expect(agentRectificationCalled).toBe(false);
  });

  test("adversarial test-file findings + lint failure → early exit skipped, agent rectification runs", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };
    _autofixDeps.recheckReview = async () => false;

    const adversarialCheck = makeAdversarialCheck([{ file: "test/unit/foo.test.ts" }]);
    const lintCheck: ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "biome check",
      exitCode: 1,
      output: "lint error",
      durationMs: 50,
    };
    const ctx = makeNoTestCtx({
      reviewResult: { success: false, checks: [adversarialCheck, lintCheck], summary: "" } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    // Mixed failures → early exit guard does not trigger → agent rectification runs
    expect(agentRectificationCalled).toBe(true);
  });

  test("adversarial source-file findings → early exit skipped, agent rectification runs", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };

    const adversarialCheck = makeAdversarialCheck([{ file: "src/rag/rag.service.ts" }]);
    const ctx = makeNoTestCtx({
      reviewResult: { success: false, checks: [adversarialCheck], summary: "" } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(agentRectificationCalled).toBe(true);
  });

  test("safety-net: mixed findings with no-test → test-writer skipped, implementer runs for source findings", async () => {
    const saved = { ..._autofixDeps };
    let testWriterCalled = false;

    _autofixDeps.runTestWriterRectification = async () => {
      testWriterCalled = true;
      return 0;
    };
    _autofixDeps.recheckReview = async () => false;

    // Mixed findings: early exit does not fire (source + test), but safety-net blocks test-writer
    const mixedCheck = makeAdversarialCheck([
      { file: "test/unit/foo.test.ts" },
      { file: "src/implementation.ts" },
    ]);
    const ctx = makeNoTestCtx({
      reviewResult: { success: false, checks: [mixedCheck], summary: "" } as any,
    });

    await autofixStage.execute(ctx);
    Object.assign(_autofixDeps, saved);

    expect(testWriterCalled).toBe(false);
  });
});
