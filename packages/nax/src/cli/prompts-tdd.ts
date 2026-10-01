/**
 * Prompts TDD Handling
 *
 * Handle three-session TDD prompt generation.
 */

import { join } from "node:path";
import type { getLogger } from "../logger";
import type { PipelineContext } from "../pipeline";
import type { UserStory } from "../prd";
import { PromptBuilder } from "../prompts";
import { commandSpecIncludes, renderCommandSpec } from "../quality";
import { buildFrontmatter } from "./prompts-shared";

/**
 * Handle three-session TDD prompts by building separate prompts for each role.
 *
 * @param story - User story
 * @param ctx - Pipeline context
 * @param outputDir - Output directory (undefined for stdout)
 * @param logger - Logger instance
 */
export async function handleThreeSessionTddPrompts(
  story: UserStory,
  ctx: PipelineContext,
  outputDir: string | undefined,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  // US-004 — gate the `run-test` region on the SSOT for naming the
  // `testScoped` key (a template that takes anything other than
  // `{{files}}` would render a tool call the `RunCommand` runtime
  // rejects). The SSOT lives at src/execution/lifecycle/acceptance-helpers.ts:89.
  const scopedTestCommand = commandSpecIncludes(ctx.config.quality?.commands?.testScoped, "{{files}}")
    ? "testScoped"
    : undefined;
  // Build prompts for each session using PromptBuilder
  const [testWriterPrompt, implementerPrompt, verifierPrompt] = await Promise.all([
    PromptBuilder.for("test-writer", { isolation: "strict" })
      .withLoader(ctx.workdir, ctx.config)
      .story(story)
      .context(ctx.contextMarkdown)
      .constitution(ctx.constitution?.content)
      .testCommand(renderCommandSpec(ctx.config.quality?.commands?.test))
      .scopedTestCommand(scopedTestCommand)
      .build(),
    PromptBuilder.for("implementer", { variant: "standard" })
      .withLoader(ctx.workdir, ctx.config)
      .story(story)
      .context(ctx.contextMarkdown)
      .constitution(ctx.constitution?.content)
      .testCommand(renderCommandSpec(ctx.config.quality?.commands?.test))
      .scopedTestCommand(scopedTestCommand)
      .build(),
    PromptBuilder.for("verifier")
      .withLoader(ctx.workdir, ctx.config)
      .story(story)
      .context(ctx.contextMarkdown)
      .constitution(ctx.constitution?.content)
      .testCommand(renderCommandSpec(ctx.config.quality?.commands?.test))
      .scopedTestCommand(scopedTestCommand)
      .build(),
  ]);

  const sessions = [
    { role: "test-writer", prompt: testWriterPrompt },
    { role: "implementer", prompt: implementerPrompt },
    { role: "verifier", prompt: verifierPrompt },
  ];

  for (const session of sessions) {
    const frontmatter = buildFrontmatter(story, ctx, session.role);
    const fullOutput = `---\n${frontmatter}---\n\n${session.prompt}`;

    if (outputDir) {
      const promptFile = join(outputDir, `${story.id}.${session.role}.md`);
      await Bun.write(promptFile, fullOutput);

      logger.info("cli", "Written TDD prompt file", {
        storyId: story.id,
        role: session.role,
        promptFile,
      });
    } else {
      // Stdout mode: print separator + story ID + role + prompt
      console.log(`\n${"=".repeat(80)}`);
      console.log(`Story: ${story.id} — ${story.title} [${session.role}]`);
      console.log("=".repeat(80));
      console.log(fullOutput);
    }
  }

  // Also write context-only file for isolation audit
  if (outputDir && ctx.contextMarkdown) {
    const contextFile = join(outputDir, `${story.id}.context.md`);
    const frontmatter = buildFrontmatter(story, ctx);
    const contextOutput = `---\n${frontmatter}---\n\n${ctx.contextMarkdown}`;
    await Bun.write(contextFile, contextOutput);
  }
}
