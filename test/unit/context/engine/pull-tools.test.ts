/**
 * pull-tools.ts — unit tests
 *
 * Covers PullToolBudget, QUERY_NEIGHBOR_DESCRIPTOR, handleQueryNeighbor,
 * QUERY_FEATURE_CONTEXT_DESCRIPTOR, and handleQueryFeatureContext.
 * Filesystem calls are intercepted via _codeNeighborDeps injection.
 * Feature context reads are intercepted via _featureContextV2Deps injection.
 *
 * The query_scratch descriptor and handler live in `./query-scratch.test.ts`
 * (US-005) so this file stays under the 800-line test file hard limit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config/types";
import { _codeNeighborDeps } from "@/context/engine/providers/code-neighbor";
import { _featureContextV2Deps } from "@/context/engine/providers/feature-context";
import {
  PULL_TOOL_REGISTRY,
  PullToolBudget,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  QUERY_NEIGHBOR_DESCRIPTOR,
  _pullToolsDeps,
  createRunCallCounter,
  handleQueryFeatureContext,
  handleQueryNeighbor,
} from "@/context/engine/pull-tools";
import { NaxError } from "@/errors";
import type { UserStory } from "@/prd";
import { makeLogger } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals for dep injection
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origCreateV1Provider: typeof _featureContextV2Deps.createV1Provider;
let origGetLogger: typeof _pullToolsDeps.getLogger;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origCreateV1Provider = _featureContextV2Deps.createV1Provider;
  origGetLogger = _pullToolsDeps.getLogger;
  // Default: no files exist, no glob results
  _codeNeighborDeps.fileExists = async () => false;
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
  // Default: feature context returns null (no context.md)
  _featureContextV2Deps.createV1Provider = () =>
    ({
      getContext: async () => null,
    }) as ReturnType<typeof origCreateV1Provider>;
  // Default: no-op logger (real logger is used)
  _pullToolsDeps.getLogger = () => makeLogger() as any;
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
  _featureContextV2Deps.createV1Provider = origCreateV1Provider;
  _pullToolsDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// QUERY_NEIGHBOR_DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("QUERY_NEIGHBOR_DESCRIPTOR", () => {
  test("has expected name, description, inputSchema, and is in PULL_TOOL_REGISTRY", () => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR.name).toBe("query_neighbor");
    expect(QUERY_NEIGHBOR_DESCRIPTOR.description.length).toBeGreaterThan(0);
    const schema = QUERY_NEIGHBOR_DESCRIPTOR.inputSchema as { required?: string[] };
    expect(schema.required).toContain("filePath");
    expect(PULL_TOOL_REGISTRY.query_neighbor).toBe(QUERY_NEIGHBOR_DESCRIPTOR);
  });

  test.each(["maxCallsPerSession", "maxTokensPerCall"] as const)("%s is a positive integer", (field) => {
    expect(QUERY_NEIGHBOR_DESCRIPTOR[field]).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_NEIGHBOR_DESCRIPTOR[field])).toBe(true);
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

  test.each([
    ["isSessionExhausted() when calls remain", () => new PullToolBudget(5, 50, createRunCallCounter()), false],
    ["isSessionExhausted() when session limit reached", () => new PullToolBudget(1, 50, createRunCallCounter()), true],
  ])("%s → %s", (_label, makeBudget, expected) => {
    const budget = makeBudget();
    budget.consume();
    expect(budget.isSessionExhausted()).toBe(expected);
  });

  test.each([
    ["isRunExhausted() when run calls remain", 0, false],
    ["isRunExhausted() when run limit reached", 49, true],
  ])("%s → %s", (_label, counterStart, expected) => {
    const counter = createRunCallCounter();
    counter.count = counterStart;
    const budget = new PullToolBudget(5, 50, counter);
    budget.consume();
    expect(budget.isRunExhausted()).toBe(expected);
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

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 7 / spec AC-18: pull-tool invocations were never recorded.
// SPEC-context-engine-v2.md:245 declares ContextManifest.pullCalls and AC-18
// declares StoryMetrics.context.pullCalls; `grep -rn pullCalls src/` returned
// zero hits, so the Phase-4 exit gate ("budget respected, cost within
// envelope") was unevaluable.
// ─────────────────────────────────────────────────────────────────────────────

describe("pull-call recording", () => {
  function makeBudget(sessionLimit = 5, runLimit = 50, counter = createRunCallCounter()) {
    return { budget: new PullToolBudget(sessionLimit, runLimit, counter), counter };
  }

  test("records one entry per invocation with the spec'd shape", async () => {
    const { budget, counter } = makeBudget();
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });

    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget, 100, undefined, "US-001");

    expect(counter.calls).toHaveLength(1);
    const c = counter.calls[0];
    expect(c?.tool).toBe("query_neighbor");
    expect(c?.query).toBe("src/a.ts");
    expect(typeof c?.at).toBe("string");
    expect(typeof c?.tokensReturned).toBe("number");
    expect(Array.isArray(c?.chunkIds)).toBe(true);
  });

  test("accumulates across calls on the shared run counter", async () => {
    const { budget, counter } = makeBudget();
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });

    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget, 100);
    await handleQueryNeighbor({ filePath: "src/b.ts" }, "/repo", budget, 100);

    expect(counter.calls.map((c) => c.query)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(counter.count).toBe(2);
  });

  test("records nothing when the budget rejects the call", async () => {
    const { budget, counter } = makeBudget(0, 50);
    let threw = false;
    try {
      await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget, 100);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(counter.calls).toHaveLength(0);
  });
});

describe("handleQueryNeighbor", () => {
  function makeBudget(sessionLimit = 5, runLimit = 50) {
    return new PullToolBudget(sessionLimit, runLimit, createRunCallCounter());
  }

  test("calls budget.consume() before fetching; propagates NaxError from exhausted budget", async () => {
    const budget = makeBudget();
    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", budget);
    expect(budget.sessionCallsUsed).toBe(1);

    const exhausted = makeBudget(0, 50);
    let threw: unknown;
    try {
      await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", exhausted);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NaxError);
    expect((threw as NaxError).code).toBe("PULL_TOOL_BUDGET_EXHAUSTED");
  });

  test("returns neighbor content (string) for src/ file and empty string for file with no neighbors", async () => {
    _codeNeighborDeps.fileExists = async (p) => p.includes("src/a.ts");
    _codeNeighborDeps.readFile = async () => "";
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
    expect(typeof (await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget()))).toBe("string");

    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
    expect(await handleQueryNeighbor({ filePath: "scripts/build.ts" }, "/repo", makeBudget())).toBe("");
  });

  test("truncates output to maxTokensPerCall * 4 characters", async () => {
    // Force many neighbors so content would exceed the cap
    const manyNeighbors = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: manyNeighbors, truncated: false });
    _codeNeighborDeps.readFile = async (p) => {
      // Each file imports the query target
      if (manyNeighbors.some((f) => p.includes(f))) return 'import { x } from "./a"';
      return "";
    };

    const maxTokensPerCall = 50; // tiny cap to force truncation
    const result = await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget(), maxTokensPerCall);
    expect(result.length).toBeLessThanOrEqual(maxTokensPerCall * 4);
  });

  test("emits logger.info with tool/resultCount/truncated fields", async () => {
    // Sub-scenario 1: basic invocation — fields present, resultCount=0, resultBytes=0
    const mockLogger = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger as any;
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget());
    const call1 = mockLogger.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(call1?.data?.tool).toBe("query_neighbor");
    expect(call1?.data?.resultCount).toBe(0);
    expect(call1?.data?.resultBytes).toBe(0);
    expect(call1?.data?.filePath).toBe("src/a.ts");

    // Sub-scenario 2: truncated=true when content exceeds cap
    const mockLogger2 = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger2 as any;
    const manyNeighbors = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.glob = () => ({ files: manyNeighbors, truncated: false });
    _codeNeighborDeps.readFile = async (p) => {
      if (manyNeighbors.some((f) => p.includes(f))) return 'import { x } from "./a"';
      return "";
    };
    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget(), 10);
    const call2 = mockLogger2.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(call2?.data?.truncated).toBe(true);

    // Sub-scenario 3: resultCount>0 when neighbors found
    const mockLogger3 = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger3 as any;
    _codeNeighborDeps.fileExists = async (p) => p.includes("test/");
    _codeNeighborDeps.glob = () => ({ files: ["src/imported.ts"], truncated: false });
    _codeNeighborDeps.readFile = async () => 'import { x } from "./a"';
    await handleQueryNeighbor({ filePath: "src/a.ts" }, "/repo", makeBudget());
    const call3 = mockLogger3.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(call3?.data?.resultCount).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: QUERY_FEATURE_CONTEXT_DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("QUERY_FEATURE_CONTEXT_DESCRIPTOR", () => {
  test("has expected name, description, inputSchema (filter optional), and is in PULL_TOOL_REGISTRY", () => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.name).toBe("query_feature_context");
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR.description.length).toBeGreaterThan(0);
    const schema = QUERY_FEATURE_CONTEXT_DESCRIPTOR.inputSchema as { required?: string[] };
    expect(schema.required).toBeUndefined();
    expect(PULL_TOOL_REGISTRY.query_feature_context).toBe(QUERY_FEATURE_CONTEXT_DESCRIPTOR);
  });

  test.each(["maxCallsPerSession", "maxTokensPerCall"] as const)("%s is a positive integer", (field) => {
    expect(QUERY_FEATURE_CONTEXT_DESCRIPTOR[field]).toBeGreaterThan(0);
    expect(Number.isInteger(QUERY_FEATURE_CONTEXT_DESCRIPTOR[field])).toBe(true);
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

  test("calls budget.consume() before fetching; propagates NaxError from exhausted budget", async () => {
    mockV1Provider("## Conventions\nUse async/await.");
    const budget = makeBudget();
    await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", budget);
    expect(budget.sessionCallsUsed).toBe(1);

    const exhausted = makeBudget(0, 50);
    let threw: unknown;
    try {
      await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", exhausted);
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

  test("returns empty string when context.md absent or no sections match filter", async () => {
    mockV1Provider(null);
    expect(await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget())).toBe("");

    mockV1Provider("## Conventions\nUse async/await.\n\n## Security\nNever log tokens.");
    expect(
      await handleQueryFeatureContext({ filter: "nonexistent-keyword-xyz" }, STORY, CONFIG, "/repo", makeBudget()),
    ).toBe("");
  });

  test("filter returns matching sections (case-insensitive)", async () => {
    mockV1Provider("## Conventions\nUse async/await.\n\n## Security\nNever log tokens.");
    const lower = await handleQueryFeatureContext({ filter: "security" }, STORY, CONFIG, "/repo", makeBudget());
    expect(lower).toContain("Security");
    expect(lower).not.toContain("Conventions");

    mockV1Provider("## Async Patterns\nPrefer async/await.\n\n## Other\nUnrelated.");
    const upper = await handleQueryFeatureContext({ filter: "ASYNC" }, STORY, CONFIG, "/repo", makeBudget());
    expect(upper).toContain("Async Patterns");
    expect(upper).not.toContain("Other");
  });

  test("filter with no ## headings returns full content (flat context.md)", async () => {
    mockV1Provider("Flat content without any headings.\nSome conventions here.");
    const result = await handleQueryFeatureContext({ filter: "conventions" }, STORY, CONFIG, "/repo", makeBudget());
    // No ## headings — section-filter not possible; full content returned
    expect(result).toContain("Flat content");
    expect(result).toContain("conventions");
  });

  test("truncates output to maxTokensPerCall * 4 characters", async () => {
    const longContent = `## Section\n${"x".repeat(500)}`;
    mockV1Provider(longContent);
    const maxTokensPerCall = 20; // tiny cap → 80 chars max
    const result = await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget(), maxTokensPerCall);
    expect(result.length).toBeLessThanOrEqual(maxTokensPerCall * 4);
  });

  test("emits logger.info with tool=query_feature_context; keyword from filter or null", async () => {
    const mockLogger = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger as any;
    mockV1Provider("## Conventions\nUse async/await.");
    await handleQueryFeatureContext({ filter: "conventions" }, STORY, CONFIG, "/repo", makeBudget());
    const callWithFilter = mockLogger.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(callWithFilter?.data?.tool).toBe("query_feature_context");
    expect(callWithFilter?.data?.keyword).toBe("conventions");
    expect(callWithFilter?.data?.storyId).toBe("US-001");
  });

  test("logger includes resultCount and resultBytes (>0 when content exists, 0 when none)", async () => {
    const mockLogger = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger as any;

    mockV1Provider("## Section\nSome content here");
    await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget());
    const withContent = mockLogger.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(withContent?.data?.resultCount).toBeGreaterThan(0);
    expect(withContent?.data?.resultBytes).toBeGreaterThan(0);

    mockLogger.calls.length = 0;
    mockV1Provider(null);
    await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget());
    const noContent = mockLogger.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(noContent?.data?.resultCount).toBe(0);
    expect(noContent?.data?.resultBytes).toBe(0);
  });

  test("logger emit includes keyword=null when no filter is provided", async () => {
    const mockLogger2 = makeLogger();
    _pullToolsDeps.getLogger = () => mockLogger2 as any;
    mockV1Provider("## Section\nContent");
    await handleQueryFeatureContext({}, STORY, CONFIG, "/repo", makeBudget());
    const callNoFilter = mockLogger2.calls.find((c) => c.stage === "pull-tool" && c.message === "invoked");
    expect(callNoFilter?.data?.keyword).toBeNull();
  });
});
