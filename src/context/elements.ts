/**
 * Context Element Factories
 *
 * Extracted from builder.ts: token estimation and context element creation.
 */

import { getLogger } from "../logger";
import { estimateTokens } from "../optimizer/types";
import type { StructuredFailure, UserStory } from "../prd";
import type { ContextElement } from "./types";

/** Create context element from current story */
export function createStoryContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return { type: "story", storyId: story.id, content, priority, tokens: estimateTokens(content) };
}

/** Create context element from dependency story, including diff summary if available */
export function createDependencyContext(story: UserStory, priority: number): ContextElement {
  const content = isCompletedDependency(story) ? formatCompletedDependency(story) : formatFullDependency(story);
  return { type: "dependency", storyId: story.id, content, priority, tokens: estimateTokens(content) };
}

/** Whether a dependency story is complete and should use the compact format */
function isCompletedDependency(story: UserStory): boolean {
  return story.status === "passed" || story.status === "decomposed" || story.status === "skipped";
}

/**
 * Compact format for completed dependencies.
 * The agent doesn't need to re-implement these — only needs to know what they produced.
 */
function formatCompletedDependency(story: UserStory): string {
  const header = `## ${story.id} (${story.status}): ${story.title}`;
  if (story.diffSummary) {
    return `${header}\n\n**Changes made:**\n\`\`\`\n${story.diffSummary}\n\`\`\``;
  }
  return `${header}\n\nStatus: ${story.status} (no diff summary available)`;
}

/** Full format for incomplete/blocked dependencies — retains full AC list for reference */
function formatFullDependency(story: UserStory): string {
  let content = formatStoryAsText(story);
  if (story.diffSummary) {
    content += `\n\n**Changes made by this story:**\n\`\`\`\n${story.diffSummary}\n\`\`\``;
  }
  return content;
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
        const loc = finding.file ? `${finding.file}:${finding.line ?? 0}` : "global";
        parts.push(`\n- **[${finding.severity}]** \`${loc}\`${source}`);
        parts.push(`  **Rule:** ${finding.rule ?? finding.category}`);
        parts.push(`  **Issue:** ${finding.message}`);
        if (typeof finding.meta?.url === "string") {
          parts.push(`  **Docs:** ${finding.meta.url}`);
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
