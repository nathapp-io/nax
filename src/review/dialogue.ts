/**
 * Reviewer-Implementer Dialogue
 *
 * Maintains a persistent reviewer session via agent.run() with keepSessionOpen: true.
 * The reviewer holds full conversation context across multiple review() calls.
 */

import type { SemanticVerdict } from "../acceptance/types";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import { NaxError } from "../errors";
import type { ReviewFinding } from "../plugins/types";
import type { SemanticStory } from "./semantic";
import type { SemanticReviewConfig } from "./types";

export type { SemanticVerdict };

/** A single message in the reviewer-implementer dialogue history */
export interface DialogueMessage {
  /** Who sent this message */
  role: "implementer" | "reviewer";
  /** Message content */
  content: string;
}

/** Result of a single review() or reReview() call */
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
  /**
   * Summary of delta between previous and current findings.
   * Populated by reReview() — undefined for the initial review() call.
   */
  deltaSummary?: string;
}

/** A stateful reviewer session wrapping a persistent agent.run() call */
export interface ReviewerSession {
  /** Whether the session is still active (false after destroy()) */
  active: boolean;
  /** Full dialogue history — implementer prompts and reviewer responses */
  history: DialogueMessage[];
  /** Send a review request and receive structured feedback */
  review(diff: string, story: SemanticStory, semanticConfig: SemanticReviewConfig): Promise<ReviewDialogueResult>;
  /**
   * Send a follow-up re-review for an updated diff.
   * References previous findings by AC identifier in the prompt.
   * Destroys and recreates the session with a compacted summary when
   * history.length would exceed config.review.dialogue.maxDialogueMessages.
   */
  reReview(updatedDiff: string): Promise<ReviewDialogueResult>;
  /**
   * Send a clarification question to the reviewer.
   * Returns the raw response string.
   */
  clarify(question: string): Promise<string>;
  /**
   * Extract a SemanticVerdict from the last review result.
   * Throws NaxError('NO_REVIEW_RESULT') if no review() has been executed yet.
   */
  getVerdict(): SemanticVerdict;
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

function buildReReviewPrompt(updatedDiff: string, previousFindings: ReviewFinding[]): string {
  const findingsList =
    previousFindings.length > 0 ? previousFindings.map((f) => `- ${f.ruleId}: ${f.message}`).join("\n") : "(none)";
  return [
    "This is a follow-up re-review. Please review the updated diff below.",
    "",
    "## Previous Findings",
    findingsList,
    "",
    "## Updated Diff",
    updatedDiff,
    "",
    "Respond with JSON: { passed: boolean, findings: [...], findingReasoning: { [id]: string }, deltaSummary: string }",
    "deltaSummary should describe which previous findings are resolved vs still present.",
  ].join("\n");
}

function extractDeltaSummary(
  rawOutput: string,
  previousFindings: ReviewFinding[],
  newFindings: ReviewFinding[],
): string {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    if (typeof parsed.deltaSummary === "string" && parsed.deltaSummary.length > 0) {
      return parsed.deltaSummary;
    }
  } catch {
    // fall through to computed summary
  }

  const newIds = new Set(newFindings.map((f) => f.ruleId));
  const prevIds = new Set(previousFindings.map((f) => f.ruleId));

  const resolved = previousFindings.filter((f) => !newIds.has(f.ruleId));
  const stillPresent = newFindings.filter((f) => prevIds.has(f.ruleId));
  const added = newFindings.filter((f) => !prevIds.has(f.ruleId));

  const parts: string[] = [];
  if (resolved.length > 0) {
    parts.push(`Resolved: ${resolved.map((f) => f.ruleId).join(", ")}.`);
  }
  if (stillPresent.length > 0) {
    parts.push(`Still present: ${stillPresent.map((f) => f.ruleId).join(", ")}.`);
  }
  if (added.length > 0) {
    parts.push(`New findings: ${added.map((f) => f.ruleId).join(", ")}.`);
  }
  if (parts.length === 0) {
    return previousFindings.length > 0 ? "All previous findings resolved." : "No changes from previous review.";
  }
  return parts.join(" ");
}

