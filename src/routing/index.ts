// Core types
export type { RoutingDecision, RoutingStrategy, RoutingContext } from "./router";

// Shared prompt constants used by classifyRoute op and llm strategy
export { ROUTING_INSTRUCTIONS } from "./strategies/llm";

// Shared validator used by classifyRoute op and llm parsing — single SSOT for
// LLM routing-decision validation (config-aware tier check + testStrategy derivation).
export { validateRoutingDecision } from "./strategies/llm-parsing";

// Main routing functions
export {
  resolveRouting,
  routeStory,
  routeTask,
  classifyComplexity,
  determineTestStrategy,
  complexityToModelTier,
  tryLlmBatchRoute,
  _tryLlmBatchRouteDeps,
} from "./router";
