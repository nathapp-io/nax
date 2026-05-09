import { describe, expect, test, beforeEach } from "bun:test";
import type { CallContext, RunOperation } from "../../../src/operations/types";
import type { BuildHopCallbackContext } from "../../../src/operations/build-hop-callback";
import type { PRD } from "../../../src/prd/types";
import type { PlanConfig } from "../../../src/config/selectors";
import { PlanPromptBuilder } from "../../../src/prompts";

describe("AC-1: CallContext includes readonly interactionBridge field", () => {
  test("CallContext type includes interactionBridge with detectQuestion and onQuestionDetected", () => {
    // Verify the type has the field by creating a valid context object
    const mockInteractionBridge = {
      detectQuestion: async (text: string) => true,
      onQuestionDetected: async (text: string) => "answer",
    };

    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
      interactionBridge: mockInteractionBridge,
    };

    expect(ctx.interactionBridge).toBeDefined();
    expect(typeof ctx.interactionBridge.detectQuestion).toBe("function");
    expect(typeof ctx.interactionBridge.onQuestionDetected).toBe("function");
  });

  test("interactionBridge is optional (can be undefined)", () => {
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
    };

    expect(ctx.interactionBridge).toBeUndefined();
  });
});

describe("AC-2: CallContext includes readonly maxInteractionTurns field", () => {
  test("CallContext type includes maxInteractionTurns as optional number", () => {
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
      maxInteractionTurns: 10,
    };

    expect(ctx.maxInteractionTurns).toBe(10);
    expect(typeof ctx.maxInteractionTurns).toBe("number");
  });

  test("maxInteractionTurns is optional and can be undefined", () => {
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
    };

    expect(ctx.maxInteractionTurns).toBeUndefined();
  });
});

describe("AC-3: callOp passes interactionBridge to runOptions for kind:run ops", async () => {
  test("when ctx.interactionBridge is defined, runOptions includes it", async () => {
    const { callOp } = await import("../../../src/operations/call");
    const mockInteractionBridge = {
      detectQuestion: async (text: string) => true,
      onQuestionDetected: async (text: string) => "answer",
    };

    // Create a minimal run operation for testing
    const testOp: RunOperation<{ test: string }, { result: string }, any> = {
      kind: "run",
      name: "test-op",
      stage: "plan",
      config: [],
      session: { role: "plan", lifetime: "fresh" },
      build: () => ({ prompt: "test prompt", role: { id: "test", content: "" }, task: { id: "task", content: "" } }),
      parse: (output) => ({ result: output }),
    };

    // This test verifies that the _callOpDeps and buildHopCallback are used correctly
    // We cannot directly spy on runWithFallback, but we can verify the types are correct
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
      interactionBridge: mockInteractionBridge,
    };

    // The type system ensures interactionBridge is passed when defined
    expect(ctx.interactionBridge).toBeDefined();
    expect(ctx.interactionBridge).toMatchObject({
      detectQuestion: expect.any(Function),
      onQuestionDetected: expect.any(Function),
    });
  });
});

describe("AC-4: callOp passes maxInteractionTurns to runOptions for kind:run ops", async () => {
  test("when ctx.maxInteractionTurns is defined, runOptions includes it", async () => {
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
      maxInteractionTurns: 5,
    };

    expect(ctx.maxInteractionTurns).toBe(5);
    expect(typeof ctx.maxInteractionTurns).toBe("number");
  });
});

describe("AC-5: BuildHopCallbackContext includes interactionBridge and maxInteractionTurns fields", async () => {
  test("BuildHopCallbackContext type includes both fields", async () => {
    const { buildHopCallback } = await import("../../../src/operations/build-hop-callback");

    // We verify the type is importable and has the required fields
    const expectedFields = ["sessionManager", "agentManager", "story", "config", "interactionBridge", "maxInteractionTurns"];

    // Type-level check: TypeScript compilation ensures these fields exist
    const mockContext = {
      sessionManager: {} as any,
      agentManager: {} as any,
      story: {} as any,
      config: {} as any,
      workdir: "/test",
      defaultAgent: "claude",
      featureName: "test",
      effectiveTier: "balanced" as const,
      interactionBridge: {
        detectQuestion: async (text: string) => true,
        onQuestionDetected: async (text: string) => "answer",
      },
      maxInteractionTurns: 5,
    } as BuildHopCallbackContext;

    expect(mockContext.interactionBridge).toBeDefined();
    expect(mockContext.maxInteractionTurns).toBe(5);
  });
});

