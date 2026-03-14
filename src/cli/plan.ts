/**
 * Plan Command — Interactive planning via agent plan mode
 *
 * Spawns a coding agent in plan mode to gather requirements,
 * ask clarifying questions, and generate a structured specification.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ClaudeCodeAdapter } from "../agents/claude";
import type { PlanOptions } from "../agents/types";
import { scanCodebase } from "../analyze/scanner";
import type { NaxConfig } from "../config";
import { resolveModel } from "../config/schema";
import { getLogger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Question detection helpers for ACP interaction bridge
// ─────────────────────────────────────────────────────────────────────────────

const QUESTION_PATTERNS = [/\?[\s]*$/, /\bwhich\b/i, /\bshould i\b/i, /\bdo you want\b/i, /\bwould you like\b/i];

async function detectQuestion(text: string): Promise<boolean> {
  return QUESTION_PATTERNS.some((p) => p.test(text.trim()));
}

async function askHuman(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n[Agent asks]: ${question}\nYour answer: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Template for structured specification output.
 *
 * This template guides the agent to produce a consistent spec format
 * that can be parsed by the analyze command.
 */
const SPEC_TEMPLATE = `# Feature: [title]

## Problem
Why this is needed.

## Requirements
- REQ-1: ...
- REQ-2: ...

## Acceptance Criteria
- AC-1: ...

## Technical Notes
Architecture hints, constraints, dependencies.

## Out of Scope
What this does NOT include.
`;

/**
 * Run the plan command to generate a feature specification.
 *
 * @param prompt - The feature description or task
 * @param workdir - Project root directory
 * @param config - Ngent configuration
 * @param options - Command options (interactive, from)
 * @returns Path to the generated spec file
 */
export async function planCommand(
  prompt: string,
  workdir: string,
  config: NaxConfig,
  options: {
    interactive?: boolean;
    from?: string;
  } = {},
): Promise<string> {
  const interactive = options.interactive !== false; // Default to true
  const ngentDir = join(workdir, "nax");
  const outputPath = join(ngentDir, config.plan.outputPath);

  // Ensure nax directory exists
  if (!existsSync(ngentDir)) {
    throw new Error(`nax directory not found. Run 'nax init' first in ${workdir}`);
  }

  // Scan codebase for context
  const logger = getLogger();
  logger.info("cli", "Scanning codebase...");
  const scan = await scanCodebase(workdir);

  // Build codebase context markdown
  const codebaseContext = buildCodebaseContext(scan);

  // Resolve model for planning
  const modelTier = config.plan.model;
  const modelEntry = config.models[modelTier];
  const modelDef = resolveModel(modelEntry);

  // Build full prompt with template
  const fullPrompt = buildPlanPrompt(prompt, SPEC_TEMPLATE);

  // Prepare plan options
  const planOptions: PlanOptions = {
    prompt: fullPrompt,
    workdir,
    interactive,
    codebaseContext,
    inputFile: options.from,
    modelTier,
    modelDef,
    config,
    // Wire ACP interaction bridge for mid-session Q&A (only in interactive mode)
    interactionBridge: interactive ? { detectQuestion, onQuestionDetected: askHuman } : undefined,
  };

  // Run agent in plan mode
  const adapter = new ClaudeCodeAdapter();

  logger.info("cli", interactive ? "Starting interactive planning session..." : `Reading from ${options.from}...`, {
    interactive,
    from: options.from,
  });

  const result = await adapter.plan(planOptions);

  // Write spec to output file
  if (interactive) {
    // In interactive mode, the agent may have written directly
    // But we also capture and write to ensure consistency
    if (result.specContent) {
      await Bun.write(outputPath, result.specContent);
    } else {
      // If agent wrote directly, verify it exists
      if (!existsSync(outputPath)) {
        throw new Error(`Interactive planning completed but spec not found at ${outputPath}`);
      }
    }
  } else {
    // In non-interactive mode, we have the spec in result
    if (!result.specContent) {
      throw new Error("Agent did not produce specification content");
    }
    await Bun.write(outputPath, result.specContent);
  }

  logger.info("cli", "✓ Specification written to output", { outputPath });

  return outputPath;
}

/**
 * Build codebase context markdown from scan results.
 *
 * @param scan - Codebase scan result
 * @returns Formatted context string
 */
function buildCodebaseContext(scan: {
  fileTree: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  testPatterns: string[];
}): string {
  const sections: string[] = [];

  // File tree
  sections.push("## Codebase Structure\n");
  sections.push("```");
  sections.push(scan.fileTree);
  sections.push("```\n");

  // Dependencies
  const allDeps = { ...scan.dependencies, ...scan.devDependencies };
  const depList = Object.entries(allDeps)
    .map(([name, version]) => `- ${name}@${version}`)
    .join("\n");

  if (depList) {
    sections.push("## Dependencies\n");
    sections.push(depList);
    sections.push("");
  }

  // Test patterns
  if (scan.testPatterns.length > 0) {
    sections.push("## Test Setup\n");
    sections.push(scan.testPatterns.map((p) => `- ${p}`).join("\n"));
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Build the full planning prompt with template.
 *
 * @param userPrompt - User's task description
 * @param template - Spec template
 * @returns Full prompt with instructions
 */
function buildPlanPrompt(userPrompt: string, template: string): string {
  return `You are helping plan a new feature for this codebase.

Task: ${userPrompt}

Please gather requirements and produce a structured specification following this template:

${template}

Ask clarifying questions as needed to ensure the spec is complete and unambiguous.
Focus on understanding:
- The problem being solved
- Specific requirements and constraints
- Acceptance criteria for success
- Technical approach and architecture
- What is explicitly out of scope

When done, output the complete specification in markdown format.`;
}
