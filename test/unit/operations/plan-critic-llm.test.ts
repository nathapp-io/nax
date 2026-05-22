import { afterEach, describe, expect, test } from "bun:test";
import { ParseValidationError } from "@/agents";
import type { RetryStrategy } from "@/agents";
import { NaxError } from "@/errors";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

/**
 * planCriticLlmOp + CriticPromptBuilder tests — US-003
 *
 * Coverage:
 * - AC1: KNOWN_SESSION_ROLES includes "plan-critic"
 * - AC2-5: planCriticLlmOp identity and model resolution
 * - AC6-11: inspectCriticOutput and parse behavior
 * - AC12-14: retry strategy configuration
 * - AC15: CriticPromptBuilder.build() output
 */

// Import stubs that may not exist yet; tests will fail during runtime if implementations are missing
let planCriticLlmOp: any;
let CriticPromptBuilder: any;
let inspectCriticOutput: any;
let buildCriticRetryPrompt: any;
let KNOWN_SESSION_ROLES: any;

// Lazy-load with proper error handling for test discovery
try {
  const operationsModule = require("@/operations/plan-critic-llm");
  planCriticLlmOp = operationsModule.planCriticLlmOp;
  inspectCriticOutput = operationsModule.inspectCriticOutput;
  buildCriticRetryPrompt = operationsModule.buildCriticRetryPrompt;
} catch (e) {
  // Module not yet created; tests will fail appropriately
}

try {
  const promptsModule = require("@/prompts/builders/critic-builder");
  CriticPromptBuilder = promptsModule.CriticPromptBuilder;
} catch (e) {
  // Module not yet created; tests will fail appropriately
}