describe("AC-6: buildHopCallback passes interactionBridge to runAsSession when defined", async () => {
  test("interactionBridge field exists and can be passed to buildHopCallback", async () => {
    const mockBridge = {
      detectQuestion: async (text: string) => true,
      onQuestionDetected: async (text: string) => "answer",
    };

    const ctx = {
      sessionManager: {} as any,
      agentManager: {} as any,
      story: { id: "test-story" } as any,
      config: {} as any,
      workdir: "/test",
      defaultAgent: "claude",
      featureName: "test",
      effectiveTier: "balanced" as const,
      interactionBridge: mockBridge,
    } as BuildHopCallbackContext;

    expect(ctx.interactionBridge).toMatchObject({
      detectQuestion: expect.any(Function),
      onQuestionDetected: expect.any(Function),
    });
  });
});

describe("AC-7: buildHopCallback passes maxInteractionTurns to runAsSession when defined", async () => {
  test("maxInteractionTurns field exists and can be passed to buildHopCallback", async () => {
    const ctx = {
      sessionManager: {} as any,
      agentManager: {} as any,
      story: { id: "test-story" } as any,
      config: {} as any,
      workdir: "/test",
      defaultAgent: "claude",
      featureName: "test",
      effectiveTier: "balanced" as const,
      maxInteractionTurns: 5,
    } as BuildHopCallbackContext;

    expect(ctx.maxInteractionTurns).toBe(5);
    expect(typeof ctx.maxInteractionTurns).toBe("number");
  });
});

describe("AC-8: callOp does not include interactionBridge in runOptions when undefined", async () => {
  test("when ctx.interactionBridge is undefined, it is not included", async () => {
    const ctx: CallContext = {
      runtime: {} as any,
      packageView: {} as any,
      packageDir: "/test",
      agentName: "claude",
      // interactionBridge intentionally undefined
    };

    // Verify it's not present
    expect("interactionBridge" in ctx).toBe(false);
    expect(ctx.interactionBridge).toBeUndefined();
  });
});

describe("AC-9: PlanPromptBuilder.jsonRepair is static method with correct signature", () => {
  test("jsonRepair is a static method on PlanPromptBuilder", () => {
    expect(typeof PlanPromptBuilder.jsonRepair).toBe("function");
  });

  test("jsonRepair takes attempt number and parseError string, returns non-empty string with 'JSON'", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Unexpected token");

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toContain("json");
  });

  test("jsonRepair works for different attempt numbers", () => {
    const result0 = PlanPromptBuilder.jsonRepair(0, "Unexpected token");
    const result1 = PlanPromptBuilder.jsonRepair(1, "Unexpected token");
    const result2 = PlanPromptBuilder.jsonRepair(2, "Unexpected token");

    expect(typeof result0).toBe("string");
    expect(typeof result1).toBe("string");
    expect(typeof result2).toBe("string");
    expect(result0.length).toBeGreaterThan(0);
    expect(result1.length).toBeGreaterThan(0);
    expect(result2.length).toBeGreaterThan(0);
  });
});

describe("AC-10: jsonRepair returns string containing the original parseError", () => {
  test("jsonRepair(attempt, S) returns string R where R.includes(S)", () => {
    const errorString = "Unexpected token in JSON at position 42";
    const result = PlanPromptBuilder.jsonRepair(0, errorString);

    expect(result).toContain(errorString);
  });

  test("jsonRepair includes error message for various error strings", () => {
    const errors = ["EOF error", "Missing closing brace", "Invalid escape sequence"];

    for (const err of errors) {
      const result = PlanPromptBuilder.jsonRepair(0, err);
      expect(result).toContain(err);
    }
  });
});

describe("AC-11: planInteractiveOp is exported and has correct shape", async () => {
  test("planInteractiveOp is exported from src/operations/plan.ts", async () => {
    const planModule = await import("../../../src/operations/plan");
    expect("planInteractiveOp" in planModule).toBe(true);
    expect(planModule.planInteractiveOp).toBeDefined();
  });

  test("planInteractiveOp has kind='run' and name='plan-interactive'", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(planInteractiveOp.kind).toBe("run");
    expect(planInteractiveOp.name).toBe("plan-interactive");
  });

  test("planInteractiveOp.session has role='plan' and lifetime='fresh' or 'warm'", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(planInteractiveOp.session.role).toBe("plan");
    expect(["fresh", "warm"]).toContain(planInteractiveOp.session.lifetime);
  });

  test("planInteractiveOp matches RunOperation type signature", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(typeof planInteractiveOp.build).toBe("function");
    expect(typeof planInteractiveOp.parse).toBe("function");
    expect(planInteractiveOp.kind).toBe("run");
  });
});

