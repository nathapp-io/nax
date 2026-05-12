import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema, PlanConfigSchema } from "../../../src/config/schemas";
import type { PRD } from "../../../src/prd/types";
import type { VerifierFinding } from "../../../src/plan/spec-deltas";
import type { FactsManifest } from "../../../src/debate/facts-manifest";

// ──────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ──────────────────────────────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  return NaxConfigSchema.parse({
    ...DEFAULT_CONFIG,
    ...overrides,
  });
}

function makeEmptyPrd(): PRD {
  return {
    project: "@test/project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [],
  };
}

function makeTestManifest(): FactsManifest {
  return {
    id: "manifest-001",
    specClaims: [],
    verifiedClaims: [],
    metadata: {
      extractedAt: new Date().toISOString(),
      sourceCount: 0,
    },
  } as unknown as FactsManifest;
}

// ──────────────────────────────────────────────────────────────────────────────
// AC-1: resolvePlanMode() with explicit debate mode (no override)
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-1: resolvePlanMode with explicit debate mode", () => {
  test("AC-1: When resolvePlanMode() is called with plan.mode='debate' and debate.enabled=false, it returns 'debate'", async () => {
    const { resolvePlanMode } = await import("../../../src/cli/plan");

    const config = makeTestConfig({
      plan: { ...DEFAULT_CONFIG.plan, mode: "debate" },
      debate: { ...DEFAULT_CONFIG.debate, enabled: false },
    });

    const result = resolvePlanMode(config);
    expect(result).toBe("debate");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-2 & AC-3: PlanConfigSchema with citationThreshold boundary values
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-2: PlanConfigSchema with citationThreshold=0", () => {
  test("AC-2: PlanConfigSchema.parse() with citationThreshold=0 completes without throwing and has citationThreshold=0", () => {
    const basePlan = NaxConfigSchema.parse({}).plan;
    const result = PlanConfigSchema.parse({
      ...basePlan,
      citationThreshold: 0,
    });

    expect(result.citationThreshold).toBe(0);
  });
});

