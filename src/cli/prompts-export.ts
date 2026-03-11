/**
 * Prompts Export Command
 *
 * Export default prompts for a given role.
 */

import type { UserStory } from "../prd";
import { PromptBuilder } from "../prompts";

const VALID_EXPORT_ROLES = ["test-writer", "implementer", "verifier", "single-session", "tdd-simple"] as const;

export interface ExportPromptCommandOptions {
  /** Role to export prompt for */
  role: string;
  /** Optional output file path (stdout if not provided) */
  out?: string;
}

/**
 * Execute the `nax prompts --export <role>` command.
 *
 * Builds the full default prompt for the given role using a stub story
 * and empty context, then writes it to stdout or a file.
 *
 * @param options - Command options
 */
export async function exportPromptCommand(options: ExportPromptCommandOptions): Promise<void> {
  const { role, out } = options;

  if (!VALID_EXPORT_ROLES.includes(role as (typeof VALID_EXPORT_ROLES)[number])) {
    console.error(`[ERROR] Invalid role: "${role}". Valid roles: ${VALID_EXPORT_ROLES.join(", ")}`);
    process.exit(1);
  }

  const stubStory: UserStory = {
    id: "EXAMPLE",
    title: "Example story",
    description: "Story ID: EXAMPLE. This is a placeholder story used to demonstrate the default prompt.",
    acceptanceCriteria: ["AC-1: Example criterion"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };

  const prompt = await PromptBuilder.for(role as (typeof VALID_EXPORT_ROLES)[number])
    .story(stubStory)
    .build();

  if (out) {
    await Bun.write(out, prompt);
    console.log(`[OK] Exported prompt for "${role}" to ${out}`);
  } else {
    console.log(prompt);
  }
}