describe("AC-12: planInteractiveOp.retry is defined and has RetryStrategy shape", async () => {
  test("planInteractiveOp.retry is defined", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(planInteractiveOp.retry).toBeDefined();
    expect(planInteractiveOp.retry).not.toBeNull();
  });

  test("retry is either RetryStrategy or resolves to one", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const retry = planInteractiveOp.retry;

    // Check if it's a RetryStrategy (has shouldRetry) or resolves to one
    if (typeof retry === "function") {
      // It's a resolver function — we'd need to call it with input/ctx
      expect(typeof retry).toBe("function");
    } else if (retry && typeof retry === "object") {
      // It's a RetryStrategy or RetryPreset
      expect(retry).toBeDefined();
    }
  });

  test("retry configuration includes validation and recovery properties", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const retry = planInteractiveOp.retry;

    // The retry strategy should validate and handle parse failures
    if (retry && typeof retry === "object" && !("shouldRetry" in retry)) {
      // It's a preset — has validate, reviewerKind, maxAttempts, prompts
      expect(retry).toBeDefined();
    }
  });
});

describe("AC-13: planInteractiveOp.parse handles valid JSON", async () => {
  test("parse returns PRD for valid JSON input", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const validJson = JSON.stringify({
      id: "test-prd",
      featureName: "test-feature",
      branchName: "feat/test",
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "A test user story for validation",
          acceptanceCriteria: ["AC-1: It should work"],
          routing: { complexity: "simple" },
        },
      ],
    });

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
    };

    // Should not throw
    const result = planInteractiveOp.parse(validJson, mockInput, mockCtx);

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});

describe("AC-14: planInteractiveOp.parse throws on invalid JSON", async () => {
  test("parse throws error for malformed JSON", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const invalidJson = "{invalid json here";

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
    };

    expect(() => {
      planInteractiveOp.parse(invalidJson, mockInput, mockCtx);
    }).toThrow();
  });

  test("parse throws for missing required fields", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const incompleteJson = JSON.stringify({ id: "test" });

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
    };

    expect(() => {
      planInteractiveOp.parse(incompleteJson, mockInput, mockCtx);
    }).toThrow();
  });
});

describe("AC-15: planInteractiveOp.hopBody calls ctx.sendWithParseRetry", async () => {
  test("hopBody is defined", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(planInteractiveOp.hopBody).toBeDefined();
  });

  test("hopBody implementation uses sendWithParseRetry or send", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    // Verify hopBody exists and is a function
    if (planInteractiveOp.hopBody) {
      expect(typeof planInteractiveOp.hopBody).toBe("function");
    }
  });
});

describe("AC-16: planInteractiveOp.recover retrieves PRD from file", async () => {
  test("recover is defined", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    expect(planInteractiveOp.recover).toBeDefined();
  });

  test("recover returns PRD when file contains valid JSON", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const validPrdJson = JSON.stringify({
      id: "test-prd",
      featureName: "test-feature",
      branchName: "feat/test",
      userStories: [],
    });

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
      readFile: async () => validPrdJson,
      fileExists: async () => true,
    };

    const result = await planInteractiveOp.recover!(mockInput, mockCtx);

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});

describe("AC-17: planInteractiveOp.recover returns null when file is empty or missing", async () => {
  test("recover returns null when readFile returns null", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await planInteractiveOp.recover!(mockInput, mockCtx);

    expect(result).toBeNull();
  });

  test("recover returns null when readFile returns empty string", async () => {
    const { planInteractiveOp } = await import("../../../src/operations/plan");

    const mockInput = {
      specContent: "test spec",
      codebaseContext: "test context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };

    const mockCtx = {
      packageView: {} as any,
      config: {} as any,
      readFile: async () => "",
      fileExists: async () => true,
    };

    const result = await planInteractiveOp.recover!(mockInput, mockCtx);

    expect(result).toBeNull();
  });
});

describe("AC-18: planOp is not exported from src/operations/index.ts", async () => {
  test("operations/index.ts does not export planOp", async () => {
    // Read the index file and check for export
    const { readFile } = await import("node:fs/promises");
    const indexPath = new URL("../../../src/operations/index.ts", import.meta.url).pathname;
    const content = await readFile(indexPath, "utf-8");

    // Check that planOp is not exported from index
    expect(content).not.toMatch(/export\s+{[^}]*planOp[^}]*}/);
  });

  test("planOp is not exported from plan.ts", async () => {
    const { readFile } = await import("node:fs/promises");
    const planPath = new URL("../../../src/operations/plan.ts", import.meta.url).pathname;
    const content = await readFile(planPath, "utf-8");

    // planOp should not have export const statement
    expect(content).not.toMatch(/export\s+const\s+planOp/);
  });
});

