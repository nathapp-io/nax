/**
 * Routing Strategy Interface
 *
 * Pluggable routing system that allows custom model tier selection logic.
 * Strategies can return null to delegate to the next strategy in the chain.
 */

import type { UserStory } from "../prd/types";
import type { NaxConfig, Complexity, ModelTier, TestStrategy } from "../config";

/** Aggregate metrics (v0.5 Phase 1 — not yet implemented) */
export interface AggregateMetrics {
  totalRuns: number;
  totalCost: number;
  totalStories: number;
  firstPassRate: number;
  escalationRate: number;
  avgCostPerStory: number;
  avgCostPerFeature: number;
  modelEfficiency: Record<string, {
    attempts: number;
    successes: number;
    passRate: number;
    avgCost: number;
    totalCost: number;
  }>;
  complexityAccuracy: Record<string, {
    predicted: number;
    actualTierUsed: string;
    mismatchRate: number;
  }>;
}

/** Context passed to routing strategies */
export interface RoutingContext {
  /** Full configuration */
  config: NaxConfig;
  /** Optional codebase context summary */
  codebaseContext?: string;
  /** Optional historical metrics (v0.5 Phase 1) */
  metrics?: AggregateMetrics;
}

/** Routing decision returned by strategies */
export interface RoutingDecision {
  /** Classified complexity */
  complexity: Complexity;
  /** Model tier to use */
  modelTier: ModelTier;
  /** Test strategy */
  testStrategy: TestStrategy;
  /** Reasoning for the decision */
  reasoning: string;
}

/**
 * Routing strategy interface.
 *
 * Strategies can return:
 * - A RoutingDecision if they can route the story
 * - null to delegate to the next strategy in the chain
 *
 * @example
 * ```ts
 * const myStrategy: RoutingStrategy = {
 *   name: "domain-specific",
 *   route(story, context) {
 *     if (story.tags.includes("migration")) {
 *       return {
 *         complexity: "expert",
 *         modelTier: "powerful",
 *         testStrategy: "three-session-tdd",
 *         reasoning: "Database migrations require expert model",
 *       };
 *     }
 *     return null; // Delegate to next strategy
 *   },
 * };
 * ```
 */
export interface RoutingStrategy {
  /** Strategy name (for logging) */
  readonly name: string;

  /**
   * Route a user story.
   *
   * @param story - The user story to route
   * @param context - Routing context (config, metrics, codebase)
   * @returns RoutingDecision if strategy can route, null to delegate
   */
  route(story: UserStory, context: RoutingContext): RoutingDecision | null;
}
