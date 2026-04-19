/**
 * Reviewer-Implementer Dialogue
 *
 * Maintains a persistent reviewer session via agent.run() with keepOpen: true.
 * The reviewer holds full conversation context across multiple review() calls.
 */

import type { SemanticVerdict } from "../acceptance/types";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config/schema-types";
import type { DebateResolverContext } from "../debate/types";
import { NaxError } from "../errors";
import type { ReviewFinding } from "../plugins/types";
import { DebatePromptBuilder } from "../prompts";
import { parseLLMJson, tryParseLLMJson } from "../utils/llm-json";
import type { SemanticStory } from "./semantic";
import type { DiffContext, SemanticReviewConfig } from "./types";

export type { SemanticVerdict };
export type { DebateResolverContext } from "../debate/types";

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
  /** LLM cost incurred for this dialogue turn */
  cost?: number;
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
   * Resolve a debate by reviewing N debater proposals using agent.run() with tool
   * access (READ, GREP). Prompt strategy varies by resolverType:
   * - majority: includes vote tally; reviewer verifies failing findings
   * - synthesis: reviewer synthesizes proposals into a single verdict
   * - custom: reviewer acts as independent judge
   * Stores result as lastCheckResult so getVerdict() and reReviewDebate() work.
   */
  resolveDebate(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    diffContext: DiffContext,
    story: SemanticStory,
    semanticConfig: SemanticReviewConfig,
    resolverContext: DebateResolverContext,
  ): Promise<ReviewDialogueResult>;
  /**
   * Re-resolve a debate after implementer changes.
   * Same session — references previous findings and debater proposals.
   */
  reReviewDebate(
    proposals: Array<{ debater: string; output: string }>,
    critiques: string[],
    diffContext: DiffContext,
    resolverContext: DebateResolverContext,
  ): Promise<ReviewDialogueResult>;
  /**
   * Extract a SemanticVerdict from the last review result.
   * Throws NaxError('NO_REVIEW_RESULT') if no review() has been executed yet.
   */
  getVerdict(): SemanticVerdict;
  /** Close the session and mark it inactive */
  destroy(): Promise<void>;
}