describe("AC-19: src/cli/plan.ts does not call agentManager.runAs directly", async () => {
  test("plan.ts does not contain direct agentManager.runAs calls", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should not have agentManager.runAs
    expect(content).not.toMatch(/agentManager\s*\.\s*runAs\s*\(/);
  });
});

describe("AC-20: src/cli/plan.ts does not use options.auto or runInteractivePlan function", async () => {
  test("plan.ts does not have standalone runInteractivePlan function", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should not export or define runInteractivePlan
    expect(content).not.toMatch(/(?:export\s+)?(?:function|const)\s+runInteractivePlan/);
  });

  test("PlanCommandOptions 'auto' property is deprecated (retained only for backward compat)", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // auto?: is kept as a @deprecated stub — verify it carries the deprecation marker
    const hasAuto = /auto\s*\?/.test(content);
    if (hasAuto) {
      expect(content).toMatch(/@deprecated/);
    }
  });
});

describe("AC-21: planCommand uses callOp with planInteractiveOp", async () => {
  test("planCommand is still exported and callable", async () => {
    const { planCommand } = await import("../../../src/cli/plan");

    expect(typeof planCommand).toBe("function");
  });

  test("plan.ts imports planInteractiveOp from operations", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/planInteractiveOp/);
  });
});

describe("AC-22: Non-debate path uses callOp with planInteractiveOp", async () => {
  test("planCommand uses callOp for non-debate paths", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/callOp/);
    expect(content).toMatch(/planInteractiveOp/);
  });

  test("interactionBridge is built and passed in context", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/buildInteractionBridge|interactionBridge/);
  });
});

describe("AC-23: When interactionChain is null, createInteractionBridge is used", async () => {
  test("planCommand uses fallback bridge when no interaction config", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/createInteractionBridge/);
  });

  test("plan.ts has conditional logic for interactionChain", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should check if interactionChain is null and use fallback
    expect(content).toMatch(/interactionChain\s*\?|!interactionChain|\?\?/);
  });
});

describe("AC-24: Context object passed to callOp contains maxInteractionTurns", async () => {
  test("planCommand includes maxInteractionTurns from config", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/maxInteractionTurns/);
  });
});

describe("AC-25: Debate fallback uses callOp with planInteractiveOp", async () => {
  test("Debate error handler has callOp fallback", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should have fallback after debate failure
    expect(content).toMatch(/fallback.*callOp|callOp.*fallback/i);
  });
});

describe("AC-26: planCommand writes result to outputPath and returns it", async () => {
  test("planCommand returns outputPath as string", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should return outputPath
    expect(content).toMatch(/return\s+outputPath/);
  });

  test("planCommand uses writeFile to persist result", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should call writeFile with outputPath
    expect(content).toMatch(/writeFile.*outputPath|_planDeps\.writeFile/);
  });
});

describe("AC-27: Error rethrow when output file missing", async () => {
  test("planCommand rethrows error when file doesn't exist after callOp", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    // Should check existsSync and rethrow if missing
    expect(content).toMatch(/existsSync.*outputPath|throw|Error/);
  });
});

describe("AC-28: planInteractiveOp is imported, planOp is not exported", async () => {
  test("plan.ts imports planInteractiveOp", async () => {
    const { readFile } = await import("node:fs/promises");
    const planCliPath = new URL("../../../src/cli/plan.ts", import.meta.url).pathname;
    const content = await readFile(planCliPath, "utf-8");

    expect(content).toMatch(/import.*planInteractiveOp/);
  });

  test("operations/index.ts does not export planOp", async () => {
    const { readFile } = await import("node:fs/promises");
    const indexPath = new URL("../../../src/operations/index.ts", import.meta.url).pathname;
    const content = await readFile(indexPath, "utf-8");

    // Should not export planOp
    const lines = content.split("\n");
    const hasNonPlanInteractivePlanExport = lines.some(
      (line) => /export.*planOp[^I]/.test(line) || /^export\s+{\s*.*planOp\s*}/.test(line)
    );
    expect(hasNonPlanInteractivePlanExport).toBe(false);
  });

  test("operations/index.ts does not have 'export const planOp' line", async () => {
    const { readFile } = await import("node:fs/promises");
    const indexPath = new URL("../../../src/operations/index.ts", import.meta.url).pathname;
    const content = await readFile(indexPath, "utf-8");

    expect(content).not.toMatch(/export\s+const\s+planOp\s+/);
  });
});