/**
 * Unit tests for src/operations/setup-generate.ts
 *
 * Covers AC1–AC8 for setupGenerateOp.parse, setupGenerateOp.build,
 * and callOp exhaustion behaviour.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { ParseValidationError } from "@/agents";
import type { NaxConfig } from "@/config";
import { NaxConfigSchema } from "@/config";
import { callOp, setupGenerateOp } from "@/operations";
import type { BuildContext } from "@/operations/types";
import { SetupPromptBuilder } from "@/prompts";
import type { RepoAnalysis } from "@/cli/setup-types";
import { makeAgentAdapter, makeMockCallContext, makeRuntimeWithFakeAgent, makeNaxConfig } from "@test/helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NO_BUILD_CTX = {} as BuildContext<NaxConfig>;

function makeSingleAnalysis(missingScripts: string[] = []): RepoAnalysis {
  return {
    shape: "single",
    packages: [{ relativeDir: "", testFramework: "bun", testFilePatterns: [], missingScripts }],
    pmRunPrefix: "bun run",
    pmDlx: "bunx",
    orchestrator: "none",
  };
}

function makeMonoAnalysis(packageCount: number): RepoAnalysis {
  return {
    shape: "mono",
    packages: Array.from({ length: packageCount }, (_, i) => ({
      relativeDir: `packages/pkg-${i}`,
      testFramework: "bun",
      testFilePatterns: [],
      missingScripts: [],
    })),
    pmRunPrefix: "bun run",
    pmDlx: "bunx",
    orchestrator: "none",
  };
}

function fenced(config: unknown): string {
  return "```json\n" + JSON.stringify({ config }) + "\n```";
}

// ─── AC1: parse returns SetupPlan with valid config ───────────────────────────

describe("setupGenerateOp.parse — AC1: valid config accepted by NaxConfigSchema", () => {
  test("AC1: fenced json with empty config passes NaxConfigSchema", () => {
    const output = fenced({});
    const result = setupGenerateOp.parse(output, makeSingleAnalysis(), NO_BUILD_CTX);
    expect(NaxConfigSchema.safeParse(result.config).success).toBe(true);
  });
});

// ─── AC2: crossCheck strips absent command and records gap ───────────────────

describe("setupGenerateOp.parse — AC2: crossCheck absent command", () => {
  test("AC2: command referencing missing script is stripped and recorded in gaps", () => {
    const analysis = makeSingleAnalysis(["test"]);
    const output = fenced({ quality: { commands: { test: "bun run test", lint: "bun run lint" } } });
    const result = setupGenerateOp.parse(output, analysis, NO_BUILD_CTX);
    expect(result.gaps.length).toBeGreaterThan(0);
    const testCmd = (result.config as Record<string, unknown> | null)?.quality as
      | { commands?: Record<string, unknown> }
      | undefined;
    expect(testCmd?.commands?.test).toBeUndefined();
  });
});

// ─── AC3: non-JSON throws ParseValidationError ───────────────────────────────

describe("setupGenerateOp.parse — AC3: non-JSON output", () => {
  test("AC3: throws ParseValidationError when parseLLMJson exhausts all tiers", () => {
    expect(() => setupGenerateOp.parse("not json at all", makeSingleAnalysis(), NO_BUILD_CTX)).toThrow(ParseValidationError);
  });
});

// ─── AC4: schema-invalid config throws ParseValidationError ──────────────────

describe("setupGenerateOp.parse — AC4: schema-invalid config", () => {
  test("AC4: throws ParseValidationError when config fails NaxConfigSchema", () => {
    const output = fenced({ name: "INVALID@NAME!" }); // invalid chars per schema
    expect(() => setupGenerateOp.parse(output, makeSingleAnalysis(), NO_BUILD_CTX)).toThrow(ParseValidationError);
  });
});

// ─── AC5: single shape → empty monoConfigs ───────────────────────────────────

describe("setupGenerateOp.parse — AC5: single shape returns empty monoConfigs", () => {
  test("AC5: monoConfigs is empty when shape is 'single'", () => {
    const output = fenced({});
    const result = setupGenerateOp.parse(output, makeSingleAnalysis(), NO_BUILD_CTX);
    expect(result.monoConfigs).toHaveLength(0);
  });
});

// ─── AC6: mono shape → N monoConfigs entries ─────────────────────────────────

describe("setupGenerateOp.parse — AC6: mono shape returns N monoConfigs", () => {
  test.each([
    ["AC6: 2 packages → 2 monoConfigs", 2],
    ["AC6: 3 packages → 3 monoConfigs", 3],
  ])("%s", (_label, n) => {
    const output = fenced({});
    const result = setupGenerateOp.parse(output, makeMonoAnalysis(n), NO_BUILD_CTX);
    expect(result.monoConfigs).toHaveLength(n);
  });
});

// ─── AC6 extension: mono monoConfigs carries LLM per-package config ──────────

describe("setupGenerateOp.parse — AC6 ext: mono monoConfigs uses LLM per-package config", () => {
  test("AC6 ext: monoConfigs carries config extracted from LLM-provided monoConfigs", () => {
    const analysis: RepoAnalysis = {
      shape: "mono",
      packages: [
        { relativeDir: "packages/pkg-0", testFramework: "bun", testFilePatterns: [], missingScripts: [] },
        { relativeDir: "packages/pkg-1", testFramework: "jest", testFilePatterns: [], missingScripts: [] },
      ],
      pmRunPrefix: "bun run",
      pmDlx: "bunx",
      orchestrator: "none",
    };

    const pkg0Config = makeNaxConfig({ execution: { maxIterations: 11 } });
    const pkg1Config = makeNaxConfig({ execution: { maxIterations: 22 } });

    const output =
      "```json\n" +
      JSON.stringify({
        config: {},
        monoConfigs: [
          { relativeDir: "packages/pkg-0", config: pkg0Config },
          { relativeDir: "packages/pkg-1", config: pkg1Config },
        ],
      }) +
      "\n```";

    const result = setupGenerateOp.parse(output, analysis, NO_BUILD_CTX);
    expect(result.monoConfigs).toHaveLength(2);
    expect(result.monoConfigs[0].relativeDir).toBe("packages/pkg-0");
    expect((result.monoConfigs[0].config as NaxConfig).execution.maxIterations).toBe(11);
    expect(result.monoConfigs[1].relativeDir).toBe("packages/pkg-1");
    expect((result.monoConfigs[1].config as NaxConfig).execution.maxIterations).toBe(22);
  });
});

// ─── AC7: build delegates to SetupPromptBuilder ──────────────────────────────

describe("setupGenerateOp.build — AC7: delegates to SetupPromptBuilder", () => {
  test("AC7: build calls new SetupPromptBuilder().build(analysis) and returns the result", () => {
    const mocked = {
      role: { id: "role", content: "role-content", overridable: false },
      task: { id: "task", content: "task-content", overridable: false },
    };
    const spy = spyOn(SetupPromptBuilder.prototype, "build").mockReturnValue(mocked as never);
    const analysis = makeSingleAnalysis();
    const result = setupGenerateOp.build(analysis, NO_BUILD_CTX);
    expect(spy).toHaveBeenCalledWith(analysis);
    expect(result).toBe(mocked);
    spy.mockRestore();
  });
});

// ─── AC8: callOp rejects SETUP_PLAN_INVALID after exhaustion ─────────────────

describe("callOp(setupGenerateOp) — AC8: SETUP_PLAN_INVALID on retry exhaustion", () => {
  test(
    "AC8: rejects with NaxError code SETUP_PLAN_INVALID when session always returns schema-invalid config",
    async () => {
      // Always return schema-invalid config (invalid name chars)
      const badOutput = fenced({ name: "INVALID@NAME!" });
      const adapter = makeAgentAdapter({
        sendTurn: mock(async () => ({
          output: badOutput,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        })),
      });
      const { runtime } = makeRuntimeWithFakeAgent(adapter);
      const ctx = makeMockCallContext({ runtime });

      await expect(callOp(ctx, setupGenerateOp, makeSingleAnalysis())).rejects.toMatchObject({
        code: "SETUP_PLAN_INVALID",
      });
    },
    15_000,
  );
});
