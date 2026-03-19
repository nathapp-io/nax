/**
 * Shared Prompts Utilities
 *
 * Functions shared between prompts-main and prompts-tdd to avoid circular imports.
 * Both modules need buildFrontmatter; keeping it here breaks the cycle:
 *   prompts-main → prompts-tdd (was circular)
 *   now both → prompts-shared
 */

import type { PipelineContext } from "../pipeline";
import type { UserStory } from "../prd";

/**
 * Build YAML frontmatter for a prompt file.
 *
 * Token counts use actual BuiltContext values (computed during pipeline execution,
 * using CHARS_PER_TOKEN=3) rather than re-estimating independently.
 *
 * @param story - User story
 * @param ctx - Pipeline context after running prompt assembly
 * @param role - Optional role for three-session TDD (test-writer, implementer, verifier)
 * @returns YAML frontmatter string (without delimiters)
 */
export function buildFrontmatter(story: UserStory, ctx: PipelineContext, role?: string): string {
  const lines: string[] = [];

  lines.push(`storyId: ${story.id}`);
  lines.push(`title: "${story.title}"`);
  lines.push(`testStrategy: ${ctx.routing.testStrategy}`);
  lines.push(`modelTier: ${ctx.routing.modelTier}`);

  if (role) {
    lines.push(`role: ${role}`);
  }

  // Use actual token counts from BuiltContext if available
  const builtContext = ctx.builtContext;
  const contextTokens = builtContext?.totalTokens ?? 0;
  const promptTokens = ctx.prompt ? Math.ceil(ctx.prompt.length / 3) : 0;

  lines.push(`contextTokens: ${contextTokens}`);
  lines.push(`promptTokens: ${promptTokens}`);

  // Dependencies
  if (story.dependencies && story.dependencies.length > 0) {
    lines.push(`dependencies: [${story.dependencies.join(", ")}]`);
  }

  // Context elements breakdown from actual BuiltContext
  lines.push("contextElements:");

  if (builtContext) {
    for (const element of builtContext.elements) {
      lines.push(`  - type: ${element.type}`);
      if (element.storyId) {
        lines.push(`    storyId: ${element.storyId}`);
      }
      if (element.filePath) {
        lines.push(`    filePath: ${element.filePath}`);
      }
      lines.push(`    tokens: ${element.tokens}`);
    }
  }

  if (builtContext?.truncated) {
    lines.push("truncated: true");
  }

  return `${lines.join("\n")}\n`;
}
