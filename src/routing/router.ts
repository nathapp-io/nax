/**
 * Task Router
 *
 * Routes stories using pluggable strategy system.
 * Falls back to keyword-based classification for backward compatibility.
 */

import type { Complexity, ModelTier, NaxConfig, TddStrategy, TestStrategy } from "../config";
import type { UserStory } from "../prd/types";
import { buildStrategyChain } from "./builder";
import type { RoutingContext } from "./strategy";

/** Routing decision for a story */
export interface RoutingDecision {
  /** Classified complexity */
  complexity: Complexity;
  /** Model tier to use */
  modelTier: ModelTier;
  /** Test strategy to apply */
  testStrategy: TestStrategy;
  /** Reasoning for the classification */
  reasoning: string;
}

/** Keywords that indicate higher complexity */
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

/**
 * Classify a story's complexity based on keywords and acceptance criteria count.
 *
 * Classification rules:
 * - expert: matches expert keywords (cryptography, distributed consensus, real-time)
 * - complex: matches complex keywords or >8 acceptance criteria
 * - medium: >4 acceptance criteria
 * - simple: default
 *
 * @param title - Story title
 * @param description - Story description
 * @param acceptanceCriteria - Array of acceptance criteria
 * @param tags - Optional story tags
 * @returns Classified complexity level
 *
 * @example
 * ```ts
 * classifyComplexity(
 *   "Add JWT authentication",
 *   "Implement JWT auth with refresh tokens",
 *   ["Secure token storage", "Token refresh", "Expiry handling"],
 *   ["security", "auth"]
 * );
 * // "complex" (matches security keywords)
 *
 * classifyComplexity(
 *   "Fix typo in README",
 *   "Correct spelling mistake",
 *   ["Update README.md"],
 *   []
 * );
 * // "simple"
 * ```
 */
export function classifyComplexity(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  tags: string[] = [],
): Complexity {
  const text = [title, description, ...acceptanceCriteria, ...tags].join(" ").toLowerCase();

  // Expert: matches expert keywords
  if (EXPERT_KEYWORDS.some((kw) => text.includes(kw))) {
    return "expert";
  }

  // Complex: matches complex keywords or has many criteria
  if (COMPLEX_KEYWORDS.some((kw) => text.includes(kw)) || acceptanceCriteria.length > 8) {
    return "complex";
  }

  // Medium: moderate criteria or some structural keywords
  if (acceptanceCriteria.length > 4) {
    return "medium";
  }

  return "simple";
}

/** Tags that indicate UI/polyglot stories which prefer lite TDD mode */
const LITE_TDD_TAGS = ["ui", "layout", "cli", "integration", "polyglot"];

/**
 * Determine test strategy using decision tree logic.
 *
 * When tddStrategy is provided:
 * - 'strict' → always three-session-tdd
 * - 'lite'   → always three-session-tdd-lite
 * - 'off'    → always test-after
 * - 'auto'   → existing heuristic logic, plus:
 *              if tags include ui/layout/cli/integration/polyglot → three-session-tdd-lite
 *              if security/public-api/complex/expert → three-session-tdd
 *              otherwise → test-after
 *
 * @param complexity - Pre-classified complexity level
 * @param title - Story title
 * @param description - Story description
 * @param tags - Optional story tags
 * @param tddStrategy - TDD strategy override from config (default: 'auto')
 * @returns Test strategy
 *
 * @example
 * ```ts
 * determineTestStrategy("complex", "Add OAuth", "Implement OAuth 2.0", ["security", "auth"], "strict");
 * // "three-session-tdd"
 *
 * determineTestStrategy("simple", "Update button", "Change primary button", ["ui"], "auto");
 * // "three-session-tdd-lite"
 * ```
 */
