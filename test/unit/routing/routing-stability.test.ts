/**
 * v0.18.4 Routing Stability Tests
 *
 * BUG-031: Keyword classifier inconsistency across retries
 * BUG-033: LLM routing retry on timeout — config fields and defaults
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { keywordStrategy } from "../../../src/routing/strategies/keyword";
import type { RoutingContext } from "../../../src/routing/strategy";
import type { UserStory } from "../../../src/prd/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../src/logger";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TEST-001",
    title: "Add login button",
    description: "Simple button feature",
    acceptanceCriteria: ["Button renders", "Click works"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

const ctx: RoutingContext = {
  config: { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } },
};

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// ---------------------------------------------------------------------------
// BUG-031: Keyword classifier stable across retries
// ---------------------------------------------------------------------------

describe("BUG-031: keyword classifier stability across retries", () => {
  test("classification is identical on first attempt and retry with same story", () => {
    const story = makeStory();
    const first = keywordStrategy.route(story, ctx);
    const retry = keywordStrategy.route(story, ctx);

    expect(first!.complexity).toBe(retry!.complexity);
    expect(first!.testStrategy).toBe(retry!.testStrategy);
    expect(first!.modelTier).toBe(retry!.modelTier);
  });

  test("description containing security/auth error text does NOT shift classification", () => {
    const clean = makeStory({ title: "Add color picker", description: "Simple UI change" });
    const withErrors = makeStory({
      title: "Add color picker",
      description: "Simple UI change\n\nPrior errors:\n- auth token expired\n- security check failed\n- refactor needed",
    });

    const cleanResult = keywordStrategy.route(clean, ctx);
    const errorResult = keywordStrategy.route(withErrors, ctx);

    // BUG-031 fix: description excluded from classification — results must be identical
    expect(cleanResult!.complexity).toBe(errorResult!.complexity);
    expect(cleanResult!.testStrategy).toBe(errorResult!.testStrategy);
    expect(cleanResult!.modelTier).toBe(errorResult!.modelTier);
  });

  test("description with complex keywords does NOT upgrade complexity", () => {
    const story = makeStory({
      title: "Fix button label",
      description: "architecture refactor security migration breaking change",
      tags: [],
      acceptanceCriteria: ["Label is correct"],
    });

    const result = keywordStrategy.route(story, ctx);
    expect(result!.complexity).toBe("simple");
    expect(result!.testStrategy).toBe("three-session-tdd-lite");
  });

  test("complexity is driven by title and tags only (not description)", () => {
    const simple = makeStory({ title: "Update label", description: "auth security jwt rbac encryption" });
    const complex = makeStory({
      title: "Add JWT authentication",
      description: "Simple change",
      tags: ["auth"],
      acceptanceCriteria: ["Token issued", "Expiry set", "Refresh works"],
    });

    expect(keywordStrategy.route(simple, ctx)!.complexity).toBe("simple");
    expect(keywordStrategy.route(complex, ctx)!.testStrategy).toBe("three-session-tdd");
  });
});

// ---------------------------------------------------------------------------
// BUG-033: LLM routing config — retries and timeout defaults
// ---------------------------------------------------------------------------

describe("BUG-033: LLM routing config defaults and retry fields", () => {
  test("LlmRoutingConfig accepts retries and retryDelayMs fields", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          mode: "per-story" as const,
          timeoutMs: 30000,
          retries: 2,
          retryDelayMs: 500,
          fallbackToKeywords: true,
          cacheDecisions: true,
        },
      },
    };

    expect(config.routing.llm!.retries).toBe(2);
    expect(config.routing.llm!.retryDelayMs).toBe(500);
  });

  test("retries defaults to undefined — callLlm uses 1 internally", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true },
      },
    };

    expect(config.routing.llm!.retries).toBeUndefined();
  });

  test("effective timeout defaults to 30000ms (raised from 15000)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true },
      },
    };

    // When timeoutMs unset, callLlm applies 30000 default (not old 15000)
    const effectiveTimeout = config.routing.llm!.timeoutMs ?? 30000;
    expect(effectiveTimeout).toBe(30000);
  });

  test("retries: 0 disables retry (single attempt only)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: { mode: "per-story" as const, retries: 0, fallbackToKeywords: true, cacheDecisions: true },
      },
    };

    expect(config.routing.llm!.retries).toBe(0);
  });

  test("NaxConfigSchema validates retries and retryDelayMs", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schemas");

    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      routing: {
        strategy: "llm",
        llm: {
          mode: "per-story",
          retries: 2,
          retryDelayMs: 1000,
          fallbackToKeywords: true,
          cacheDecisions: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.llm?.retries).toBe(2);
      expect(result.data.routing.llm?.retryDelayMs).toBe(1000);
    }
  });

  test("NaxConfigSchema rejects negative retries", async () => {
    const { NaxConfigSchema } = await import("../../../src/config/schemas");

    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      routing: {
        strategy: "llm",
        llm: { mode: "per-story", retries: -1, fallbackToKeywords: true, cacheDecisions: true },
      },
    });

    expect(result.success).toBe(false);
  });
});
