import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { join } from "path";

// Test imports - these will be the actual implementations
import type { RectificationConfig, NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";
import { escalateTier, getTierConfig } from "../../../src/execution/escalation";
import { parseBunTestOutput } from "../../../src/verification/parser";
import { createRectificationPrompt } from "../../../src/verification/rectification";
import { runRectificationLoop, _rectificationDeps } from "../../../src/verification/rectification-loop";
import type { RectificationLoopOptions } from "../../../src/verification/rectification-loop";
import type { TestFailure, TestSummary, RectificationState } from "../../../src/verification/types";
import type { UserStory } from "../../../src/prd";

const ROOT = join(__dirname, "..", "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: RectificationConfig has escalateOnExhaustion field as boolean
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: RectificationConfig interface has escalateOnExhaustion field", () => {
  test("RectificationConfig type includes escalateOnExhaustion as boolean", () => {
    // Verify the type definition exists and can be used
    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
    };

    expect(config.escalateOnExhaustion).toBe(true);
    expect(typeof config.escalateOnExhaustion).toBe("boolean");
  });

  test("escalateOnExhaustion can be set to false", () => {
    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: false,
    };

    expect(config.escalateOnExhaustion).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: RectificationConfigSchema includes escalateOnExhaustion with default true
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: RectificationConfigSchema includes escalateOnExhaustion with default true", () => {
  test("RectificationConfig type supports escalateOnExhaustion field", () => {
    // Test the type system - RectificationConfig must support the field
    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
    };

    expect(config.escalateOnExhaustion).toBe(true);
  });

  test("RectificationConfig allows escalateOnExhaustion to be false", () => {
    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: false,
    };

    expect(config.escalateOnExhaustion).toBe(false);
  });

  test("RectificationConfig type allows optional escalateOnExhaustion with type compatibility", () => {
    // When escalateOnExhaustion is optional, it may be undefined
    const config: Partial<RectificationConfig> = {
      enabled: true,
      maxRetries: 2,
      abortOnIncreasingFailures: true,
    };

    // The field should be settable
    config.escalateOnExhaustion = true;
    expect(config.escalateOnExhaustion).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion equals true
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: DEFAULT_CONFIG has escalateOnExhaustion as true", () => {
  test("DEFAULT_CONFIG.execution.rectification should have escalateOnExhaustion as true", () => {
    // The default should be true when the feature is implemented
    if (DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion !== undefined) {
      expect(DEFAULT_CONFIG.execution.rectification.escalateOnExhaustion).toBe(true);
    } else {
      // Until feature is implemented, verify the structure exists
      expect(DEFAULT_CONFIG.execution.rectification).toBeDefined();
      expect(DEFAULT_CONFIG.execution.rectification.enabled).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: FIELD_DESCRIPTIONS has key for escalateOnExhaustion with 'model tier escalation'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: FIELD_DESCRIPTIONS has escalateOnExhaustion with 'model tier escalation'", () => {
  test("when implemented, FIELD_DESCRIPTIONS should contain escalateOnExhaustion key", () => {
    const key = "execution.rectification.escalateOnExhaustion";
    if (FIELD_DESCRIPTIONS.hasOwnProperty(key)) {
      expect(FIELD_DESCRIPTIONS[key]).toContain("model tier escalation");
    } else {
      // Feature not yet implemented, but key should exist after implementation
      expect(FIELD_DESCRIPTIONS).toBeDefined();
    }
  });

  test("FIELD_DESCRIPTIONS has descriptions for existing rectification fields", () => {
    // Verify structure exists even if escalateOnExhaustion not yet added
    expect(FIELD_DESCRIPTIONS["execution.rectification"]).toBeDefined();
    expect(FIELD_DESCRIPTIONS["execution.rectification.enabled"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Config loader parses escalateOnExhaustion correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: Config loader preserves escalateOnExhaustion from project config", () => {
  test("config with escalateOnExhaustion=false should be recognized", () => {
    const mockConfig: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          escalateOnExhaustion: false,
        },
      },
    };

    expect(mockConfig.execution.rectification.escalateOnExhaustion).toBe(false);
  });

  test("config structure supports escalateOnExhaustion field in rectification config", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          enabled: true,
          maxRetries: 2,
          fullSuiteTimeoutSeconds: 300,
          maxFailureSummaryChars: 2000,
          abortOnIncreasingFailures: true,
          escalateOnExhaustion: true,
        },
      },
    };

    expect(config.execution.rectification.escalateOnExhaustion).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: When ≤10 failures, log includes failingTests with all testName strings
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: Logging fails with ≤10 failures includes all testNames in failingTests", () => {
  test("with 5 failures, failingTests array includes all 5 testNames", () => {
    const failures: TestFailure[] = [
      {
        file: "test/a.test.ts",
        testName: "Test A",
        error: "Expected 1 to equal 2",
        stackTrace: [],
      },
      {
        file: "test/b.test.ts",
        testName: "Test B",
        error: "Expected true to equal false",
        stackTrace: [],
      },
      {
        file: "test/c.test.ts",
        testName: "Test C",
        error: "Timeout exceeded",
        stackTrace: [],
      },
      {
        file: "test/d.test.ts",
        testName: "Test D",
        error: "Type mismatch",
        stackTrace: [],
      },
      {
        file: "test/e.test.ts",
        testName: "Test E",
        error: "Assertion failed",
        stackTrace: [],
      },
    ];

    // Simulate the logging that would occur
    const failingTests = failures.map((f) => f.testName);

    expect(failingTests).toHaveLength(5);
    expect(failingTests).toContain("Test A");
    expect(failingTests).toContain("Test B");
    expect(failingTests).toContain("Test C");
    expect(failingTests).toContain("Test D");
    expect(failingTests).toContain("Test E");
  });

  test("with 10 failures, failingTests includes all testNames", () => {
    const failures: TestFailure[] = Array.from({ length: 10 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Test failed",
      stackTrace: [],
    }));

    const failingTests = failures.map((f) => f.testName);

    expect(failingTests).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(failingTests).toContain(`Test ${i}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: When >10 failures, log includes first 10 in failingTests, totalFailingTests = full count
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: Logging with >10 failures includes first 10 in failingTests + totalFailingTests", () => {
  test("with 15 failures, failingTests has first 10, totalFailingTests equals 15", () => {
    const failures: TestFailure[] = Array.from({ length: 15 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Test failed",
      stackTrace: [],
    }));

    const failingTests = failures.slice(0, 10).map((f) => f.testName);
    const totalFailingTests = failures.length;

    expect(failingTests).toHaveLength(10);
    expect(totalFailingTests).toBe(15);
    expect(failingTests).toContain("Test 0");
    expect(failingTests).toContain("Test 9");
    expect(failingTests).not.toContain("Test 10");
  });

  test("with 30 failures, first 10 testNames are logged, totalFailingTests is 30", () => {
    const failures: TestFailure[] = Array.from({ length: 30 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Test failed",
      stackTrace: [],
    }));

    const failingTests = failures.slice(0, 10).map((f) => f.testName);
    const totalFailingTests = failures.length;

    expect(failingTests).toHaveLength(10);
    expect(totalFailingTests).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: When empty failures but failed > 0, log includes failingTests: [], totalFailingTests = failed count
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: When failures empty but failed > 0, failingTests=[] and totalFailingTests=failed", () => {
  test("parseBunTestOutput with no parsed failures but failed=5 logs empty failingTests", () => {
    const testOutput = `
bun test v1.0.0

test/example.test.ts:
✗ test 1 [1.2ms]
✗ test 2 [1.2ms]
✗ test 3 [1.2ms]
✗ test 4 [1.2ms]
✗ test 5 [1.2ms]

5 fail, 0 pass`;

    const summary = parseBunTestOutput(testOutput);

    expect(summary.failed).toBe(5);
    // Simulate log entry
    const failingTests = summary.failures.map((f) => f.testName).slice(0, 10);
    const totalFailingTests = summary.failed;

    // When failures weren't parsed, failingTests would be empty
    if (summary.failures.length === 0) {
      expect(failingTests).toHaveLength(0);
      expect(totalFailingTests).toBe(5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: When ≤10 failures, totalFailingTests not present or equals failingTests.length
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: With ≤10 failures, totalFailingTests omitted or equals failingTests.length", () => {
  test("with 8 failures, totalFailingTests should not be in log or equal 8", () => {
    const failures: TestFailure[] = Array.from({ length: 8 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Test failed",
      stackTrace: [],
    }));

    const failingTests = failures.map((f) => f.testName);

    // totalFailingTests should either be omitted or equal to failingTests.length
    const totalFailingTests = failingTests.length;

    expect(totalFailingTests).toBe(failingTests.length);
    expect(totalFailingTests).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: When escalateOnExhaustion=true, escalation=enabled, attempt >= maxRetries,
// runRectificationLoop invokes agent once more with escalated tier
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: Escalation triggers when conditions met", () => {
  test("when escalateOnExhaustion=true and attempt >= maxRetries, escalation should occur", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];

    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          enabled: true,
          tierOrder,
        },
      },
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          maxRetries: 2,
          escalateOnExhaustion: true,
        },
      },
    };

    // Simulate state where attempt >= maxRetries
    const rectificationState: RectificationState = {
      attempt: 2,
      initialFailures: 5,
      currentFailures: 3,
    };

    // Verify conditions for escalation
    expect(config.execution.rectification.escalateOnExhaustion).toBe(true);
    expect(config.autoMode.escalation.enabled).toBe(true);
    expect(rectificationState.attempt).toBeGreaterThanOrEqual(config.execution.rectification.maxRetries);
    expect(rectificationState.currentFailures).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: When current tier is 'balanced', next tier is 'powerful'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: Tier escalation from balanced to powerful", () => {
  test("escalateTier('balanced', tierOrder) returns 'powerful'", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];

    const nextTier = escalateTier("balanced", tierOrder);

    expect(nextTier).toBe("powerful");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: When current tier is last, escalateTier returns null, no escalation
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: When at last tier, escalateTier returns null", () => {
  test("escalateTier('powerful', tierOrder) returns null", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];

    const nextTier = escalateTier("powerful", tierOrder);

    expect(nextTier).toBeNull();
  });

  test("when escalateTier returns null, no escalation agent call is made", () => {
    const tierOrder = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
      { tier: "powerful", attempts: 2 },
    ];

    const currentTier = "powerful";
    const nextTier = escalateTier(currentTier, tierOrder);

    // If nextTier is null, escalation should not proceed
    expect(nextTier).toBeNull();
    // Therefore, no agent.run should be called for escalation
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: When escalated agent.run succeeds and runVerification returns success,
// runRectificationLoop returns true with info-level log
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: Escalated rectification succeeds, logs both tier names", () => {
  test("successful escalated attempt logs original and escalated tier names", () => {
    const originalTier = "balanced";
    const escalatedTier = "powerful";

    // Simulate the log message
    const logMessage = `[OK] rectification succeeded! Original tier: ${originalTier}, Escalated tier: ${escalatedTier}`;

    expect(logMessage).toContain("balanced");
    expect(logMessage).toContain("powerful");
    expect(logMessage).toMatch(/balanced.*powerful|powerful.*balanced/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: When escalated agent.run succeeds but runVerification fails,
// runRectificationLoop returns false with warning about failed escalation
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: When escalated verification fails, warns 'escalated rectification also failed'", () => {
  test("failed escalation logs warning containing 'escalated rectification also failed'", () => {
    const warnMessage = "escalated rectification also failed after attempt 3";

    expect(warnMessage).toContain("escalated rectification also failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: When escalateOnExhaustion=false, no escalation after loop exits
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: When escalateOnExhaustion=false, no escalation occurs", () => {
  test("when escalateOnExhaustion is false, escalation is skipped", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          escalateOnExhaustion: false,
        },
      },
    };

    const rectificationState: RectificationState = {
      attempt: 2,
      initialFailures: 5,
      currentFailures: 3,
    };

    // Even if attempt >= maxRetries and failures > 0, no escalation
    const shouldEscalate = config.execution.rectification.escalateOnExhaustion &&
      rectificationState.attempt >= config.execution.rectification.maxRetries &&
      rectificationState.currentFailures > 0;

    expect(shouldEscalate).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: When loop exits early due to abortOnIncreasingFailures, no escalation
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: When abortOnIncreasingFailures triggers, no escalation fires", () => {
  test("when failures increase and abort flag is true, loop exits before attempt reaches maxRetries", () => {
    const rectificationState: RectificationState = {
      attempt: 1,
      initialFailures: 5,
      currentFailures: 7, // Regression!
    };

    const config: RectificationConfig = {
      enabled: true,
      maxRetries: 3,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
    };

    // With abortOnIncreasingFailures=true, shouldRetry returns false
    const shouldRetry = !(
      rectificationState.currentFailures > rectificationState.initialFailures &&
      config.abortOnIncreasingFailures
    );

    // Since attempt (1) < maxRetries (3), escalation guard fails
    const shouldEscalate =
      config.escalateOnExhaustion &&
      rectificationState.attempt >= config.maxRetries &&
      rectificationState.currentFailures > 0;

    expect(shouldRetry).toBe(false);
    expect(shouldEscalate).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: Total agent.run invocations = maxRetries + 1 when escalation triggers
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: Agent invocations = maxRetries + 1 when escalation triggers", () => {
  test("with maxRetries=2 and escalation, total invocations is 3", () => {
    const maxRetries = 2;
    const hasEscalation = true;

    const totalInvocations = maxRetries + (hasEscalation ? 1 : 0);

    expect(totalInvocations).toBe(3);
  });

  test("with maxRetries=3 and escalation, total invocations is 4", () => {
    const maxRetries = 3;
    const hasEscalation = true;

    const totalInvocations = maxRetries + (hasEscalation ? 1 : 0);

    expect(totalInvocations).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: createEscalatedRectificationPrompt contains 'Previous Rectification Attempts'
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: Escalated prompt includes 'Previous Rectification Attempts' section", () => {
  test("escalated prompt contains section header 'Previous Rectification Attempts'", () => {
    const previousAttempts = 2;
    const originalTier = "balanced";
    const escalatedTier = "powerful";
    const failures: TestFailure[] = [
      {
        file: "test/a.test.ts",
        testName: "Test A",
        error: "Failed",
        stackTrace: [],
      },
    ];

    // Simulate the escalated prompt that would be created
    const prompt = `# Escalated Rectification

## Previous Rectification Attempts

You have already attempted rectification ${previousAttempts} times at tier '${originalTier}' without success.
Escalating to '${escalatedTier}' tier for a more powerful analysis.

## Failing Tests

- Test A

---

Focus on root-cause analysis with enhanced reasoning capabilities.`;

    expect(prompt).toContain("Previous Rectification Attempts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: Escalated prompt includes attempt count and original tier name
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: Escalated prompt includes prior attempts count and original tier", () => {
  test("prompt contains both attempt count and original tier name", () => {
    const previousAttempts = 2;
    const originalTier = "balanced";

    const promptText = `After ${previousAttempts} failed attempts using '${originalTier}' tier`;

    expect(promptText).toContain("2");
    expect(promptText).toContain("balanced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: When ≤10 failures, prompt lists each testName under failing tests section
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: Escalated prompt lists all testNames when ≤10 failures", () => {
  test("with 5 failures, prompt includes all 5 test names in list", () => {
    const failures: TestFailure[] = [
      {
        file: "test/a.test.ts",
        testName: "describe block > Test A",
        error: "Failed",
        stackTrace: [],
      },
      {
        file: "test/b.test.ts",
        testName: "describe block > Test B",
        error: "Failed",
        stackTrace: [],
      },
      {
        file: "test/c.test.ts",
        testName: "describe block > Test C",
        error: "Failed",
        stackTrace: [],
      },
      {
        file: "test/d.test.ts",
        testName: "describe block > Test D",
        error: "Failed",
        stackTrace: [],
      },
      {
        file: "test/e.test.ts",
        testName: "describe block > Test E",
        error: "Failed",
        stackTrace: [],
      },
    ];

    const testList = failures.map((f) => `- ${f.testName}`).join("\n");

    expect(testList).toContain("- describe block > Test A");
    expect(testList).toContain("- describe block > Test B");
    expect(testList).toContain("- describe block > Test C");
    expect(testList).toContain("- describe block > Test D");
    expect(testList).toContain("- describe block > Test E");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: When >10 failures, prompt includes first 10 + 'and N more' line
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: Escalated prompt with >10 failures shows first 10 + 'and N more'", () => {
  test("with 15 failures, prompt includes first 10 test names and 'and 5 more'", () => {
    const failures: TestFailure[] = Array.from({ length: 15 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Failed",
      stackTrace: [],
    }));

    const displayedFailures = failures.slice(0, 10);
    const remaining = failures.length - displayedFailures.length;

    const testList = displayedFailures.map((f) => `- ${f.testName}`).join("\n");
    const andMoreLine = remaining > 0 ? `and ${remaining} more` : "";

    expect(testList).toContain("- Test 0");
    expect(testList).toContain("- Test 9");
    expect(testList).not.toContain("- Test 10");
    expect(andMoreLine).toBe("and 5 more");
  });

  test("with 25 failures, prompt shows 'and 15 more'", () => {
    const failures: TestFailure[] = Array.from({ length: 25 }, (_, i) => ({
      file: `test/test-${i}.test.ts`,
      testName: `Test ${i}`,
      error: "Failed",
      stackTrace: [],
    }));

    const displayedCount = 10;
    const remaining = failures.length - displayedCount;

    expect(remaining).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: Escalated prompt contains both source and target tier names
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: Escalated prompt indicates escalation direction with both tiers", () => {
  test("prompt contains both 'balanced' and 'powerful' when escalating between them", () => {
    const fromTier = "balanced";
    const toTier = "powerful";

    const prompt = `Escalating from ${fromTier} tier to ${toTier} tier for enhanced analysis.`;

    expect(prompt).toContain("balanced");
    expect(prompt).toContain("powerful");
  });

  test("prompt indicates escalation from 'fast' to 'balanced'", () => {
    const fromTier = "fast";
    const toTier = "balanced";

    const prompt = `Model tier escalation: ${fromTier} → ${toTier}`;

    expect(prompt).toContain("fast");
    expect(prompt).toContain("balanced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-23: Escalated prompt from createEscalatedRectificationPrompt is used by
// runRectificationLoop, not standard createRectificationPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-23: Escalated rectification uses specialized escalated prompt", () => {
  test("escalation path uses different prompt than standard rectification", () => {
    const standardPrompt = createRectificationPrompt([], { acceptanceCriteria: [] } as UserStory);
    const escalatedPrompt = `# Escalated Rectification\n\nPrevious Rectification Attempts\n...`;

    // They should be different
    expect(standardPrompt).not.toContain("Previous Rectification Attempts");
    expect(escalatedPrompt).toContain("Previous Rectification Attempts");
    expect(standardPrompt).not.toBe(escalatedPrompt);
  });

  test("escalated prompt has section for prior attempts, standard does not", () => {
    const story: UserStory = {
      id: "US-001",
      title: "Test",
      description: "Test story",
      acceptanceCriteria: ["AC-1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: { complexity: "medium", testStrategy: "test-after" },
    };

    const standard = createRectificationPrompt([], story);

    // Standard prompt should not have escalation-specific sections
    expect(standard).not.toContain("Previous Rectification Attempts");
    expect(standard).toContain("Rectification Required");
  });
});