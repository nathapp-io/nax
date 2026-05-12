/**
 * Unit tests for src/operations/plan-draft.ts
 *
 * Verifies planDraftOp, inspectDraftOutput, and the retry strategy wiring.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ParseValidationError } from "@/agents";
import { inspectDraftOutput, planDraftOp } from "@/operations";
import type { PlanDraftInput } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MINIMAL_STORY = {
  id: "US-001",
  title: "Login",
  description: "User can log in",
  acceptanceCriteria: ["AC-1: form submits"],
  complexity: "simple",
};

/** Valid PRD JSON with an inline [F-001] citation — ensures citation rate = 1.0 >= DEFAULT 0.5 */
const VALID_PRD_WITH_CITATION = JSON.stringify({
  feature: "UserAuth [F-001]",
  project: "auth-service",
  branchName: "feat/auth",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  userStories: [MINIMAL_STORY],
});

/** Valid PRD JSON with NO citations — citation rate = 0 < DEFAULT 0.5 */
const VALID_PRD_NO_CITATION = JSON.stringify({
  feature: "UserAuth",
  project: "auth-service",
  branchName: "feat/auth",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  userStories: [MINIMAL_STORY],
});

function makeDraftInput(overrides?: Partial<PlanDraftInput>): PlanDraftInput {
  return {
    manifestSection: "## Manifest\nF-001: user table exists",
    manifest: { repoFacts: [], specClaims: [], gaps: [] } as any,
    specContent: "Build a login feature",
    codebaseContext: "Express.js backend",
    feature: "UserAuth",
    branchName: "feat/auth",
    citationThreshold: 0.5,
    ...overrides,
  };
}

function makeBuildCtx(planOverrides?: { model?: string; timeoutSeconds?: number }) {
  const base = planOverrides ? { plan: planOverrides } : {};
  const config = makeNaxConfig(base as any);
  const runtime = makeTestRuntime({ config });
  createdRuntimes.push(runtime);
  return { config, stage: "plan" as const, agentName: "claude", storyId: "US-001" };
}

// ─── AC-5: planDraftOp identity ────────────────────────────────────────────

describe("planDraftOp — AC-5: identity properties", () => {
  test("kind === 'run'", () => {
    expect(planDraftOp.kind).toBe("run");
  });

  test("name === 'plan-draft'", () => {
    expect(planDraftOp.name).toBe("plan-draft");
  });

  test("stage === 'plan'", () => {
    expect(planDraftOp.stage).toBe("plan");
  });

  test("session.role === 'plan-draft'", () => {
    expect(planDraftOp.session.role).toBe("plan-draft");
  });

  test("session.lifetime === 'fresh'", () => {
    expect(planDraftOp.session.lifetime).toBe("fresh");
  });

  test("noFallback === true", () => {
    expect(planDraftOp.noFallback).toBe(true);
  });

  test("retry is a function factory (returns strategy per input)", () => {
    expect(planDraftOp.retry).toBeDefined();
    expect(typeof planDraftOp.retry).toBe("function");
  });
});

// ─── AC-6 & AC-7: planDraftOp.build ─────────────────────────────────────────

