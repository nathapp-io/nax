/**
 * PlanPromptBuilder — centralises all planning prompt construction.
 *
 * Migrated from: src/cli/plan.ts (buildPlanningPrompt)
 *
 * Owns the prompt sent to the LLM during `nax plan`. Returns a
 * PlanningPromptParts object so callers can split taskContext from
 * outputFormat when running debate/rebuttal rounds.
 *
 * Instance methods (not static) — required by Biome's noStaticOnlyClass rule.
 * Instantiation cost is negligible; builders are short-lived call-and-discard.
 */

import type { ProjectProfile } from "../../config/runtime-types";
import {
  COMPLEXITY_GUIDE,
  GROUPING_RULES,
  SPEC_ANCHOR_RULES,
  TEST_STRATEGY_GUIDE,
  getAcQualityRules,
} from "../../config/test-strategy";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Compact per-package summary for the planning prompt. */
export interface PackageSummary {
  path: string;
  name: string;
  runtime: string;
  framework: string;
  testRunner: string;
  keyDeps: string[];
}

/** The two separable parts of the planning prompt. */
export interface PlanningPromptParts {
  /** Spec, codebase context, and analysis instructions — safe to include in rebuttal rounds. */
  taskContext: string;
  /** Output schema and format directive — proposal round only; omitted from rebuttal prompts. */
  outputFormat: string;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export class PlanPromptBuilder {
  /**
   * Build the full planning prompt sent to the LLM.
   *
   * Structured as 3 explicit steps (ENH-006):
   *   Step 1: Understand the spec
   *   Step 2: Analyze codebase (existing) or architecture decisions (greenfield)
   *   Step 3: Generate implementation stories from analysis
   *
   * Includes:
   * - Spec content + codebase context
   * - Output schema with analysis + contextFiles fields
   * - Complexity + test strategy guides
   * - MW-007: Monorepo hint and package list when packages are detected
   */
  build(
    specContent: string,
    codebaseContext: string,
    outputFilePath?: string,
    packages?: string[],
    packageDetails?: PackageSummary[],
    projectProfile?: ProjectProfile,
  ): PlanningPromptParts {
    const isMonorepo = packages && packages.length > 0;
    const packageDetailsSection =
      packageDetails && packageDetails.length > 0 ? buildPackageDetailsSection(packageDetails) : "";
    const monorepoHint = isMonorepo
      ? `\n## Monorepo Context\n\nThis is a monorepo. Detected packages:\n${packages.map((p) => `- ${p}`).join("\n")}\n${packageDetailsSection}\nFor each user story, set the "workdir" field to the relevant package path (e.g. "packages/api"). Stories that span the root should omit "workdir".`
      : "";

    const workdirField = isMonorepo
      ? `\n      "workdir": "string — optional, relative path to package (e.g. \\"packages/api\\"). Omit for root-level stories.",`
      : "";

    const specAnchorSection = specContent.trim() ? `\n\n${SPEC_ANCHOR_RULES}` : "";

    const taskContext = `You are a senior software architect generating a product requirements document (PRD) as JSON.

## Step 1: Understand the Spec

Read the spec carefully. Identify the goal, scope, constraints, and what "done" looks like.

## Spec

${specContent}

## Step 2: Analyze

Examine the codebase context below.

If the codebase has existing code (refactoring, enhancement, bug fix):
- Which existing files need modification?
- Which files import from or depend on them?
- What tests cover the affected code?
- What are the risks (breaking changes, backward compatibility)?
- What is the migration path?

If this is a greenfield project (empty or minimal codebase):
- What is the target architecture?
- What are the key technical decisions (framework, patterns, conventions)?
- What should be built first (dependency order)?

Record ALL findings in the "analysis" field of the output JSON. This analysis is provided to every implementation agent as context — be thorough.

**Important:** The codebase context below contains file names and structure only — no file content. Do NOT assert specific line numbers. The implementer will read the actual files via contextFiles.

## Codebase Context

${codebaseContext}${monorepoHint}

## Step 3: Generate Implementation Stories

Based on your Step 2 analysis, create stories that produce CODE CHANGES.

${GROUPING_RULES}

${getAcQualityRules(projectProfile)}${specAnchorSection}

For each story, set "contextFiles" to the key source files the agent should read before implementing (max 5 per story). Use your Step 2 analysis to identify the most relevant files. Leave empty for greenfield stories with no existing files to reference.

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}`;

    const suggestedCriteriaField = specContent.trim()
      ? `\n      "suggestedCriteria": ["string — optional. Behavioral edge cases or negative paths you identified that are NOT in the spec. Plain assertions only — observable outputs, return values, state changes, or error conditions. No implementation details or vague descriptions. Omit this field if empty."],`
      : "";

    const outputDirective = outputFilePath
      ? `Write the PRD JSON directly to this file path: ${outputFilePath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`
      : "Output ONLY the JSON object. Do not wrap in markdown code blocks.";

    const outputFormat = `## Output Schema

Generate a JSON object with this exact structure (no markdown, no explanation — JSON only):

{
  "project": "string — project name",
  "feature": "string — feature name",
  "analysis": "string — your Step 2 analysis: key files, impact areas, risks, architecture decisions, migration notes. All implementation agents will receive this.",
  "branchName": "string — git branch (e.g. feat/my-feature)",
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp",
  "userStories": [
    {
      "id": "string — e.g. US-001",
      "title": "string — concise story title",
      "description": "string — detailed description of the story",
      "acceptanceCriteria": ["string — behavioral, testable criteria. Format: 'When [X], then [Y]'. One assertion per AC. Never include quality gates."],${suggestedCriteriaField}
      "contextFiles": ["string — key source files the agent should read (max 5, relative paths)"],
      "tags": ["string — routing tags, e.g. feature, security, api"],
      "dependencies": ["string — story IDs this story depends on"],${workdirField}
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test, explains why tests are unnecessary",
        "reasoning": "string — brief classification rationale"
      },
      "escalations": [],
      "attempts": 0
    }
  ]
}

${outputDirective}`;

    return { taskContext, outputFormat };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Render per-package summaries as a compact markdown table for the prompt.
 */
function buildPackageDetailsSection(details: PackageSummary[]): string {
  if (details.length === 0) return "";

  const rows = details.map((d) => {
    const stack = [d.framework, d.testRunner, ...d.keyDeps].filter(Boolean).join(", ") || "—";
    return `| \`${d.path}\` | ${d.name} | ${stack} |`;
  });

  return `\n## Package Tech Stacks\n\n| Path | Package | Stack |\n|:-----|:--------|:------|\n${rows.join("\n")}\n`;
}
