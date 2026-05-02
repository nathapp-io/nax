import type { Complexity, ModelTier, TestStrategy } from "../config";

/** Routing decision for a story */
export interface RoutingDecision {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
}