describe("planDraftOp.build — AC-6 & AC-7: draft prompt construction", () => {
  test("AC-6: build without revisionFindings returns ComposeInput with role and task", () => {
    const ctx = makeBuildCtx();
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: undefined }), ctx as any);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result.role).toBeDefined();
    expect(result.task).toBeDefined();
  });

  test("AC-6: task.content contains the manifestSection", () => {
    const ctx = makeBuildCtx();
    const input = makeDraftInput({ manifestSection: "UNIQUE_MANIFEST_MARKER", revisionFindings: undefined });
    const result = planDraftOp.build(input, ctx as any);
    const content = JSON.stringify(result);
    expect(content).toContain("UNIQUE_MANIFEST_MARKER");
  });

  test("AC-6: task.content contains 'intent' (citation exemption)", () => {
    const ctx = makeBuildCtx();
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: undefined }), ctx as any);
    const content = JSON.stringify(result);
    expect(content).toContain("intent");
  });

  test("AC-6: build without revisionFindings does NOT contain 'Previous draft rejected'", () => {
    const ctx = makeBuildCtx();
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: undefined }), ctx as any);
    const content = JSON.stringify(result);
    expect(content).not.toContain("Previous draft rejected");
  });

  test("AC-7: build with revisionFindings contains 'Previous draft rejected'", () => {
    const ctx = makeBuildCtx();
    const findings = [{ checklistItem: "ac-testable", severity: "blocker" as const, message: "ACs must be testable" }];
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: findings }), ctx as any);
    const content = JSON.stringify(result);
    expect(content).toContain("Previous draft rejected");
  });

  test("AC-7: build with revisionFindings includes the finding message", () => {
    const ctx = makeBuildCtx();
    const msg = "User stories must reference the manifest";
    const findings = [{ checklistItem: "citation", severity: "blocker" as const, message: msg }];
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: findings }), ctx as any);
    const content = JSON.stringify(result);
    expect(content).toContain(msg);
  });
});

// ─── AC-8 & AC-9: planDraftOp.model ─────────────────────────────────────────

describe("planDraftOp.model — AC-8 & AC-9: model tier resolution", () => {
  test("AC-8: returns 'fast' when config.plan.model is not set", () => {
    // Pass empty plan object so deepMerge replaces DEFAULT_CONFIG.plan (model: "balanced") with {}
    const ctx = makeBuildCtx({});
    const result = (planDraftOp.model as Function)({}, ctx);
    expect(result).toBe("fast");
  });

  test("AC-9: returns configured model when config.plan.model is 'balanced'", () => {
    const ctx = makeBuildCtx({ model: "balanced" });
    const result = (planDraftOp.model as Function)({}, ctx);
    expect(result).toBe("balanced");
  });
});

// ─── AC-10: planDraftOp.parse (success path) ─────────────────────────────────

describe("planDraftOp.parse — AC-10: success path", () => {
  test("AC-10: returns { prd, citationRate, advisory: false } for valid output above threshold", () => {
    const input = makeDraftInput({ citationThreshold: 0.5 });
    const result = planDraftOp.parse(VALID_PRD_WITH_CITATION, input, {} as any);
    expect(result.advisory).toBe(false);
    expect(typeof result.citationRate).toBe("number");
    expect(result.prd.feature).toContain("UserAuth");
  });

  test("AC-10: advisory is false on the success path", () => {
    const input = makeDraftInput({ citationThreshold: 0 });
    const result = planDraftOp.parse(VALID_PRD_NO_CITATION, input, {} as any);
    expect(result.advisory).toBe(false);
  });
});

// ─── AC-11, AC-12, AC-13: inspectDraftOutput ─────────────────────────────────

describe("inspectDraftOutput — AC-11, AC-12, AC-13: tiered inspection", () => {
  test("AC-11: returns { ok: false, kind: 'not-json' } for non-JSON input", () => {
    const result = inspectDraftOutput("not valid json at all");
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("not-json");
    expect(result.message).toBeTruthy();
  });

  test("AC-12: returns { ok: false, kind: 'prd-invalid' } for valid JSON, invalid PRD", () => {
    const result = inspectDraftOutput('{"foo":"bar"}');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("prd-invalid");
    expect(result.message).toContain("PRD");
  });

  test("AC-12: message references the underlying validatePlanOutput error", () => {
    const result = inspectDraftOutput('{"foo":"bar"}');
    expect(result.message).toBeTruthy();
    expect((result.message ?? "").length).toBeGreaterThan(10);
  });

  test("AC-13: returns { ok: false, kind: 'citation-low' } when rate < DEFAULT 0.5", () => {
    const result = inspectDraftOutput(VALID_PRD_NO_CITATION);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("citation-low");
    expect(result.citationRate).toBeDefined();
    expect(result.citationRate!).toBeLessThan(0.5);
  });

  test("AC-13: partial is the validated PRD when citation is low", () => {
    const result = inspectDraftOutput(VALID_PRD_NO_CITATION);
    expect(result.partial).toBeDefined();
    // inspectDraftOutput is called without feature arg so feature is ""; check project from JSON
    expect(result.partial!.project).toBe("auth-service");
  });

  test("AC-13: ok is true when rate >= DEFAULT 0.5", () => {
    const result = inspectDraftOutput(VALID_PRD_WITH_CITATION);
    expect(result.ok).toBe(true);
    expect(result.partial).toBeDefined();
  });
});