function compactHistory(history: DialogueMessage[]): void {
  const summaryLines = ["[Compacted conversation summary]"];
  for (const msg of history.slice(0, -2)) {
    const preview = msg.content.length > 200 ? `${msg.content.slice(0, 200)}...` : msg.content;
    summaryLines.push(`${msg.role}: ${preview}`);
  }
  const summary = summaryLines.join("\n");
  const lastImplementer = history[history.length - 2] as DialogueMessage;
  const lastReviewer = history[history.length - 1] as DialogueMessage;
  history.length = 0;
  history.push({ role: "implementer", content: summary });
  history.push(lastImplementer);
  history.push(lastReviewer);
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

  if (!("passed" in parsed)) {
    throw new NaxError("[dialogue] Reviewer response missing required 'passed' field", "REVIEWER_PARSE_FAILED", {
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
  let lastCheckResult: ReviewDialogueResult | null = null;
  let lastStory: SemanticStory | null = null;
  let lastSemanticConfig: SemanticReviewConfig | null = null;

  function resolveRunParams(semanticConfig: SemanticReviewConfig) {
    const modelTier = semanticConfig.modelTier;
    const defaultAgent = _config.autoMode?.defaultAgent ?? "claude";
    const modelDef = resolveModelForAgent(_config.models, defaultAgent, modelTier, defaultAgent);
    const timeoutSeconds = semanticConfig.timeoutMs
      ? Math.ceil(semanticConfig.timeoutMs / 1000)
      : (_config.execution?.sessionTimeoutSeconds ?? 3600);
    return { modelTier, modelDef, timeoutSeconds };
  }

  return {
    get active() {
      return active;
    },
    get history() {
      return [...history];
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
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(semanticConfig);

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

      const parsed = parseReviewResponse(result.output);
      lastCheckResult = parsed;
      lastStory = story;
      lastSemanticConfig = semanticConfig;
      return parsed;
    },
    async reReview(updatedDiff: string): Promise<ReviewDialogueResult> {
      if (!active) {
        throw new NaxError(
          `[dialogue] ReviewerSession for story ${storyId} has been destroyed`,
          "REVIEWER_SESSION_DESTROYED",
          { stage: "review", storyId, featureName },
        );
      }
      if (!lastCheckResult || !lastSemanticConfig) {
        throw new NaxError(`[dialogue] reReview() called before any review() on story ${storyId}`, "NO_REVIEW_RESULT", {
          stage: "review",
          storyId,
        });
      }

      const previousFindings = lastCheckResult.checkResult.findings;
      const prompt = buildReReviewPrompt(updatedDiff, previousFindings);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(lastSemanticConfig);

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

      const parsed = parseReviewResponse(result.output);
      const deltaSummary = extractDeltaSummary(result.output, previousFindings, parsed.checkResult.findings);
      const dialogueResult: ReviewDialogueResult = { ...parsed, deltaSummary };
      lastCheckResult = dialogueResult;

      const maxMessages = _config.review?.dialogue?.maxDialogueMessages ?? 20;
      if (history.length > maxMessages) {
        compactHistory(history);
      }

      return dialogueResult;
    },
    async clarify(question: string): Promise<string> {
      if (!active) {
        throw new NaxError(
          `[dialogue] ReviewerSession for story ${storyId} has been destroyed`,
          "REVIEWER_SESSION_DESTROYED",
          { stage: "review", storyId, featureName },
        );
      }

      const effectiveSemanticConfig =
        lastSemanticConfig ??
        ({ modelTier: "balanced", rules: [], timeoutMs: 60_000, excludePatterns: [] } as SemanticReviewConfig);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(effectiveSemanticConfig);

      const result = await agent.run({
        prompt: question,
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

      history.push({ role: "implementer", content: question });
      history.push({ role: "reviewer", content: result.output });

      return result.output;
    },
    getVerdict(): SemanticVerdict {
      if (!lastCheckResult || !lastStory) {
        throw new NaxError(
          `[dialogue] getVerdict() called before any review() on story ${storyId}`,
          "NO_REVIEW_RESULT",
          { stage: "review", storyId },
        );
      }
      return {
        storyId,
        passed: lastCheckResult.checkResult.success,
        timestamp: new Date().toISOString(),
        acCount: lastStory.acceptanceCriteria.length,
        findings: lastCheckResult.checkResult.findings,
      };
    },
    async destroy(): Promise<void> {
      if (!active) return;
      active = false;
      history.length = 0;
    },
  };
}
