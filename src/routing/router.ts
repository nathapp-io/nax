/**
 * Task Router
 *
 * Classifies task complexity and routes to the appropriate
 * model tier and test strategy.
 */

import type { Complexity, TestStrategy, NgentConfig } from "../config";
import type { ModelTier } from "../agents";

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
  "refactor", "redesign", "architecture", "migration",
  "breaking change", "public api", "security", "auth",
  "encryption", "permission", "rbac", "casl", "jwt",
  "grpc", "microservice", "event-driven", "saga",
];

const EXPERT_KEYWORDS = [
  "cryptograph", "zero-knowledge", "distributed consensus",
  "real-time", "websocket", "streaming", "performance critical",
];

const SECURITY_KEYWORDS = [
  "auth", "security", "permission", "jwt", "oauth", "token",
  "encryption", "secret", "credential", "password", "rbac", "casl",
];

const PUBLIC_API_KEYWORDS = [
  "public api", "breaking change", "external", "consumer",
  "sdk", "npm publish", "release", "endpoint",
];

/** Classify a story's complexity based on its content */
export function classifyComplexity(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  tags: string[] = [],
): Complexity {
  const text = [title, description, ...acceptanceCriteria, ...tags]
    .join(" ")
    .toLowerCase();

  // Expert: matches expert keywords
  if (EXPERT_KEYWORDS.some((kw) => text.includes(kw))) {
    return "expert";
  }

  // Complex: matches complex keywords or has many criteria
  if (
    COMPLEX_KEYWORDS.some((kw) => text.includes(kw)) ||
    acceptanceCriteria.length > 8
  ) {
    return "complex";
  }

  // Medium: moderate criteria or some structural keywords
  if (acceptanceCriteria.length > 4) {
    return "medium";
  }

  return "simple";
}

/**
 * Determine test strategy using the embedded decision tree
 * from dev-workflow.
 *
 * Decision tree:
 *   Is it public API or security-critical?
 *     YES → three-session-tdd
 *     NO → Is complexity complex/expert?
 *       YES → three-session-tdd
 *       NO → test-after
 */
export function determineTestStrategy(
  complexity: Complexity,
  title: string,
  description: string,
  tags: string[] = [],
): TestStrategy {
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

  // Simple/medium → test-after
  return "test-after";
}

/** Map complexity to model tier */
function complexityToModelTier(
  complexity: Complexity,
  config: NgentConfig,
): ModelTier {
  const mapping = config.autoMode.complexityRouting;
  return (mapping[complexity] ?? "standard") as ModelTier;
}

/** Route a task: classify, pick model, pick test strategy */
export function routeTask(
  title: string,
  description: string,
  acceptanceCriteria: string[],
  tags: string[],
  config: NgentConfig,
): RoutingDecision {
  const complexity = classifyComplexity(title, description, acceptanceCriteria, tags);
  const modelTier = complexityToModelTier(complexity, config);
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
    reasoning: reasons.length > 0
      ? `three-session-tdd: ${reasons.join(", ")}`
      : `test-after: simple task (${complexity})`,
  };
}
