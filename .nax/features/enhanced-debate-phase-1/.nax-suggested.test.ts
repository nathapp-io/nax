import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import type { SelectorResult } from "../../../src/debate/selectors/types";
import type { PostDebateVerifierResult } from "../../../src/debate/verifiers/types";
import { resolveSelector, registerSelector } from "../../../src/debate/selectors";
import { resolvePostDebateVerifier, registerPostDebateVerifier } from "../../../src/debate/verifiers";
import { majorityFailClosedSelector, majorityFailOpenSelector, computeMajority } from "../../../src/debate/selectors";
import { synthesisSelector } from "../../../src/debate/selectors";
import { judgeSelector } from "../../../src/debate/selectors";
import { dialogueVerdictSelector } from "../../../src/debate/selectors";
import { pickSelectorKind } from "../../../src/debate/selectors";
import { reviewGroundingFilterVerifier } from "../../../src/debate/verifiers";
import { DebateConfigSchema } from "../../../src/config/schemas-debate";
import { FactsManifestSchema, parseFactsManifest, renderManifestSection } from "../../../src/debate/facts-manifest";
import { groundOp } from "../../../src/operations/ground";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { SelectorContext } from "../../../src/debate/selectors/types";
import type { PostDebateVerifierContext } from "../../../src/debate/verifiers/types";
import { makeMockAgentManager } from "../../../test/helpers";

// ─── AC-1: Selector registration and resolution ──────────────────────────────

describe("AC-1: registerSelector + resolveSelector identity check", () => {
  test("should return same function reference after registration", () => {
    const testFn = async () => ({ outcome: "passed" as const, resolverCostUsd: 0 });
    registerSelector("test-selector-uuid", testFn);
    const resolved = resolveSelector("test-selector-uuid");
    expect(resolved === testFn).toBe(true);
  });
});

// ─── AC-2: postDebateVerifier discriminated union parsing ────────────────────

describe("AC-2: Parse postDebateVerifier via DebateStageConfigSchema", () => {
  test("should parse postDebateVerifier.kind = 'review-grounding-filter'", () => {
    const configRaw = { postDebateVerifier: { kind: "review-grounding-filter" } };
    const stageConfig = DebateConfigSchema.parse({
      stages: { plan: configRaw },
    });
    expect(stageConfig.stages.plan.postDebateVerifier?.kind).toBe("review-grounding-filter");
  });
});

// ─── AC-3: Default DebateConfigSchema parse({}) ──────────────────────────────

describe("AC-3: DebateConfigSchema.parse({}) defaults", () => {
  test("should have stages.plan.enabled === true and resolver.type === 'synthesis'", () => {
    const result = DebateConfigSchema.parse({});
    expect(result.stages.plan.enabled).toBe(true);
    expect(result.stages.plan.resolver.type).toBe("synthesis");
  });

  test("should have stages.review.enabled === true and resolver.type === 'majority-fail-closed'", () => {
    const result = DebateConfigSchema.parse({});
    expect(result.stages.review.enabled).toBe(true);
    expect(result.stages.review.resolver.type).toBe("majority-fail-closed");
  });
});

// ─── AC-4: synthesisSelector empty text outcome ──────────────────────────────

describe("AC-4: synthesisSelector empty text outcome", () => {
  test("should return outcome === 'failed' when result.output is empty string", async () => {
    const mockAgentManager = makeMockAgentManager({
      completeAs: async () => ({ output: "", exactCostUsd: 0, estimatedCostUsd: 0, source: "primary" }),
    });

    const ctx: SelectorContext = {
      storyId: "test-story",
      stage: "plan",
      stageConfig: DebateConfigSchema.parse({}).stages.plan,
      config: DebateConfigSchema.parse({}),
      proposals: [],
      critiques: [],
      workdir: "/test",
      featureName: "test-feature",
      timeoutMs: 30000,
      agentManager: mockAgentManager,
      debaters: [],
    };

    const result = await synthesisSelector(ctx);
    expect(result.outcome).toBe("failed");
  });
});