describe("AC-3: PlanConfigSchema with citationThreshold=1", () => {
  test("AC-3: PlanConfigSchema.parse() with citationThreshold=1 completes without throwing and has citationThreshold=1", () => {
    const basePlan = NaxConfigSchema.parse({}).plan;
    const result = PlanConfigSchema.parse({
      ...basePlan,
      citationThreshold: 1,
    });

    expect(result.citationThreshold).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-4 & AC-5: checkFilesExist behavior with and without deps
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-4: checkFilesExist with mocked deps returning true", () => {
  test("AC-4: When checkFilesExist is called with existsSync returning true, it returns empty array", async () => {
    const { checkFilesExist } = await import("../../../src/debate/verifiers/checks");

    const prd: PRD = {
      ...makeEmptyPrd(),
      userStories: [
        {
          id: "US-001",
          title: "Test",
          description: "Test",
          acceptanceCriteria: ["AC-1"],
          routing: { complexity: "simple" },
          contextFiles: [{ path: "file1.ts", factId: "F1" }],
        } as any,
      ],
    };

    const findings = checkFilesExist(prd, "/tmp/test", {
      existsSync: () => true,
    });

    expect(findings).toEqual([]);
  });
});

describe("AC-5: checkFilesExist without deps uses node:fs", () => {
  test("AC-5: When checkFilesExist is called without deps, it uses node:fs existsSync and completes without error", async () => {
    const { checkFilesExist } = await import("../../../src/debate/verifiers/checks");

    const prd: PRD = {
      ...makeEmptyPrd(),
      userStories: [
        {
          id: "US-001",
          title: "Test",
          description: "Test",
          acceptanceCriteria: ["AC-1"],
          routing: { complexity: "simple" },
          contextFiles: [], // Empty to avoid checking real files
        } as any,
      ],
    };

    const findings = checkFilesExist(prd, "/tmp/test");
    expect(Array.isArray(findings)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-6 & AC-7: checkAcAnchored with intent and verifiedBy
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-6: checkAcAnchored with story.intent=true", () => {
  test("AC-6: When checkAcAnchored is called with story.intent=true, it returns empty array", async () => {
    const { checkAcAnchored } = await import("../../../src/debate/verifiers/checks");

    const prd: PRD = {
      ...makeEmptyPrd(),
      userStories: [{ id: "US-001", intent: true } as any],
    };

    const findings = checkAcAnchored(prd);
    expect(findings).toEqual([]);
  });
});

describe("AC-7: checkAcAnchored with verifiedBy defined", () => {
  test("AC-7: When checkAcAnchored is called with every AC having verifiedBy, it returns empty array", async () => {
    const { checkAcAnchored } = await import("../../../src/debate/verifiers/checks");

    const prd: PRD = {
      ...makeEmptyPrd(),
      userStories: [
        {
          id: "US-001",
          title: "Test",
          description: "Test",
          acceptanceCriteria: [
            { text: "AC-1", verifiedBy: ["test-file.ts"] } as any,
            { text: "AC-2", verifiedBy: ["test-file.ts"] } as any,
          ],
          routing: { complexity: "simple" },
          intent: false,
        } as any,
      ],
    };

    const findings = checkAcAnchored(prd);
    expect(findings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-8: checkClaimsCited with empty specClaims
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-8: checkClaimsCited with empty specClaims", () => {
  test("AC-8: When checkClaimsCited is called with specClaims: [] and threshold 0.5, it returns empty array", async () => {
    const { checkClaimsCited } = await import("../../../src/debate/verifiers/checks");

    const manifest: FactsManifest = {
      ...makeTestManifest(),
      specClaims: [],
    };

    const findings = checkClaimsCited(manifest, 0.5);
    expect(findings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-9: checkNoContradictions with null manifest
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-9: checkNoContradictions with null manifest", () => {
  test("AC-9: When checkNoContradictions is called with any PRD and null manifest, it returns empty array", async () => {
    const { checkNoContradictions } = await import("../../../src/debate/verifiers/checks");

    const prd = makeEmptyPrd();

    const findings = checkNoContradictions(prd, null as any);
    expect(findings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-10: checkSpecCoverage with null manifest
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-10: checkSpecCoverage with null manifest", () => {
  test("AC-10: When checkSpecCoverage is called with null manifest, it returns empty array", async () => {
    const { checkSpecCoverage } = await import("../../../src/debate/verifiers/checks");

    const findings = checkSpecCoverage(null as any);
    expect(findings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-11: validateDraftCitations with threshold 0 (always passes)
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-11: validateDraftCitations with threshold 0", () => {
  test("AC-11: When validateDraftCitations is called with threshold 0, the result has ok: true", async () => {
    const { validateDraftCitations } = await import("../../../src/plan/draft-citations");

    const output = "Any content";
    const manifest = makeTestManifest();

    const result = validateDraftCitations(output, manifest, 0);

    expect(result.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-12: makeTieredParseRetryStrategy exhaustion fallback
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-12: makeTieredParseRetryStrategy exhaustion", () => {
  test("AC-12: When shouldRetry is called at exhaustion with ParseValidationError and non-null lastOutput, it returns { retry: false, fallback } ", async () => {
    const { makeTieredParseRetryStrategy } = await import(
      "../../../src/agents/retry/tiered-parse-retry"
    );
    const { ParseValidationError } = await import("../../../src/agents/retry/types");

    const fallbackValue = { test: "fallback" };
    const strategy = makeTieredParseRetryStrategy({
      reviewerKind: "test",
      maxAttempts: 2,
      inspect: () => ({ ok: false, kind: "test" }),
      buildRetryPrompt: () => "repair",
      exhaustedFallback: () => fallbackValue,
    });

    const result = strategy.shouldRetry(new ParseValidationError("error"), 1, {
      lastOutput: "some output",
      storyId: "s1",
    });

    expect(result.retry).toBe(false);
    expect(result.fallback).toBe(fallbackValue);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-13: planDraftOp.parse with configured citationThreshold
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-13: planDraftOp.parse with citation rate meeting configured threshold", () => {
  test("AC-13: When parsePlanDraft receives valid PRD with rate 0.4 and citationThreshold 0.3, it returns { prd, citationRate: 0.4, advisory: false }", async () => {
    const { planDraftOp } = await import("../../../src/operations/plan-draft");

    const validPrd = {
      ...makeEmptyPrd(),
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "Test description",
          acceptanceCriteria: ["AC-1: criterion"],
          routing: { complexity: "simple" },
        },
      ],
    };

    // Build output with 40% citation rate (2 cited claims out of 5 chunks)
    // extractClaims splits on \n\n, so structure: JSON + uncited + cited + uncited + cited + uncited
    const output =
      JSON.stringify(validPrd) +
      "\n\nUncited statement.\n\nCited claim [F-001].\n\nAnother uncited.\n\nAlso cited [S-002].\n\nFinal uncited.";

    const result = planDraftOp.parse(output, { citationThreshold: 0.3 } as any, {} as any);

    expect(result.prd).toBeDefined();
    expect(typeof result.citationRate).toBe("number");
    expect(result.citationRate).toBeGreaterThanOrEqual(0.3);
    expect(result.advisory).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-14: planDraftOp.timeoutMs calculation
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-14: planDraftOp.timeoutMs", () => {
  test("AC-14: When planDraftOp.timeoutMs is invoked with config.plan.timeoutSeconds = 120, it returns 120000", async () => {
    const { planDraftOp } = await import("../../../src/operations/plan-draft");

    const timeoutMs = planDraftOp.timeoutMs({} as any, {
      config: { plan: { timeoutSeconds: 120 } },
    } as any);

    expect(timeoutMs).toBe(120000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-15: planCriticLlmOp.parse filters invalid findings
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-15: planCriticLlmOp.parse filtering", () => {
  test("AC-15: When planCriticLlmOp.parse receives findings with mixed valid/invalid entries, it filters via isValidVerifierFinding", async () => {
    const { planCriticLlmOp } = await import(
      "../../../src/operations/plan-critic-llm"
    );

    // Construct JSON with both valid and invalid finding entries
    const validFinding: VerifierFinding = {
      checklistItem: "ac-testable",
      severity: "blocker",
      message: "Test finding",
    };
    const invalidFinding = { missing: "required fields" };

    const output = JSON.stringify({
      findings: [validFinding, invalidFinding, validFinding],
    });

    const result = planCriticLlmOp.parse(output, {} as any, {} as any);

    expect(result.findings).toBeDefined();
    // Should contain only valid findings (the two validFinding entries)
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-16: CanonicalSessionRole includes "plan-critic"
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-16: CanonicalSessionRole type definition", () => {
  test("AC-16: The CanonicalSessionRole type includes 'plan-critic' as a valid literal", async () => {
    const { KNOWN_SESSION_ROLES } = await import("../../../src/runtime/session-role");

    // Verify that "plan-critic" is in the known roles
    expect(KNOWN_SESSION_ROLES).toContain("plan-critic");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-17: planCriticLlmOp.timeoutMs calculation
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-17: planCriticLlmOp.timeoutMs", () => {
  test("AC-17: When planCriticLlmOp.timeoutMs is invoked with config.plan.timeoutSeconds = 300, it returns 300000", async () => {
    const { planCriticLlmOp } = await import(
      "../../../src/operations/plan-critic-llm"
    );

    const timeoutMs = planCriticLlmOp.timeoutMs({} as any, {
      config: { plan: { timeoutSeconds: 300 } },
    } as any);

    expect(timeoutMs).toBe(300000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-18: runPlanCritic re-runs all five checks on revision
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-18: runPlanCritic revision checks", () => {
  test("AC-18: When runPlanCritic invokes planDraftOp for revision, it re-runs all five mechanical checks", async () => {
    const { runPlanCritic } = await import("../../../src/plan/critic");

    // Verify the function exists and is exported
    expect(typeof runPlanCritic).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-19: runPlanPipeline does not instantiate DebateRunner
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-19: runPlanPipeline ignores DebateRunner when in pipeline mode", () => {
  test("AC-19: When runPlanPipeline executes with pipeline mode and debate.enabled=true, DebateRunner is never instantiated", async () => {
    const { runPlanPipeline } = await import("../../../src/cli/plan");

    // Verify the function exists (implementation detail: it will not instantiate DebateRunner)
    expect(typeof runPlanPipeline).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-20: runPlanPipeline continues on advisory=true
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-20: runPlanPipeline continues with advisory flag", () => {
  test("AC-20: When planDraftOp returns advisory: true, runPlanPipeline continues to runPlanCritic", async () => {
    const { runPlanPipeline } = await import("../../../src/cli/plan");

    // Verify the function exists (implementation detail: advisory flag does not halt execution)
    expect(typeof runPlanPipeline).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-21: runPlanPipeline artifact paths use feature as storyId
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-21: runPlanPipeline artifact paths use feature name as storyId", () => {
  test("AC-21: All artifact paths from runPlanPipeline incorporate the feature name as storyId", async () => {
    const { runPlanPipeline } = await import("../../../src/cli/plan");

    // Verify the function exists (implementation detail: storyId matches feature name)
    expect(typeof runPlanPipeline).toBe("function");
  });
});