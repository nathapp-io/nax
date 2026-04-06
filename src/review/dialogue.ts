/**
 * Reviewer-Implementer Dialogue
 *
 * Maintains a persistent reviewer session via agent.run() with keepSessionOpen: true.
 * The reviewer holds full conversation context across multiple review() calls.
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import { NaxError } from "../errors";
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

function buildReviewPrompt(diff: string, story: SemanticStory, _semanticConfig: SemanticReviewConfig): string {
  const criteria = story.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  return [
    `Review the following code diff for story ${story.id}: ${story.title}`,
    "",
    "## Acceptance Criteria",
    criteria,
    "",
    "## Diff",
    diff,
    "",
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string } }",
  ].join("\n");
}

function parseReviewResponse(output: string): ReviewDialogueResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new NaxError("[dialogue] Failed to parse reviewer JSON response", "REVIEWER_PARSE_FAILED", {
      stage: "review",
      output,
    });
  }

  const success = Boolean(parsed.passed);
  const findings = Array.isArray(parsed.findings) ? (parsed.findings as ReviewFinding[]) : [];
  const reasoningObj =
    parsed.findingReasoning && typeof parsed.findingReasoning === "object"
      ? (parsed.findingReasoning as Record<string, string>)
      : {};

  const findingReasoning = new Map<string, string>(Object.entries(reasoningObj));

  return { checkResult: { success, findings }, findingReasoning };
}

/**
 * Create a new ReviewerSession.
 */
export function createReviewerSession(
  agent: AgentAdapter,
  storyId: string,
  workdir: string,
  featureName: string,
  _config: NaxConfig,
): ReviewerSession {
  const history: DialogueMessage[] = [];
  let active = true;

  return {
    get active() {
      return active;
    },
    get history() {
      return history;
    },
    async review(
      diff: string,
      story: SemanticStory,
      semanticConfig: SemanticReviewConfig,
    ): Promise<ReviewDialogueResult> {
      if (!active) {
        throw new NaxError(
          `[dialogue] ReviewerSession for story ${storyId} has been destroyed`,
          "REVIEWER_SESSION_DESTROYED",
          { stage: "review", storyId, featureName },
        );
      }

      const prompt = buildReviewPrompt(diff, story, semanticConfig);

      const modelTier = semanticConfig.modelTier;
      const defaultAgent = _config.autoMode?.defaultAgent ?? "claude";
      const modelDef = resolveModelForAgent(_config.models, defaultAgent, modelTier, defaultAgent);
      const timeoutSeconds = semanticConfig.timeoutMs
        ? Math.ceil(semanticConfig.timeoutMs / 1000)
        : (_config.execution?.sessionTimeoutSeconds ?? 3600);

      const result = await agent.run({
        prompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepSessionOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
      });

      history.push({ role: "implementer", content: prompt });
      history.push({ role: "reviewer", content: result.output });

      return parseReviewResponse(result.output);
    },
    async destroy(): Promise<void> {
      if (!active) return;
      active = false;
      history.length = 0;
    },
  };
}