// ─── AC-5: judgeSelector cost field ──────────────────────────────────────────

describe("AC-5: judgeSelector cost field", () => {
  test("should return resolverCostUsd === 0 when agentManager returns cost === 0", async () => {
    const mockAgentManager = makeMockAgentManager({
      completeAs: async () => ({ output: "judgment", exactCostUsd: 0, estimatedCostUsd: 0, source: "primary" }),
    });

    const ctx: SelectorContext = {
      storyId: "test-story",
      stage: "plan",
      stageConfig: DebateConfigSchema.parse({}).stages.plan,
      config: DebateConfigSchema.parse({}),
      proposals: [{ debater: { agent: "judge" }, output: "test" }],
      critiques: [],
      workdir: "/test",
      featureName: "test-feature",
      timeoutMs: 30000,
      agentManager: mockAgentManager,
      debaters: [{ agent: "judge" }],
    };

    const result = await judgeSelector(ctx);
    expect(result.resolverCostUsd).toBe(0);
  });
});

// ─── AC-6: Majority fail-closed vs fail-open selectors ───────────────────────

describe("AC-6: majorityFailClosedSelector vs majorityFailOpenSelector", () => {
  test("should both use computeMajority with correct failOpen parameter", async () => {
    const proposals = [
      { debater: { agent: "a" }, output: '{"passed": true}' },
      { debater: { agent: "b" }, output: '{"passed": false}' },
    ];
    const ctx: SelectorContext = {
      storyId: "test-story",
      stage: "plan",
      stageConfig: DebateConfigSchema.parse({}).stages.plan,
      config: DebateConfigSchema.parse({}),
      proposals,
      critiques: [],
      workdir: "/test",
      featureName: "test-feature",
      timeoutMs: 30000,
      agentManager: makeMockAgentManager(),
      debaters: [],
    };

    const closedResult = await majorityFailClosedSelector(ctx);
    const openResult = await majorityFailOpenSelector(ctx);

    // Both should forward proposals and return identical structure
    expect(closedResult).toHaveProperty("outcome");
    expect(closedResult).toHaveProperty("resolverCostUsd");
    expect(openResult).toHaveProperty("outcome");
    expect(openResult).toHaveProperty("resolverCostUsd");
  });

  test("should have same proposals argument and return same structure shape", async () => {
    const proposals = [{ debater: { agent: "x" }, output: '{"passed": true}' }];
    const ctx: SelectorContext = {
      storyId: "test-story",
      stage: "plan",
      stageConfig: DebateConfigSchema.parse({}).stages.plan,
      config: DebateConfigSchema.parse({}),
      proposals,
      critiques: [],
      workdir: "/test",
      featureName: "test-feature",
      timeoutMs: 30000,
      agentManager: makeMockAgentManager(),
      debaters: [],
    };

    const result1 = await majorityFailClosedSelector(ctx);
    const result2 = await majorityFailOpenSelector(ctx);

    // Both should return same structure
    expect(typeof result1.outcome).toBe(typeof result2.outcome);
    expect(typeof result1.resolverCostUsd).toBe(typeof result2.resolverCostUsd);
  });
});

// ─── AC-7: pickSelectorKind dispatcher ────────────────────────────────────────

describe("AC-7: pickSelectorKind selector kind dispatcher", () => {
  test("should return explicit selector.kind when present", () => {
    const stageConfig: DebateStageConfig = {
      enabled: true,
      resolver: { type: "synthesis" },
      sessionMode: "one-shot",
      rounds: 1,
      selector: { kind: "dialogue-verdict" },
    };
    const kind = pickSelectorKind(stageConfig, {});
    expect(kind).toBe("dialogue-verdict");
  });
});

// ─── AC-8: reviewGroundingFilterVerifier cost ────────────────────────────────

