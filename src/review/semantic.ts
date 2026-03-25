/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 */

import { spawn } from "bun";
import type { AgentAdapter } from "../agents/types";
import type { ModelTier } from "../config/schema-types";
import type { ReviewCheckResult, SemanticReviewConfig } from "./types";

/** Story fields required for semantic review */
export interface SemanticStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/** Function that resolves an AgentAdapter for a given model tier */
export type ModelResolver = (tier: ModelTier) => AgentAdapter | null | undefined;

/** Injectable dependencies for semantic.ts — allows tests to mock spawn without mock.module() */
export const _semanticDeps = {
  spawn: spawn as typeof spawn,
};

/**
 * Run a semantic review using an LLM against the story diff.
 *
 * Stub — implementation to follow.
 */
export async function runSemanticReview(
  _workdir: string,
  _storyGitRef: string | undefined,
  _story: SemanticStory,
  _semanticConfig: SemanticReviewConfig,
  _modelResolver: ModelResolver,
): Promise<ReviewCheckResult> {
  throw new Error("[semantic] runSemanticReview: not implemented");
}
