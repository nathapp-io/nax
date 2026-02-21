/**
 * LLM Routing Strategy Tests
 *
 * Tests LLM-based routing with mocked claude CLI calls.
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { llmStrategy, buildRoutingPrompt, buildBatchPrompt, parseRoutingResponse, clearCache, routeBatch, validateRoutingDecision, stripCodeFences } from "../../src/routing/strategies/llm";
import type { UserStory } from "../../src/prd/types";
import type { RoutingContext } from "../../src/routing/strategy";
import type { NaxConfig } from "../../src/config";
import { DEFAULT_CONFIG } from "../../src/config/schema";

// Test user stories
const simpleStory: UserStory = {
  id: "US-001",
  title: "Fix typo in README",
  description: "Correct spelling mistake",
  acceptanceCriteria: ["Update README.md with correct spelling"],
  tags: ["docs"],
  dependencies: [],
  status: "pending",
  passes: false,
};

const complexStory: UserStory = {
  id: "US-002",
  title: "Add JWT authentication",
  description: "Implement JWT authentication with refresh tokens",
  acceptanceCriteria: [
    "Secure token storage",
    "Token refresh endpoint",
    "Expiry handling",
    "Logout functionality",
  ],
  tags: ["security", "auth"],
  dependencies: [],
  status: "pending",
  passes: false,
};

const barrelExportStory: UserStory = {
  id: "US-008",
  title: "Export public API and create barrel exports",
  description: "Create index.ts barrel export for public API",
  acceptanceCriteria: [
    "Create src/index.ts",
    "Export all public interfaces",
  ],
  tags: ["public-api"],
  dependencies: [],
  status: "pending",
  passes: false,
};

// Test context
const testContext: RoutingContext = {
  config: DEFAULT_CONFIG,
};

describe("LLM Routing Strategy - Prompt Building", () => {
  test("buildRoutingPrompt formats story correctly", () => {
    const prompt = buildRoutingPrompt(simpleStory, DEFAULT_CONFIG);

    expect(prompt).toContain("Title: Fix typo in README");
    expect(prompt).toContain("Description: Correct spelling mistake");
    expect(prompt).toContain("1. Update README.md with correct spelling");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("fast: Simple changes");
    expect(prompt).toContain("balanced: Standard features");
    expect(prompt).toContain("powerful: Complex architecture");
    expect(prompt).toContain("test-after: Write implementation first");
    expect(prompt).toContain("three-session-tdd: Separate test-writer");
  });

  test("buildRoutingPrompt includes all acceptance criteria", () => {
    const prompt = buildRoutingPrompt(complexStory, DEFAULT_CONFIG);

    expect(prompt).toContain("1. Secure token storage");
    expect(prompt).toContain("2. Token refresh endpoint");
    expect(prompt).toContain("3. Expiry handling");
    expect(prompt).toContain("4. Logout functionality");
  });

  test("buildBatchPrompt formats multiple stories", () => {
    const stories = [simpleStory, complexStory];
    const prompt = buildBatchPrompt(stories, DEFAULT_CONFIG);

    expect(prompt).toContain("1. US-001: Fix typo in README");
    expect(prompt).toContain("2. US-002: Add JWT authentication");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("Tags: security, auth");
    expect(prompt).toContain('{"id":"US-001"');
  });
});

describe("LLM Routing Strategy - Response Parsing", () => {
  test("parseRoutingResponse handles valid JSON", () => {
    const output = '{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"Simple documentation fix"}';
    const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
    expect(decision.testStrategy).toBe("test-after");
    expect(decision.reasoning).toBe("Simple documentation fix");
  });

  test("parseRoutingResponse strips markdown code blocks", () => {
    const output = '```json\n{"complexity":"complex","modelTier":"powerful","testStrategy":"three-session-tdd","reasoning":"Security-critical"}\n```';
    const decision = parseRoutingResponse(output, complexStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.testStrategy).toBe("three-session-tdd");
  });

  test("parseRoutingResponse strips json language tag", () => {
    const output = 'json\n{"complexity":"medium","modelTier":"balanced","testStrategy":"test-after","reasoning":"Standard feature"}';
    const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("medium");
  });

  test("parseRoutingResponse throws on invalid JSON", () => {
    const output = 'This is not JSON';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow();
  });

  test("parseRoutingResponse throws on missing fields", () => {
    const output = '{"complexity":"simple","modelTier":"fast"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("parseRoutingResponse throws on invalid complexity", () => {
    const output = '{"complexity":"ultra","modelTier":"fast","testStrategy":"test-after","reasoning":"test"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Invalid complexity");
  });

  test("parseRoutingResponse throws on invalid testStrategy", () => {
    const output = '{"complexity":"simple","modelTier":"fast","testStrategy":"tdd-extreme","reasoning":"test"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Invalid testStrategy");
  });

  test("parseRoutingResponse throws on invalid modelTier", () => {
    const output = '{"complexity":"simple","modelTier":"ultra","testStrategy":"test-after","reasoning":"test"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Invalid modelTier");
  });
});

describe("LLM Routing Strategy - Cache", () => {
  beforeEach(() => {
    clearCache();
  });

  test("clearCache resets the cache", async () => {
    // Mock Bun.spawn to return a valid response
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"test"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    // First call should hit LLM
    const decision1 = await llmStrategy.route(simpleStory, testContext);
    expect(decision1).not.toBeNull();

    // Clear cache
    clearCache();

    // Second call should hit LLM again (not cache)
    const decision2 = await llmStrategy.route(simpleStory, testContext);
    expect(decision2).not.toBeNull();

    // Should have called spawn twice (once before cache clear, once after)
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    mockSpawn.mockRestore();
  });
});

describe("LLM Routing Strategy - Integration", () => {
  test("route() returns null when llm config not present", async () => {
    const contextWithoutLlm: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          llm: undefined,
        },
      },
    };

    const decision = await llmStrategy.route(simpleStory, contextWithoutLlm);
    expect(decision).toBeNull();
  });

  test("route() returns cached decision on second call", async () => {
    clearCache();

    // Mock Bun.spawn to return a valid response
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"test"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    // First call
    const decision1 = await llmStrategy.route(simpleStory, testContext);
    expect(decision1).not.toBeNull();
    expect(decision1?.complexity).toBe("simple");

    // Second call should hit cache
    const decision2 = await llmStrategy.route(simpleStory, testContext);
    expect(decision2).not.toBeNull();
    expect(decision2?.complexity).toBe("simple");

    // Should only spawn once (second call hits cache)
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockRestore();
  });

  test("route() falls back to null on timeout", async () => {
    clearCache();

    // Mock Bun.spawn to timeout
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      // Never resolve (simulates timeout)
      return {
        stdout: new ReadableStream({ start() {} }),
        stderr: new ReadableStream({ start() {} }),
        exited: new Promise(() => {}), // never resolves
        kill: () => {}, // mock kill for timeout cleanup
      } as any;
    });

    // Create context with short timeout
    const contextWithTimeout: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          llm: {
            ...DEFAULT_CONFIG.routing.llm,
            timeoutMs: 100, // 100ms timeout
            fallbackToKeywords: true,
          },
        },
      },
    };

    const decision = await llmStrategy.route(simpleStory, contextWithTimeout);

    // Should return null (falls back to keyword)
    expect(decision).toBeNull();

    mockSpawn.mockRestore();
  }, { timeout: 1000 });

  test("route() falls back to null on parse error", async () => {
    clearCache();

    // Mock Bun.spawn to return invalid JSON
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('This is not JSON'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const decision = await llmStrategy.route(simpleStory, testContext);

    // Should return null (falls back to keyword)
    expect(decision).toBeNull();

    mockSpawn.mockRestore();
  });
});

describe("LLM Routing Strategy - Batch Routing", () => {
  test("routeBatch parses batch response correctly", async () => {
    clearCache();

    const stories = [simpleStory, complexStory];

    // Mock Bun.spawn to return batch response
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const batchResponse = JSON.stringify([
        { id: "US-001", complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "Documentation fix" },
        { id: "US-002", complexity: "complex", modelTier: "powerful", testStrategy: "three-session-tdd", reasoning: "Security-critical auth" },
      ]);
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(batchResponse));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const decisions = await routeBatch(stories, testContext);

    expect(decisions.size).toBe(2);
    expect(decisions.get("US-001")?.complexity).toBe("simple");
    expect(decisions.get("US-001")?.modelTier).toBe("fast");
    expect(decisions.get("US-002")?.complexity).toBe("complex");
    expect(decisions.get("US-002")?.modelTier).toBe("powerful");

    mockSpawn.mockRestore();
  });

  test("routeBatch populates cache when cacheDecisions enabled", async () => {
    clearCache();

    const stories = [simpleStory];

    // Mock Bun.spawn for batch call
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const batchResponse = JSON.stringify([
        { id: "US-001", complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      ]);
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(batchResponse));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    // Call routeBatch
    await routeBatch(stories, testContext);

    // Now individual route() call should hit cache (no spawn)
    mockSpawn.mockClear();

    const decision = await llmStrategy.route(simpleStory, testContext);
    expect(decision).not.toBeNull();
    expect(decision?.complexity).toBe("simple");

    // Should not have spawned (hit cache)
    expect(mockSpawn).toHaveBeenCalledTimes(0);

    mockSpawn.mockRestore();
  });

  test("routeBatch throws on missing llm config", async () => {
    const contextWithoutLlm: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          llm: undefined,
        },
      },
    };

    await expect(routeBatch([simpleStory], contextWithoutLlm)).rejects.toThrow("LLM routing config not found");
  });

  test("routeBatch throws on batch response parse error", async () => {
    clearCache();

    // Mock Bun.spawn to return invalid batch response
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Not a JSON array'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    await expect(routeBatch([simpleStory], testContext)).rejects.toThrow();

    mockSpawn.mockRestore();
  });
});

describe("LLM Routing Strategy - Edge Cases", () => {
  test("parseRoutingResponse handles all valid complexity values", () => {
    const complexities = ["simple", "medium", "complex", "expert"];

    for (const complexity of complexities) {
      const output = `{"complexity":"${complexity}","modelTier":"fast","testStrategy":"test-after","reasoning":"test"}`;
      const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);
      expect(decision.complexity).toBe(complexity);
    }
  });

  test("parseRoutingResponse handles all valid test strategies", () => {
    const strategies = ["test-after", "three-session-tdd"];

    for (const strategy of strategies) {
      const output = `{"complexity":"simple","modelTier":"fast","testStrategy":"${strategy}","reasoning":"test"}`;
      const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);
      expect(decision.testStrategy).toBe(strategy);
    }
  });

  test("route() handles stories with no tags", async () => {
    clearCache();

    const storyNoTags: UserStory = {
      ...simpleStory,
      tags: [],
    };

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"test"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const decision = await llmStrategy.route(storyNoTags, testContext);
    expect(decision).not.toBeNull();

    mockSpawn.mockRestore();
  });

  test("route() handles stories with many acceptance criteria", async () => {
    clearCache();

    const storyManyCriteria: UserStory = {
      ...simpleStory,
      acceptanceCriteria: Array.from({ length: 20 }, (_, i) => `Criteria ${i + 1}`),
    };

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"complex","modelTier":"powerful","testStrategy":"three-session-tdd","reasoning":"Many criteria"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const decision = await llmStrategy.route(storyManyCriteria, testContext);
    expect(decision).not.toBeNull();
    expect(decision?.complexity).toBe("complex");

    mockSpawn.mockRestore();
  });
});

describe("stripCodeFences", () => {
  test("returns plain JSON unchanged", () => {
    const input = '{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips ```json ... ``` fences", () => {
    const input = '```json\n{"complexity":"simple"}\n```';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips ``` ... ``` fences without language tag", () => {
    const input = '```\n{"complexity":"simple"}\n```';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips leading 'json' keyword (no backticks)", () => {
    const input = 'json\n{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("trims whitespace", () => {
    const input = '  \n {"complexity":"simple"} \n  ';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("handles multiline JSON inside fences", () => {
    const input = '```json\n{\n  "complexity": "simple",\n  "modelTier": "fast"\n}\n```';
    expect(stripCodeFences(input)).toBe('{\n  "complexity": "simple",\n  "modelTier": "fast"\n}');
  });
});

describe("LLM Routing Strategy - Mode Behavior", () => {
  beforeEach(() => {
    clearCache();
  });

  test("one-shot mode: cache miss returns keyword fallback without LLM call", async () => {
    const mockSpawn = spyOn(Bun, "spawn");

    const oneShotContext: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "llm",
          llm: {
            mode: "one-shot",
            cacheDecisions: true,
            fallbackToKeywords: true,
          },
        },
      },
    };

    // Cache is empty, so this should fall back to keyword without calling LLM
    const decision = await llmStrategy.route(simpleStory, oneShotContext);

    // Should get a keyword-based decision (not null)
    expect(decision).not.toBeNull();
    // Should NOT have spawned LLM
    expect(mockSpawn).not.toHaveBeenCalled();

    mockSpawn.mockRestore();
  });

  test("one-shot mode: cache hit returns cached decision", async () => {
    clearCache();

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const batchResponse = JSON.stringify([
        { id: "US-001", complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "Cached decision" },
      ]);
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(batchResponse));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const oneShotContext: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "llm",
          llm: {
            mode: "one-shot",
            cacheDecisions: true,
          },
        },
      },
    };

    // First, populate cache via batch route
    await routeBatch([simpleStory], oneShotContext);
    mockSpawn.mockClear();

    // Now route the same story - should hit cache
    const decision = await llmStrategy.route(simpleStory, oneShotContext);

    expect(decision).not.toBeNull();
    expect(decision?.complexity).toBe("simple");
    expect(decision?.reasoning).toBe("Cached decision");
    // Should NOT have spawned again
    expect(mockSpawn).not.toHaveBeenCalled();

    mockSpawn.mockRestore();
  });

  test("per-story mode: each story triggers individual LLM call", async () => {
    clearCache();

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"per-story call"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const perStoryContext: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "llm",
          llm: {
            mode: "per-story",
            cacheDecisions: true,
          },
        },
      },
    };

    // Route two different stories
    const decision1 = await llmStrategy.route(simpleStory, perStoryContext);
    const decision2 = await llmStrategy.route(complexStory, perStoryContext);

    expect(decision1).not.toBeNull();
    expect(decision2).not.toBeNull();
    // Should have spawned twice (once per story)
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    mockSpawn.mockRestore();
  });

  test("hybrid mode: batch route upfront, per-story on cache miss", async () => {
    clearCache();

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const batchResponse = JSON.stringify([
        { id: "US-001", complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "batched" },
      ]);
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(batchResponse));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const hybridContext: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "llm",
          llm: {
            mode: "hybrid",
            cacheDecisions: true,
          },
        },
      },
    };

    // Populate cache with batch route
    await routeBatch([simpleStory], hybridContext);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockClear();

    // Route cached story - should hit cache
    const decision1 = await llmStrategy.route(simpleStory, hybridContext);
    expect(decision1).not.toBeNull();
    expect(decision1?.reasoning).toBe("batched");
    expect(mockSpawn).not.toHaveBeenCalled();

    // Route uncached story - should spawn LLM
    mockSpawn.mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"complex","modelTier":"powerful","testStrategy":"three-session-tdd","reasoning":"per-story fallback"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const decision2 = await llmStrategy.route(complexStory, hybridContext);
    expect(decision2).not.toBeNull();
    expect(decision2?.reasoning).toBe("per-story fallback");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockRestore();
  });

  test("default mode (undefined) behaves as hybrid", async () => {
    clearCache();

    const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"default mode"}'));
          controller.close();
        },
      });
      const stderr = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill: () => {},
      } as any;
    });

    const defaultContext: RoutingContext = {
      config: {
        ...DEFAULT_CONFIG,
        routing: {
          ...DEFAULT_CONFIG.routing,
          strategy: "llm",
          llm: {
            // mode not specified - should default to hybrid
            cacheDecisions: true,
          },
        },
      },
    };

    // Cache miss - hybrid mode should make LLM call (not fall back to keyword like one-shot)
    const decision = await llmStrategy.route(simpleStory, defaultContext);

    expect(decision).not.toBeNull();
    expect(decision?.reasoning).toBe("default mode");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockRestore();
  });
});

describe("validateRoutingDecision", () => {
  test("returns valid decision for correct input", () => {
    const input = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "trivial" };
    const result = validateRoutingDecision(input, DEFAULT_CONFIG);
    expect(result).toEqual({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "trivial",
    });
  });

  test("accepts all valid complexity values", () => {
    for (const c of ["simple", "medium", "complex", "expert"]) {
      const input = { complexity: c, modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
      expect(validateRoutingDecision(input, DEFAULT_CONFIG).complexity).toBe(c);
    }
  });

  test("accepts all valid test strategies", () => {
    for (const ts of ["test-after", "three-session-tdd"]) {
      const input = { complexity: "simple", modelTier: "fast", testStrategy: ts, reasoning: "test" };
      expect(validateRoutingDecision(input, DEFAULT_CONFIG).testStrategy).toBe(ts);
    }
  });

  test("throws on missing complexity", () => {
    const input = { modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on missing modelTier", () => {
    const input = { complexity: "simple", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on missing testStrategy", () => {
    const input = { complexity: "simple", modelTier: "fast", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on missing reasoning", () => {
    const input = { complexity: "simple", modelTier: "fast", testStrategy: "test-after" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on invalid complexity value", () => {
    const input = { complexity: "mega", modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Invalid complexity: mega");
  });

  test("throws on invalid testStrategy value", () => {
    const input = { complexity: "simple", modelTier: "fast", testStrategy: "yolo", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Invalid testStrategy: yolo");
  });

  test("throws on modelTier not in config", () => {
    const input = { complexity: "simple", modelTier: "ultra", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Invalid modelTier: ultra");
  });

  test("throws on empty string fields", () => {
    const input = { complexity: "", modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });
});
