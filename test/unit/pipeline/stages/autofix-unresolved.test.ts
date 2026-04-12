/**
 * Unit tests for autofixStage — UNRESOLVED suppression for mechanical-only failures.
 *
 * Covers nathapp-io/nax#405: when only mechanical checks (lint/typecheck) failed but
 * LLM checks (semantic/adversarial) passed, the agent cannot fix unfixable errors in
 * files it is not allowed to modify (e.g. lint in test files). In this case the
 * UNRESOLVED signal from the agent should NOT trigger tier escalation.
 */

import { describe, expect, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";

function makeFailedReviewResult(checks: Partial<ReviewCheckResult>[]) {
  const fullChecks = checks.map((c) => ({
    check: c.check ?? "lint",
    success: false,
    command: c.command ?? "biome check",
    exitCode: c.exitCode ?? 1,
    output: c.output ?? "error output",
    durationMs: c.durationMs ?? 100,
  }));
  return { success: false, checks: fullChecks } as any;
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
    hooks: {} as any,
    ...overrides,
  };
}

describe("autofixStage — UNRESOLVED suppression for mechanical-only failures (#405)", () => {
  test("returns continue (not escalate) when UNRESOLVED and mechanicalFailedOnly=true", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({
      succeeded: false,
      cost: 0,
      unresolvedReason: "lint error in test file cannot be fixed without modifying test files",
    });

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint", output: "no-non-null-assertion in spec.ts" }]),
      mechanicalFailedOnly: true,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("continue");
  });

  test("marks reviewResult.success=true when suppressing UNRESOLVED for mechanical-only", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({
      succeeded: false,
      cost: 0,
      unresolvedReason: "cannot fix lint in test file",
    });

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }]),
      mechanicalFailedOnly: true,
    });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(ctx.reviewResult?.success).toBe(true);
  });

  test("still escalates when UNRESOLVED and mechanicalFailedOnly=false", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({
      succeeded: false,
      cost: 0,
      unresolvedReason: "semantic findings contradict each other",
    });

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      mechanicalFailedOnly: false,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("still escalates when UNRESOLVED and mechanicalFailedOnly is undefined", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({
      succeeded: false,
      cost: 0,
      unresolvedReason: "conflicting instructions",
    });

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }]),
      // mechanicalFailedOnly not set
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("recheckReview passing with mechanicalFailedOnly=true takes normal retry path", async () => {
    // When recheckReview passes first, the suppression path is never reached —
    // the stage should return retry, not trigger the mechanicalFailedOnly guard.
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({
      commandName: "lintFix",
      command: "",
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 0,
      timedOut: false,
    });
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }]),
      mechanicalFailedOnly: true,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
  });
});
