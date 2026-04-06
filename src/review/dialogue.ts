/**
 * Reviewer-Implementer Dialogue
 *
 * Maintains a persistent reviewer session via agent.run() with keepSessionOpen: true.
 * The reviewer holds full conversation context across multiple review() calls.
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import type { ReviewFinding } from "../plugins/types";
import type { SemanticStory } from "./semantic";
import type { SemanticReviewConfig } from "./types";

/** A single message in the reviewer-implementer dialogue history */
export interface DialogueMessage {
  /** Who sent this message */
  role: "implementer" | "reviewer";
  /** Message content */
  content: string;
}

/** Result of a single review() call */
export interface ReviewDialogueResult {
  /** Structured check outcome */
  checkResult: {
    /** Whether all acceptance criteria passed */
    success: boolean;
    /** Structured findings from the reviewer */
    findings: ReviewFinding[];
  };
  /** Map from finding identifier to detailed reasoning string */
  findingReasoning: Map<string, string>;
}

/** A stateful reviewer session wrapping a persistent agent.run() call */
export interface ReviewerSession {
  /** Whether the session is still active (false after destroy()) */
  active: boolean;
  /** Full dialogue history — implementer prompts and reviewer responses */
  history: DialogueMessage[];
  /** Send a review request and receive structured feedback */
  review(diff: string, story: SemanticStory, semanticConfig: SemanticReviewConfig): Promise<ReviewDialogueResult>;
  /** Close the session and mark it inactive */
  destroy(): Promise<void>;
}

/**
 * Create a new ReviewerSession.
 * Stub — not yet implemented.
 */
export function createReviewerSession(
  _agent: AgentAdapter,
  _storyId: string,
  _workdir: string,
  _featureName: string,
  _config: NaxConfig,
): ReviewerSession {
  throw new Error("not implemented");
}
