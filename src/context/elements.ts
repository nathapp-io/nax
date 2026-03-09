/**
 * Context Element Factories
 *
 * Extracted from builder.ts: token estimation and context element creation.
 */

import { getLogger } from "../logger";
import type { StructuredFailure, UserStory } from "../prd";
import type { ContextElement } from "./types";

/**
 * Approximate character-to-token ratio for token estimation.
 * Value of 3 is a middle ground optimized for mixed content (prose + code + markdown).
 * Slightly overestimates tokens, preventing budget overflow.
 */
const CHARS_PER_TOKEN = 3;

/** Estimate token count for text using character-to-token ratio. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Create context element from current story */
export function createStoryContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return { type: "story", storyId: story.id, content, priority, tokens: estimateTokens(content) };
}

/** Create context element from dependency story */
export function createDependencyContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return { type: "dependency", storyId: story.id, content, priority, tokens: estimateTokens(content) };
}

/** Create context element from error */
export function createErrorContext(errorMessage: string, priority: number): ContextElement {
  return { type: "error", content: errorMessage, priority, tokens: estimateTokens(errorMessage) };
}

/** Create context element from progress summary */
export function createProgressContext(progressText: string, priority: number): ContextElement {
  return { type: "progress", content: progressText, priority, tokens: estimateTokens(progressText) };
}

/** Create context element from file content */
export function createFileContext(filePath: string, content: string, priority: number): ContextElement {
  return { type: "file", filePath, content, priority, tokens: estimateTokens(content) };
}

/** Create context element from test coverage summary */
export function createTestCoverageContext(content: string, tokens: number, priority: number): ContextElement {
  return { type: "test-coverage", content, priority, tokens };
}

/** Create context element from prior failures */
export function createPriorFailuresContext(failures: StructuredFailure[], priority: number): ContextElement {
  const content = formatPriorFailures(failures);
  return { type: "prior-failures", content, priority, tokens: estimateTokens(content) };
}

/** Format prior failures as markdown for agent context */
export function formatPriorFailures(failures: StructuredFailure[]): string {
  if (!failures || failures.length === 0) {
    return "";
  }

  const parts: string[] = [];
  parts.push("## Prior Failures (Structured Context)\n");

  for (const failure of failures) {
    parts.push(`### Attempt ${failure.attempt} — ${failure.modelTier}`);
    parts.push(`**Stage:** ${failure.stage}`);
    parts.push(`**Summary:** ${failure.summary}`);

    if (failure.testFailures && failure.testFailures.length > 0) {
      parts.push("\n**Test Failures:**");
      for (const testFailure of failure.testFailures) {
        parts.push(`\n- **File:** \`${testFailure.file}\``);
        parts.push(`  **Test:** ${testFailure.testName}`);
        parts.push(`  **Error:** ${testFailure.error}`);
        if (testFailure.stackTrace && testFailure.stackTrace.length > 0) {
          parts.push(`  **Stack:** ${testFailure.stackTrace[0]}`);
        }
      }
    }

    if (failure.reviewFindings && failure.reviewFindings.length > 0) {
      parts.push("\n**Review Findings (fix these issues):**");
      for (const finding of failure.reviewFindings) {
        const source = finding.source ? ` (${finding.source})` : "";
        parts.push(`\n- **[${finding.severity}]** \`${finding.file}:${finding.line}\`${source}`);
        parts.push(`  **Rule:** ${finding.ruleId}`);
        parts.push(`  **Issue:** ${finding.message}`);
        if (finding.url) {
          parts.push(`  **Docs:** ${finding.url}`);
        }
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

/** Format story as text for context (defensive checks for malformed PRD data) */
export function formatStoryAsText(story: UserStory): string {
  const parts: string[] = [];
  parts.push(`## ${story.id}: ${story.title}`);
  parts.push("");
  parts.push(`**Description:** ${story.description}`);
  parts.push("");
  parts.push("**Acceptance Criteria:**");

  if (story.acceptanceCriteria && Array.isArray(story.acceptanceCriteria)) {
    for (const ac of story.acceptanceCriteria) {
      parts.push(`- ${ac}`);
    }
  } else {
    const logger = getLogger();
    logger.warn("context", "Story has invalid acceptanceCriteria", {
      storyId: story.id,
      type: typeof story.acceptanceCriteria,
    });
    parts.push("- (No acceptance criteria defined)");
  }

  if (story.tags && story.tags.length > 0) {
    parts.push("");
    parts.push(`**Tags:** ${story.tags.join(", ")}`);
  }

  return parts.join("\n");
}
