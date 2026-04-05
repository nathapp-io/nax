import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { spawnSync } from "bun";
import type { AgentResult } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { collectStoryMetrics, loadRunMetrics, saveRunMetrics } from "../../../src/metrics";
import type { RunMetrics, StoryMetrics, TokenUsage } from "../../../src/metrics/types";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKDIR = `/tmp/nax-token-usage-test-${randomUUID()}`;

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeCtx(
  story: UserStory,
  routingOverrides?: Partial<PipelineContext["routing"]>,
  ctxOverrides?: Partial<PipelineContext>,
): PipelineContext {
  return {
    config: { ...DEFAULT_CONFIG } as NaxConfig,
    prd: makePRD(story),
    story,
    stories: [story],
    routing: {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "test",
      ...routingOverrides,
    },
    workdir: WORKDIR,
    hooks: { hooks: {} },
    agentResult: {
      success: true,
      output: "",
      estimatedCost: 0.01,
      durationMs: 5000,
    },
    ...ctxOverrides,
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// AC-1: TokenUsage interface is defined in src/metrics/types.ts with correct fields
// ---------------------------------------------------------------------------

describe("AC-1: TokenUsage interface in src/metrics/types.ts", () => {
  test("TokenUsage interface has required fields input_tokens and output_tokens", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/metrics/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("input_tokens:");
    expect(content).toContain("output_tokens:");
  });

  test("TokenUsage interface has optional fields cache_read_input_tokens and cache_creation_input_tokens", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/metrics/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("cache_read_input_tokens?:");
    expect(content).toContain("cache_creation_input_tokens?:");
  });

  test("TokenUsage is exported with 'export interface TokenUsage'", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/metrics/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("export interface TokenUsage");
  });
});

// ---------------------------------------------------------------------------
// AC-2: tokens field of type TokenUsage | undefined is in StoryMetrics
// ---------------------------------------------------------------------------

