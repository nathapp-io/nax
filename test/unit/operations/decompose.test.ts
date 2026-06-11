/**
 * Unit tests for src/operations/decompose.ts
 *
 * Verifies:
 * - AC-T8-1: Capability cards are NOT injected when routing.agents.enabled === false
 * - AC-T8-2: Capability cards are NOT injected when profiles is empty (even if enabled)
 * - AC-T8-3: Capability cards ARE injected when enabled === true and profiles are non-empty
 */

import { afterEach, describe, expect, test } from "bun:test";
import { decomposeConfigSelector } from "../../../src/config";
import { decomposeOp } from "../../../src/operations/decompose";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const SAMPLE_INPUT = {
  specContent: "A feature spec",
  codebaseContext: "Some context",
};

const SAMPLE_PROFILE = {
  id: "fast-coder",
  target: { agent: "opencode", model: "fast" as const },
  strengths: ["code-generation", "refactoring"],
  costTier: "low" as const,
};

function makeBuildCtx(configOverrides?: object) {
  const config = makeNaxConfig(configOverrides);
  const runtime = makeTestRuntime({ config });
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(decomposeConfigSelector) };
}

describe("decomposeOp — agent capability cards injection", () => {
  test("AC-T8-1: capability cards are NOT injected when routing.agents.enabled === false", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: false,
          profiles: [SAMPLE_PROFILE],
        },
      },
    });

    const result = decomposeOp.build(SAMPLE_INPUT, ctx);
    const prompt = result.task.content;

    expect(prompt).not.toContain("## Agent Profiles");
    expect(prompt).not.toContain("fast-coder");
  });

  test("AC-T8-2: capability cards are NOT injected when profiles is empty (enabled === true)", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          profiles: [],
        },
      },
    });

    const result = decomposeOp.build(SAMPLE_INPUT, ctx);
    const prompt = result.task.content;

    expect(prompt).not.toContain("## Agent Profiles");
  });

  test("AC-T8-3: capability cards ARE injected when enabled === true and profiles are non-empty", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          profiles: [SAMPLE_PROFILE],
        },
      },
    });

    const result = decomposeOp.build(SAMPLE_INPUT, ctx);
    const prompt = result.task.content;

    expect(prompt).toContain("## Agent Profiles");
    expect(prompt).toContain("fast-coder");
    expect(prompt).toContain("opencode");
    expect(prompt).toContain("code-generation");
    expect(prompt).toContain("low");
  });

  test("AC-T8-4: default config (no routing.agents override) produces no capability cards", () => {
    const ctx = makeBuildCtx();

    const result = decomposeOp.build(SAMPLE_INPUT, ctx);
    const prompt = result.task.content;

    // Default has profiles = [] so no capability cards should appear
    expect(prompt).not.toContain("## Agent Profiles");
  });

  test("AC-T8-5: prompt structure — role block is empty, task block contains the full prompt", () => {
    const ctx = makeBuildCtx();

    const result = decomposeOp.build(SAMPLE_INPUT, ctx);

    expect(result.role.content).toBe("");
    expect(result.task.content.length).toBeGreaterThan(0);
  });
});
