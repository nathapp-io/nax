import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import {
  agentManagerConfigSelector,
  contextToolRuntimeConfigSelector,
  debateConfigSelector,
  interactionConfigSelector,
  precheckConfigSelector,
  promptLoaderConfigSelector,
  qualityConfigSelector,
  reviewConfigSelector,
  routingConfigSelector,
  tddConfigSelector,
  testPatternConfigSelector,
} from "../../../src/config/selectors";

describe("ConfigSelector — Phase 1 selectors", () => {
  describe("new selectors", () => {
    test("agentManagerConfigSelector picks agent and execution", () => {
      const slice = agentManagerConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("agent");
      expect(slice).toHaveProperty("execution");
      expect(Object.keys(slice).sort()).toEqual(["agent", "execution"]);
    });

    test("agentManagerConfigSelector has correct name", () => {
      expect(agentManagerConfigSelector.name).toBe("agent-manager");
    });

    test("interactionConfigSelector picks interaction", () => {
      const slice = interactionConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("interaction");
      expect(Object.keys(slice)).toEqual(["interaction"]);
    });

    test("interactionConfigSelector has correct name", () => {
      expect(interactionConfigSelector.name).toBe("interaction");
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
      });
      expect(Object.keys(slice).sort()).toEqual([
        "execution",
        "precheck",
        "project",
        "prompts",
        "quality",
        "review",
      ]);
    });

    test("precheckConfigSelector has correct name", () => {
      expect(precheckConfigSelector.name).toBe("precheck");
    });

    test("qualityConfigSelector picks quality and execution", () => {
      const slice = qualityConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("quality");
      expect(slice).toHaveProperty("execution");
      expect(Object.keys(slice).sort()).toEqual(["execution", "quality"]);
    });

    test("qualityConfigSelector has correct name", () => {
      expect(qualityConfigSelector.name).toBe("quality");
    });
  });

  describe("widened selectors", () => {
    test("debateConfigSelector now includes models and agent", () => {
      const slice = debateConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("debate");
      expect(slice).toHaveProperty("models");
      expect(slice).toHaveProperty("agent");
      expect(Object.keys(slice).sort()).toEqual(["agent", "debate", "models"]);
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

    test("debateConfigSelector preserves values", () => {
      const slice = debateConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.debate).toEqual(DEFAULT_CONFIG.debate);
      expect(slice.models).toEqual(DEFAULT_CONFIG.models);
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

    test("testPatternConfigSelector has correct name", () => {
      expect(testPatternConfigSelector.name).toBe("test-pattern");
    });

    test("contextToolRuntimeConfigSelector picks context, execution, project, quality", () => {
      const slice = contextToolRuntimeConfigSelector.select(DEFAULT_CONFIG);
      expect(Object.keys(slice).sort()).toEqual(["context", "execution", "project", "quality"]);
    });

    test("contextToolRuntimeConfigSelector has correct name", () => {
      expect(contextToolRuntimeConfigSelector.name).toBe("context-tool-runtime");
    });

    test("promptLoaderConfigSelector picks prompts, context, project", () => {
      const slice = promptLoaderConfigSelector.select(DEFAULT_CONFIG);
      expect(Object.keys(slice).sort()).toEqual(["context", "project", "prompts"]);
    });

    test("promptLoaderConfigSelector has correct name", () => {
      expect(promptLoaderConfigSelector.name).toBe("prompt-loader");
    });
  });
});