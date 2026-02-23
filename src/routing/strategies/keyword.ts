/**
 * Keyword-Based Routing Strategy
 *
 * Routes stories based on keyword matching and acceptance criteria count.
 * This is the default fallback strategy — always returns a decision (never null).
 */

import type { Complexity, ModelTier, TestStrategy } from "../../config";
import type { UserStory } from "../../prd/types";
import type { RoutingContext, RoutingDecision, RoutingStrategy } from "../strategy";

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
 * Classify complexity based on keywords and criteria count.
 */
function classifyComplexity(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  tags: string[] = [],
): Complexity {
  const text = [title, description, ...acceptanceCriteria, ...tags].join(" ").toLowerCase();

  if (EXPERT_KEYWORDS.some((kw) => text.includes(kw))) {
    return "expert";
  }

  if (COMPLEX_KEYWORDS.some((kw) => text.includes(kw)) || acceptanceCriteria.length > 8) {
    return "complex";
  }

  if (acceptanceCriteria.length > 4) {
    return "medium";
  }

  return "simple";
}

/**
 * Determine test strategy using decision tree.
 */
function determineTestStrategy(
  complexity: Complexity,
  title: string,
  description: string,
  tags: string[] = [],
): TestStrategy {
  const text = [title, description, ...tags].join(" ").toLowerCase();

  const isSecurityCritical = SECURITY_KEYWORDS.some((kw) => text.includes(kw));
  const isPublicApi = PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw));

  if (isSecurityCritical || isPublicApi) {
    return "three-session-tdd";
  }

  if (complexity === "complex" || complexity === "expert") {
    return "three-session-tdd";
  }

  return "test-after";
}

/** Map complexity to model tier */
function complexityToModelTier(complexity: Complexity, context: RoutingContext): ModelTier {
  const mapping = context.config.autoMode.complexityRouting;
  return (mapping[complexity] ?? "balanced") as ModelTier;
}

/**
 * Keyword-based routing strategy.
 *
 * This strategy:
 * - Classifies complexity based on keywords and criteria count
 * - Maps complexity to model tier via config
 * - Applies test strategy decision tree
 * - ALWAYS returns a decision (never null)
 *
 * Use as the final fallback strategy in a chain.
 */
export const keywordStrategy: RoutingStrategy = {
  name: "keyword",

  route(story: UserStory, context: RoutingContext): RoutingDecision {
    const { title, description, acceptanceCriteria, tags } = story;

    const complexity = classifyComplexity(title, description, acceptanceCriteria, tags);
    const modelTier = complexityToModelTier(complexity, context);
    const testStrategy = determineTestStrategy(complexity, title, description, tags);

    const reasons: string[] = [];
    if (testStrategy === "three-session-tdd") {
      const text = [title, description, ...tags].join(" ").toLowerCase();
      if (SECURITY_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("security-critical");
      if (PUBLIC_API_KEYWORDS.some((kw) => text.includes(kw))) reasons.push("public-api");
      if (complexity === "complex" || complexity === "expert") reasons.push(`complexity:${complexity}`);
    }

    return {
      complexity,
      modelTier,
      testStrategy,
      reasoning:
        reasons.length > 0 ? `three-session-tdd: ${reasons.join(", ")}` : `test-after: simple task (${complexity})`,
    };
  },
};