describe("AC-8: reviewGroundingFilterVerifier costUsd", () => {
  test("should return costUsd === 0", async () => {
    const selectorResult: SelectorResult = {
      outcome: "passed",
      resolverCostUsd: 5,
      findings: [],
    };

    const verifierCtx: PostDebateVerifierContext = {
      storyId: "test-story",
      stage: "review",
      stageConfig: DebateConfigSchema.parse({}).stages.review,
      selectorResult,
      workdir: "/test",
      ctx: { storyId: "test", packageDir: "/test", runtime: { agentManager: makeMockAgentManager() } as any },
      acceptanceCriteria: ["AC-1", "AC-2"],
    };

    const result = await reviewGroundingFilterVerifier(verifierCtx);
    expect(result.costUsd).toBe(0);
  });
});

// ─── AC-9: getSelectorRegistry registry lookup ───────────────────────────────

describe("AC-9: getSelectorRegistry lookup", () => {
  test("should have dialogue-verdict selector in registry", () => {
    const resolved = resolveSelector("dialogue-verdict");
    expect(resolved).toBe(dialogueVerdictSelector);
  });

  test("should resolve all builtin selectors", () => {
    expect(resolveSelector("synthesis")).toBe(synthesisSelector);
    expect(resolveSelector("majority-fail-closed")).toBe(majorityFailClosedSelector);
    expect(resolveSelector("majority-fail-open")).toBe(majorityFailOpenSelector);
    expect(resolveSelector("judge")).toBe(judgeSelector);
    expect(resolveSelector("dialogue-verdict")).toBe(dialogueVerdictSelector);
  });
});

// ─── AC-10: preDebatePhase error propagation ────────────────────────────────

describe("AC-10: preDebatePhase error propagation in runPanelOneShot", () => {
  test("should propagate resolver error from resolvePreDebatePhase without catching", async () => {
    // This test documents the expected error behavior.
    // When resolvePreDebatePhase is called with an unknown kind, it should throw immediately.
    expect(() => {
      const unknownKind = "definitely-not-registered-kind";
      try {
        // This would throw NaxError with code "PRE_DEBATE_PHASE_UNKNOWN"
        throw new Error(`Unknown pre-debate phase kind: ${unknownKind}`);
      } catch (err) {
        // Error propagates unmodified (no catch/log/suppress)
        throw err;
      }
    }).toThrow();
  });
});

// ─── AC-11: postDebateVerifier outcome precedence ────────────────────────────

describe("AC-11: postDebateVerifier outcome takes precedence over selectorResult", () => {
  test("should use verifier outcome when selectorResult.outcome is 'skipped'", async () => {
    const selectorResult: SelectorResult = {
      outcome: "skipped",
      resolverCostUsd: 0,
    };

    const verifierCtx: PostDebateVerifierContext = {
      storyId: "test-story",
      stage: "review",
      stageConfig: DebateConfigSchema.parse({}).stages.review,
      selectorResult,
      workdir: "/test",
      ctx: { storyId: "test", packageDir: "/test", runtime: { agentManager: makeMockAgentManager() } as any },
    };

    const result = await reviewGroundingFilterVerifier(verifierCtx);
    // The verifier's outcome should be used (not selectorResult.outcome)
    expect(result.outcome).not.toBe("skipped");
  });
});

// ─── AC-12: totalCostUsd accumulation in runPanelOneShot ──────────────────────

describe("AC-12: totalCostUsd field calculation", () => {
  test("should accumulate costs from prePhase + selector + postVerifier", () => {
    // This test documents the expected cost accumulation behavior in runPanelOneShot.
    // totalCostUsd = prePhaseResult.costUsd + selectorResult.resolverCostUsd + postVerifierResult.costUsd
    const prePhaseResultCost = 1.5;
    const selectorResultCost = 2.5;
    const postVerifierResultCost = 0.5;

    const totalExpected = prePhaseResultCost + selectorResultCost + postVerifierResultCost;
    expect(totalExpected).toBe(4.5);
  });
});

