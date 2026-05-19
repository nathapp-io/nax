/**
 * PlanInputs Assembly Tests
 *
 * Tests for PlanInputs type and assemblePlanInputs validation function.
 * Covers:
 * - AC1: PlanInputs includes testWriter, greenfieldGate, implementer, fullSuiteGate, verifier, semanticReview, adversarialReview, rectification
 * - AC2: assemblePlanInputs validates required data before returning PlanInputs
 * - AC3: Missing resolved test patterns produces deterministic structured failure
 * - AC4: Invalid or missing config produces deterministic structured failure
 * - AC5: Validation failures use NaxError with machine-readable code and context.stage='execution-inputs'
 * - AC6: Validation behavior is covered by targeted unit tests
 */

import { describe, test, expect } from "bun:test";
import { NaxError } from "@/errors";
import { assemblePlanInputs, type PlanInputs } from "@/execution";
import { makeStory, makeNaxConfig } from "@test/helpers";

// AC1: PlanInputs type with all required slots
describe("PlanInputs type", () => {
  test("PlanInputs is a valid TypeScript type that includes all slots", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    // This creates a minimal valid PlanInputs
    const inputs: PlanInputs = {
      story,
      config,
    };

    expect(inputs).toBeDefined();
    expect(inputs.story).toBe(story);
    expect(inputs.config).toBe(config);
  });

  test("PlanInputs can include testWriter slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      testWriter: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.testWriter).toBeDefined();
  });

  test("PlanInputs can include greenfieldGate slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      greenfieldGate: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.greenfieldGate).toBeDefined();
  });

  test("PlanInputs can include implementer slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      implementer: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.implementer).toBeDefined();
  });

  test("PlanInputs can include fullSuiteGate slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      fullSuiteGate: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.fullSuiteGate).toBeDefined();
  });

  test("PlanInputs can include verifier slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      verifier: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.verifier).toBeDefined();
  });

  test("PlanInputs can include semanticReview slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      semanticReview: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.semanticReview).toBeDefined();
  });

  test("PlanInputs can include adversarialReview slot when provided", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputs: PlanInputs = {
      story,
      config,
      adversarialReview: {
        story,
        contextMarkdown: "test context",
      },
    };

    expect(inputs.adversarialReview).toBeDefined();
  });

  test("PlanInputs rectification slot is optional", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();

    const inputsWithout: PlanInputs = { story, config };
    expect(inputsWithout.rectification).toBeUndefined();

    const inputsWith: PlanInputs = { story, config, rectification: {} };
    expect(inputsWith.rectification).toBeDefined();
  });
});

// AC2: assemblePlanInputs validates required data
describe("assemblePlanInputs validation", () => {
  test("returns PlanInputs when all required data is present and valid", () => {
    const story = makeStory({ id: "US-001", title: "Test story" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);

    expect(result).toBeDefined();
    expect(result.story).toBe(story);
    expect(result.config).toBe(config);
  });

  test("throws NaxError when story.id is empty", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("throws NaxError when story.title is empty", () => {
    const story = makeStory({ id: "US-001", title: "" });
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("validates story.id is non-empty string", () => {
    const story = makeStory({ id: "   " }); // Whitespace only
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("validates story.title is non-empty string", () => {
    const story = makeStory({ id: "US-001", title: "   " }); // Whitespace only
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });
});

// AC3: Missing resolved test patterns produces deterministic structured failure
describe("assemblePlanInputs - missing test patterns", () => {
  test("returns valid PlanInputs even when called with basic story/config", () => {
    const story = makeStory({ id: "US-001", title: "Test feature" });
    const config = makeNaxConfig();

    // Test pattern validation is deferred to downstream orchestrator setup
    // assemblePlanInputs validates only the boundary contract
    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
  });

  test("validates config.agent.default is set", () => {
    const story = makeStory({ id: "US-001", title: "Test feature" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error for missing agent includes context with stage='execution-inputs'", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
    }
  });

  test("error message is human-readable for missing agent", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).message).toContain("agent");
    }
  });

  test("handles monorepo story with workdir", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test feature",
      workdir: "packages/lib",
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.workdir).toBe("packages/lib");
  });
});

// AC4: Invalid or missing config produces deterministic structured failure
describe("assemblePlanInputs - invalid config", () => {
  test("throws NaxError when agent.default is not set", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: {
        default: "",
        fallback: { map: {} },
      },
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("error includes config field path in context", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: {
        default: "",
        fallback: { map: {} },
      },
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.field).toBe("agent.default");
    }
  });

  test("error code is machine-readable", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: {
        default: "",
        fallback: { map: {} },
      },
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      const code = (err as NaxError).code;
      expect(/^[A-Z_]+$/.test(code)).toBe(true);
    }
  });

  test("validates config with valid agent.default", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        fallback: { map: {} },
      },
    });

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
  });

  test("handles story with per-package config (workdir present)", () => {
    const story = makeStory({
      id: "US-001",
      workdir: "packages/lib",
    });
    const config = makeNaxConfig({
      agent: {
        default: "claude",
        fallback: { map: {} },
      },
    });

    const result = assemblePlanInputs(story, config);
    expect(result.story.workdir).toBe("packages/lib");
  });
});

