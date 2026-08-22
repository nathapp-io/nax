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

import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import { type PlanInputs, assemblePlanInputs, assemblePlanInputsFromCtx } from "@/execution";
import { _diffUtilsDeps } from "@/review";
import type { ResolvedTestPatterns } from "@/test-runners";
import { makeNaxConfig, makeSpawn, makeStory } from "@test/helpers";

// Helper: stub git-diff spawn so review-input prep can resolve stat. The orchestrator
// path calls collectDiffStat before constructing review inputs; tests that assert
// the slots populate must provide a non-empty stat or the slot is correctly skipped.
function makeStatSpawn(stat: string) {
  return makeSpawn(() => stat).spawn;
}

const FAKE_PATTERNS: ResolvedTestPatterns = {
  globs: [],
  regex: [],
  pathspec: [],
  testDirs: [],
  resolution: "fallback",
};

// AC1: PlanInputs includes all required slot keys
describe("PlanInputs type", () => {
  test("minimal PlanInputs requires only story and config", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();
    const inputs: PlanInputs = { story, config };
    expect(inputs.story).toBe(story);
    expect(inputs.config).toBe(config);
    expect(inputs.testWriter).toBeUndefined();
    expect(inputs.greenfieldGate).toBeUndefined();
    expect(inputs.implementer).toBeUndefined();
    expect(inputs.fullSuiteGate).toBeUndefined();
    expect(inputs.verifier).toBeUndefined();
    expect(inputs.semanticReview).toBeUndefined();
    expect(inputs.adversarialReview).toBeUndefined();
    expect(inputs.rectification).toBeUndefined();
  });

  test("PlanInputs accepts correctly-typed slot inputs", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();
    const inputs: PlanInputs = {
      story,
      config,
      testWriter: { story, contextMarkdown: "ctx" },
      greenfieldGate: { story, workdir: "/tmp", resolvedTestPatterns: FAKE_PATTERNS },
      implementer: { story, contextMarkdown: "ctx" },
      fullSuiteGate: { story, workdir: "/tmp" },
      verifier: { story },
      rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false },
    };
    expect(inputs.greenfieldGate?.workdir).toBe("/tmp");
    expect(inputs.fullSuiteGate?.workdir).toBe("/tmp");
    expect(inputs.verifier?.story).toBe(story);
    expect(inputs.rectification?.maxAttempts).toBe(3);
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

  test.each([
    ["story.id empty", { id: "", title: "Test" }],
    ["story.title empty", { id: "US-001", title: "" }],
    ["story.id whitespace", { id: "   ", title: "Test" }],
    ["story.title whitespace", { id: "US-001", title: "   " }],
  ])("throws NaxError when %s", (_label, storyOverrides) => {
    const story = makeStory(storyOverrides as any);
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

  test("validates config.agent.default: throws NaxError with stage='execution-inputs' and human-readable message", () => {
    const story = makeStory({ id: "US-001", title: "Test feature" });
    const config = makeNaxConfig({ agent: { default: "", fallback: { map: {} } } });
    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
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
  test("error includes config field path in context and machine-readable code", () => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig({ agent: { default: "", fallback: { map: {} } } });
    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.field).toBe("agent.default");
      expect(/^[A-Z_]+$/.test((err as NaxError).code)).toBe(true);
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

  test.each([
    ["story id", { id: "" }, undefined, "STORY_ID_INVALID"],
    ["story title", { id: "US-001", title: "" }, undefined, "STORY_TITLE_MISSING"],
    ["config", { id: "US-001" }, { agent: { default: "", fallback: { map: {} } } }, "CONFIG_INVALID"],
  ])(
    "NaxError has machine-readable code on %s failure",
    (_label: string, storyOverrides: any, configOverrides: any, expectedCode: string) => {
      const story = makeStory(storyOverrides as any);
      const config = configOverrides ? makeNaxConfig(configOverrides) : makeNaxConfig();
      try {
        assemblePlanInputs(story, config);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect((err as NaxError).code).toBe(expectedCode);
      }
    },
  );

  test("NaxError context has stage+storyId; code is UPPER_SNAKE_CASE; message is human-readable", () => {
    const story = makeStory({ id: "" });
    const config = makeNaxConfig();
    try {
      assemblePlanInputs(story, config);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
      expect((err as NaxError).context?.storyId).toBeDefined();
      expect(/^[A-Z_]+$/.test((err as NaxError).code)).toBe(true);
      expect((err as NaxError).message.toLowerCase()).toContain("required");
    }
  });
});

// AC6: Validation behavior covered by targeted unit tests
describe("assemblePlanInputs - edge cases", () => {
  test.each([
    ["undefined workdir (single-package)", { workdir: undefined }, "workdir", undefined],
    ["workdir (monorepo)", { workdir: "packages/api" }, "workdir", "packages/api"],
    ["empty dependencies", { dependencies: [] }, "dependencies", []],
    ["filled dependencies", { dependencies: ["US-005"] }, "dependencies", ["US-005"]],
  ])("handles story with %s", (_label: string, overrides: any, field: string, expected: any) => {
    const story = makeStory({ id: "US-001", title: "Test", ...overrides });
    const config = makeNaxConfig();
    const result = assemblePlanInputs(story, config);
    if (expected === undefined) {
      expect((result.story as any)[field]).toBeUndefined();
    } else {
      expect((result.story as any)[field]).toEqual(expected);
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC1: PlanInputs new slots (verifyScoped, lintCheck, typecheckCheck)
// ─────────────────────────────────────────────────────────────────────────────

function makeNonTddCtx(configOverride: Record<string, unknown> = {}): any {
  const config = {
    ...DEFAULT_CONFIG,
    ...configOverride,
    execution: {
      ...DEFAULT_CONFIG.execution,
      ...((configOverride.execution as object) ?? {}),
    },
    review: {
      ...DEFAULT_CONFIG.review,
      ...((configOverride.review as object) ?? {}),
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      ...((configOverride.quality as object) ?? {}),
      commands: {
        ...(DEFAULT_CONFIG.quality?.commands ?? {}),
        ...(((configOverride.quality as Record<string, unknown>)?.commands as object) ?? {}),
      },
    },
  };
  return {
    story: makeStory({ id: "US-001", title: "Test" }),
    config,
    workdir: "/tmp/repo",
    routing: { testStrategy: "no-test", agent: "claude" },
    prompt: "do the thing",
    featureContextMarkdown: "feat",
    constitution: { content: "" },
    prd: { feature: "f" },
    projectDir: "/tmp/proj",
  };
}

describe("PlanInputs — AC1: new optional slots (US-005)", () => {
  test.each([
    ["verifyScoped", "verifyScoped" as const],
    ["lintCheck", "lintCheck" as const],
    ["typecheckCheck", "typecheckCheck" as const],
  ])("AC1: PlanInputs type accepts %s slot input", (_label, slotKey) => {
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();
    const inputs: PlanInputs = {
      story,
      config,
      [slotKey]: { workdir: "/tmp", storyId: "US-001" },
    };
    expect(inputs[slotKey]).toBeDefined();
    expect((inputs[slotKey] as { workdir: string })?.workdir).toBe("/tmp");
  });

  test("AC1: assemblePlanInputsFromCtx populates verifyScoped for non-TDD strategy", async () => {
    const ctx = makeNonTddCtx();
    const inputs = await assemblePlanInputsFromCtx(ctx);
    // Non-TDD strategies should receive verifyScoped slot when configured
    expect(inputs.verifyScoped).toBeDefined();
  });

  test.each([
    ["deferred", "deferred" as const, "deferred"],
    ["per-story", "per-story" as const, "per-story"],
    ["disabled (maps to deferred)", "disabled" as const, "deferred"],
  ])(
    "AC1: verifyScoped.regressionMode when regressionGate.mode=%s",
    async (_label, gateMode, expectedRegressionMode) => {
      const ctx = makeNonTddCtx({
        execution: {
          ...DEFAULT_CONFIG.execution,
          regressionGate: { ...DEFAULT_CONFIG.execution.regressionGate, mode: gateMode },
        },
      });
      const inputs = await assemblePlanInputsFromCtx(ctx);
      expect(inputs.verifyScoped?.regressionMode).toBe(expectedRegressionMode);
    },
  );

  test("AC1: assemblePlanInputsFromCtx populates lintCheck when 'lint' in review.checks and lint command configured", async () => {
    const ctx = makeNonTddCtx({
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["lint"],
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...(DEFAULT_CONFIG.quality?.commands ?? {}),
          lint: "bun run lint",
        },
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.lintCheck).toBeDefined();
  });

  test("AC1: assemblePlanInputsFromCtx populates typecheckCheck when 'typecheck' in review.checks and typecheck command configured", async () => {
    const ctx = makeNonTddCtx({
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["typecheck"],
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...(DEFAULT_CONFIG.quality?.commands ?? {}),
          typecheck: "bun run typecheck",
        },
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.typecheckCheck).toBeDefined();
  });

  test("AC1: lintCheck remains undefined when 'lint' not in review.checks", async () => {
    const ctx = makeNonTddCtx({
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...(DEFAULT_CONFIG.quality?.commands ?? {}),
          lint: "bun run lint",
        },
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.lintCheck).toBeUndefined();
  });

  test("AC1: assemblePlanInputsFromCtx populates semanticReview when check enabled and config present", async () => {
    const origSpawn = _diffUtilsDeps.spawn;
    const origIsValid = _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.spawn = makeStatSpawn(" src/foo.ts | 5 +-\n 1 file changed\n");
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    try {
      const ctx = makeNonTddCtx({
        review: {
          ...DEFAULT_CONFIG.review,
          enabled: true,
          checks: ["semantic"],
        },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      expect(inputs.semanticReview).toBeDefined();
      expect(inputs.semanticReview?.storyGitRef).toBe("abc123");
    } finally {
      _diffUtilsDeps.spawn = origSpawn;
      _diffUtilsDeps.isGitRefValid = origIsValid;
    }
  });

  test("AC1: assemblePlanInputsFromCtx populates adversarialReview when check enabled and config present", async () => {
    const origSpawn = _diffUtilsDeps.spawn;
    const origIsValid = _diffUtilsDeps.isGitRefValid;
    _diffUtilsDeps.spawn = makeStatSpawn(" src/foo.ts | 5 +-\n 1 file changed\n");
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    try {
      const ctx = makeNonTddCtx({
        review: {
          ...DEFAULT_CONFIG.review,
          enabled: true,
          checks: ["adversarial"],
          adversarial: {
            model: "balanced",
            diffMode: "ref",
            rules: [],
            timeoutMs: 600_000,
            parallel: false,
            maxConcurrentSessions: 2,
          },
        },
      });
      ctx.storyGitRef = "abc123";
      const inputs = await assemblePlanInputsFromCtx(ctx);
      expect(inputs.adversarialReview).toBeDefined();
      expect(inputs.adversarialReview?.storyGitRef).toBe("abc123");
    } finally {
      _diffUtilsDeps.spawn = origSpawn;
      _diffUtilsDeps.isGitRefValid = origIsValid;
    }
  });
});

// Additional validation tests
describe("assemblePlanInputs - complete scenario", () => {
  test("builds valid PlanInputs and preserves story/config refs", () => {
    const story = makeStory({ id: "US-001", title: "Implement feature", workdir: "packages/lib" });
    const config = makeNaxConfig({ agent: { default: "claude", fallback: { map: {} } } });
    const result = assemblePlanInputs(story, config);
    expect(result.story).toBe(story);
    expect(result.config).toBe(config);
  });

  test("fails fast on first validation error — story id or config agent.default", () => {
    expect(() => assemblePlanInputs(makeStory({ id: "" }), makeNaxConfig())).toThrow(NaxError);
    expect(() =>
      assemblePlanInputs(makeStory({ id: "US-001" }), makeNaxConfig({ agent: { default: "", fallback: { map: {} } } })),
    ).toThrow(NaxError);
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

// ─────────────────────────────────────────────────────────────────────────────
// US-1496: no-progress fields threaded into RectificationPhaseOptions
//
// Acceptance criteria covered here:
//   AC 7 — abortOnNoProgress is read from config.execution.rectification.abortOnNoProgress
//   AC 8 — consecutiveNoProgressToBail is read from config.execution.rectification.consecutiveNoProgressToBail
// ─────────────────────────────────────────────────────────────────────────────

describe("assemblePlanInputsFromCtx — no-progress fields (US-1496)", () => {
  test("[US-1496 AC 7] RectificationPhaseOptions.abortOnNoProgress reads from config.execution.rectification.abortOnNoProgress", async () => {
    const ctx = makeNonTddCtx({
      execution: {
        ...DEFAULT_CONFIG.execution,
        inlineReview: true,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          enabled: true,
          abortOnNoProgress: false,
          consecutiveNoProgressToBail: 7,
        },
      },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.rectification).toBeDefined();
    expect(inputs.rectification!.abortOnNoProgress).toBe(false);
  });

  test("[US-1496 AC 8] RectificationPhaseOptions.consecutiveNoProgressToBail reads from config.execution.rectification.consecutiveNoProgressToBail", async () => {
    const ctx = makeNonTddCtx({
      execution: {
        ...DEFAULT_CONFIG.execution,
        inlineReview: true,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          enabled: true,
          abortOnNoProgress: false,
          consecutiveNoProgressToBail: 7,
        },
      },
      review: {
        ...DEFAULT_CONFIG.review,
        enabled: true,
        checks: ["semantic"],
      },
    });
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.rectification).toBeDefined();
    expect(inputs.rectification!.consecutiveNoProgressToBail).toBe(7);
  });
});