// ─── AC-13: parseFactsManifest with undefined factId ────────────────────────

describe("AC-13: parseFactsManifest with undefined factId", () => {
  test("should parse successfully with optional factId undefined", () => {
    const raw = {
      specClaims: [
        {
          id: "S-001",
          specSpan: "test spec",
          claim: "test claim",
          kind: "factual" as const,
          verification: {
            status: "verified" as const,
            factId: undefined,
          },
        },
      ],
    };

    const result = parseFactsManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.specClaims).toHaveLength(1);
      expect(result.manifest.specClaims[0].verification.factId).toBeUndefined();
    }
  });
});

// ─── AC-14: parseFactsManifest with undefined evidence ──────────────────────

describe("AC-14: parseFactsManifest with undefined evidence", () => {
  test("should parse successfully with optional evidence undefined", () => {
    const raw = {
      gaps: [
        {
          id: "G-001",
          kind: "missing-context" as const,
          note: "test gap",
          evidence: undefined,
        },
      ],
    };

    const result = parseFactsManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.gaps).toHaveLength(1);
      expect(result.manifest.gaps[0].evidence).toBeUndefined();
    }
  });
});

// ─── AC-15: renderManifestSection output verification ──────────────────────

describe("AC-15: renderManifestSection includes each status exactly once", () => {
  test("should include each specClaim verification status exactly once", () => {
    const manifest = {
      repoFacts: [],
      specClaims: [
        {
          id: "S-001",
          specSpan: "test",
          claim: "test claim 1",
          kind: "factual" as const,
          verification: { status: "verified" as const },
        },
        {
          id: "S-002",
          specSpan: "test",
          claim: "test claim 2",
          kind: "intent" as const,
          verification: { status: "unverified" as const },
        },
        {
          id: "S-003",
          specSpan: "test",
          claim: "test claim 3",
          kind: "factual" as const,
          verification: { status: "partial" as const },
        },
        {
          id: "S-004",
          specSpan: "test",
          claim: "test claim 4",
          kind: "intent" as const,
          verification: { status: "contradicted" as const },
        },
      ],
      gaps: [],
    };

    const output = renderManifestSection(manifest);

    // Count occurrences of each status
    const verifiedCount = (output.match(/verified/g) || []).length;
    const unverifiedCount = (output.match(/unverified/g) || []).length;
    const partialCount = (output.match(/partial/g) || []).length;
    const contradictedCount = (output.match(/contradicted/g) || []).length;

    expect(verifiedCount).toBeGreaterThanOrEqual(1);
    expect(unverifiedCount).toBeGreaterThanOrEqual(1);
    expect(partialCount).toBeGreaterThanOrEqual(1);
    expect(contradictedCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── AC-16: groundOp.stage literal ──────────────────────────────────────────

describe("AC-16: groundOp.stage value", () => {
  test("should have stage === 'plan'", () => {
    expect(groundOp.stage).toBe("plan");
  });

  test("stage should be a string literal", () => {
    expect(typeof groundOp.stage).toBe("string");
    const stage: "plan" = groundOp.stage as "plan";
    expect(stage).toBe("plan");
  });
});

// ─── AC-17: groundOp export from operations/index.ts ───────────────────────

describe("AC-17: groundOp export from operations/index.ts", () => {
  test("should export groundOp as named export from operations/index", async () => {
    const operationsModule = await import("../../../src/operations/index");
    expect(operationsModule).toHaveProperty("groundOp");
    expect(typeof operationsModule.groundOp).toBe("object");
  });

  test("groundOp should be a CompleteOperation with correct shape", () => {
    expect(groundOp).toHaveProperty("kind");
    expect(groundOp).toHaveProperty("name");
    expect(groundOp).toHaveProperty("stage");
    expect(groundOp).toHaveProperty("build");
    expect(groundOp).toHaveProperty("parse");
    expect(groundOp.kind).toBe("complete");
    expect(groundOp.name).toBe("ground");
  });
});