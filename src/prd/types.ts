/**
 * PRD (Product Requirements Document) Types
 *
 * Machine-readable task state for orchestration.
 */

import type { Complexity, TestStrategy } from "../config";
import type { ModelTier } from "../agents";

/** User story status */
export type StoryStatus = "pending" | "in-progress" | "passed" | "failed" | "skipped";

/** Routing metadata per story */
export interface StoryRouting {
  complexity: Complexity;
  modelTier: ModelTier;
  testStrategy: TestStrategy;
  reasoning: string;
  estimatedCost?: number;
}

/** Escalation attempt tracking */
export interface EscalationAttempt {
  fromTier: ModelTier;
  toTier: ModelTier;
  reason: string;
  timestamp: string;
}

/** A single user story */
export interface UserStory {
  /** Story ID (e.g., "US-001") */
  id: string;
  /** Story title */
  title: string;
  /** Story description */
  description: string;
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Tags for routing (e.g., ["security", "public-api"]) */
  tags: string[];
  /** Dependencies (story IDs that must complete first) */
  dependencies: string[];
  /** Current status */
  status: StoryStatus;
  /** Whether all acceptance criteria pass */
  passes: boolean;
  /** Routing metadata (set during analyze phase) */
  routing?: StoryRouting;
  /** Escalation history */
  escalations: EscalationAttempt[];
  /** Number of attempts */
  attempts: number;
}

/** The full PRD document */
export interface PRD {
  /** Project name */
  project: string;
  /** Feature name */
  feature: string;
  /** Git branch name */
  branchName: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** All user stories */
  userStories: UserStory[];
}