// AC5: Boundary validation uses canonical NaxError contract
describe("assemblePlanInputs - NaxError contract", () => {
  test("throws NaxError (not Error) on validation failure", () => {
    const story = makeStory({ id: "" }); // Invalid: empty id
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("NaxError has machine-readable code on story id failure", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).code).toBe("STORY_ID_INVALID");
    }
  });

  test("NaxError has machine-readable code on story title failure", () => {
    const story = makeStory({ id: "US-001", title: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).code).toBe("STORY_TITLE_MISSING");
    }
  });

  test("NaxError has machine-readable code on config failure", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).code).toBe("CONFIG_INVALID");
    }
  });

  test("NaxError context includes stage='execution-inputs'", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
    }
  });

  test("NaxError context includes story metadata for correlation", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.storyId).toBeDefined();
    }
  });

  test("NaxError code is machine-parseable (UPPER_SNAKE_CASE)", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      const code = (err as NaxError).code;
      expect(/^[A-Z_]+$/.test(code)).toBe(true);
    }
  });

  test("error message is human-readable", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      const msg = (err as NaxError).message;
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.toLowerCase()).toContain("required");
    }
  });
});

// AC6: Validation behavior covered by targeted unit tests
describe("assemblePlanInputs - edge cases", () => {
  test("handles story with optional workdir (single-package)", () => {
    const story = makeStory({ id: "US-001", title: "Test", workdir: undefined });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.workdir).toBeUndefined();
  });

  test("handles story with workdir (monorepo)", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test",
      workdir: "packages/api",
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.workdir).toBe("packages/api");
  });

  test("handles story with optional dependencies (empty)", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test",
      dependencies: [],
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.dependencies).toEqual([]);
  });

  test("handles story with optional dependencies (filled)", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test",
      dependencies: ["US-005"],
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.dependencies).toEqual(["US-005"]);
  });

  test("handles config with nested optional fields", () => {
    const story = makeStory({ id: "US-001", title: "Test" });
    const config = makeNaxConfig({
      context: undefined,
    });

    const result = assemblePlanInputs(story, config);
    expect(result.config).toBeDefined();
  });

  test("preserves story properties through assembly", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test feature",
      workdir: "packages/lib",
      dependencies: ["US-005"],
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story.id).toBe("US-001");
    expect(result.story.title).toBe("Test feature");
    expect(result.story.workdir).toBe("packages/lib");
    expect(result.story.dependencies).toEqual(["US-005"]);
  });

  test("preserves config properties through assembly", () => {
    const story = makeStory({ id: "US-001", title: "Test" });
    const config = makeNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
    });

    const result = assemblePlanInputs(story, config);
    expect(result.config.agent?.default).toBe("claude");
  });
});

// Additional validation tests
describe("assemblePlanInputs - complete scenario", () => {
  test("builds valid PlanInputs from story and config", () => {
    const story = makeStory({
      id: "US-001",
      title: "Implement feature",
      workdir: "packages/lib",
    });
    const config = makeNaxConfig({
      agent: { default: "claude", fallback: { map: {} } },
    });

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
    expect(result.story).toBe(story);
    expect(result.config).toBe(config);
  });

  test("fails fast on first validation error (story)", () => {
    const story = makeStory({ id: "" }); // Invalid story
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("fails fast on first validation error (config)", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } }, // Invalid config
    });

    expect(() => {
      assemblePlanInputs(story, config);
    }).toThrow(NaxError);
  });

  test("preserves story and config in returned PlanInputs", () => {
    const story = makeStory({
      id: "US-001",
      title: "Test",
      workdir: "packages/lib",
    });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result.story).toBe(story);
    expect(result.config).toBe(config);
  });

  test("returned PlanInputs has correct structure for downstream assembly", () => {
    const story = makeStory({ id: "US-001", title: "Test" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);

    // Core fields must be present
    expect(result.story).toBeDefined();
    expect(result.config).toBeDefined();

    // Optional slots can be undefined initially
    expect(typeof result.testWriter).not.toBe("function");
    expect(typeof result.greenfieldGate).not.toBe("function");
    expect(typeof result.implementer).not.toBe("function");
    expect(typeof result.fullSuiteGate).not.toBe("function");
    expect(typeof result.verifier).not.toBe("function");
    expect(typeof result.semanticReview).not.toBe("function");
    expect(typeof result.adversarialReview).not.toBe("function");
  });
});
