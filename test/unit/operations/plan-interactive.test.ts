/**
 * Unit tests for planInteractiveOp
 *
 * Verifies the planInteractiveOp operation:
 * - Is a RunOperation with correct structure
 * - Has retry strategy for JSON parse failures
 * - Parses valid PRD JSON successfully
 * - Throws on invalid JSON output
 * - Uses hopBody with sendWithParseRetry
 * - Has recover method for disk fallback
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ParseValidationError } from "@/agents";
import type { RetryStrategy } from "@/agents";
import { validatePlanOutput } from "@/prd";
import { makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// We'll define minimal imports to test the op shape.
// The actual implementation will provide these.
describe("planInteractiveOp shape", () => {
  test("exports planInteractiveOp", async () => {
    // This test will pass once planInteractiveOp is exported
    const mod = await import("@/operations");
    expect(mod).toHaveProperty("planInteractiveOp");
  });

  test("planInteractiveOp has kind === 'run'", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.kind).toBe("run");
  });

  test("planInteractiveOp.name === 'plan-interactive'", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.name).toBe("plan-interactive");
  });

  test("planInteractiveOp.stage === 'plan'", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.stage).toBe("plan");
  });

  test("planInteractiveOp.session.role === 'plan'", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.session.role).toBe("plan");
  });

  test("planInteractiveOp.session.lifetime === 'fresh'", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.session.lifetime).toBe("fresh");
  });

  test("planInteractiveOp.config is defined", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.config).toBeDefined();
  });

  test("planInteractiveOp.build is a function", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(typeof planInteractiveOp.build).toBe("function");
  });

  test("planInteractiveOp.parse is a function", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(typeof planInteractiveOp.parse).toBe("function");
  });
});

describe("planInteractiveOp.retry", () => {
  test("retry field is defined", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.retry).toBeDefined();
  });

  test("retry resolves to a RetryStrategy-like object with shouldRetry method", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const retryResult = typeof planInteractiveOp.retry === "function" ? planInteractiveOp.retry(input, ctx) : planInteractiveOp.retry;
    expect(retryResult).toBeDefined();
    if (retryResult && typeof retryResult === "object" && "shouldRetry" in retryResult) {
      expect(typeof retryResult.shouldRetry).toBe("function");
    }
  });
});

describe("planInteractiveOp.fileOutput", () => {
  test("fileOutput is defined and returns outputPath", async () => {
    // The plan op uses file-based output: the agent writes JSON to disk and
    // replies with a text confirmation. callOp reads the file via fileOutput
    // and substitutes it as the probe output so retries check the actual JSON.
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.fileOutput).toBeDefined();
    const path = planInteractiveOp.fileOutput?.({
      specContent: "",
      codebaseContext: "",
      featureName: "f",
      branchName: "feat/f",
      outputPath: "/tmp/prd.json",
    });
    expect(path).toBe("/tmp/prd.json");
  });

  test("hopBody is NOT defined (file-reading done by callOp via fileOutput)", async () => {
    // hopBody is no longer needed — callOp injects file content directly.
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.hopBody).toBeUndefined();
  });
});

describe("planInteractiveOp.parse()", () => {
  test("returns PRD object when output is valid JSON", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const validPRD = {
      project: "test-project",
      feature: "test-feature",
      analysis: "test analysis",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["Test AC"],
          contextFiles: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          routing: {
            complexity: "simple",
            testStrategy: "no-test",
            noTestJustification: "test",
            reasoning: "test",
          },
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const result = planInteractiveOp.parse(JSON.stringify(validPRD), input, ctx);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("userStories");
  });

  test("throws error when output is not valid JSON", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    expect(() => {
      planInteractiveOp.parse("not valid json {", input, ctx);
    }).toThrow();
  });

  test("throws error when JSON is missing required fields", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const invalidPRD = { project: "test" };

    expect(() => {
      planInteractiveOp.parse(JSON.stringify(invalidPRD), input, ctx);
    }).toThrow();
  });
});

describe("planInteractiveOp.recover", () => {
  test("recover method is defined", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.recover).toBeDefined();
  });

  test("recover is an async function", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(typeof planInteractiveOp.recover).toBe("function");
  });

  test("recover returns null when outputPath file does not exist", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (path: string) => null,
      fileExists: async (path: string) => false,
    };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/nonexistent/prd.json",
    };

    const result = await planInteractiveOp.recover!(input, ctx as any);
    expect(result).toBeNull();
  });

  test("recover returns parsed PRD when outputPath file exists with valid JSON", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const validPRD = {
      project: "test-project",
      feature: "test-feature",
      analysis: "test analysis",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["Test AC"],
          contextFiles: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          routing: {
            complexity: "simple",
            testStrategy: "no-test",
            noTestJustification: "test",
            reasoning: "test",
          },
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (path: string) => JSON.stringify(validPRD),
      fileExists: async (path: string) => true,
    };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const result = await planInteractiveOp.recover!(input, ctx as any);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("userStories");
    expect(Array.isArray(result!.userStories)).toBe(true);
  });

  test("recover returns null when file exists but contains invalid JSON", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (path: string) => "not valid json {",
      fileExists: async (path: string) => true,
    };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const result = await planInteractiveOp.recover!(input, ctx as any);
    expect(result).toBeNull();
  });
});

describe("planInteractiveOp.verify", () => {
  test("verify method is defined", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.verify).toBeDefined();
  });

  test("verify returns null when userStories is empty", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const emptyPRD = {
      project: "test-project",
      feature: "test-feature",
      analysis: "test analysis",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [],
    };

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (path: string) => null,
      fileExists: async (path: string) => false,
    };

    const result = await planInteractiveOp.verify!(emptyPRD as any, {} as any, ctx as any);
    expect(result).toBeNull();
  });

  test("verify returns the PRD when userStories is not empty", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const validPRD = {
      project: "test-project",
      feature: "test-feature",
      analysis: "test analysis",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["Test AC"],
          contextFiles: [],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          routing: {
            complexity: "simple",
            testStrategy: "no-test",
            noTestJustification: "test",
            reasoning: "test",
          },
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (path: string) => null,
      fileExists: async (path: string) => false,
    };

    const result = await planInteractiveOp.verify!(validPRD as any, {} as any, ctx as any);
    expect(result).not.toBeNull();
    expect(result).toEqual(validPRD);
  });
});

// ─── Adversarial: retry validate / parse consistency ─────────────────────────
//
// Bug found by adversarial review:
//   planInteractiveOp.retry.validate returns true for { userStories: [] },
//   but planInteractiveOp.parse (via validatePlanOutput) throws on that same
//   output ("[schema] userStories is required and must be a non-empty array").
//   As a result the retry strategy concludes "valid, stop retrying" for a
//   response that parse() would reject, silencing the retry and propagating
//   the parse error to the caller without a retry attempt.
//
// Spec-correct behaviour (AC-4): retry MUST fire for any output that parse
// would reject, including empty-userStories JSON.

describe("planInteractiveOp.retry — validate/parse consistency (adversarial AC-4)", () => {
  test("retry.shouldRetry requests a retry when LLM returns empty userStories", async () => {
    const { planInteractiveOp } = await import("@/operations");

    const strategyOrFn = planInteractiveOp.retry;
    const retryStrategy: RetryStrategy = (
      typeof strategyOrFn === "function"
        ? strategyOrFn(
            {
              specContent: "test",
              codebaseContext: "test",
              featureName: "test",
              branchName: "feat/test",
              outputPath: "/tmp/prd.json",
            },
            {} as Parameters<typeof strategyOrFn>[1],
          )
        : strategyOrFn
    ) as RetryStrategy;

    expect(retryStrategy).not.toBeNull();

    const emptyStoriesOutput = JSON.stringify({
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      userStories: [],
    });

    // Confirm parse() would indeed throw on this output
    expect(() =>
      validatePlanOutput(emptyStoriesOutput, "test-feature", "feat/test"),
    ).toThrow("[schema] userStories is required and must be a non-empty array");

    // Spec-correct: the retry strategy must also reject empty userStories so
    // the LLM gets another chance rather than throwing a phantom parse error.
    const decision = retryStrategy.shouldRetry(
      new ParseValidationError("LLM returned empty userStories"),
      0,
      {
        site: "run",
        agentName: "claude",
        stage: "plan",
        storyId: "US-001",
        lastOutput: emptyStoriesOutput,
      },
    );

    // This assertion FAILS with the current implementation because validate
    // returns true for { userStories: [] }, causing shouldRetry to return
    // { retry: false }.  Fix: add `&& parsed.userStories.length > 0` to
    // the validate predicate in planInteractiveOp.retry.
    expect(decision.retry).toBe(true);
  });
});

// ─── US-002 (#993): op.recover is the load-bearing escape hatch ──────────────
//
// planInteractiveOp deliberately omits exhaustedFallback (it is synchronous
// and only receives lastOutput, so it cannot read outputPath from disk).
// op.recover is the third sanctioned escape hatch per retry-strategy.md.
// These tests verify the three required recover behaviours.

describe("planInteractiveOp.recover — disk-recovery escape hatch (#993)", () => {
  const baseInput = {
    specContent: "spec",
    codebaseContext: "ctx",
    featureName: "test-feature",
    branchName: "feat/test",
    outputPath: "/tmp/prd.json",
  };

  const validPrdJson = JSON.stringify({
    project: "test-project",
    feature: "test-feature",
    analysis: "analysis",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "Story",
        description: "desc",
        acceptanceCriteria: ["AC1"],
        contextFiles: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "test", reasoning: "test" },
        escalations: [],
        attempts: 0,
      },
    ],
  });

  const envelopeJson = JSON.stringify({
    output: "File already valid.",
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    estimatedCostUsd: 0.001,
    internalRoundTrips: 3,
  });

  test("(a) recover returns valid PRD when outputPath exists with parseable userStories", async () => {
    const { planInteractiveOp } = await import("@/operations");
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (_path: string) => validPrdJson,
      fileExists: async (_path: string) => true,
    };

    const result = await planInteractiveOp.recover!(baseInput, ctx as any);

    expect(result).not.toBeNull();
    expect(Array.isArray(result!.userStories)).toBe(true);
    expect(result!.userStories.length).toBe(1);
    expect(result!.userStories[0]?.id).toBe("US-001");
  });

  test("(b) recover returns null when outputPath is missing (readFile returns null)", async () => {
    const { planInteractiveOp } = await import("@/operations");
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (_path: string) => null,
      fileExists: async (_path: string) => false,
    };

    const result = await planInteractiveOp.recover!(baseInput, ctx as any);
    expect(result).toBeNull();
  });

  test("(c) recover returns null when outputPath contains the envelope shape (not a valid PRD)", async () => {
    const { planInteractiveOp } = await import("@/operations");
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (_path: string) => envelopeJson,
      fileExists: async (_path: string) => true,
    };

    // validatePlanOutput throws inside recover's try/catch → recover returns null
    const result = await planInteractiveOp.recover!(baseInput, ctx as any);
    expect(result).toBeNull();
  });
});
