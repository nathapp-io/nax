import { describe, expect, test } from "bun:test";
import { assertDefined, makeMockCallContext, makeSpawn, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG, resolveConfiguredModel, tddConfigSelector } from "@/config";
import { implementerOp, testWriterOp } from "@/operations";
import type { UserStory } from "@/prd";

/** Real package view for parse/verify/build contexts — read-only surface the ops actually use. */
const testPackageView = makeMockCallContext().packageView;

async function runVerify(
  parsed: Parameters<NonNullable<typeof implementerOp.verify>>[0],
  input: Parameters<NonNullable<typeof implementerOp.verify>>[1],
  ctx: Parameters<NonNullable<typeof implementerOp.verify>>[2],
) {
  assertDefined(implementerOp.verify, "implementerOp.verify");
  return implementerOp.verify(parsed, input, ctx);
}

/**
 * Tests for implementerOp — the full RunOperation shape for the implementer role.
 *
 * AC-1: implementerOp.kind equals "run", implementerOp.session.role equals
 * "implementer", and implementerOp.session.lifetime equals "warm".
 *
 * AC-4: Given implementerOp.parse receives empty output, when parse executes,
 * then it returns ImplementerOutput with success: false and filesChanged: [].
 * Given a buildHopCallback error string ('Agent "..." failed: ...'), parse
 * returns success: false. Given non-error non-empty output (prose or JSON),
 * parse returns success: true — session exited 0, treat as success.
 *
 * AC-5: Given upgraded TDD op parse cannot produce a usable value and op-level
 * recover can derive output from disk artifacts, when callOp post-parse flow
 * runs, then it returns recovered output instead of throwing parse failure.
 */

describe("implementerOp — RunOperation shape", () => {
  test("exports implementerOp as a RunOperation with kind=run", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp).toBeDefined();
    expect(implementerOp.kind).toBe("run");
  });

  test("implementerOp.session.role equals 'implementer'", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.session.role).toBe("implementer");
  });

  test("implementerOp.session.lifetime equals 'warm'", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.session.lifetime).toBe("warm");
  });

  test.each([["name" as const], ["stage" as const]])("implementerOp has a non-empty %s string", async (field) => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp[field]).toBe("string");
    expect(implementerOp[field]).toBeTruthy();
  });

  test("implementerOp has a config selector", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.config).toBeDefined();
  });

  test.each([["build" as const], ["parse" as const]])("implementerOp has a %s function", async (method) => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp[method]).toBe("function");
  });
});

