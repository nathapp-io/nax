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

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ParseValidationError } from "@/agents";
import type { RetryStrategy } from "@/agents";
import { planInteractiveOp } from "@/operations";
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
  test("exports planInteractiveOp with correct kind, name, stage, session role/lifetime, config, build, and parse", async () => {
    const mod = await import("@/operations");
    expect(mod).toHaveProperty("planInteractiveOp");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.kind).toBe("run");
    expect(planInteractiveOp.name).toBe("plan-interactive");
    expect(planInteractiveOp.stage).toBe("plan");
    expect(planInteractiveOp.session.role).toBe("plan");
    expect(planInteractiveOp.session.lifetime).toBe("fresh");
    expect(planInteractiveOp.config).toBeDefined();
    expect(typeof planInteractiveOp.build).toBe("function");
    expect(typeof planInteractiveOp.parse).toBe("function");
  });
});

describe("planInteractiveOp.retry", () => {
  test("retry is defined and resolves to a RetryStrategy with shouldRetry method", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.retry).toBeDefined();

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
  test("fileOutput is defined and returns outputPath; hopBody is undefined", async () => {
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
          routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "test", reasoning: "test" },
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const input = { specContent: "Test spec", codebaseContext: "Test context", featureName: "test-feature", branchName: "feat/test", outputPath: "/tmp/prd.json" };
    const result = planInteractiveOp.parse(JSON.stringify(validPRD), input, ctx);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("userStories");
  });

  test.each([
    ["not valid JSON", "not valid json {"],
    ["missing required fields", JSON.stringify({ project: "test" })],
  ] as const)("throws error when output is %s", async (_label, output) => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };
    const input = { specContent: "Test spec", codebaseContext: "Test context", featureName: "test-feature", branchName: "feat/test", outputPath: "/tmp/prd.json" };
    expect(() => { planInteractiveOp.parse(output, input, ctx); }).toThrow();
  });
});

describe("planInteractiveOp.recover", () => {
  test("recover is defined as an async function", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    expect(planInteractiveOp.recover).toBeDefined();
    expect(typeof planInteractiveOp.recover).toBe("function");
  });

  test.each([
    ["file does not exist", async (_path: string) => null, async (_path: string) => false],
    ["file has invalid JSON", async (_path: string) => "not valid json {", async (_path: string) => true],
  ] as const)("recover returns null when %s", async (_label, readFile, fileExists) => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config), readFile, fileExists };
    const input = { specContent: "Test spec", codebaseContext: "Test context", featureName: "test-feature", branchName: "feat/test", outputPath: "/nonexistent/prd.json" };
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
          routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "test", reasoning: "test" },
          escalations: [],
          attempts: 0,
        },
      ],
    };

    const ctx = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (_path: string) => JSON.stringify(validPRD),
      fileExists: async (_path: string) => true,
    };
    const input = { specContent: "Test spec", codebaseContext: "Test context", featureName: "test-feature", branchName: "feat/test", outputPath: "/tmp/prd.json" };
    const result = await planInteractiveOp.recover!(input, ctx as any);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("userStories");
    expect(Array.isArray(result!.userStories)).toBe(true);
  });
});

describe("planInteractiveOp.verify", () => {
  test("verify returns null for empty userStories and returns the PRD for non-empty userStories", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config), readFile: async (_p: string) => null, fileExists: async (_p: string) => false };

    const emptyPRD = {
      project: "test-project", feature: "test-feature", analysis: "test analysis",
      branchName: "feat/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      userStories: [],
    };

    const input = { specContent: "Test spec", codebaseContext: "", featureName: "test-feature", branchName: "feat/test", outputPath: "/tmp/prd.json" };

    const nullResult = await planInteractiveOp.verify!(emptyPRD as any, input as any, ctx as any);
    expect(nullResult).toBeNull();

    const validPRD = {
      ...emptyPRD,
      userStories: [{
        id: "US-001", title: "Test story", description: "Test description", acceptanceCriteria: ["Test AC"],
        contextFiles: [], tags: [], dependencies: [], status: "pending", passes: false,
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "test", reasoning: "test" },
        escalations: [], attempts: 0,
      }],
    };
    const prdResult = await planInteractiveOp.verify!(validPRD as any, input as any, ctx as any);
    expect(prdResult).not.toBeNull();
    expect(prdResult).toEqual(validPRD);
  });
});

describe("planInteractiveOp.verify — [verbatim] residual-drift warning (single mode)", () => {
  const SPEC_WITH_VERBATIM = '## Acceptance Criteria\n- [verbatim] `grep -rn "oldSym" src/` returns zero matches';

  function makeVerifyCtx() {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    return {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async (_p: string) => null,
      fileExists: async (_p: string) => false,
    };
  }

  function storyWith(acs: string[]) {
    return {
      id: "US-001", title: "Story", description: "desc", acceptanceCriteria: acs,
      contextFiles: [], tags: [], dependencies: [], status: "pending", passes: false,
      routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "t", reasoning: "t" },
      escalations: [], attempts: 0,
    };
  }

  function prdWith(acs: string[]) {
    return {
      project: "p", feature: "test-feature", analysis: "a", branchName: "feat/test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      userStories: [storyWith(acs)],
    };
  }

  async function withWarnSpy<T>(fn: (warnSpy: ReturnType<typeof spyOn>) => Promise<T>): Promise<T> {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const warnSpy = spyOn(initLogger({ level: "silent" }), "warn");
    try {
      return await fn(warnSpy);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  }

  function verbatimWarn(warnSpy: ReturnType<typeof spyOn>) {
    return warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("[verbatim]"));
  }

  const input = { specContent: SPEC_WITH_VERBATIM, codebaseContext: "", featureName: "test-feature", branchName: "feat/test", outputPath: "/tmp/prd.json" };

  test("warns and still returns the PRD when a [verbatim] spec AC is dropped", async () => {
    await withWarnSpy(async (warnSpy) => {
      const prd = prdWith(["unrelated AC that does not contain the grep"]);
      const result = await planInteractiveOp.verify!(prd as any, input as any, makeVerifyCtx() as any);
      expect(result).not.toBeNull();
      const warn = verbatimWarn(warnSpy);
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown>).missingCount).toBe(1);
    });
  });

  test("does not warn when the [verbatim] command survives in a PRD AC", async () => {
    await withWarnSpy(async (warnSpy) => {
      const prd = prdWith(['When cleanup completes, grep -rn "oldSym" src/ returns zero matches.']);
      const result = await planInteractiveOp.verify!(prd as any, input as any, makeVerifyCtx() as any);
      expect(result).not.toBeNull();
      expect(verbatimWarn(warnSpy)).toBeUndefined();
    });
  });
});

// ─── Adversarial: retry validate / parse consistency ─────────────────────────

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

    expect(() =>
      validatePlanOutput(emptyStoriesOutput, "test-feature", "feat/test"),
    ).toThrow("[schema] userStories is required and must be a non-empty array");

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

    expect(decision.retry).toBe(true);
  });
});

// ─── US-002 (#993): op.recover is the load-bearing escape hatch ──────────────

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

  test.each([
    ["(b) outputPath is missing (readFile returns null)", async (_p: string) => null, async (_p: string) => false],
    ["(c) outputPath contains the envelope shape (not a valid PRD)", async (_p: string) => envelopeJson, async (_p: string) => true],
  ] as const)("%s → recover returns null", async (_label, readFile, fileExists) => {
    const { planInteractiveOp } = await import("@/operations");
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config), readFile, fileExists };
    const result = await planInteractiveOp.recover!(baseInput, ctx as any);
    expect(result).toBeNull();
  });
});