export function determineTestStrategy(
  complexity: Complexity,
  title: string,
  description: string,
  tags: string[] = [],
  tddStrategy: TddStrategy = "auto",
): TestStrategy {
  // Explicit overrides — ignore all heuristics
  if (tddStrategy === "strict") return "three-session-tdd";
  if (tddStrategy === "lite") return "three-session-tdd-lite";
  if (tddStrategy === "off") return "test-after";

  // auto mode: apply heuristics
  const text = [title, description, ...tags].join(" ").toLowerCase();

  // Public API or security → always three-session-tdd
  const isSecurityCritical = SECURITY_KEYWORDS.some((kw) => text.includes(kw));
  const isPublicApi = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  if (isSecurityCritical || isPublicApi) {
    return "three-session-tdd";
  }

  // Complex/expert → three-session-tdd
  if (complexity === "complex" || complexity === "expert") {
    return "three-session-tdd";
  }

  // UI/polyglot tags → three-session-tdd-lite
  const normalizedTags = tags.map((t) => t.toLowerCase());
  if (LITE_TDD_TAGS.some((tag) => normalizedTags.includes(tag))) {
    return "three-session-tdd-lite";
  }

  // Simple/medium → test-after
  return "test-after";
}

/** Map complexity to model tier */
function complexityToModelTier(complexity: Complexity, config: NaxConfig): ModelTier {
  const mapping = config.autoMode.complexityRouting;
  return (mapping[complexity] ?? "balanced") as ModelTier;
}

/**
 * Route a story using the pluggable strategy system.
 *
 * This is the new main entry point for the routing system. It:
 * 1. Builds the strategy chain based on config
 * 2. Routes the story through the chain
 * 3. Returns the first non-null decision
 *
 * @param story - User story to route
 * @param context - Routing context (config, codebase, metrics)
 * @param workdir - Working directory for resolving custom strategy paths
 * @param plugins - Optional plugin registry for plugin-provided routers
 * @returns Routing decision from the strategy chain
 *
 * @example
 * ```ts
 * const decision = await routeStory(story, { config }, "/path/to/project", plugins);
 * // {
 * //   complexity: "complex",
 * //   modelTier: "balanced",
 * //   testStrategy: "three-session-tdd",
 * //   reasoning: "three-session-tdd: security-critical, complexity:complex"
 * // }
 * ```
 */
export async function routeStory(
  story: UserStory,
  context: RoutingContext,
  workdir: string,
  plugins?: import("../plugins/registry").PluginRegistry,
): Promise<RoutingDecision> {
  const chain = await buildStrategyChain(context.config, workdir, plugins);
  return await chain.route(story, context);
}

/**
 * Route a task through complexity classification, model tier selection, and test strategy.
 *
 * DEPRECATED: Use routeStory() instead. This function is kept for backward compatibility
 * and uses only the keyword strategy.
 *
 * @param title - Story title
 * @param description - Story description
 * @param acceptanceCriteria - Array of acceptance criteria
 * @param tags - Story tags
 * @param config - nax configuration with complexity routing mappings
 * @returns Routing decision with complexity, model tier, test strategy, and reasoning
 *
 * @deprecated Use routeStory() with a UserStory object instead
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
  const tddStrategy = config.tdd?.strategy ?? "auto";
  const testStrategy = determineTestStrategy(complexity, title, description, tags, tddStrategy);

  const reasons: string[] = [];
  if (testStrategy === "three-session-tdd" || testStrategy === "three-session-tdd-lite") {
    const text = [title, description, ...tags].join(" ").toLowerCase();
    if (SECURITY_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("security-critical");
    if (PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("public-api");
    if (complexity === "complex" || complexity === "expert") reasons.push(`complexity:${complexity}`);
    if (tddStrategy !== "auto") reasons.push(`strategy:${tddStrategy}`);
    const normalizedTags = tags.map((t) => t.toLowerCase());
    if (LITE_TDD_TAGS.some((tag) => normalizedTags.includes(tag))) reasons.push("ui/polyglot-tag");
  }

  const prefix = testStrategy === "three-session-tdd-lite" ? "three-session-tdd-lite" : testStrategy;
  return {
    complexity,
    modelTier,
    testStrategy,
    reasoning:
      reasons.length > 0 ? `${prefix}: ${reasons.join(", ")}` : `test-after: simple task (${complexity})`,
  };
}
