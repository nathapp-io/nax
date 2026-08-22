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
  test("has correct kind, name, stage, session, noFallback, and retry factory", () => {
    expect(planDraftOp.kind).toBe("run");
    expect(planDraftOp.name).toBe("plan-draft");
    expect(planDraftOp.stage).toBe("plan");
    expect(planDraftOp.session.role).toBe("plan-draft");
    expect(planDraftOp.session.lifetime).toBe("fresh");
    expect(planDraftOp.noFallback).toBe(true);
    expect(planDraftOp.retry).toBeDefined();
    expect(typeof planDraftOp.retry).toBe("function");
  });
});

// ─── AC-6 & AC-7: planDraftOp.build ─────────────────────────────────────────

describe("planDraftOp.build — AC-6 & AC-7: draft prompt construction", () => {
  test("AC-6: build without revisionFindings returns ComposeInput with role, task, manifestSection, intent, and no revision header", () => {
    const ctx = makeBuildCtx();
    const result = planDraftOp.build(
      makeDraftInput({ manifestSection: "UNIQUE_MANIFEST_MARKER", revisionFindings: undefined }),
      ctx as any,
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result.role).toBeDefined();
    expect(result.task).toBeDefined();
    const content = JSON.stringify(result);
    expect(content).toContain("UNIQUE_MANIFEST_MARKER");
    expect(content).toContain("intent");
    expect(content).not.toContain("Previous draft rejected");
  });

  test("AC-7: build with revisionFindings contains revision header and finding message", () => {
    const ctx = makeBuildCtx();
    const msg = "User stories must reference the manifest";
    const findings = [{ checklistItem: "citation", severity: "blocker" as const, message: msg }];
    const result = planDraftOp.build(makeDraftInput({ revisionFindings: findings }), ctx as any);
    const content = JSON.stringify(result);
    expect(content).toContain("Previous draft rejected");
    expect(content).toContain(msg);
  });
});

// ─── AC-8 & AC-9: planDraftOp.model ─────────────────────────────────────────

describe("planDraftOp.model — AC-8 & AC-9: model tier resolution", () => {
  test.each([
    ["AC-8: not set → 'fast'", {}, "fast"],
    ["AC-9: 'balanced' → 'balanced'", { model: "balanced" }, "balanced"],
  ] as const)("%s", (_label, planOverrides, expected) => {
    const ctx = makeBuildCtx(planOverrides as any);
    expect((planDraftOp.model as Function)({}, ctx)).toBe(expected);
  });
});

// ─── AC-10: planDraftOp.parse (success path) ─────────────────────────────────

describe("planDraftOp.parse — AC-10: success path", () => {
  test("AC-10: returns { prd, citationRate, advisory: false } for valid output at or above threshold", () => {
    const result1 = planDraftOp.parse(VALID_PRD_WITH_CITATION, makeDraftInput({ citationThreshold: 0.5 }), {} as any);
    expect(result1.advisory).toBe(false);
    expect(typeof result1.citationRate).toBe("number");
    expect(result1.prd.feature).toContain("UserAuth");
    const result2 = planDraftOp.parse(VALID_PRD_NO_CITATION, makeDraftInput({ citationThreshold: 0 }), {} as any);
    expect(result2.advisory).toBe(false);
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

  test("AC-12: returns { ok: false, kind: 'prd-invalid' } with non-empty PRD message for valid JSON, invalid PRD", () => {
    const result = inspectDraftOutput('{"foo":"bar"}');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("prd-invalid");
    expect(result.message).toContain("PRD");
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
  test.each([
    ["AC-14: non-JSON output", "not valid json"],
    ["AC-15: valid JSON failing PRD schema", '{"foo":"bar"}'],
  ])("%s throws ParseValidationError", (_label, output) => {
    expect(() => planDraftOp.parse(output, makeDraftInput(), {} as any)).toThrow(ParseValidationError);
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

  test.each([
    ["non-ParseValidationError", () => new Error("network"), { lastOutput: "{}", storyId: "s1" }],
    ["missing lastOutput", () => new ParseValidationError("bad"), { storyId: "s1" }],
  ] as const)("returns { retry: false } when %s", (_label, makeErr, ctx) => {
    const decision = retry.shouldRetry(makeErr(), 0, ctx);
    expect(decision.retry).toBe(false);
  });

  test("returns { retry: true, nextPrompt } on first failure with not-json output", () => {
    const decision = retry.shouldRetry(new ParseValidationError("not json"), 0, {
      lastOutput: "not valid json",
      storyId: "s1",
    });
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
    const decision = retry.shouldRetry(new ParseValidationError("bad"), 1, {
      lastOutput: "not valid json",
      storyId: "s1",
    });
    expect(decision.retry).toBe(false);
    expect((decision.fallback as any).advisory).toBe(true);
    expect((decision.fallback as any).citationRate).toBe(0);
  });
});
