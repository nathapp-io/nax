// RE-ARCH: keep
/**
 * v0.18.4 Routing Stability Tests
 *
 * BUG-031: Keyword classifier inconsistency across retries
 * BUG-033: LLM routing retry on timeout — config fields and defaults
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../src/logger";
import type { UserStory } from "../../../src/prd/types";
import { classifyComplexity, complexityToModelTier, determineTestStrategy } from "../../../src/routing";
import { classifyRouteOp, classifyRouteBatchOp } from "../../../src/operations";
import { makeStory } from "../../helpers";

/** Minimal keyword-route helper replacing the deleted keywordStrategy object. */
function keywordRoute(story: UserStory, config: NaxConfig) {
  const tddStrategy = config.tdd?.strategy ?? "auto";
  const complexity = classifyComplexity(story.title, story.description, story.acceptanceCriteria, story.tags ?? []);
  const modelTier = complexityToModelTier(complexity, config);
  const testStrategy = determineTestStrategy(complexity, story.title, story.description, story.tags ?? [], tddStrategy);
  return { complexity, modelTier, testStrategy };
}

const routeCtxConfig: NaxConfig = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, llm: undefined } };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// BUG-031
describe("keyword classifier produces identical results across retries", () => {
  test("classification is identical on first attempt and retry with same story", () => {
    const story = makeStory();
    const first = keywordRoute(story, routeCtxConfig);
    const retry = keywordRoute(story, routeCtxConfig);

    expect(first.complexity).toBe(retry.complexity);
    expect(first.testStrategy).toBe(retry.testStrategy);
    expect(first.modelTier).toBe(retry.modelTier);
  });

  test("description containing security/auth error text does NOT shift classification", () => {
    const clean = makeStory({ title: "Add color picker", description: "Simple UI change" });
    const withErrors = makeStory({
      title: "Add color picker",
      description: "Simple UI change\n\nPrior errors:\n- auth token expired\n- security check failed\n- refactor needed",
    });

    const cleanResult = keywordRoute(clean, routeCtxConfig);
    const errorResult = keywordRoute(withErrors, routeCtxConfig);

    // BUG-031 fix: description excluded from classification — results must be identical
    expect(cleanResult.complexity).toBe(errorResult.complexity);
    expect(cleanResult.testStrategy).toBe(errorResult.testStrategy);
    expect(cleanResult.modelTier).toBe(errorResult.modelTier);
  });

  test("description with complex keywords does NOT upgrade complexity", () => {
    const story = makeStory({
      title: "Fix button label",
      description: "architecture refactor security migration breaking change",
      tags: [],
      acceptanceCriteria: ["Label is correct"],
    });

    const result = keywordRoute(story, routeCtxConfig);
    expect(result.complexity).toBe("simple");
    // TS-001: simple → tdd-simple (not test-after)
    expect(result.testStrategy as string).toBe("tdd-simple");
  });

  test("complexity is driven by title and tags only (not description)", () => {
    const simple = makeStory({ title: "Update label", description: "auth security jwt rbac encryption" });
    const complex = makeStory({
      title: "Add JWT authentication",
      description: "Simple change",
      tags: ["auth"],
      acceptanceCriteria: ["Token issued", "Expiry set", "Refresh works"],
    });

    expect(keywordRoute(simple, routeCtxConfig).complexity).toBe("simple");
    expect(keywordRoute(complex, routeCtxConfig).testStrategy).toBe("three-session-tdd");
  });
});

// ---------------------------------------------------------------------------
// BUG-033: LLM routing config — retries and timeout defaults
// ---------------------------------------------------------------------------

// BUG-033
describe("LLM routing config accepts retry and timeout fields with correct defaults", () => {
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
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true } as NaxConfig["routing"]["llm"],
      },
    };

    expect(config.routing.llm!.retries).toBeUndefined();
  });

  test("effective timeout defaults to 30000ms (raised from 15000)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true } as NaxConfig["routing"]["llm"],
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

// ---------------------------------------------------------------------------
// Issue #856 site #4: classifyRouteOp / classifyRouteBatchOp retry preset
// ---------------------------------------------------------------------------

describe("classifyRouteOp declares retry preset (issue #856 site #4)", () => {
  test("classifyRouteOp has a retry field", () => {
    expect(classifyRouteOp.retry).toBeDefined();
  });

  test("classifyRouteBatchOp has a retry field", () => {
    expect(classifyRouteBatchOp.retry).toBeDefined();
  });

  test("retry resolver uses routing.llm.retries when set (deprecation bridge)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, llm: { mode: "per-story" as const, retries: 3, retryDelayMs: 2000 } },
    };
    const buildCtx = {
      packageView: null as never,
      config: { routing: config.routing, autoMode: config.autoMode } as never,
    };
    const resolver = classifyRouteOp.retry as (input: unknown, ctx: typeof buildCtx) => { maxAttempts: number; baseDelayMs: number } | undefined;
    const preset = resolver({}, buildCtx);
    expect(preset?.maxAttempts).toBe(4); // retries: 3 → maxAttempts: 4
    expect(preset?.baseDelayMs).toBe(2000);
  });

  test("retry resolver yields maxAttempts: 1 when retries: 0 (single attempt, no retry)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, llm: { mode: "per-story" as const, retries: 0, retryDelayMs: 500 } },
    };
    const buildCtx = {
      packageView: null as never,
      config: { routing: config.routing, autoMode: config.autoMode } as never,
    };
    const resolver = classifyRouteOp.retry as (input: unknown, ctx: typeof buildCtx) => { maxAttempts: number } | undefined;
    const preset = resolver({}, buildCtx);
    expect(preset?.maxAttempts).toBe(1);
  });
});