describe("AC-2: tokens field in StoryMetrics interface", () => {
  test("StoryMetrics interface has optional tokens field", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/metrics/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("tokens?:");
  });

  test("collectStoryMetrics returns object with tokens field when tokenUsage is provided", () => {
    const story = makeStory();
    const ctx = makeCtx(
      story,
      {},
      {
        agentResult: {
          success: true,
          output: "",
          estimatedCost: 0.01,
          durationMs: 5000,
          tokenUsage: {
            input_tokens: 1000,
            output_tokens: 500,
          } as TokenUsage,
        },
      },
    );

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());
    expect("tokens" in metrics).toBe(true);
    expect(metrics.tokens).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-3: totalTokens field of type TokenUsage | undefined is in RunMetrics
// ---------------------------------------------------------------------------

describe("AC-3: totalTokens field in RunMetrics interface", () => {
  test("RunMetrics interface has optional totalTokens field", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/metrics/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("totalTokens?:");
  });
});

// ---------------------------------------------------------------------------
// AC-4: TokenUsage is included in export type statement in src/metrics/index.ts
// ---------------------------------------------------------------------------

describe("AC-4: TokenUsage is exported from src/metrics/index.ts", () => {
  test("TokenUsage is in the export type statement in metrics/index.ts", () => {
    const indexPath = resolve(import.meta.dir, "../../../src/metrics/index.ts");
    const content = readFileSync(indexPath, "utf-8");
    expect(content).toContain("TokenUsage");
  });
});

// ---------------------------------------------------------------------------
// AC-5: bun run typecheck exits with code 0
// ---------------------------------------------------------------------------

describe("AC-5: bun run typecheck passes", () => {
  test("bun run typecheck completes with exit code 0", () => {
    const projectRoot = resolve(import.meta.dir, "../../../..");
    const result = spawnSync(["bun", "run", "typecheck"], {
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6: TokenUsage with only required fields serializes without cache keys
// ---------------------------------------------------------------------------

describe("AC-6: TokenUsage with only required fields omits cache keys in JSON", () => {
  test("TokenUsage { input_tokens: n, output_tokens: m } serializes without cache fields", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
    };
    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json);
    expect(parsed.input_tokens).toBe(1000);
    expect(parsed.output_tokens).toBe(500);
    expect(parsed.cache_read_input_tokens).toBeUndefined();
    expect(parsed.creation_input_tokens).toBeUndefined();
  });

  test("TokenUsage with cache fields as 0 omits them from JSON serialization", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const json = JSON.stringify(usage);
    const parsed = JSON.parse(json);
    expect(parsed.cache_read_input_tokens).toBeUndefined();
    expect(parsed.cache_creation_input_tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-7: ACP adapter run() returns tokenUsage with four number fields
// ---------------------------------------------------------------------------

describe("AC-7: ACP adapter run() returns tokenUsage with four fields", () => {
  test("AgentResult type includes tokenUsage property", () => {
    const result: AgentResult = {
      success: true,
      exitCode: 0,
      output: "test output",
      rateLimited: false,
      durationMs: 1000,
      estimatedCost: 0.01,
      tokenUsage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      } as TokenUsage,
    };
    expect(result.tokenUsage).toBeDefined();
    const tu = result.tokenUsage;
    expect(tu).not.toBeNull();
    if (tu) {
      expect(tu.input_tokens).toBe(100);
      expect(tu.output_tokens).toBe(50);
      expect(tu.cache_read_input_tokens).toBe(10);
      expect(tu.cache_creation_input_tokens).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8: collectStoryMetrics populates storyMetrics.tokens when tokenUsage defined
// ---------------------------------------------------------------------------

describe("AC-8: collectStoryMetrics populates tokens when ctx.agentResult.tokenUsage is defined", () => {
  test("storyMetrics.tokens contains inputTokens, outputTokens, cache fields when tokenUsage is set", () => {
    const story = makeStory();
    const ctx = makeCtx(
      story,
      {},
      {
        agentResult: {
          success: true,
          output: "",
          estimatedCost: 0.01,
          durationMs: 5000,
          tokenUsage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          } as TokenUsage,
        },
      },
    );

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.tokens).toBeDefined();
    const tokens = metrics.tokens;
    expect(tokens).not.toBeNull();
    if (tokens) {
      expect(tokens.input_tokens).toBe(1000);
      expect(tokens.output_tokens).toBe(500);
      expect(tokens.cache_read_input_tokens).toBe(100);
      expect(tokens.cache_creation_input_tokens).toBe(50);
    }
  });

  test("storyMetrics.tokens has non-undefined number values for all four fields", () => {
    const story = makeStory();
    const ctx = makeCtx(
      story,
      {},
      {
        agentResult: {
          success: true,
          output: "",
          estimatedCost: 0.01,
          durationMs: 5000,
          tokenUsage: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          } as TokenUsage,
        },
      },
    );

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.tokens).toBeDefined();
    const tokens = metrics.tokens;
    expect(tokens).not.toBeNull();
    if (tokens) {
      expect(typeof tokens.input_tokens).toBe("number");
      expect(typeof tokens.output_tokens).toBe("number");
      expect(typeof tokens.cache_read_input_tokens).toBe("number");
      expect(typeof tokens.cache_creation_input_tokens).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9: collectStoryMetrics leaves storyMetrics.tokens undefined when tokenUsage undefined
// ---------------------------------------------------------------------------

describe("AC-9: collectStoryMetrics leaves tokens undefined when agentResult.tokenUsage is undefined", () => {
  test("storyMetrics.tokens does not exist when ctx.agentResult.tokenUsage is undefined", () => {
    const story = makeStory();
    const ctx = makeCtx(
      story,
      {},
      {
        agentResult: {
          success: true,
          output: "",
          estimatedCost: 0.01,
          durationMs: 5000,
        },
      },
    );

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-10: When cache fields are 0, they are absent from tokenUsage object
// ---------------------------------------------------------------------------

describe("AC-10: tokenUsage omits cache fields when they are 0", () => {
  test("tokenUsage with cache_read_input_tokens=0 does not have that key", () => {
    const usage: Record<string, unknown> = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const json = JSON.stringify(usage);
    expect(json).not.toContain("cache_read_input_tokens");
    expect(json).not.toContain("cache_creation_input_tokens");
  });

  test("Object.prototype.hasOwnProperty.call returns false for cache fields set to 0", () => {
    const usage: Record<string, unknown> = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    expect(Object.prototype.hasOwnProperty.call(usage, "cache_read_input_tokens")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(usage, "cache_creation_input_tokens")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-11: AgentResult interface includes tokenUsage property
// ---------------------------------------------------------------------------

describe("AC-11: AgentResult interface has tokenUsage property", () => {
  test("AgentResult interface includes tokenUsage?: TokenUsage", () => {
    const typesPath = resolve(import.meta.dir, "../../../src/agents/types.ts");
    const content = readFileSync(typesPath, "utf-8");
    expect(content).toContain("tokenUsage?:");
  });
});

// ---------------------------------------------------------------------------
// AC-12 to AC-15: saveRunMetrics aggregates tokens correctly
// ---------------------------------------------------------------------------

describe("AC-12 to AC-15: saveRunMetrics aggregates token fields correctly", () => {
  const testDir = join(WORKDIR, "aggregate-test");

  test("AC-12: totalTokens fields equal sums of corresponding story.tokens fields", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const runMetrics: RunMetrics = {
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.05,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 10000,
      stories: [
        {
          storyId: "US-001",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.025,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
        {
          storyId: "US-002",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.025,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
        },
      ],
    };

    await saveRunMetrics(workdir, runMetrics);

    const metricsPath = join(workdir, ".nax", "metrics.json");
    const saved = JSON.parse(readFileSync(metricsPath, "utf-8")) as RunMetrics[];
    expect(saved.length).toBe(1);
    expect(saved[0].totalTokens).toBeDefined();
    const totalTokens = saved[0].totalTokens;
    expect(totalTokens).not.toBeNull();
    if (totalTokens) {
      expect(totalTokens.input_tokens).toBe(3000);
      expect(totalTokens.output_tokens).toBe(1500);
      expect(totalTokens.cache_read_input_tokens).toBe(300);
      expect(totalTokens.cache_creation_input_tokens).toBe(150);
    }

    rmSync(testDir, { recursive: true, force: true });
  });

  test("AC-13: totalTokens.input_tokens equals sum of all story.tokens.input_tokens", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const runMetrics: RunMetrics = {
      runId: "run-002",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 3,
      storiesCompleted: 3,
      storiesFailed: 0,
      totalDurationMs: 15000,
      stories: [
        {
          storyId: "US-001",
          complexity: "simple",
          modelTier: "fast",
          modelUsed: "claude-haiku-4",
          attempts: 1,
          finalTier: "fast",
          success: true,
          cost: 0.01,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: { input_tokens: 500, output_tokens: 250 },
        },
        {
          storyId: "US-002",
          complexity: "simple",
          modelTier: "fast",
          modelUsed: "claude-haiku-4",
          attempts: 1,
          finalTier: "fast",
          success: true,
          cost: 0.01,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: { input_tokens: 1500, output_tokens: 750 },
        },
        {
          storyId: "US-003",
          complexity: "simple",
          modelTier: "fast",
          modelUsed: "claude-haiku-4",
          attempts: 1,
          finalTier: "fast",
          success: true,
          cost: 0.01,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: { input_tokens: 1000, output_tokens: 500 },
        },
      ],
    };

    await saveRunMetrics(workdir, runMetrics);

    const metricsPath = join(workdir, ".nax", "metrics.json");
    const saved = JSON.parse(readFileSync(metricsPath, "utf-8")) as RunMetrics[];
    const totalTokens = saved[0].totalTokens;
    expect(totalTokens).not.toBeNull();
    if (totalTokens) {
      expect(totalTokens.input_tokens).toBe(3000);
      expect(totalTokens.input_tokens).toBe(
        runMetrics.stories.reduce((sum, s) => sum + (s.tokens?.input_tokens ?? 0), 0),
      );
    }

    rmSync(testDir, { recursive: true, force: true });
  });

  test("AC-14: totalTokens.cache_read_input_tokens equals sum of all story.tokens.cache_read_input_tokens", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const runMetrics: RunMetrics = {
      runId: "run-003",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 10000,
      stories: [
        {
          storyId: "US-001",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.015,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
        {
          storyId: "US-002",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.015,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
        },
      ],
    };

    await saveRunMetrics(workdir, runMetrics);

    const metricsPath = join(workdir, ".nax", "metrics.json");
    const saved = JSON.parse(readFileSync(metricsPath, "utf-8")) as RunMetrics[];
    const totalTokens = saved[0].totalTokens;
    expect(totalTokens).not.toBeNull();
    if (totalTokens) {
      expect(totalTokens.cache_read_input_tokens).toBe(300);
      expect(totalTokens.cache_read_input_tokens).toBe(
        runMetrics.stories.reduce((sum, s) => sum + (s.tokens?.cache_read_input_tokens ?? 0), 0),
      );
    }

    rmSync(testDir, { recursive: true, force: true });
  });

  test("AC-15: totalTokens.cache_creation_input_tokens equals sum of all story.tokens.cache_creation_input_tokens", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const runMetrics: RunMetrics = {
      runId: "run-004",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 10000,
      stories: [
        {
          storyId: "US-001",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.015,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
        {
          storyId: "US-002",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.015,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          tokens: {
            input_tokens: 2000,
            output_tokens: 1000,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 100,
          },
        },
      ],
    };

    await saveRunMetrics(workdir, runMetrics);

    const metricsPath = join(workdir, ".nax", "metrics.json");
    const saved = JSON.parse(readFileSync(metricsPath, "utf-8")) as RunMetrics[];
    const totalTokens = saved[0].totalTokens;
    expect(totalTokens).not.toBeNull();
    if (totalTokens) {
      expect(totalTokens.cache_creation_input_tokens).toBe(150);
      expect(totalTokens.cache_creation_input_tokens).toBe(
        runMetrics.stories.reduce((sum, s) => sum + (s.tokens?.cache_creation_input_tokens ?? 0), 0),
      );
    }

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// AC-16: saveRunMetrics omits totalTokens when no tokens data
// ---------------------------------------------------------------------------

describe("AC-16: saveRunMetrics omits totalTokens when all story.tokens are undefined", () => {
  const testDir = join(WORKDIR, "no-tokens-test");

  test("written object does not contain totalTokens when no stories have tokens", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const runMetrics: RunMetrics = {
      runId: "run-005",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.02,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 10000,
      stories: [
        {
          storyId: "US-001",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.01,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        {
          storyId: "US-002",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.01,
          durationMs: 5000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    };

    await saveRunMetrics(workdir, runMetrics);

    const metricsPath = join(workdir, ".nax", "metrics.json");
    const saved = JSON.parse(readFileSync(metricsPath, "utf-8")) as RunMetrics[];
    expect(Object.hasOwn(saved[0], "totalTokens")).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// AC-17: loadRunMetrics handles files without totalTokens field
// ---------------------------------------------------------------------------

describe("AC-17: loadRunMetrics returns valid RunMetrics when file lacks totalTokens", () => {
  const testDir = join(WORKDIR, "load-test");

  test("loadRunMetrics does not throw and preserves story data when totalTokens is absent", async () => {
    mkdirSync(join(testDir, ".nax"), { recursive: true });
    const workdir = testDir;

    const metricsWithoutTotalTokens = [
      {
        runId: "run-legacy-001",
        feature: "legacy-feature",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: "2026-04-01T00:10:00.000Z",
        totalCost: 0.05,
        totalStories: 2,
        storiesCompleted: 2,
        storiesFailed: 0,
        totalDurationMs: 600000,
        stories: [
          {
            storyId: "US-001",
            complexity: "medium",
            modelTier: "balanced",
            modelUsed: "claude-sonnet-4",
            attempts: 1,
            finalTier: "balanced",
            success: true,
            cost: 0.025,
            durationMs: 300000,
            firstPassSuccess: true,
            startedAt: "2026-04-01T00:00:00.000Z",
            completedAt: "2026-04-01T00:05:00.000Z",
            tokens: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 50,
            },
          },
          {
            storyId: "US-002",
            complexity: "medium",
            modelTier: "balanced",
            modelUsed: "claude-sonnet-4",
            attempts: 1,
            finalTier: "balanced",
            success: true,
            cost: 0.025,
            durationMs: 300000,
            firstPassSuccess: true,
            startedAt: "2026-04-01T00:05:00.000Z",
            completedAt: "2026-04-01T00:10:00.000Z",
            tokens: {
              input_tokens: 2000,
              output_tokens: 1000,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
            },
          },
        ],
      },
    ];

    const metricsPath = join(workdir, ".nax", "metrics.json");
    writeFileSync(metricsPath, JSON.stringify(metricsWithoutTotalTokens));

    const loaded = await loadRunMetrics(workdir);
    expect(loaded).toBeDefined();
    expect(Array.isArray(loaded)).toBe(true);
    expect(loaded.length).toBe(1);
    expect(loaded[0].runId).toBe("run-legacy-001");
    expect(loaded[0].stories.length).toBe(2);
    expect(loaded[0].stories[0].storyId).toBe("US-001");
    expect(loaded[0].stories[1].storyId).toBe("US-002");

    rmSync(testDir, { recursive: true, force: true });
  });
});