// ─── AC-14, AC-15, AC-16: planDraftOp.parse (failure paths) ──────────────────

describe("planDraftOp.parse — AC-14, AC-15, AC-16: failure paths", () => {
  test("AC-14: throws ParseValidationError for non-JSON output", () => {
    expect(() =>
      planDraftOp.parse("not valid json", makeDraftInput(), {} as any)
    ).toThrow(ParseValidationError);
  });

  test("AC-15: throws ParseValidationError for valid JSON that fails PRD schema", () => {
    expect(() =>
      planDraftOp.parse('{"foo":"bar"}', makeDraftInput(), {} as any)
    ).toThrow(ParseValidationError);
  });

  test("AC-16: throws ParseValidationError with 'citation rate' in message when rate < configured threshold", () => {
    let caught: unknown;
    try {
      planDraftOp.parse(VALID_PRD_NO_CITATION, makeDraftInput({ citationThreshold: 0.5 }), {} as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ParseValidationError);
    expect((caught as ParseValidationError).message).toContain("citation rate");
  });

  test("AC-16: uses the configured citationThreshold, not the default 0.5", () => {
    // VALID_PRD_WITH_CITATION has rate = 1.0, so threshold 0.5 succeeds but threshold 1.5 is impossible
    // Use threshold 0 to confirm parse succeeds on a no-citation output
    const result = planDraftOp.parse(VALID_PRD_NO_CITATION, makeDraftInput({ citationThreshold: 0 }), {} as any);
    expect(result.advisory).toBe(false);
  });
});

// ─── AC-17: retry strategy wiring ────────────────────────────────────────────

describe("planDraftOp.retry — AC-17: retry strategy wiring", () => {
  // retry is now a factory function; call it with a default input to get the strategy
  const retry = (planDraftOp.retry as Function)(makeDraftInput()) as { shouldRetry: Function };

  test("returns { retry: false } when failure is not ParseValidationError", () => {
    const decision = retry.shouldRetry(new Error("network"), 0, { lastOutput: "{}", storyId: "s1" });
    expect(decision.retry).toBe(false);
  });

  test("returns { retry: false } when lastOutput is missing", () => {
    const decision = retry.shouldRetry(new ParseValidationError("bad"), 0, { storyId: "s1" });
    expect(decision.retry).toBe(false);
  });

  test("returns { retry: true, nextPrompt } on first failure with not-json output", () => {
    const decision = retry.shouldRetry(
      new ParseValidationError("not json"),
      0,
      { lastOutput: "not valid json", storyId: "s1" },
    );
    expect(decision.retry).toBe(true);
    expect(typeof decision.nextPrompt).toBe("string");
    expect(decision.nextPrompt.length).toBeGreaterThan(0);
  });

  test("returns fallback on exhaustion (attempt >= maxAttempts-1)", () => {
    const decision = retry.shouldRetry(
      new ParseValidationError("bad"),
      1, // maxAttempts=2, so attempt 1 >= 1 triggers exhaustion
      { lastOutput: VALID_PRD_NO_CITATION, storyId: "s1" },
    );
    expect(decision.retry).toBe(false);
    expect(decision.fallback).toBeDefined();
    expect((decision.fallback as any).advisory).toBe(true);
  });

  test("exhaustedFallback returns FAIL_OPEN_DRAFT when partial is absent (not-json output)", () => {
    const decision = retry.shouldRetry(
      new ParseValidationError("bad"),
      1,
      { lastOutput: "not valid json", storyId: "s1" },
    );
    expect(decision.retry).toBe(false);
    expect((decision.fallback as any).advisory).toBe(true);
    expect((decision.fallback as any).citationRate).toBe(0);
  });
});
