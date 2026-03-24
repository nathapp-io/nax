/**
 * Task Router
 *
 * Core routing logic: classifyComplexity, determineTestStrategy, complexityToModelTier.
 * resolveRouting() is the single entry point for all routing decisions:
 *   plugin routers > LLM fallback > keyword fallback
 */

import { getAgent } from "../agents/registry";
import type { AgentAdapter } from "../agents/types";
import type { Complexity, ModelTier, NaxConfig, TddStrategy, TestStrategy } from "../config";
import { getSafeLogger } from "../logger";
import type { PluginRegistry } from "../plugins/registry";
import type { UserStory } from "../prd/types";

// ---------------------------------------------------------------------------
// Interfaces (moved here from deleted strategy.ts)
// ---------------------------------------------------------------------------

/** Context passed to plugin routing strategies */
export interface RoutingContext {
  /** Full configuration */
  config: NaxConfig;
  /** Optional codebase context summary */
  codebaseContext?: string;
  /** Optional agent adapter for LLM-based routing */
  adapter?: AgentAdapter;
}

/**
 * Routing strategy interface for plugins.
 *
 * Return a RoutingDecision to claim the story, or null to delegate.
 */
export interface RoutingStrategy {
  readonly name: string;
  route(story: UserStory, context: RoutingContext): RoutingDecision | null | Promise<RoutingDecision | null>;
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

/** Routing decision for a story */
export interface RoutingDecision {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

const COMPLEX_KEYWORDS = [
  "refactor",
  "redesign",
  "architecture",
  "migration",
  "breaking change",
  "public api",
  "security",
  "auth",
  "encryption",
  "permission",
  "rbac",
  "casl",
  "jwt",
  "grpc",
  "microservice",
  "event-driven",
  "saga",
];

const EXPERT_KEYWORDS = [
  "cryptograph",
  "zero-knowledge",
  "distributed consensus",
  "real-time",
  "websocket",
  "streaming",
  "performance critical",
];

const SECURITY_KEYWORDS = [
  "auth",
  "security",
  "permission",
  "jwt",
  "oauth",
  "token",
  "encryption",
  "secret",
  "credential",
  "password",
  "rbac",
  "casl",
];

const PUBLIC_API_KEYWORDS = [
  "public api",
  "breaking change",
  "external",
  "consumer",
  "sdk",
  "npm publish",
  "release",
  "endpoint",
];

/** Tags that indicate a lite-mode story */
const LITE_TAGS = ["ui", "layout", "cli", "integration", "polyglot"];

// ---------------------------------------------------------------------------
// Core classification functions
// ---------------------------------------------------------------------------

/**
 * Classify a story's complexity based on keywords and acceptance criteria count.
 *
 * BUG-031: description excluded — it accumulates priorErrors across retries and
 * causes classification drift. Only stable, immutable fields are used.
 */
export function classifyComplexity(
  title: string,
  _description: string,
  acceptanceCriteria: string[],
  tags: string[] = [],
): Complexity {
  const text = [title, ...(acceptanceCriteria ?? []), ...(tags ?? [])].join(" ").toLowerCase();

  if (EXPERT_KEYWORDS.some((kw) => text.includes(kw))) return "expert";
  if (COMPLEX_KEYWORDS.some((kw) => text.includes(kw)) || acceptanceCriteria.length > 8) return "complex";
  if (acceptanceCriteria.length > 4) return "medium";
  return "simple";
}

/**
 * Determine test strategy using decision tree logic.
 *
 * When tddStrategy is provided:
 * - 'strict' → always three-session-tdd
 * - 'lite'   → always three-session-tdd-lite
 * - 'off'    → always test-after
 * - 'auto'   → heuristic logic
 */
export function determineTestStrategy(
  complexity: Complexity,
  title: string,
  _description: string,
  tags: string[] = [],
  tddStrategy: TddStrategy = "auto",
): TestStrategy {
  if (tddStrategy === "strict") return "three-session-tdd";
  if (tddStrategy === "lite") return "three-session-tdd-lite";
  if (tddStrategy === "simple") return "tdd-simple";
  if (tddStrategy === "off") return "test-after";

  // auto mode: apply heuristics
  // BUG-031: exclude description — only use stable, immutable story fields
  const text = [title, ...(tags ?? [])].join(" ").toLowerCase();

  const isSecurityCritical = SECURITY_KEYWORDS.some((kw) => text.includes(kw));
  const isPublicApi = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  if (isSecurityCritical || isPublicApi) return "three-session-tdd";

  if (complexity === "complex" || complexity === "expert") {
    const normalizedTags = (tags ?? []).map((t) => t.toLowerCase());
    const hasLiteTag = LITE_TAGS.some((tag) => normalizedTags.includes(tag));
    return hasLiteTag ? "three-session-tdd-lite" : "three-session-tdd";
  }

  if (complexity === "simple") return "tdd-simple";
  return "three-session-tdd-lite";
}

/** Map complexity to model tier */
export function complexityToModelTier(complexity: Complexity, config: NaxConfig): ModelTier {
  const mapping = config.autoMode.complexityRouting;
  return (mapping[complexity] ?? "balanced") as ModelTier;
}

// ---------------------------------------------------------------------------
// Keyword fallback (internal)
// ---------------------------------------------------------------------------

function keywordRoute(story: UserStory, config: NaxConfig): RoutingDecision {
  const { title, description, acceptanceCriteria, tags } = story;
  const tddStrategy: TddStrategy = config.tdd?.strategy ?? "auto";
  const complexity = classifyComplexity(title, description, acceptanceCriteria, tags);
  const modelTier = complexityToModelTier(complexity, config);
  const testStrategy = determineTestStrategy(complexity, title, description, tags, tddStrategy);

  const reasons: string[] = [];
  const text = [title, ...(tags ?? [])].join(" ").toLowerCase();
  if (SECURITY_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("security-critical");
  if (PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("public-api");
  if ((complexity === "complex" || complexity === "expert") && reasons.length === 0) {
    reasons.push(`complexity:${complexity}`);
  }

  const prefix = testStrategy;
  const reasoning = reasons.length > 0 ? `${prefix}: ${reasons.join(", ")}` : `${prefix}: ${complexity} task`;

  return { complexity, modelTier, testStrategy, reasoning };
}

// ---------------------------------------------------------------------------
// resolveRouting — main entry point
// ---------------------------------------------------------------------------

/**
 * Route a story using the simplified priority chain:
 *   1. Plugin routers (plugins.getRouters()) — first win
 *   2. LLM fallback (if routing.strategy === "llm" and adapter available)
 *   3. Keyword fallback (always available)
 *
 * Greenfield detection and escalation overrides are handled by the caller
 * (pipeline routing stage), not here.
 *
 * @param story - User story to route
 * @param config - nax configuration
 * @param plugins - Optional plugin registry for plugin-provided routers
 * @param adapter - Optional agent adapter for LLM routing
 * @returns Routing decision
 */
export async function resolveRouting(
  story: UserStory,
  config: NaxConfig,
  plugins?: PluginRegistry,
  adapter?: AgentAdapter,
): Promise<RoutingDecision> {
  const logger = getSafeLogger();

  // 0. PRD wins — if story already has routing values set (either manually by the user
  //    or persisted from a previous run), use them directly. This ensures retries use
  //    the same routing as the original run, and manual PRD overrides are respected.
  //    modelTier is always re-derived from complexity + config (never persisted).
  if (story.routing?.complexity && story.routing?.testStrategy) {
    const modelTier = complexityToModelTier(story.routing.complexity, config);
    return {
      complexity: story.routing.complexity,
      modelTier,
      testStrategy: story.routing.testStrategy,
      reasoning: story.routing.reasoning ?? "(from PRD)",
    };
  }

  // 1. Plugin routers — highest priority
  if (plugins) {
    for (const pluginRouter of plugins.getRouters()) {
      try {
        const decision = await pluginRouter.route(story, { config, adapter });
        if (decision !== null) return decision;
      } catch (err) {
        logger?.warn("routing", `Plugin router "${pluginRouter.name}" failed`, {
          storyId: story.id,
          error: (err as Error).message,
        });
      }
    }
  }

  // 2. LLM fallback (if configured and adapter available)
  if (config.routing.strategy === "llm" && adapter) {
    try {
      const { classifyWithLlm } = await import("./strategies/llm");
      const decision = await classifyWithLlm(story, config, adapter);
      if (decision !== null) return decision;
    } catch (err) {
      logger?.warn("routing", "LLM routing failed, falling back to keyword", {
        storyId: story.id,
        error: (err as Error).message,
      });
    }
  }

  // 3. Keyword fallback — always available
  return keywordRoute(story, config);
}

// ---------------------------------------------------------------------------
// routeStory — backward compat wrapper (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use resolveRouting() instead.
 */
export async function routeStory(
  story: UserStory,
  context: RoutingContext,
  _workdir: string,
  plugins?: PluginRegistry,
): Promise<RoutingDecision> {
  return resolveRouting(story, context.config, plugins, context.adapter);
}

// ---------------------------------------------------------------------------
// routeTask — sync keyword-only wrapper (deprecated)
// ---------------------------------------------------------------------------

/**
 * Route a task synchronously using keyword classification only.
 *
 * @deprecated Use resolveRouting() for full routing with LLM and plugin support.
 */
export function routeTask(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  tags: string[],
  config: NaxConfig,
): RoutingDecision {
  const complexity = classifyComplexity(title, description, acceptanceCriteria, tags);
  const modelTier = complexityToModelTier(complexity, config);
  const tddStrategy: TddStrategy = config.tdd?.strategy ?? "auto";
  const testStrategy = determineTestStrategy(complexity, title, description, tags, tddStrategy);

  const reasons: string[] = [];
  const text = [title, ...(tags ?? [])].join(" ").toLowerCase();
  const normalizedTags = (tags ?? []).map((t) => t.toLowerCase());
  const hasLiteTag = LITE_TAGS.some((tag) => normalizedTags.includes(tag));

  if (SECURITY_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("security-critical");
  if (PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("public-api");

  if ((complexity === "complex" || complexity === "expert") && reasons.length === 0) {
    reasons.push(`complexity:${complexity}`);
  }

  if (tddStrategy !== "auto") reasons.push(`strategy:${tddStrategy}`);
  if (hasLiteTag && (complexity === "complex" || complexity === "expert")) {
    reasons.push("lite-tags");
  }

  const prefix = testStrategy;
  return {
    complexity,
    modelTier,
    testStrategy,
    reasoning: reasons.length > 0 ? `${prefix}: ${reasons.join(", ")}` : `test-after: simple task (${complexity})`,
  };
}

// ---------------------------------------------------------------------------
// tryLlmBatchRoute — pre-populates LLM routing cache for a batch of stories
// ---------------------------------------------------------------------------

/**
 * Attempt to pre-route a batch of stories using LLM to optimize cost and consistency.
 * Populates the LLM routing cache; individual resolveRouting() calls will then hit cache.
 *
 * No-ops if routing.strategy is not "llm" or mode is "per-story" or stories is empty.
 */
export const _tryLlmBatchRouteDeps = { getAgent };

export async function tryLlmBatchRoute(
  config: NaxConfig,
  stories: UserStory[],
  label = "routing",
  _deps = _tryLlmBatchRouteDeps,
): Promise<void> {
  const mode = config.routing.llm?.mode ?? "hybrid";
  if (config.routing.strategy !== "llm" || mode === "per-story" || stories.length === 0) return;
  const resolvedAdapter = _deps.getAgent(config.execution?.agent ?? "claude");
  if (!resolvedAdapter) return;

  const logger = getSafeLogger();
  try {
    logger?.debug("routing", `LLM batch routing: ${label}`, { storyCount: stories.length, mode });
    const { routeBatch } = await import("./strategies/llm");
    await routeBatch(stories, { config, adapter: resolvedAdapter });
    logger?.debug("routing", "LLM batch routing complete", { label });
  } catch (err) {
    logger?.warn("routing", "LLM batch routing failed, falling back to individual routing", {
      error: (err as Error).message,
      label,
    });
  }
}
