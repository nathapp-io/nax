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
import { assertDefined, makePRD, makeStory, makeTestRuntime, opSelector, withWarnSpy } from "@test/helpers";
import type { RetryStrategy } from "@/agents";
import { ParseValidationError } from "@/agents";
import { planInteractiveOp } from "@/operations";
import { validatePlanOutput } from "@/prd";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/** Shared verify-context factory — the op's verify() only touches these four fields. */
function makeInteractiveVerifyCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(planInteractiveOp.config)),
    readFile: async (_p: string) => null as string | null,
    fileExists: async (_p: string) => false,
  };
}

async function runRecover(
  input: Parameters<NonNullable<typeof planInteractiveOp.recover>>[0],
  ctx: Parameters<NonNullable<typeof planInteractiveOp.recover>>[1],
) {
  assertDefined(planInteractiveOp.recover, "recover");
  return planInteractiveOp.recover(input, ctx);
}

function runVerify(
  prd: Parameters<NonNullable<typeof planInteractiveOp.verify>>[0],
  input: Parameters<NonNullable<typeof planInteractiveOp.verify>>[1],
  ctx: Parameters<NonNullable<typeof planInteractiveOp.verify>>[2],
) {
  assertDefined(planInteractiveOp.verify, "verify");
  return planInteractiveOp.verify(prd, input, ctx);
}

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
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };

    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const retryResult =
      typeof planInteractiveOp.retry === "function" ? planInteractiveOp.retry(input, ctx) : planInteractiveOp.retry;
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
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };

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

  test.each([
    ["not valid JSON", "not valid json {"],
    ["missing required fields", JSON.stringify({ project: "test" })],
  ] as const)("throws error when output is %s", async (_label, output) => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };
    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };
    expect(() => {
      planInteractiveOp.parse(output, input, ctx);
    }).toThrow();
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
    [
      "file does not exist",
      async (_path: string): Promise<string | null> => null,
      async (_path: string): Promise<boolean> => false,
    ],
    [
      "file has invalid JSON",
      async (_path: string): Promise<string | null> => "not valid json {",
      async (_path: string): Promise<boolean> => true,
    ],
  ] as const)("recover returns null when %s", async (_label, readFile, fileExists) => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)), readFile, fileExists };
    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/nonexistent/prd.json",
    };
    const result = await runRecover(input, ctx);
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
      config: view.select(opSelector(planInteractiveOp.config)),
      readFile: async (_path: string) => JSON.stringify(validPRD),
      fileExists: async (_path: string) => true,
    };
    const input = {
      specContent: "Test spec",
      codebaseContext: "Test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };
    const result = await runRecover(input, ctx);
    assertDefined(result, "recover() result");
    expect(result).toHaveProperty("userStories");
    expect(Array.isArray(result.userStories)).toBe(true);
  });
});

describe("planInteractiveOp.verify", () => {
  test("verify returns null for empty userStories and returns the PRD for non-empty userStories", async () => {
    const mod = await import("@/operations");
    const { planInteractiveOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = {
      packageView: view,
      config: view.select(opSelector(planInteractiveOp.config)),
      readFile: async (_p: string) => null,
      fileExists: async (_p: string) => false,
    };

    const emptyPRD = {
      project: "test-project",
      feature: "test-feature",
      analysis: "test analysis",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [],
    };

    const input = {
      specContent: "Test spec",
      codebaseContext: "",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const nullResult = await runVerify(emptyPRD, input, ctx);
    expect(nullResult).toBeNull();

    const validPRD = {
      ...emptyPRD,
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["Test AC"],
          contextFiles: [],
          tags: [],
          dependencies: [],
          status: "pending" as const,
          passes: false,
          routing: {
            complexity: "simple" as const,
            testStrategy: "no-test" as const,
            noTestJustification: "test",
            reasoning: "test",
          },
          escalations: [],
          attempts: 0,
        },
      ],
    };
    const prdResult = await runVerify(validPRD, input, ctx);
    assertDefined(prdResult, "verify() result");
    expect(prdResult).toEqual(validPRD);
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

    expect(() => validatePlanOutput(emptyStoriesOutput, "test-feature", "feat/test")).toThrow(
      "[schema] userStories is required and must be a non-empty array",
    );

    const decision = retryStrategy.shouldRetry(new ParseValidationError("LLM returned empty userStories"), 0, {
      site: "run",
      agentName: "claude",
      stage: "plan",
      storyId: "US-001",
      lastOutput: emptyStoriesOutput,
    });

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
      config: view.select(opSelector(planInteractiveOp.config)),
      readFile: async (_path: string) => validPrdJson,
      fileExists: async (_path: string) => true,
    };
    const result = await runRecover(baseInput, ctx);
    assertDefined(result, "recover() result");
    expect(Array.isArray(result.userStories)).toBe(true);
    expect(result.userStories.length).toBe(1);
    expect(result.userStories[0]?.id).toBe("US-001");
  });

  test.each([
    [
      "(b) outputPath is missing (readFile returns null)",
      async (_p: string): Promise<string | null> => null,
      async (_p: string): Promise<boolean> => false,
    ],
    [
      "(c) outputPath contains the envelope shape (not a valid PRD)",
      async (_p: string): Promise<string | null> => envelopeJson,
      async (_p: string): Promise<boolean> => true,
    ],
  ] as const)("%s → recover returns null", async (_label, readFile, fileExists) => {
    const { planInteractiveOp } = await import("@/operations");
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)), readFile, fileExists };
    const result = await runRecover(baseInput, ctx);
    expect(result).toBeNull();
  });
});

describe("planInteractiveOp.verify — out-of-scope backfill (single mode)", () => {
  const SPEC = "## Out of Scope\n\n- An interactive Ink TUI\n- Per-story checkpoints\n";

  function prdWith(outOfScope?: string[]) {
    return makePRD({
      feature: "test-feature",
      branchName: "feat/test",
      ...(outOfScope ? { outOfScope } : {}),
      userStories: [
        makeStory({
          acceptanceCriteria: ["When x, then y"],
          routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "t", reasoning: "t" },
        }),
      ],
    });
  }

  const input = {
    specContent: SPEC,
    codebaseContext: "",
    featureName: "test-feature",
    branchName: "feat/test",
    outputPath: "/tmp/prd.json",
  };

  test("backfills every spec exclusion the planner omitted, and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const result = await runVerify(prdWith(), input as never, makeInteractiveVerifyCtx() as never);
      expect(result?.outOfScope).toEqual(["An interactive Ink TUI", "Per-story checkpoints"]);
      const warn = warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("out-of-scope"));
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown> | undefined)?.missingCount).toBe(2);
    });
  });

  test("keeps the planner's own wording and restores only what it dropped", async () => {
    const prd = prdWith(["An interactive Ink TUI — deferred to arc 3"]);
    const result = await runVerify(prd, input as never, makeInteractiveVerifyCtx() as never);
    // Restored items lead so the cap can never truncate them away.
    expect(result?.outOfScope).toEqual(["Per-story checkpoints", "An interactive Ink TUI — deferred to arc 3"]);
  });

  test("does not warn or add a field when the spec declares no exclusions", async () => {
    await withWarnSpy(async (warnSpy) => {
      const noScopeInput = { ...input, specContent: "# Feature\n\n## Design\n- build it\n" };
      const result = await runVerify(prdWith(), noScopeInput as never, makeInteractiveVerifyCtx() as never);
      expect(result?.outOfScope).toBeUndefined();
      expect(warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("out-of-scope"))).toBeUndefined();
    });
  });
});