describe("implementerOp.parse — error handling", () => {
  test("returns ImplementerOutput with success=false when output is empty", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const result = implementerOp.parse("", input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns ImplementerOutput with success=false when output is a buildHopCallback error string", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const result = implementerOp.parse('Agent "mock" failed: Agent failed', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns ImplementerOutput with success=true when output is non-empty prose", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const result = implementerOp.parse("I implemented the story and committed all changes.", input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(result.output).toBe("I implemented the story and committed all changes.");
  });

  test("returns ImplementerOutput with success=true when output is malformed JSON (non-agent-error)", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const result = implementerOp.parse('{ "broken": ', input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(result.output).toBe('{ "broken": ');
  });

  test("returns ImplementerOutput with all required fields on parse failure", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const result = implementerOp.parse("", input, ctx);

    expect(result.success).toBeDefined();
    expect(result.filesChanged).toBeDefined();
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("implementerOp.recover — disk artifact recovery", () => {
  test("implementerOp has an optional recover function", async () => {
    const { implementerOp } = await import("@/operations");
    // recover is optional per ADR-020 §D4
    if (implementerOp.recover) {
      expect(typeof implementerOp.recover).toBe("function");
    }
  });

  test("when recover exists, it accepts input and VerifyContext", async () => {
    const { implementerOp } = await import("@/operations");
    // Type check that recover signature is correct if it exists
    if (implementerOp.recover) {
      const recoverFn = implementerOp.recover;
      expect(recoverFn.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("implementerOp input/output types", () => {
  test("implementerOp input includes story", async () => {
    // Verifying the input type carries story field
    const { implementerOp: _implementerOp } = await import("@/operations");
    const mockInput = {
      story: makeStory({ id: "US-001" }),
    };
    // If this compiles, the type is correct
    expect(mockInput.story).toBeDefined();
  });

  test("implementerOp output includes success, filesChanged, estimatedCostUsd, durationMs", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: makeStory({ id: "US-001" }),
    };

    const output = implementerOp.parse("", input, ctx);

    expect("success" in output).toBe(true);
    expect("filesChanged" in output).toBe(true);
    expect("estimatedCostUsd" in output).toBe(true);
    expect("durationMs" in output).toBe(true);
    expect("output" in output).toBe(true);
  });
});

describe("implementerOp.verify — isolation", () => {
  test("attaches isolation with warnings when implementer touched test files", async () => {
    const { implementerOp: _implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = makeSpawn(() => "src/foo.ts\ntest/foo.test.ts\n").spawn;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts", "test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" };
      const ctx = {
        packageView: testPackageView,
        config: DEFAULT_CONFIG,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      const isolation = result.isolation;
      assertDefined(isolation, "verify().isolation");
      expect(isolation.passed).toBe(true);
      expect(isolation.warnings).toContain("test/foo.test.ts");
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("attaches passing isolation when implementer touched only source files", async () => {
    const { implementerOp: _implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = makeSpawn(() => "src/foo.ts\n").spawn;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" };
      const ctx = {
        packageView: testPackageView,
        config: DEFAULT_CONFIG,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await runVerify(parsed, input, ctx);
      assertDefined(result, "verify() result");
      const isolation = result.isolation;
      assertDefined(isolation, "verify().isolation");
      expect(isolation.passed).toBe(true);
      expect(isolation.warnings ?? []).toEqual([]);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("returns parsed unchanged when beforeRef absent", async () => {
    const { implementerOp: _implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const parsed = {
      success: true,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input = { story: makeStory({ id: "US-001" }) };
    const ctx = {
      packageView: testPackageView,
      config: DEFAULT_CONFIG,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await runVerify(parsed, input, ctx);
    expect(result).toEqual(parsed);
  });
});

function storyWithTier(tier: string | undefined): UserStory {
  return makeStory({
    routing: tier ? { complexity: "medium", modelTier: tier, testStrategy: "tdd-simple", reasoning: "" } : undefined,
  });
}

const buildCtx = { config: tddConfigSelector.select(DEFAULT_CONFIG), packageView: testPackageView };

function tddBuildCtx(sessionTiers: Partial<typeof DEFAULT_CONFIG.tdd.sessionTiers> = {}) {
  return {
    config: {
      ...tddConfigSelector.select(DEFAULT_CONFIG),
      tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: { ...DEFAULT_CONFIG.tdd.sessionTiers, ...sessionTiers } },
    },
    packageView: testPackageView,
  };
}

describe("implementerOp.model — routing-driven", () => {
  test("returns the story's initial modelTier", () => {
    const model = implementerOp.model;
    expect(typeof model === "function" ? model({ story: storyWithTier("fast") }, buildCtx) : model).toBe("fast");
  });

  test("follows the escalated tier (escalation mutates story.routing.modelTier)", () => {
    const model = implementerOp.model;
    expect(typeof model === "function" ? model({ story: storyWithTier("powerful") }, buildCtx) : model).toBe(
      "powerful",
    );
  });

  test("uses a literal profile pin with its assigned agent", () => {
    const model = implementerOp.model;
    const story = makeStory({
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "tdd-simple",
        reasoning: "",
        agent: "claude",
        profileModelPin: "claude-opus-5-1",
      },
    });

    expect(typeof model === "function" ? model({ story }, buildCtx) : model).toEqual({
      agent: "claude",
      model: "claude-opus-5-1",
    });
  });

  test("returns undefined when routing is absent (callOp then defaults)", () => {
    const model = implementerOp.model;
    expect(typeof model === "function" ? model({ story: storyWithTier(undefined) }, buildCtx) : model).toBeUndefined();
  });
});

describe("per-role tier reaches effectiveTier (callOp contract)", () => {
  const models = {
    opencode: { fast: "minimax/MiniMax-M2.7", balanced: "opencode-go/deepseek-v4-pro", powerful: "minimax/MiniMax-M3" },
  };

  test("fast story → implementer resolves to the fast model, NOT balanced", () => {
    const model = implementerOp.model;
    const opModel =
      (typeof model === "function" ? model({ story: storyWithTier("fast") }, buildCtx) : model) ?? "balanced";
    const resolved = resolveConfiguredModel(models, "opencode", opModel, "opencode");
    expect(resolved.modelTier).toBe("fast");
  });

  test("unconfigured test-writer still defaults to fast via schema, not balanced", () => {
    const model = testWriterOp.model;
    const opModel =
      (typeof model === "function" ? model({ story: makeStory() }, tddBuildCtx({ testWriter: "fast" })) : model) ??
      "balanced";
    const resolved = resolveConfiguredModel(models, "opencode", opModel, "opencode");
    expect(resolved.modelTier).toBe("fast");
  });
});
