/**
 * pull-tools.ts — unit tests
 *
 * Covers PullToolBudget, QUERY_NEIGHBOR_DESCRIPTOR, handleQueryNeighbor,
 * QUERY_FEATURE_CONTEXT_DESCRIPTOR, and handleQueryFeatureContext.
 * Filesystem calls are intercepted via _codeNeighborDeps injection.
 * Feature context reads are intercepted via _featureContextV2Deps injection.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NaxError } from "../../../../src/errors";
import { _codeNeighborDeps } from "../../../../src/context/v2/providers/code-neighbor";
import { _featureContextV2Deps } from "../../../../src/context/v2/providers/feature-context";
import {
  QUERY_NEIGHBOR_DESCRIPTOR,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  PULL_TOOL_REGISTRY,
  PullToolBudget,
  createRunCallCounter,
  handleQueryNeighbor,
  handleQueryFeatureContext,
} from "../../../../src/context/v2/pull-tools";
import type { NaxConfig } from "../../../../src/config/types";
import type { UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals for dep injection
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origCreateV1Provider: typeof _featureContextV2Deps.createV1Provider;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origCreateV1Provider = _featureContextV2Deps.createV1Provider;
  // Default: no files exist, no glob results
  _codeNeighborDeps.fileExists = async () => false;
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => [];
  // Default: feature context returns null (no context.md)
  _featureContextV2Deps.createV1Provider = () => ({
    getContext: async () => null,
  }) as ReturnType<typeof origCreateV1Provider>;
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
  _featureContextV2Deps.createV1Provider = origCreateV1Provider;
});

// ─────────────────────────────────────────────────────────────────────────────
// QUERY_NEIGHBOR_DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("QUERY_NEIGHBOR_DESCRIPTOR", () => {
  test("has name 'query_neighbor'", () => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR.name).toBe("query_neighbor");
  });

  test("has a non-empty description", () => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("inputSchema requires filePath", () => {
    const schema = QUERY_NEIGHBOR_DESCRIPTOR.inputSchema as { required?: string[] };
    expect(schema.required).toContain("filePath");
  });

  test("maxCallsPerSession is a positive integer", () => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR.maxCallsPerSession).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_NEIGHBOR_DESCRIPTOR.maxCallsPerSession)).toBe(true);
  });

  test("maxTokensPerCall is a positive integer", () => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR.maxTokensPerCall).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_NEIGHBOR_DESCRIPTOR.maxTokensPerCall)).toBe(true);
  });

  test("PULL_TOOL_REGISTRY includes query_neighbor", () => {
    expect(PULL_TOOL_REGISTRY["query_neighbor"]).toBe(QUERY_NEIGHBOR_DESCRIPTOR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PullToolBudget
// ─────────────────────────────────────────────────────────────────────────────

describe("PullToolBudget", () => {
  test("consume() succeeds while under session limit", () => {
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(3, 50, counter);
    expect(() => budget.consume()).not.toThrow();
    expect(() => budget.consume()).not.toThrow();
    expect(() => budget.consume()).not.toThrow();
    expect(budget.sessionCallsUsed).toBe(3);
  });

  test("consume() throws NaxError after session limit is reached", () => {
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(2, 50, counter);
    budget.consume();
    budget.consume();
    let threw: unknown;
    try {
      budget.consume();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("consume() throws NaxError after run limit even with session headroom", () => {
    const counter = createRunCallCounter();
    counter.count = 50; // pre-exhaust the run counter
    const budget = new PullToolBudget(5, 50, counter);
    let threw: unknown;
    try {
      budget.consume();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("isSessionExhausted() returns false when calls remain", () => {
    const budget = new PullToolBudget(5, 50, createRunCallCounter());
    budget.consume();
    expect(budget.isSessionExhausted()).toBe(false);
  });

  test("isSessionExhausted() returns true when session limit reached", () => {
    const budget = new PullToolBudget(1, 50, createRunCallCounter());
    budget.consume();
    expect(budget.isSessionExhausted()).toBe(true);
  });

  test("isRunExhausted() returns false when run calls remain", () => {
    const counter = createRunCallCounter();
    const budget = new PullToolBudget(5, 50, counter);
    budget.consume();
    expect(budget.isRunExhausted()).toBe(false);
  });

  test("isRunExhausted() returns true when run limit reached", () => {
    const counter = createRunCallCounter();
    counter.count = 49;
    const budget = new PullToolBudget(5, 50, counter);
    budget.consume();
    expect(budget.isRunExhausted()).toBe(true);
  });

  test("run counter is shared — multiple budgets draw from the same pool", () => {
    const counter = createRunCallCounter();
    const b1 = new PullToolBudget(5, 3, counter);
    const b2 = new PullToolBudget(5, 3, counter);
    b1.consume();
    b1.consume();
    b2.consume(); // counter.count is now 3 — run exhausted
    let threw: unknown;
    try {
      b2.consume();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleQueryNeighbor
// ─────────────────────────────────────────────────────────────────────────────

describe("handleQueryNeighbor", () => {
  function makeBudget(sessionLimit = 5, runLimit = 50) {
    return new PullToolBudget(sessionLimit, runLimit, createRunCallCounter());
  }

  test("calls budget.consume() before fetching", async () => {
    const budget = makeBudget();
    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget);
    expect(budget.sessionCallsUsed).toBe(1);
  });

  test("propagates NaxError from exhausted budget", async () => {
    const budget = makeBudget(0, 50); // 0 session limit — immediately exhausted
    let threw: unknown;
    try {
      await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("returns neighbor content from CodeNeighborProvider", async () => {
    // src/a.ts exists — sibling test is always added
    _codeNeighborDeps.fileExists = async (p) => p.includes("src/a.ts");
    _codeNeighborDeps.readFile = async () => "";
    _codeNeighborDeps.glob = () => [];

    const result = await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget());
    expect(typeof result).toBe("string");
  });

  test("returns empty string when file has no neighbors", async () => {
    // scripts/ file — no sibling test, no forward/reverse deps
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => [];
    const result = await handleQueryNeighbor({ filePath: "scripts/build.ts" }, "/repo", makeBudget());
    expect(result).toBe("");
  });

  test("truncates output to maxTokensPerCall * 4 characters", async () => {
    // Force many neighbors so content would exceed the cap
    const manyNeighbors = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => manyNeighbors;
    _codeNeighborDeps.readFile = async (p) => {
      // Each file imports the query target
      if (manyNeighbors.some((f) => p.includes(f))) return 'import { x } from "./a"';
      return "";
    };

    const maxTokensPerCall = 50; // tiny cap to force truncation
    const result = await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget(), maxTokensPerCall);
    expect(result.length).toBeLessThanOrEqual(maxTokensPerCall * 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: QUERY_FEATURE_CONTEXT_DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("QUERY_FEATURE_CONTEXT_DESCRIPTOR", () => {
  test("has name 'query_feature_context'", () => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.name).toBe("query_feature_context");
  });

  test("has a non-empty description", () => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("inputSchema has no required fields (filter is optional)", () => {
    const schema = QUERY_FEATURE_CONTEXT_DESCRIPTOR.inputSchema as { required?: string[] };
    expect(schema.required).toBeUndefined();
  });

  test("maxCallsPerSession is a positive integer", () => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.maxCallsPerSession).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_FEATURE_CONTEXT_DESCRIPTOR.maxCallsPerSession)).toBe(true);
  });

  test("maxTokensPerCall is a positive integer", () => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.maxTokensPerCall).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_FEATURE_CONTEXT_DESCRIPTOR.maxTokensPerCall)).toBe(true);
  });

  test("PULL_TOOL_REGISTRY includes query_feature_context", () => {
    expect(PULL_TOOL_REGISTRY["query_feature_context"]).toBe(QUERY_FEATURE_CONTEXT_DESCRIPTOR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: handleQueryFeatureContext
// ─────────────────────────────────────────────────────────────────────────────

describe("handleQueryFeatureContext", () => {
  const STORY = {
    id: "US-001",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
  } as unknown as UserStory;

  const CONFIG = {} as unknown as NaxConfig;

  function makeBudget(sessionLimit = 5, runLimit = 50) {
    return new PullToolBudget(sessionLimit, runLimit, createRunCallCounter());
  }

  function mockV1Provider(content: string | null) {
    _featureContextV2Deps.createV1Provider = () =>
      ({
        getContext: async () =>
          content === null
            ? null
            : { content, estimatedTokens: Math.ceil(content.length / 4), featureId: "test-feature" },
      }) as ReturnType<typeof origCreateV1Provider>;
  }

  test("calls budget.consume() before fetching", async () => {
    mockV1Provider("## Conventions\nUse async/await.");
    const budget = makeBudget();
    await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", budget);
    expect(budget.sessionCallsUsed).toBe(1);
  });

  test("propagates NaxError from exhausted budget", async () => {
    const budget = makeBudget(0, 50); // 0 session limit — immediately exhausted
    let threw: unknown;
    try {
      await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", budget);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("returns full content when no filter is provided", async () => {
    mockV1Provider("## Section A\nContent A.\n\n## Section B\nContent B.");
    const result = await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget());
    expect(result).toContain("Section A");
    expect(result).toContain("Section B");
  });

  test("returns empty string when context.md does not exist", async () => {
    mockV1Provider(null);
    const result = await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget());
    expect(result).toBe("");
  });

  test("filter returns only sections containing the keyword", async () => {
    mockV1Provider("## Conventions\nUse async/await.\n\n## Security\nNever log tokens.");
    const result = await handleQueryFeatureContext(
      { filter: "security" },
      STORY,
      CONFIG,
      "/repo",
      makeBudget(),
    );
    expect(result).toContain("Security");
    expect(result).not.toContain("Conventions");
  });

  test("filter is case-insensitive", async () => {
    mockV1Provider("## Async Patterns\nPrefer async/await.\n\n## Other\nUnrelated.");
    const result = await handleQueryFeatureContext(
      { filter: "ASYNC" },
      STORY,
      CONFIG,
      "/repo",
      makeBudget(),
    );
    expect(result).toContain("Async Patterns");
    expect(result).not.toContain("Other");
  });

  test("filter returns empty string when no sections match", async () => {
    mockV1Provider("## Conventions\nUse async/await.\n\n## Security\nNever log tokens.");
    const result = await handleQueryFeatureContext(
      { filter: "nonexistent-keyword-xyz" },
      STORY,
      CONFIG,
      "/repo",
      makeBudget(),
    );
    expect(result).toBe("");
  });

  test("truncates output to maxTokensPerCall * 4 characters", async () => {
    const longContent = "## Section\n" + "x".repeat(500);
    mockV1Provider(longContent);
    const maxTokensPerCall = 20; // tiny cap → 80 chars max
    const result = await handleQueryFeatureContext(
      {},
      STORY,
      CONFIG,
      "/repo",
      makeBudget(),
      maxTokensPerCall,
    );
    expect(result.length).toBeLessThanOrEqual(maxTokensPerCall * 4);
  });
});
