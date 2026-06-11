import type { Complexity, ModelTier, TestStrategy } from "../config";

/** Routing decision for a story */
export interface RoutingDecision {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  /** Resolved agent name from the chosen profile — undefined when no profile selected */
  agent?: string;
  /** Profile id that produced the agent choice — for audit and metrics */
  agentProfileId?: string;
}