function extractDeltaSummary(
  rawOutput: string,
  previousFindings: ReviewFinding[],
  newFindings: ReviewFinding[],
): string {
  const parsed = tryParseLLMJson<Record<string, unknown>>(rawOutput);
  if (parsed && typeof parsed.deltaSummary === "string" && parsed.deltaSummary.length > 0) {
    return parsed.deltaSummary;
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

function compactHistory(history: DialogueMessage[]): string {
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
  return summary;
}

/**
 * Map a raw LLM finding object to a ReviewFinding.
 * The dialogue reviewer LLM may return `issue`/`suggestion` (matching the semantic.ts prompt schema)
 * or may return `message`/`ruleId` directly. Both shapes are normalized here so that
 * ReviewFinding.ruleId and ReviewFinding.message are always populated.
 */
function mapLLMFindingToReviewFinding(f: Record<string, unknown>): ReviewFinding {
  const rawSeverity = typeof f.severity === "string" ? f.severity : "info";
  let severity: ReviewFinding["severity"] = "info";
  if (rawSeverity === "warn" || rawSeverity === "warning") severity = "warning";
  else if (rawSeverity === "critical" || rawSeverity === "error" || rawSeverity === "low") severity = rawSeverity;
  else if (rawSeverity === "unverifiable") severity = "info";
  else if (rawSeverity === "info") severity = "info";

  return {
    ruleId: typeof f.ruleId === "string" && f.ruleId ? f.ruleId : "semantic",
    severity,
    file: typeof f.file === "string" ? f.file : "",
    line: typeof f.line === "number" ? f.line : 0,
    message: typeof f.message === "string" && f.message ? f.message : typeof f.issue === "string" ? f.issue : "",
    source: typeof f.source === "string" ? f.source : "semantic-review",
  };
}

function parseReviewResponse(output: string): ReviewDialogueResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseLLMJson<Record<string, unknown>>(output);
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
  const rawFindings = Array.isArray(parsed.findings) ? (parsed.findings as Record<string, unknown>[]) : [];
  const findings: ReviewFinding[] = rawFindings.map((f) => mapLLMFindingToReviewFinding(f));
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
  // Tracks whether the last review call was resolveDebate() (vs review()).
  // reReviewDebate() requires a prior resolveDebate() to avoid using findings
  // from a non-debate review() call as the delta baseline.
  let lastWasDebateResolve = false;
  /**
   * Tracks session lifecycle for compaction-triggered resets.
   * - generation: incremented each time history overflow causes a session reset.
   * - pendingCompactionContext: when non-null, the next agent.run() call must
   *   inject this compacted context as initial context and use a new sessionHandle
   *   to start a fresh session (satisfying AC4 session destruction + recreation).
   */
  const sessionState = {
    generation: 1,
    pendingCompactionContext: null as string | null,
  };
  // Shared builder instance — review-specific methods are self-contained and don't use stageContext/options.
  const promptBuilder = new DebatePromptBuilder(
    { taskContext: "", outputFormat: "", stage: "review" },
    { debaters: [], sessionMode: "stateful" },
  );

  function resolveRunParams(semanticConfig: SemanticReviewConfig) {
    const modelTier = semanticConfig.modelTier;
    const defaultAgent = _config.autoMode?.defaultAgent ?? "claude";
    const modelDef = resolveModelForAgent(_config.models, defaultAgent, modelTier, defaultAgent);
    const timeoutSeconds = semanticConfig.timeoutMs
      ? Math.ceil(semanticConfig.timeoutMs / 1000)
      : (_config.execution?.sessionTimeoutSeconds ?? 3600);
    return { modelTier, modelDef, timeoutSeconds };
  }

  /**
   * Builds the effective prompt and sessionHandle for an agent.run() call.
   *
   * When a compaction reset occurred (pendingCompactionContext is set), the
   * compacted context is prepended to the prompt so the fresh session receives
   * the full prior conversation summary as initial context (AC4).
   * sessionHandle is set to a generation-scoped name so the adapter creates
   * a new session rather than reusing the previous one.
   */
  function buildEffectiveRunArgs(prompt: string): { effectivePrompt: string; sessionHandle: string | undefined } {
    if (sessionState.pendingCompactionContext !== null) {
      const context = sessionState.pendingCompactionContext;
      sessionState.pendingCompactionContext = null;
      return {
        effectivePrompt: `${context}\n\n---\n\n${prompt}`,
        sessionHandle: `nax-reviewer-${storyId}-gen${sessionState.generation}`,
      };
    }
    const sessionHandle =
      sessionState.generation > 1 ? `nax-reviewer-${storyId}-gen${sessionState.generation}` : undefined;
    return { effectivePrompt: prompt, sessionHandle };
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

      const prompt = promptBuilder.buildReviewPrompt(diff, story);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(semanticConfig);
      const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(prompt);

      const result = await agent.run({
        prompt: effectivePrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
        sessionHandle,
      });

      history.push({ role: "implementer", content: prompt });
      history.push({ role: "reviewer", content: result.output });

      const parsed = parseReviewResponse(result.output);
      const reviewResult: ReviewDialogueResult = { ...parsed, cost: result.estimatedCost ?? 0 };
      lastCheckResult = reviewResult;
      lastStory = story;
      lastSemanticConfig = semanticConfig;
      lastWasDebateResolve = false;
      return reviewResult;
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
      const prompt = promptBuilder.buildReReviewPrompt(updatedDiff, previousFindings);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(lastSemanticConfig);
      const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(prompt);

      const result = await agent.run({
        prompt: effectivePrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
        sessionHandle,
      });

      history.push({ role: "implementer", content: prompt });
      history.push({ role: "reviewer", content: result.output });

      const parsed = parseReviewResponse(result.output);
      const deltaSummary = extractDeltaSummary(result.output, previousFindings, parsed.checkResult.findings);
      const dialogueResult: ReviewDialogueResult = { ...parsed, deltaSummary, cost: result.estimatedCost ?? 0 };
      lastCheckResult = dialogueResult;

      const maxMessages = _config.review?.dialogue?.maxDialogueMessages ?? 20;
      if (history.length > maxMessages) {
        // AC4: destroy the current session and prepare a fresh one.
        // compactHistory() returns the summary string; store it so the next
        // agent.run() call injects it as initial context for the new session.
        // Incrementing sessionState.generation causes buildEffectiveRunArgs()
        // to use a new sessionHandle, which forces the adapter to create a
        // fresh session rather than resuming the previous one.
        const compactedSummary = compactHistory(history);
        sessionState.generation++;
        sessionState.pendingCompactionContext = compactedSummary;
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
        ({
          modelTier: "balanced",
          diffMode: "embedded",
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 60_000,
          excludePatterns: [],
        } as SemanticReviewConfig);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(effectiveSemanticConfig);
      const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(question);

      const result = await agent.run({
        prompt: effectivePrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
        sessionHandle,
      });

      history.push({ role: "implementer", content: question });
      history.push({ role: "reviewer", content: result.output });

      return result.output;
    },
    async resolveDebate(
      proposals: Array<{ debater: string; output: string }>,
      critiques: string[],
      diffContext: DiffContext,
      story: SemanticStory,
      semanticConfig: SemanticReviewConfig,
      resolverContext: DebateResolverContext,
    ): Promise<ReviewDialogueResult> {
      if (!active) {
        throw new NaxError(
          `[dialogue] ReviewerSession for story ${storyId} has been destroyed`,
          "REVIEWER_SESSION_DESTROYED",
          { stage: "review", storyId, featureName },
        );
      }

      const prompt = promptBuilder.buildResolverPrompt(proposals, critiques, diffContext, story, resolverContext);
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(semanticConfig);
      const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(prompt);

      const result = await agent.run({
        prompt: effectivePrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
        sessionHandle,
      });

      history.push({ role: "implementer", content: prompt });
      history.push({ role: "reviewer", content: result.output });

      const parsed = parseReviewResponse(result.output);
      const reviewResult: ReviewDialogueResult = { ...parsed, cost: result.estimatedCost ?? 0 };
      lastCheckResult = reviewResult;
      lastStory = story;
      lastSemanticConfig = semanticConfig;
      lastWasDebateResolve = true;
      return reviewResult;
    },
    async reReviewDebate(
      proposals: Array<{ debater: string; output: string }>,
      critiques: string[],
      diffContext: DiffContext,
      resolverContext: DebateResolverContext,
    ): Promise<ReviewDialogueResult> {
      if (!active) {
        throw new NaxError(
          `[dialogue] ReviewerSession for story ${storyId} has been destroyed`,
          "REVIEWER_SESSION_DESTROYED",
          { stage: "review", storyId, featureName },
        );
      }
      if (!lastCheckResult || !lastSemanticConfig || !lastWasDebateResolve) {
        throw new NaxError(
          `[dialogue] reReviewDebate() called before any resolveDebate() on story ${storyId}`,
          "NO_REVIEW_RESULT",
          { stage: "review", storyId },
        );
      }

      const previousFindings = lastCheckResult.checkResult.findings;
      const prompt = promptBuilder.buildReResolverPrompt(
        proposals,
        critiques,
        diffContext,
        previousFindings,
        resolverContext,
      );
      const { modelTier, modelDef, timeoutSeconds } = resolveRunParams(lastSemanticConfig);
      const { effectivePrompt, sessionHandle } = buildEffectiveRunArgs(prompt);

      const result = await agent.run({
        prompt: effectivePrompt,
        workdir,
        modelTier,
        modelDef,
        timeoutSeconds,
        sessionRole: "reviewer",
        keepOpen: true,
        pipelineStage: "review",
        config: _config,
        storyId,
        featureName,
        sessionHandle,
      });

      history.push({ role: "implementer", content: prompt });
      history.push({ role: "reviewer", content: result.output });

      const parsed = parseReviewResponse(result.output);
      const deltaSummary = extractDeltaSummary(result.output, previousFindings, parsed.checkResult.findings);
      const dialogueResult: ReviewDialogueResult = { ...parsed, deltaSummary, cost: result.estimatedCost ?? 0 };
      lastCheckResult = dialogueResult;

      const maxMessages = _config.review?.dialogue?.maxDialogueMessages ?? 20;
      if (history.length > maxMessages) {
        const compactedSummary = compactHistory(history);
        sessionState.generation++;
        sessionState.pendingCompactionContext = compactedSummary;
      }

      return dialogueResult;
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
