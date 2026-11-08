import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import {
  agentManagerConfigSelector,
  DEFAULT_CONFIG,
  planConfigSelector,
  qualityConfigSelector,
  routingConfigSelector,
  workflowConfigSelector,
} from "@/config";

describe("ConfigSelector — Phase 1 selectors", () => {
  describe("new selectors", () => {
    test("agentManagerConfigSelector picks agent, execution, profile and context", () => {
      const slice = agentManagerConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("agent");
      expect(slice).toHaveProperty("execution");
      // #1433 — AgentManager stamps the resolved profile onto dispatch events so
      // cost rows record which overlay was active.
      expect(slice).toHaveProperty("profile");
      // US-007 — `instructionOptionsForSession` reads `context.projectContext`
      // off the `AgentRunOptions.config` this slice fills, to deny a native
      // session the repository's root instruction file under `mode: "replace"`.
      expect(slice).toHaveProperty("context");
      expect(Object.keys(slice).sort()).toEqual(["agent", "context", "execution", "profile"]);
    });

    test.each([
      [agentManagerConfigSelector, "agent-manager"],
      [qualityConfigSelector, "quality"],
    ] as const)("%s selector has correct name", (selector, name) => {
      expect(selector.name).toBe(name);
    });

    test("qualityConfigSelector picks quality and execution", () => {
      const slice = qualityConfigSelector.select(DEFAULT_CONFIG);
      expect(slice).toHaveProperty("quality");
      expect(slice).toHaveProperty("execution");
      expect(Object.keys(slice).sort()).toEqual(["execution", "quality"]);
    });
  });

  describe("round-trip — sliced values match full config", () => {
    test("agentManagerConfigSelector preserves values", () => {
      const slice = agentManagerConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.agent).toEqual(DEFAULT_CONFIG.agent);
      expect(slice.execution).toEqual(DEFAULT_CONFIG.execution);
    });

    test("routingConfigSelector preserves values", () => {
      const slice = routingConfigSelector.select(DEFAULT_CONFIG);
      expect(slice.routing).toEqual(DEFAULT_CONFIG.routing);
      expect(slice.autoMode).toEqual(DEFAULT_CONFIG.autoMode);
      expect(slice.tdd).toEqual(DEFAULT_CONFIG.tdd);
    });
  });
});

describe("planConfigSelector — ADR-025 routing slice", () => {
  test("includes routing so plan-time agent selection can read routing.agents", () => {
    const slice = planConfigSelector.select(DEFAULT_CONFIG);
    expect(slice.routing).toBeDefined();
    expect(slice.routing?.agents).toBeDefined();
  });
});

// US-001 — the retained selectors' key boundaries. Each assertion compares the
// selector's own key set, so a dropped or added pick fails here.
describe("retained selector key boundaries (US-001)", () => {
  test("AC-1: planConfigSelector picks exactly plan, agent, models, project and routing", () => {
    const slice = planConfigSelector.select(makeNaxConfig());
    expect(Object.keys(slice).sort()).toEqual(["agent", "models", "plan", "project", "routing"]);
  });

  test("AC-2: workflowConfigSelector picks exactly workflow, review, execution, autoMode, quality, agent, models and finish", () => {
    const slice = workflowConfigSelector.select(makeNaxConfig());
    expect(Object.keys(slice).sort()).toEqual([
      "agent",
      "autoMode",
      "execution",
      "finish",
      "models",
      "quality",
      "review",
      "workflow",
    ]);
  });

  test("AC-3: routingConfigSelector picks exactly routing, autoMode and tdd", () => {
    const slice = routingConfigSelector.select(makeNaxConfig());
    expect(Object.keys(slice).sort()).toEqual(["autoMode", "routing", "tdd"]);
  });

  test("AC-4: planConfigSelector omits an execution section the config carries", () => {
    const config = makeNaxConfig({ execution: { costLimit: 7 } });
    // The section is genuinely present on the source config.
    expect(config.execution.costLimit).toBe(7);

    const slice = planConfigSelector.select(config);
    expect(Object.hasOwn(slice, "execution")).toBe(false);
    expect(slice).not.toHaveProperty("execution");
  });
});
