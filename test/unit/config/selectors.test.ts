import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  NaxConfigSchema,
  agentManagerConfigSelector,
  contextToolRuntimeConfigSelector,
  debateConfigSelector,
  interactionConfigSelector,
  planConfigSelector,
  precheckConfigSelector,
  promptLoaderConfigSelector,
  qualityConfigSelector,
  reviewConfigSelector,
  routingConfigSelector,
  tddConfigSelector,
  testPatternConfigSelector,
} from "@/config";
import type { DebateConfig } from "@/config/selectors";

describe("ConfigSelector — Phase 1 selectors", () => {
  describe("new selectors", () => {
    test("agentManagerConfigSelector picks agent, execution and profile", () => {
      const slice = agentManagerConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("agent");
      expect(slice).toHaveProperty("execution");
      // #1433 — AgentManager stamps the resolved profile onto dispatch events so
      // cost rows record which overlay was active.
      expect(slice).toHaveProperty("profile");
      expect(Object.keys(slice).sort()).toEqual(["agent", "execution", "profile"]);
    });

    test.each([
      [agentManagerConfigSelector, "agent-manager"],
      [interactionConfigSelector, "interaction"],
      [precheckConfigSelector, "precheck"],
      [qualityConfigSelector, "quality"],
      [testPatternConfigSelector, "test-pattern"],
      [contextToolRuntimeConfigSelector, "context-tool-runtime"],
      [promptLoaderConfigSelector, "prompt-loader"],
    ] as const)("%s selector has correct name", (selector, name) => {
      expect(selector.name).toBe(name);
    });

    test("interactionConfigSelector picks interaction", () => {
      const slice = interactionConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("interaction");
      expect(Object.keys(slice)).toEqual(["interaction"]);
    });

    test("interactionConfigSelector preserves values", () => {
      const slice = interactionConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.interaction).toEqual(DEFAULT_CONFIG.interaction);
    });

    test("precheckConfigSelector picks all keys precheck/* uses", () => {
      const slice = precheckConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toMatchObject({
        precheck: expect.any(Object),
        quality: expect.any(Object),
        execution: expect.any(Object),
        // MED-03: checkAgentCLI resolves the agent via resolveDefaultAgent(config),
        // which reads config.agent.default — precheck's slice must include it.
        agent: expect.any(Object),
      });
      expect(Object.keys(slice).sort()).toEqual([
        "agent",
        "execution",
        "precheck",
        "project",
        "prompts",
        "quality",
        "review",
      ]);
    });

    test("qualityConfigSelector picks quality and execution", () => {
      const slice = qualityConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("quality");
      expect(slice).toHaveProperty("execution");
      expect(Object.keys(slice).sort()).toEqual(["execution", "quality"]);
    });
  });

  describe("widened selectors", () => {
    test("debateConfigSelector includes only debate and agent (models removed in US-006 Phase D)", () => {
      const slice = debateConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("debate");
      expect(slice).toHaveProperty("agent");
      expect(slice).not.toHaveProperty("models");
      expect(Object.keys(slice).sort()).toEqual(["agent", "debate"]);
    });

    test("reviewConfigSelector now includes models, execution, project, quality, agent", () => {
      const slice = reviewConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("review");
      expect(slice).toHaveProperty("debate");
      expect(slice).toHaveProperty("models");
      expect(slice).toHaveProperty("execution");
      expect(slice).toHaveProperty("project");
      expect(slice).toHaveProperty("quality");
      expect(slice).toHaveProperty("agent");
      expect(Object.keys(slice).sort()).toEqual([
        "agent",
        "debate",
        "execution",
        "models",
        "project",
        "quality",
        "review",
      ]);
    });

    test("tddConfigSelector now includes quality, agent, models, prompts, context, project, precheck", () => {
      const slice = tddConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("tdd");
      expect(slice).toHaveProperty("execution");
      expect(slice).toHaveProperty("quality");
      expect(slice).toHaveProperty("agent");
      expect(slice).toHaveProperty("models");
      expect(slice).toHaveProperty("prompts");
      expect(slice).toHaveProperty("context");
      expect(slice).toHaveProperty("project");
      expect(slice).toHaveProperty("precheck");
      expect(Object.keys(slice).sort()).toEqual([
        "agent",
        "context",
        "execution",
        "models",
        "precheck",
        "project",
        "prompts",
        "quality",
        "tdd",
      ]);
    });

    test("routingConfigSelector now includes autoMode and tdd", () => {
      const slice = routingConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("routing");
      expect(slice).toHaveProperty("autoMode");
      expect(slice).toHaveProperty("tdd");
      expect(Object.keys(slice).sort()).toEqual(["autoMode", "routing", "tdd"]);
    });
  });

  describe("round-trip — sliced values match full config", () => {
    test("agentManagerConfigSelector preserves values", () => {
      const slice = agentManagerConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.agent).toEqual(DEFAULT_CONFIG.agent);
      expect(slice.execution).toEqual(DEFAULT_CONFIG.execution);
    });

    test("precheckConfigSelector preserves values", () => {
      const slice = precheckConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.quality).toEqual(DEFAULT_CONFIG.quality);
      expect(slice.execution).toEqual(DEFAULT_CONFIG.execution);
      expect(slice.review).toEqual(DEFAULT_CONFIG.review);
    });

    test("debateConfigSelector preserves debate and agent values (no models)", () => {
      const slice = debateConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.debate).toEqual(DEFAULT_CONFIG.debate);
      expect(slice.agent).toEqual(DEFAULT_CONFIG.agent);
    });

    test("reviewConfigSelector preserves values", () => {
      const slice = reviewConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.review).toEqual(DEFAULT_CONFIG.review);
      expect(slice.models).toEqual(DEFAULT_CONFIG.models);
      expect(slice.execution).toEqual(DEFAULT_CONFIG.execution);
    });

    test("tddConfigSelector preserves values", () => {
      const slice = tddConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.tdd).toEqual(DEFAULT_CONFIG.tdd);
      expect(slice.quality).toEqual(DEFAULT_CONFIG.quality);
      expect(slice.models).toEqual(DEFAULT_CONFIG.models);
      expect(slice.agent).toEqual(DEFAULT_CONFIG.agent);
    });

    test("routingConfigSelector preserves values", () => {
      const slice = routingConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.routing).toEqual(DEFAULT_CONFIG.routing);
      expect(slice.autoMode).toEqual(DEFAULT_CONFIG.autoMode);
      expect(slice.tdd).toEqual(DEFAULT_CONFIG.tdd);
    });
  });

  describe("new selectors from eliminate-naxconfig-silent-fail-casts plan", () => {
    test("testPatternConfigSelector picks execution, project, quality", () => {
      const slice = testPatternConfigSelector.select(DEFAULT_CONFIG);
      expect(Object.keys(slice).sort()).toEqual(["execution", "project", "quality"]);
    });

    test("contextToolRuntimeConfigSelector picks context, execution, project, quality", () => {
      const slice = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
      expect(Object.keys(slice).sort()).toEqual(["context", "execution", "project", "quality"]);
    });

    test("promptLoaderConfigSelector picks prompts, context, project", () => {
      const slice = promptLoaderConfigSelector.select(DEFAULT_CONFIG);
      expect(Object.keys(slice).sort()).toEqual(["context", "project", "prompts"]);
    });
  });
});

describe("planConfigSelector — ADR-025 routing slice", () => {
  test("includes routing so plan-time agent selection can read routing.agents", () => {
    const full = NaxConfigSchema.parse({});
    const slice = planConfigSelector.select(full);
    expect(slice.routing).toBeDefined();
    expect(slice.routing?.agents).toBeDefined();
  });
});

// AC9: DebateConfig derived type has exactly "debate" | "agent" keys
describe("DebateConfig type shape (AC9 — US-006 Phase D)", () => {
  test("DebateConfig has exactly the keys 'debate' and 'agent' at runtime", () => {
    const slice = debateConfigSelector.select(DEFAULT_CONFIG);
    expect(Object.keys(slice).sort()).toEqual(["agent", "debate"]);
  });

  test("DebateConfig compile-time shape: 'models' is no longer a key", () => {
    // Compile-time guard: this line fails tsc if DebateConfig still includes 'models'.
    // Runtime assertion is also checked via the selector test above.
    const slice: DebateConfig = debateConfigSelector.select(DEFAULT_CONFIG);
    const keys = Object.keys(slice);
    expect(keys).not.toContain("models");
  });
});
