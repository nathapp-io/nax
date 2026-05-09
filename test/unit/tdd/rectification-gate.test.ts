/**
 * Tests for rectification-gate.ts — pass/fail decision logic.
 *
 * Separate from rectification-gate-session.test.ts which covers session reuse.
 * Uses injectable _rectificationGateDeps to avoid mock.module() contamination.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { _rectificationGateDeps, runFullSuiteGate } from "../../../src/tdd/rectification-gate";
import { makeMockAgentManager } from "../../helpers/mock-agent-manager";
import { makeStory } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(): NaxConfig {
  return {
    models: {
      claude: {
        fast: { model: "fast-model" },
        balanced: { model: "balanced-model" },
        powerful: { model: "powerful-model" },
      },
    },
    agent: { default: "claude" },
    execution: {
      rectification: {
        enabled: true,
        maxRetries: 1,
        fullSuiteTimeoutSeconds: 60,
        maxFailureSummaryChars: 1000,
      },
      sessionTimeoutSeconds: 300,
      dangerouslySkipPermissions: true,
    },
    quality: { commands: { test: "bun test" } },
  } as unknown as NaxConfig;
}

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

let origDeps: typeof _rectificationGateDeps;

beforeEach(() => {
  origDeps = { ..._rectificationGateDeps };
  _rectificationGateDeps.resolveTestCommands = mock(async () => ({ testCommand: "bun test" })) as any;
});

afterEach(() => {
  Object.assign(_rectificationGateDeps, origDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate pass/fail decisions
// ─────────────────────────────────────────────────────────────────────────────

describe("runFullSuiteGate — pass/fail decisions", () => {
  // BUG-060 (issue #989): defense-in-depth guard: exitCode != 0 + failures.length > 0
  // must fail the gate even when the failed counter is 0 (parser mis-count).
  test("fails gate when exitCode=1 and failures.length > 0 even if failed counter is 0", async () => {
    const story = makeStory({ id: "US-BUG-060" });
    const config = makeConfig();
    const agentManager = makeMockAgentManager({ getDefaultAgent: "claude" });

    _rectificationGateDeps.executeWithTimeout = mock(async () => ({
      success: false,
      exitCode: 1,
      output: "some output with failures",
    })) as any;

    // Simulate the broken parser state: failures.length > 0 but failed === 0
    _rectificationGateDeps.parseTestOutput = mock(() => ({
      failed: 0,
      passed: 31,
      failures: [{ file: "test/cli/plan.test.ts", testName: "plan > AC-1", error: "Expected true", stackTrace: [] }],
    })) as any;

    const result = await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      SILENT_LOGGER,
    );

    // Gate must NOT pass — we have real failures even though failed===0
    expect(result.fullSuiteGatePassed).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("passes gate when exitCode=1 but failures.length === 0 and failed === 0 (environmental noise)", async () => {
    const story = makeStory({ id: "US-ENV-NOISE" });
    const config = makeConfig();
    const agentManager = makeMockAgentManager({ getDefaultAgent: "claude" });

    _rectificationGateDeps.executeWithTimeout = mock(async () => ({
      success: false,
      exitCode: 1,
      output: "some linter warning output",
    })) as any;

    _rectificationGateDeps.parseTestOutput = mock(() => ({
      failed: 0,
      passed: 31,
      failures: [],
    })) as any;

    const result = await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      SILENT_LOGGER,
    );

    // passed > 0, failures empty, failed === 0: environmental noise → gate passes
    expect(result.fullSuiteGatePassed).toBe(true);
    expect(result.status).toBe("passed-with-nonzero-exit");
  });

  test("passes gate cleanly when exitCode=0", async () => {
    const story = makeStory({ id: "US-CLEAN" });
    const config = makeConfig();
    const agentManager = makeMockAgentManager({ getDefaultAgent: "claude" });

    _rectificationGateDeps.executeWithTimeout = mock(async () => ({
      success: true,
      exitCode: 0,
      output: "",
    })) as any;

    const result = await runFullSuiteGate(
      story,
      config,
      "/tmp/fake-workdir",
      agentManager,
      "balanced",
      true,
      SILENT_LOGGER,
    );

    expect(result.fullSuiteGatePassed).toBe(true);
    expect(result.status).toBe("passed");
  });
});
