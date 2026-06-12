/**
 * Unit tests for src/operations/decompose.ts
 *
 * Verifies:
 * - AC-T8-1: Capability cards are NOT injected when routing.agents.enabled === false
 * - AC-T8-2: Capability cards are NOT injected when profiles is empty (even if enabled)
 * - AC-T8-3: Capability cards ARE injected when enabled === true and profiles are non-empty
 * - AC-T8-6: Agent profile selection instruction is injected alongside capability cards
 * - AC-T9-1: Story with unknown/hallucinated agentProfileId → routing unchanged, no error
 * - AC-T9-2: Story with valid agentProfileId → routing.agent and routing.agentProfileId set
 * - AC-T9-3: Story without agentProfileId → routing unchanged
 * - AC-T9-4: agentProfileId missing + default set → routing resolved from default profile
 * - AC-T9-5: agentProfileId unknown/hallucinated + default set → routing resolved from default profile
 * - AC-T9-6: agentProfileId unknown + no default → routing unchanged
 */

import { afterEach, describe, expect, test } from "bun:test";
import { decomposeConfigSelector } from "../../../src/config";
import { _decomposeOpDeps, decomposeOp } from "../../../src/operations/decompose";
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

/** Minimal LLM JSON for a single story with optional agentProfileId */
function makeDecomposeOutput(stories: Array<{
  id?: string;
  title?: string;
  agentProfileId?: string;
}>): string {
  const arr = stories.map((s) => ({
    id: s.id ?? "US-001",
    title: s.title ?? "Story One",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    complexity: "simple",
    contextFiles: [],
    reasoning: "reason",
    estimatedLOC: 10,
    risks: [],
    ...(s.agentProfileId !== undefined ? { agentProfileId: s.agentProfileId } : {}),
  }));
  return JSON.stringify(arr);
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

describe("decomposeOp — parse: agentProfileId resolution", () => {
  test("AC-T9-3: story without agentProfileId leaves routing unchanged (undefined)", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-1: story with unknown/hallucinated agentProfileId leaves routing unchanged, no error", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "nonexistent-profile" }]);
    // Should not throw
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-1b: hallucinated agentProfileId with empty profiles list also leaves routing unchanged", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "some-id" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-2: story with valid agentProfileId sets routing.agent, routing.agentProfileId, and routing.profileModelTier", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "fast-coder" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing?.agent).toBe("opencode");
    expect(result[0].routing?.agentProfileId).toBe("fast-coder");
    expect(result[0].routing?.profileModelTier).toBe("fast");
  });

  test("AC-T9-2b: routing.agent and routing.agentProfileId are set per-story independently", () => {
    const secondProfile = {
      id: "quality-agent",
      target: { agent: "claude", model: "balanced" as const },
      strengths: ["review"],
      costTier: "high" as const,
    };
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE, secondProfile] },
      },
    });

    const output = makeDecomposeOutput([
      { id: "US-001", agentProfileId: "fast-coder" },
      { id: "US-002", agentProfileId: "quality-agent" },
      { id: "US-003" },
    ]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(3);
    expect(result[0].routing?.agent).toBe("opencode");
    expect(result[0].routing?.agentProfileId).toBe("fast-coder");
    expect(result[1].routing?.agent).toBe("claude");
    expect(result[1].routing?.agentProfileId).toBe("quality-agent");
    expect(result[2].routing).toBeUndefined();
  });

  test("AC-T9-2c: existing routing fields are preserved when profile is matched", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    // The LLM may emit extra routing-adjacent fields; parse should not destroy them.
    // The decomposed story doesn't carry a full routing object — it only carries agentProfileId.
    // After resolution, routing.agent and routing.agentProfileId are set; others remain absent.
    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "fast-coder" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result[0].routing?.agent).toBe("opencode");
    expect(result[0].routing?.agentProfileId).toBe("fast-coder");
  });

  test("AC-T9-1c: when agents.enabled === false, agentProfileId is ignored even if profile exists", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: false, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "fast-coder" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-4: agentProfileId missing + default set → routing resolved from default profile, including profileModelTier", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          default: "fast-coder",
          profiles: [SAMPLE_PROFILE],
        },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing?.agent).toBe("opencode");
    expect(result[0].routing?.agentProfileId).toBe("fast-coder");
    expect(result[0].routing?.profileModelTier).toBe("fast");
  });

  test("AC-T9-5: agentProfileId unknown/hallucinated + default set → routing resolved from default profile, including profileModelTier", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          default: "fast-coder",
          profiles: [SAMPLE_PROFILE],
        },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "nonexistent-profile" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing?.agent).toBe("opencode");
    expect(result[0].routing?.agentProfileId).toBe("fast-coder");
    expect(result[0].routing?.profileModelTier).toBe("fast");
  });

  test("AC-T9-6: agentProfileId unknown + no default → routing unchanged (existing behavior preserved)", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: {
          enabled: true,
          profiles: [SAMPLE_PROFILE],
        },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "nonexistent-profile" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    expect(result[0].routing).toBeUndefined();
  });

  test("Delta C3: warns with storyId when the LLM emits an unknown agentProfileId", () => {
    const orig = _decomposeOpDeps.getSafeLogger;
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    _decomposeOpDeps.getSafeLogger = () =>
      ({
        warn: (_stage: string, message: string, data?: Record<string, unknown>) => {
          warnings.push({ message, data });
        },
        info: () => {},
        debug: () => {},
        error: () => {},
      }) as never;
    try {
      const ctx = makeBuildCtx({
        routing: {
          strategy: "keyword",
          agents: {
            enabled: true,
            profiles: [SAMPLE_PROFILE],
          },
        },
      });

      const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "hallucinated-id" }]);
      const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

      const warn = warnings.find(
        (w) => w.message.includes("hallucinated-id") || w.message.includes("unknown"),
      );
      expect(warn).toBeDefined();
      expect(warn?.data?.storyId).toBe(result[0].id);
    } finally {
      _decomposeOpDeps.getSafeLogger = orig;
    }
  });
});

describe("decomposeOp — build: agent profile instruction injection", () => {
  test("AC-T8-6: agent profile selection instruction is injected when enabled and profiles are non-empty", () => {
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

    expect(prompt).toContain("agentProfileId");
  });

  test("AC-T8-6b: agent profile selection instruction is NOT injected when routing.agents.enabled === false", () => {
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

    // The instruction appended by agentProfileInstruction() should not be present
    // (Note: agentProfileId may appear from the schema example — check for the full instruction phrase)
    expect(prompt).not.toContain("assign the best-matching profile id to the");
  });

  test("AC-T8-6c: agent profile selection instruction is NOT injected when profiles is empty", () => {
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

    expect(prompt).not.toContain("assign the best-matching profile id to the");
  });
});
