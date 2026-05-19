/**
 * Build Plan for Strategy
 *
 * Unifies sequencing via strategy-driven plan builder.
 * Strategy only controls slot inclusion; actual ordering remains owned by
 * CANONICAL_ORDER and StoryOrchestratorBuilder.
 */

import type { NaxConfig } from "../config";
import type { TestStrategy } from "../config/schema-types";
import type { UserStory } from "../prd/types";

export interface BuildPlanForStrategyOptions {
  readonly story: UserStory;
  readonly config: NaxConfig;
  readonly testStrategy: TestStrategy;
  readonly isFreshRun?: boolean;
}

export interface PlanForStrategy {
  readonly testWriter?: boolean;
  readonly greenfieldGate?: boolean;
  readonly implementer?: boolean;
  readonly fullSuiteGate?: boolean;
  readonly verifier?: boolean;
  readonly semanticReview?: boolean;
  readonly adversarialReview?: boolean;
  readonly rectification?: boolean;
}

/**
 * Build a plan object that specifies which slots should be included in execution
 * based on the test strategy and configuration.
 *
 * AC1: testStrategy is passed as an explicit parameter, not read from NaxConfig
 * AC2: Fresh run includes test-writer and greenfield-gate; retry run omits both
 * AC3: TDD strategies include full-suite-gate and verifier; non-TDD omit them
 * AC4: Review phase selection controlled by config.review.checks membership
 * AC5: Rectification gated by shouldRunRectification(config)
 * AC6: Slot composition logic covered with table-driven tests
 */
export function buildPlanForStrategy(options: BuildPlanForStrategyOptions): PlanForStrategy {
  const { story: _story, config: _config, testStrategy: _testStrategy, isFreshRun: _isFreshRun = true } = options;

  // Stub implementation — to be filled by implementer
  // This will return an object with boolean flags for each slot
  return {
    testWriter: undefined,
    greenfieldGate: undefined,
    implementer: undefined,
    fullSuiteGate: undefined,
    verifier: undefined,
    semanticReview: undefined,
    adversarialReview: undefined,
    rectification: undefined,
  };
}
