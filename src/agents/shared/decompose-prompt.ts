/**
 * Decompose Prompt Builder
 *
 * Builds decompose prompts via OneShotPromptBuilder.
 * Extracted from decompose.ts as part of Phase 6 prompt migration.
 *
 * Two modes:
 *   - spec mode: breaks a feature spec into user stories
 *   - plan mode: splits a single targetStory into sub-stories
 */

import { COMPLEXITY_GUIDE, GROUPING_RULES, TEST_STRATEGY_GUIDE } from "../../config/test-strategy";
import { OneShotPromptBuilder, type SchemaDescriptor } from "../../prompts";
import type { DecomposeOptions } from "../types";

const DECOMPOSE_SPEC_SCHEMA: SchemaDescriptor = {
  name: "DecomposedStory[]",
  description: "Respond with ONLY a JSON array — no markdown code fences, no explanation text before or after.",
  example: [
    {
      id: "US-001",
      title: "Story title",
      description: "Story description",
      acceptanceCriteria: ["Criterion 1"],
      tags: ["tag1"],
      dependencies: [],
      complexity: "medium",
      contextFiles: ["src/path/to/file.ts"],
      reasoning: "Why this complexity level",
      estimatedLOC: 150,
      risks: ["Risk 1"],
      testStrategy: "test-after",
    },
  ],
};

const DECOMPOSE_PLAN_SCHEMA: SchemaDescriptor = {
  name: "SubStory[]",
  description: "Return a JSON array of sub-stories — no markdown code fences, no explanation — JSON array only.",
  example: [
    {
      id: "US-001-A",
      title: "Sub-story title",
      description: "Description",
      acceptanceCriteria: ["Behavioral, testable criterion"],
      contextFiles: ["src/path/to/file.ts"],
      tags: [],
      dependencies: [],
      complexity: "simple",
      reasoning: "Why this complexity",
      estimatedLOC: 0,
      risks: [],
      testStrategy: "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
    },
  ],
};

const SPEC_DECOMPOSE_INSTRUCTIONS = `Break down the feature specification into user stories and classify each story's complexity.

For each story, provide:
1. id: Story ID (e.g., "US-001")
2. title: Concise story title
3. description: What needs to be implemented
4. acceptanceCriteria: Array of testable criteria
5. tags: Array of routing tags (e.g., ["security", "api"])
6. dependencies: Array of story IDs this depends on (e.g., ["US-001"])
7. complexity: "simple" | "medium" | "complex" | "expert"
8. contextFiles: Array of file paths to inject into agent prompt before execution
9. reasoning: Why this complexity level
10. estimatedLOC: Estimated lines of code to change
11. risks: Array of implementation risks
12. testStrategy: "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite"
13. noTestJustification: string (REQUIRED when testStrategy is "no-test" — explain why tests are unnecessary)

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}

${GROUPING_RULES}

Consider:
1. Does infrastructure exist? (e.g., "add caching" when no cache layer exists = complex)
2. How many files will be touched?
3. Are there cross-cutting concerns (auth, validation, error handling)?
4. Does it require new dependencies or architectural decisions?`;

function buildPlanModeInstructions(targetStoryId: string, maxAcCount: number | null | undefined): string {
  const acConstraint =
    maxAcCount != null
      ? `\n## Acceptance Criteria Constraint\n\nEvery sub-story must have at most ${maxAcCount} acceptance criteria. If a story would exceed this limit, split it into additional sub-stories instead of adding more ACs.`
      : "";

  return `Decompose the target story (${targetStoryId}) into smaller, implementable sub-stories.

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}

${GROUPING_RULES}${acConstraint}`;
}

/** Narrowed input for synchronous decompose prompt building (used by decomposeOp). */
export interface DecomposePromptInput {
  specContent: string;
  codebaseContext: string;
  targetStory?: import("../../prd/types").UserStory;
  siblings?: import("../../prd/types").UserStory[];
  maxAcCount?: number | null;
}

/**
 * Build a decompose prompt synchronously (used by decomposeOp.build()).
 *
 * Functionally identical to buildDecomposePromptAsync — all inner operations
 * are synchronous (OneShotPromptBuilder.build() returns a string, no I/O).
 */
export function buildDecomposePromptSync(input: DecomposePromptInput): string {
  if (input.targetStory) {
    return buildPlanModePromptSync(input);
  }
  return buildSpecModePromptSync(input);
}

/**
 * Build a decompose prompt using OneShotPromptBuilder.
 *
 * Dispatches to plan-mode or spec-mode depending on options.targetStory.
 */
export async function buildDecomposePromptAsync(options: DecomposeOptions): Promise<string> {
  if (options.targetStory) {
    return buildPlanModePrompt(options);
  }
  return buildSpecModePrompt(options);
}

function buildPlanModePromptSync(input: DecomposePromptInput): string {
  // biome-ignore lint/style/noNonNullAssertion: guarded by caller (input.targetStory is defined)
  const targetStory = input.targetStory!;
  const siblings = input.siblings ?? [];
  const instructions = buildPlanModeInstructions(targetStory.id, input.maxAcCount ?? null);

  let builder = OneShotPromptBuilder.for("decomposer")
    .instructions(instructions)
    .inputData("Target Story", JSON.stringify(targetStory, null, 2))
    .inputData("Codebase Context", input.codebaseContext);

  if (siblings.length > 0) {
    const siblingsSummary = siblings.map((s) => `- ${s.id}: ${s.title}`).join("\n");
    builder = builder.inputData("Sibling Stories", siblingsSummary);
  }

  return builder.jsonSchema(DECOMPOSE_PLAN_SCHEMA).build();
}

function buildSpecModePromptSync(input: DecomposePromptInput): string {
  return OneShotPromptBuilder.for("decomposer")
    .instructions(SPEC_DECOMPOSE_INSTRUCTIONS)
    .inputData("Codebase Context", input.codebaseContext)
    .inputData("Feature Specification", input.specContent)
    .jsonSchema(DECOMPOSE_SPEC_SCHEMA)
    .build();
}

async function buildPlanModePrompt(options: DecomposeOptions): Promise<string> {
  // biome-ignore lint/style/noNonNullAssertion: guarded by caller (options.targetStory is defined)
  const targetStory = options.targetStory!;
  const siblings = options.siblings ?? [];
  const maxAcCount = options.config?.precheck?.storySizeGate?.maxAcCount ?? null;
  const instructions = buildPlanModeInstructions(targetStory.id, maxAcCount);

  let builder = OneShotPromptBuilder.for("decomposer")
    .instructions(instructions)
    .inputData("Target Story", JSON.stringify(targetStory, null, 2))
    .inputData("Codebase Context", options.codebaseContext);

  if (siblings.length > 0) {
    const siblingsSummary = siblings.map((s) => `- ${s.id}: ${s.title}`).join("\n");
    builder = builder.inputData("Sibling Stories", siblingsSummary);
  }

  return builder.jsonSchema(DECOMPOSE_PLAN_SCHEMA).build();
}

async function buildSpecModePrompt(options: DecomposeOptions): Promise<string> {
  return OneShotPromptBuilder.for("decomposer")
    .instructions(SPEC_DECOMPOSE_INSTRUCTIONS)
    .inputData("Codebase Context", options.codebaseContext)
    .inputData("Feature Specification", options.specContent)
    .jsonSchema(DECOMPOSE_SPEC_SCHEMA)
    .build();
}
