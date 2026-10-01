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
import { makeLogger, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { decomposeConfigSelector } from "@/config";
import { _decomposeOpDeps, decomposeOp } from "@/operations/decompose";
import type { NaxRuntime } from "@/runtime";

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
function makeDecomposeOutput(
  stories: Array<{
    id?: string;
    title?: string;
    agentProfileId?: string;
  }>,
): string {
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

describe("decomposeOp — parse: ADR-025 — no agent re-selection, raw output returned", () => {
  test("AC-T9-3: story without agentProfileId leaves routing undefined (raw output pass-through)", () => {
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

  test("AC-T9-1: story with agentProfileId leaves routing unchanged — parse does not resolve profiles", () => {
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

  // ADR-025: parse() is now a pure pass-through — it does NOT resolve agentProfileId → routing.agent.
  // Agent assignment is inherited from the parent story via mapDecomposedStoriesToUserStories(parentRouting).

  test("AC-T9-2: story with valid agentProfileId in LLM output → routing still undefined (no resolution in parse)", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "fast-coder" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    expect(result).toHaveLength(1);
    // parse() does NOT resolve profiles — routing remains undefined
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-2b: multiple stories with agentProfileIds → routing is undefined for all (ADR-025)", () => {
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
    // parse() no longer resolves any profile — all routing fields are absent
    expect(result[0].routing).toBeUndefined();
    expect(result[1].routing).toBeUndefined();
    expect(result[2].routing).toBeUndefined();
  });

  test("AC-T9-2c: parse returns raw LLM output — no routing mutation", () => {
    const ctx = makeBuildCtx({
      routing: {
        strategy: "keyword",
        agents: { enabled: true, profiles: [SAMPLE_PROFILE] },
      },
    });

    const output = makeDecomposeOutput([{ id: "US-001", agentProfileId: "fast-coder" }]);
    const result = decomposeOp.parse(output, SAMPLE_INPUT, ctx);

    // ADR-025: parse is a pass-through; routing is set downstream via parentRouting
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-1c: when agents.enabled === false, agentProfileId is still not resolved (ADR-025 — parse never resolves)", () => {
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

  test("AC-T9-4: default profile configured — parse still does not resolve (ADR-025)", () => {
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
    // ADR-025: default profile resolution moved to mapper via parentRouting
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-5: unknown agentProfileId + default configured — parse is still a pass-through", () => {
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
    expect(result[0].routing).toBeUndefined();
  });

  test("AC-T9-6: agentProfileId unknown + no default → routing undefined (unchanged)", () => {
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

  test("ADR-025: parse does not emit any logger warnings for unknown agentProfileId", () => {
    const orig = _decomposeOpDeps.getSafeLogger;
    const logger = makeLogger();
    _decomposeOpDeps.getSafeLogger = () => logger;
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
      decomposeOp.parse(output, SAMPLE_INPUT, ctx);

      // parse() is a pass-through — no profile resolution, no warning
      expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
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
