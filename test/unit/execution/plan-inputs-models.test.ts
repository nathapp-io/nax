/**
 * PlanInputs — model tier mapping validation (AC4 coverage)
 *
 * Covers the second config guard in assemblePlanInputs: config.models must contain
 * at least one tier mapping for the default agent, otherwise slot-model-tier resolution
 * silently returns undefined (hidden null propagation).
 *
 * Kept separate from plan-inputs.test.ts (concern-based split per test-architecture.md).
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeSparseNaxConfig, makeStory } from "@test/helpers";
import { NaxError } from "@/errors";
import { assemblePlanInputs } from "@/execution";

describe("assemblePlanInputs — model tier mapping validation", () => {
  test("passes when default agent has tier mappings in config.models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
    });

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
  });

  test("throws CONFIG_INVALID when config.models is empty (no mappings for any agent)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error code is CONFIG_INVALID for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).code).toBe("CONFIG_INVALID");
    }
  });

  test("error context.field is 'models' for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.field).toBe("models");
    }
  });

  test("error context.stage is 'execution-inputs' for missing model mappings", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
    }
  });

  test("throws CONFIG_INVALID when default agent has no entry in models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // sparse config: agent.default set, models omitted entirely
    const config = makeSparseNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
      models: {},
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("throws CONFIG_INVALID when agent.default names an agent absent from models", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // sparse config: models only contains "other-agent", not the default "claude"
    const config = makeSparseNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
      models: { "other-agent": { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error message references tier mapping requirement", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).message.toLowerCase()).toContain("model");
    }
  });

  test("error includes storyId for correlation", () => {
    const story = makeStory({ id: "US-042", title: "Feature" });
    const config = makeNaxConfig({ models: {} });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.storyId).toBe("US-042");
    }
  });

  test("agent.default check fires before models check (agent error takes priority)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    // Both invalid: empty agent.default and empty models
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
      models: {},
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      // The agent.default guard fires first; field should be "agent.default"
      expect((err as NaxError).context?.field).toBe("agent.default");
    }
  });
});
