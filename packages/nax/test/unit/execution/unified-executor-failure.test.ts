/**
 * Behavioral tests for failure routing in executeUnified.
 *
 * File: unified-executor-failure.test.ts
 * Covers:
 *   exec AC-23  an 'escalate' finalAction reaches handleTierEscalation (source)
 *
 * The behavioral half of exec AC-23 drove `_unifiedExecutorDeps.runParallelBatch`
 * to prove each `batchResult.failed` story reached `handlePipelineFailure`. US-001
 * removed the parallel dispatch path, so that seam is gone; the source guards on
 * the shared failure handler remain.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-23 — source-level: handlePipelineFailure has escalate→handleTierEscalation path
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-23 (source): handlePipelineFailure routes escalate action to handleTierEscalation", () => {
  test("AC-23: pipeline-result-handler.ts has case 'escalate' that calls handleTierEscalation", async () => {
    const source = await Bun.file(join(SRC, "execution/pipeline-result-handler.ts")).text();
    // The escalate switch case must be present
    expect(source).toContain(`case "escalate"`);
    // It must call handleTierEscalation
    expect(source).toContain("handleTierEscalation");
    // handleTierEscalation must be called within the escalate case body
    const escalateCaseIdx = source.indexOf(`case "escalate"`);
    const tierEscalationIdx = source.indexOf("handleTierEscalation", escalateCaseIdx);
    expect(escalateCaseIdx).toBeGreaterThan(0);
    expect(tierEscalationIdx).toBeGreaterThan(escalateCaseIdx);
    // The call is within ~500 chars of the case start (same block). US-002
    // added the runtimeCrashResult derivation inline in the same case body,
    // so the distance grew but the call is still inside the escalate case.
    expect(tierEscalationIdx - escalateCaseIdx).toBeLessThan(500);
  });

  test("AC-23: handleTierEscalation is imported from escalation module in pipeline-result-handler.ts", async () => {
    const source = await Bun.file(join(SRC, "execution/pipeline-result-handler.ts")).text();
    expect(source).toContain("handleTierEscalation");
    // Must be imported from the escalation barrel or submodule
    expect(source).toMatch(/from\s+["']\.\/escalation["']/);
  });
});
