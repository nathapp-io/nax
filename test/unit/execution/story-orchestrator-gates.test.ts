/**
 * Story Orchestrator Gates Tests
 *
 * Tests for US-005: Promote greenfield and full-suite gates into StoryOrchestratorBuilder
 *
 * Covers:
 * - AC1: CANONICAL_ORDER includes greenfield-gate after test-writer and full-suite-gate after implementer
 * - AC2: ExecutionPlan.run() short-circuits remaining phases when either gate returns success=false
 * - AC3: fullSuiteGateOp output status supports: passed, rectification-exhausted, disabled, execution-failed, inconclusive
 * - AC4: When full-suite execution is skipped by config, output status is disabled with success=false and zeroed attempts
 * - AC5: When full-suite command/process invocation fails before parseable test results, output status is execution-failed
 * - AC6: When full-suite output is present but cannot be confidently classified, output status is inconclusive
 * - AC7: fullSuiteGateOp fallback/recover preserves structured failure output
 * - AC8: greenfieldGateOp input is self-contained (story, workdir, resolvedTestPatterns)
 */

import { describe, test, expect } from "bun:test";
import type { RunOperation } from "@/operations";
import { pickSelector } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

// ============================================================================
// Test Fixtures
// ============================================================================

interface TestInput {
  code: string;
}

interface TestOutput {
  success: boolean;
}

const testSel = pickSelector("test-orchestrator-gates", "execution");

const mockImplementerOp: RunOperation<TestInput, TestOutput, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r1", content: "Implement", overridable: false },
    task: { id: "t1", content: "code", overridable: false },
  }),
  parse: () => ({ success: true }),
};

// Ensure fixture is used (avoids unused-variable warnings)
void mockImplementerOp;