try {
  const sessionRoleModule = require("@/runtime/session-role");
  KNOWN_SESSION_ROLES = sessionRoleModule.KNOWN_SESSION_ROLES;
} catch (e) {
  // Module not yet created; tests will fail appropriately
}

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeBuildCtx(criticOverrides?: { criticModel?: unknown; timeoutSeconds?: number }) {
  const base = criticOverrides ? ({ plan: criticOverrides } as any) : {};
  const config = makeNaxConfig(base);
  const runtime = makeTestRuntime({ config });
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(planCriticLlmOp.config) };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: KNOWN_SESSION_ROLES includes "plan-critic"
// ─────────────────────────────────────────────────────────────────────────────
describe("KNOWN_SESSION_ROLES — AC1", () => {
  test("includes 'plan-critic' as a CanonicalSessionRole member", () => {
    expect(KNOWN_SESSION_ROLES).toBeDefined();
    expect(Array.isArray(KNOWN_SESSION_ROLES)).toBe(true);
    expect(KNOWN_SESSION_ROLES).toContain("plan-critic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: planCriticLlmOp identity properties
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp — identity (AC2)", () => {
  test.each([
    ["kind is 'run'", (op: any) => op.kind, "run"],
    ["name is 'plan-critic-llm'", (op: any) => op.name, "plan-critic-llm"],
    ["stage is 'plan'", (op: any) => op.stage, "plan"],
    ["session.lifetime is 'fresh'", (op: any) => op.session.lifetime, "fresh"],
    ["noFallback is true", (op: any) => op.noFallback, true],
  ])("%s", (_label, accessor, expected) => {
    expect(planCriticLlmOp).toBeDefined();
    expect(accessor(planCriticLlmOp)).toBe(expected);
  });

  test("session.role is 'plan-critic'", () => {
    expect(planCriticLlmOp).toBeDefined();
    expect(planCriticLlmOp.session).toBeDefined();
    expect(planCriticLlmOp.session.role).toBe("plan-critic");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: planCriticLlmOp.build() returns ComposeInput with non-empty role.content
// and task.content
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp.build() — AC3", () => {
  test("returns an object with non-empty role.content and task.content", () => {
    const mockPrd = { feature: "test-feature", specContent: "some spec", stories: [], branch: "test-branch" };
    const mockManifest = { repoFacts: [], specClaims: [], gaps: [] };
    const ctx = makeBuildCtx();
    const result = planCriticLlmOp.build({ prd: mockPrd, manifest: mockManifest }, ctx);
    expect(result).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.task).toBeDefined();
    expect(typeof result.role.content).toBe("string");
    expect(result.role.content.length).toBeGreaterThan(0);
    expect(typeof result.task.content).toBe("string");
    expect(result.task.content.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4-5: planCriticLlmOp.model() resolution
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp.model() resolution — AC4-5", () => {
  test("returns 'fast' when config.plan is empty (default from schema) — AC4", () => {
    const ctx = makeBuildCtx();
    const result = planCriticLlmOp.model?.({}, ctx);
    expect(result).toBe("fast");
  });

  test.each(["balanced", "powerful"] as const)("returns criticModel '%s' when provided — AC5", (model) => {
    const ctx = makeBuildCtx({ criticModel: model });
    expect(planCriticLlmOp.model?.({}, ctx)).toBe(model);
  });

  test("resolves model from context config — not from input", () => {
    const input = { some: "data" };
    const ctx = makeBuildCtx({ criticModel: "balanced" });
    const result = planCriticLlmOp.model?.(input as any, ctx);
    expect(result).toBe("balanced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6-8: inspectCriticOutput behavior
// ─────────────────────────────────────────────────────────────────────────────
describe("inspectCriticOutput — AC6-8", () => {
  test("returns { ok: true, findings } for markdown-fenced JSON (parseLLMJson used, not bare JSON.parse) — AC6", () => {
    const input = '```json\n{"findings":[]}\n```';
    const result = inspectCriticOutput(input);
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings.length).toBe(0);
  });

  test("returns { ok: false } with kind 'not-json' or 'schema-invalid' as appropriate — AC7-8", () => {
    expect(inspectCriticOutput("not json")).toMatchObject({ ok: false, kind: "not-json" });
    expect(inspectCriticOutput('{"other":"x"}')).toMatchObject({ ok: false, kind: "schema-invalid" });
  });

  test("filters non-VerifierFinding items from findings array", () => {
    const input = JSON.stringify({
      findings: [
        { checklistItem: "ac-testable", severity: "blocker" },
        { invalid: "item" }, // Should be filtered out
        { checklistItem: "failure-modes-considered", severity: "major" },
      ],
    });

    const result = inspectCriticOutput(input);

    expect(result.ok).toBe(true);
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    // Filtered result should contain only valid findings
    expect(result.findings.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9-11: planCriticLlmOp.parse() behavior
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp.parse() — AC9-11", () => {
  test("returns findings array on valid JSON; throws ParseValidationError on invalid or schema-mismatch — AC9-11", () => {
    expect(planCriticLlmOp.parse?.('{"findings":[]}', {}, {})).toMatchObject({ findings: [] });
    expect(planCriticLlmOp.parse?.(JSON.stringify({ findings: [{ checklistItem: "ac-testable", severity: "blocker" }] }), {}, {}).findings.length).toBeGreaterThan(0);
    expect(() => planCriticLlmOp.parse?.("not json", {}, {})).toThrow(ParseValidationError);
    expect(() => planCriticLlmOp.parse?.('{"other":"x"}', {}, {})).toThrow(ParseValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: planCriticLlmOp.retry configuration
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp.retry — AC12", () => {
  test("retry is defined as a RetryStrategy with shouldRetry function", () => {
    expect(planCriticLlmOp.retry).toBeDefined();
    expect(typeof (planCriticLlmOp.retry as RetryStrategy).shouldRetry).toBe("function");
  });

  test("retry.shouldRetry handles ParseValidationError and checks lastOutput", () => {
    const strategy = planCriticLlmOp.retry as RetryStrategy;

    const mockCtx = {
      lastOutput: "invalid json",
      storyId: "test-story",
      signal: new AbortController().signal,
    };

    const failure = new ParseValidationError("test error");
    const decision = strategy.shouldRetry(failure, 0, mockCtx as any);

    expect(decision).toBeDefined();
    expect(typeof decision).toBe("object");
    expect("retry" in decision).toBe(true);
  });

  test("retry exhaustion returns { retry: false, fallback: { findings: [] } }", () => {
    const strategy = planCriticLlmOp.retry as RetryStrategy;

    const mockCtx = {
      lastOutput: "invalid json",
      storyId: "test-story",
      signal: new AbortController().signal,
    };

    // Attempt at max (or beyond) should return retry: false
    const failure = new ParseValidationError("test error");
    const decision = strategy.shouldRetry(failure, 2, mockCtx as any);

    expect(decision.retry).toBe(false);
    expect(decision.fallback).toBeDefined();
    expect(decision.fallback).toEqual({ findings: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13-14: buildCriticRetryPrompt function
// ─────────────────────────────────────────────────────────────────────────────
describe("buildCriticRetryPrompt — AC13-14", () => {
  test.each([
    ["not-json", "Response was not valid JSON or could not be extracted."],
    ["schema-invalid", "Response was valid JSON but did not have a `findings` array at the root."],
  ])("returns repair string for %s kind", (kind, message) => {
    const result = buildCriticRetryPrompt({ ok: false, kind, message } as any, false);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("passes isTruncated flag to repair methods", () => {
    const inspection = {
      ok: false,
      kind: "not-json",
      message: "Response was not valid JSON.",
    };

    const truncated = buildCriticRetryPrompt(inspection, true);
    const notTruncated = buildCriticRetryPrompt(inspection, false);

    expect(truncated).toBeDefined();
    expect(notTruncated).toBeDefined();
    // Both should be non-empty strings
    expect(typeof truncated).toBe("string");
    expect(typeof notTruncated).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC15: CriticPromptBuilder.build() output
// ─────────────────────────────────────────────────────────────────────────────
describe("CriticPromptBuilder.build() — AC15", () => {
  test.each([
    ["ac-testable", "test-feature"],
    ["failure-modes-considered", "test-feature"],
    ["my-special-feature", "my-special-feature"],
  ])("task.content contains '%s'", (expectedSubstring: string, feature: string) => {
    const mockPrd = { feature, specContent: "some spec", stories: [], branch: "test-branch" };
    const mockManifest = { repoFacts: [], specClaims: [], gaps: [] };
    const result = new CriticPromptBuilder().build?.(mockPrd, mockManifest);
    expect(result.task.content).toContain(expectedSubstring);
  });

  test("build method exists and is callable", () => {
    expect(CriticPromptBuilder).toBeDefined();
    const builder = new CriticPromptBuilder();
    expect(typeof builder.build).toBe("function");
  });

  test.each(["jsonRepair", "schemaRepair"])("CriticPromptBuilder has static %s method", (method) => {
    expect(typeof (CriticPromptBuilder as any)[method]).toBe("function");
  });

  test.each<[string, () => string]>([
    ["jsonRepair", () => CriticPromptBuilder.jsonRepair(false, "Error message")],
    ["schemaRepair", () => CriticPromptBuilder.schemaRepair("Error message")],
  ])("%s returns non-empty string", (_method, call) => {
    const result = call();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: operationsExport includes planCriticLlmOp
// ─────────────────────────────────────────────────────────────────────────────
describe("planCriticLlmOp export from operations barrel", () => {
  test("planCriticLlmOp is exported from @/operations", async () => {
    const operationsModule = await import("@/operations");
    expect(operationsModule.planCriticLlmOp).toBeDefined();
  });
});
