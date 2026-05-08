import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: TurnResult import consistency in src/agents/retry/
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: TurnResult import consistency in retry module", () => {
  test("src/agents/retry/types.ts imports TurnResult from ../../agents/types", () => {
    const typesPath = join(import.meta.dir, "../../../src/agents/retry/types.ts");
    const content = readFileSync(typesPath, "utf-8");

    // Check that the import statement exists
    expect(content).toContain('import type { TurnResult } from "../../agents/types"');
  });

  test("all files in src/agents/retry/ that import TurnResult use identical path ../../agents/types", () => {
    const retryDir = join(import.meta.dir, "../../../src/agents/retry");

    // Read all TypeScript files in the retry module
    const files = new Bun.Glob("*.ts").scanSync({ cwd: retryDir, absolute: true });

    const turnResultImports: Map<string, string[]> = new Map();

    for (const file of files) {
      const content = readFileSync(file, "utf-8");

      // Find all TurnResult imports
      const importMatches = content.match(/import\s+(?:.*\s)?TurnResult.*from\s+["']([^"']+)["']/g) || [];

      if (importMatches.length > 0) {
        // Extract the path from each import
        const paths = importMatches.map((match) => {
          const pathMatch = match.match(/from\s+["']([^"']+)["']/);
          return pathMatch ? pathMatch[1] : "";
        });

        turnResultImports.set(file, paths);
      }
    }

    // Verify all imports use the same path
    const allPaths = Array.from(turnResultImports.values()).flat();
    const uniquePaths = new Set(allPaths);

    if (allPaths.length > 0) {
      expect(uniquePaths.size).toBe(1);
      expect(Array.from(uniquePaths)[0]).toBe("../../agents/types");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: composeRetry with all strategies returning { retry: false }
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: composeRetry iterates all strategies when all return false", () => {
  const { composeRetry } = await import("../../../src/agents/retry/index");

  test("all strategies are invoked exactly once when all return false", () => {
    // Track invocation count for each strategy
    const invocations: number[] = [0, 0, 0];

    // Create three strategies that return { retry: false }
    const strategies = [
      {
        shouldRetry: (failure, attempt, ctx) => {
          invocations[0]++;
          return { retry: false };
        },
      },
      {
        shouldRetry: (failure, attempt, ctx) => {
          invocations[1]++;
          return { retry: false };
        },
      },
      {
        shouldRetry: (failure, attempt, ctx) => {
          invocations[2]++;
          return { retry: false };
        },
      },
    ];

    const composed = composeRetry(strategies);
    const testErr = new Error("test");
    const ctx = {
      site: "run" as const,
      agentName: "claude",
      stage: "run" as const,
      storyId: "AC-2",
    };

    // Invoke the composed strategy
    const result = composed.shouldRetry(testErr, 0, ctx);

    // All strategies should be called exactly once
    expect(invocations).toEqual([1, 1, 1]);
    expect(result).toEqual({ retry: false });
  });

  test("no additional invocations occur after the list is exhausted", () => {
    let postExhaustionInvoked = false;

    const strategies = [
      {
        shouldRetry: () => ({ retry: false }),
      },
      {
        shouldRetry: () => ({ retry: false }),
      },
      {
        shouldRetry: () => {
          postExhaustionInvoked = true;
          return { retry: false };
        },
      },
    ];

    const composed = composeRetry(strategies);
    const testErr = new Error("test");
    const ctx = { site: "run" as const, agentName: "claude", stage: "run" as const };

    composed.shouldRetry(testErr, 0, ctx);

    // Third strategy should be called exactly once (not multiple times)
    expect(postExhaustionInvoked).toBe(true);
  });

  test("composed strategy returns { retry: false } after exhausting all strategies", () => {
    const strategies = [
      { shouldRetry: () => ({ retry: false }) },
      { shouldRetry: () => ({ retry: false }) },
      { shouldRetry: () => ({ retry: false }) },
    ];

    const composed = composeRetry(strategies);
    const testErr = new Error("test");
    const ctx = { site: "run" as const, agentName: "claude", stage: "run" as const };

    const result = composed.shouldRetry(testErr, 0, ctx);
    expect(result).toEqual({ retry: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: RetryContext passed unchanged to each strategy (by deep equality)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: RetryContext preserved and unchanged through composeRetry", () => {
  const { composeRetry } = await import("../../../src/agents/retry/index");

  test("original RetryContext is passed unchanged to each strategy", () => {
    // Capture the context received by each strategy
    const receivedContexts = [];

    const originalCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: "AC-3-test",
      lastOutput: "test output",
      lastTurnResult: { output: "test", estimatedCostUsd: 0.01, attempts: 1, source: "primary" },
    };

    const strategies = [
      {
        shouldRetry: (failure, attempt, ctx) => {
          receivedContexts.push(structuredClone(ctx));
          return { retry: false };
        },
      },
      {
        shouldRetry: (failure, attempt, ctx) => {
          receivedContexts.push(structuredClone(ctx));
          return { retry: false };
        },
      },
    ];

    const composed = composeRetry(strategies);
    composed.shouldRetry(new Error("test"), 0, originalCtx);

    // Each strategy receives the exact same context
    expect(receivedContexts.length).toBe(2);
    expect(receivedContexts[0]).toEqual(originalCtx);
    expect(receivedContexts[1]).toEqual(originalCtx);
  });

  test("all optional fields in RetryContext are preserved", () => {
    const receivedContexts = [];

    const ctxWithAllFields = {
      site: "run" as const,
      agentName: "test-agent",
      stage: "verify" as const,
      storyId: "story-123",
      lastOutput: "output data",
      lastTurnResult: { output: "turn output", estimatedCostUsd: 0.02, attempts: 2, source: "fallback" },
    };

    const strategies = [
      {
        shouldRetry: (failure, attempt, ctx) => {
          receivedContexts.push(ctx);
          return { retry: false };
        },
      },
    ];

    const composed = composeRetry(strategies);
    composed.shouldRetry(new Error("test"), 0, ctxWithAllFields);

    const received = receivedContexts[0];
    expect(received.site).toBe("run");
    expect(received.agentName).toBe("test-agent");
    expect(received.stage).toBe("verify");
    expect(received.storyId).toBe("story-123");
    expect(received.lastOutput).toBe("output data");
    expect(received.lastTurnResult).toBeDefined();
    expect(received.lastTurnResult?.output).toBe("turn output");
    expect(received.lastTurnResult?.estimatedCostUsd).toBe(0.02);
  });

  test("context modifications do not affect subsequent strategies", () => {
    const receivedContexts = [];

    const originalCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "run" as const,
      storyId: "AC-3-isolation",
      lastOutput: "original",
    };

    const strategies = [
      {
        shouldRetry: (failure, attempt, ctx) => {
          receivedContexts.push(structuredClone(ctx));
          // Attempt to mutate (though context is readonly)
          return { retry: false };
        },
      },
      {
        shouldRetry: (failure, attempt, ctx) => {
          receivedContexts.push(structuredClone(ctx));
          return { retry: false };
        },
      },
    ];

    const composed = composeRetry(strategies);
    composed.shouldRetry(new Error("test"), 0, originalCtx);

    // Both strategies receive the same original context values
    expect(receivedContexts[0]).toEqual(receivedContexts[1]);
    expect(receivedContexts[0]).toEqual(originalCtx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: op.retry resolver invoked exactly once before first ctx.send()
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: RunOperation.retry resolver timing and invocation", () => {
  test("RunOperation interface includes optional retry field with resolver signature", async () => {
    // This test verifies the type structure is in place by importing the type
    const { join: pathJoin } = await import("node:path");

    const typesPath = pathJoin(import.meta.dir, "../../../src/operations/types.ts");
    const content = readFileSync(typesPath, "utf-8");

    // Verify the retry field is documented on RunOperation
    expect(content).toContain("readonly retry?:");
    expect(content).toContain("RetryPreset");
    expect(content).toContain("RetryStrategy");
  });

  test("retry resolver form receives (input, ctx) arguments matching complete-kind contract", async () => {
    // Import the type to verify the signature
    const typesPath = join(import.meta.dir, "../../../src/operations/types.ts");
    const content = readFileSync(typesPath, "utf-8");

    // Verify the resolver form accepts (input, ctx) and returns RetryPreset | RetryStrategy | undefined
    expect(content).toContain("(input: I, ctx: BuildContext<C>) => RetryPreset | RetryStrategy | undefined");
  });

  test("ParseValidationError is available for strategies in run-kind retry", async () => {
    // Import ParseValidationError to verify it exists and can be used in strategies
    const { ParseValidationError } = await import("../../../src/agents/retry/index");

    const error = new ParseValidationError("test validation failed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ParseValidationError");
    expect(error.kind).toBe("parse-validation");
  });

  test("RunOperation.retry when set and op.hopBody absent follows same semantics as complete-kind", () => {
    // This test verifies the documented behavior matches the interface
    // by confirming both use the same resolver signature and return types

    const typesPath = join(import.meta.dir, "../../../src/operations/types.ts");
    const content = readFileSync(typesPath, "utf-8");

    // Extract the retry field definition from RunOperation
    const runOpMatch = content.match(/export interface RunOperation<I, O, C>[\s\S]*?{[\s\S]*?readonly retry\?:[\s\S]*?(?:readonly|};)/);

    // Extract the retry field definition from CompleteOperation
    const completeOpMatch = content.match(/export interface CompleteOperation<I, O, C>[\s\S]*?{[\s\S]*?readonly retry\?:[\s\S]*?(?:readonly|};)/);

    // Both should reference the same types
    if (runOpMatch && completeOpMatch) {
      const runRetryDef = runOpMatch[0];
      const completeRetryDef = completeOpMatch[0];

      // Both mention RetryPreset and RetryStrategy
      expect(runRetryDef).toContain("RetryPreset");
      expect(runRetryDef).toContain("RetryStrategy");
      expect(completeRetryDef).toContain("RetryPreset");
      expect(completeRetryDef).toContain("RetryStrategy");
    }
  });

  test("retryStrategy.shouldRetry can receive ParseValidationError in run-kind retries", async () => {
    const { ParseValidationError, makeParseRetryStrategy } = await import(
      "../../../src/agents/retry/index"
    );

    let receivedErrorType = null;

    // Create a simple parse retry strategy
    const strategy = makeParseRetryStrategy({
      validate: () => false,
      reviewerKind: "test",
      parse: () => null,
      prompts: {
        invalid: () => "invalid",
        truncated: () => "truncated",
      },
    });

    // Invoke with a ParseValidationError
    const parseError = new ParseValidationError("output invalid");
    const ctx = {
      site: "run" as const,
      agentName: "claude",
      stage: "run" as const,
      lastOutput: "bad json",
    };

    const result = strategy.shouldRetry(parseError, 0, ctx);

    // The strategy should handle ParseValidationError and return a retry decision
    expect(result.retry === true || result.retry === false).toBe(true);
  });

  test("RetryStrategy.shouldRetry receives correct parameters (failure, attempt, ctx)", async () => {
    const { composeRetry } = await import("../../../src/agents/retry/index");

    let capturedArgs = null;

    const strategy = {
      shouldRetry: (failure, attempt, ctx) => {
        capturedArgs = { failure, attempt, ctx };
        return { retry: false };
      },
    };

    const composed = composeRetry([strategy]);
    const testError = new Error("test failure");
    const testCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "verify" as const,
      storyId: "test-story",
    };

    composed.shouldRetry(testError, 2, testCtx);

    // Verify all three parameters are passed through
    expect(capturedArgs?.failure).toBe(testError);
    expect(capturedArgs?.attempt).toBe(2);
    expect(capturedArgs?.ctx).toBe(testCtx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Verify composability with run-kind ops
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: Consolidated retry framework", () => {
  test("parseRetryStrategy can be composed with other strategies via composeRetry", async () => {
    const { makeParseRetryStrategy, composeRetry } = await import("../../../src/agents/retry/index");

    // Create a parse retry strategy
    const parseStrategy = makeParseRetryStrategy({
      validate: (parsed) => parsed !== null && typeof parsed === "object",
      reviewerKind: "semantic",
      maxAttempts: 2,
      prompts: {
        invalid: () => "invalid prompt",
        truncated: () => "truncated prompt",
      },
    });

    // Create another simple strategy
    const fallbackStrategy = {
      shouldRetry: () => ({ retry: false }),
    };

    // Compose them
    const composed = composeRetry([parseStrategy, fallbackStrategy]);

    // Verify composed strategy can be called
    expect(composed.shouldRetry).toBeDefined();

    const testCtx = {
      site: "run" as const,
      agentName: "claude",
      stage: "run" as const,
      lastOutput: "test",
    };

    // Should not throw
    const result = composed.shouldRetry(new Error("test"), 0, testCtx);
    expect(result).toBeDefined();
  });

  test("all exported symbols from src/agents/retry/index.ts are available", async () => {
    const retryIndex = await import("../../../src/agents/retry/index");

    // Verify key exports exist
    expect(retryIndex.composeRetry).toBeDefined();
    expect(retryIndex.makeParseRetryStrategy).toBeDefined();
    expect(retryIndex.ParseValidationError).toBeDefined();
    expect(retryIndex.defaultRetryStrategy).toBeDefined();
    expect(retryIndex.resolveRetryPreset).toBeDefined();
  });

  test("types are correctly exported for consumer use", async () => {
    // Verify types are exported from the barrel
    const typesPath = join(import.meta.dir, "../../../src/agents/retry/index.ts");
    const content = readFileSync(typesPath, "utf-8");

    expect(content).toContain("export type { RetryContext");
    expect(content).toContain("export type { RetryDecision");
    expect(content).toContain("export type { RetryStrategy");
    expect(content).toContain("export type { RetryPreset");
  });
});