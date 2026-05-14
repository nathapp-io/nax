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

import type { ProjectProfile } from "@/config";
import {
  COMPLEXITY_GUIDE,
  DESCRIPTION_QUALITY_RULES,
  GROUPING_RULES,
  SPEC_ANCHOR_RULES,
  TEST_STRATEGY_GUIDE,
  getAcQualityRules,
} from "@/config";
import type { ComposeInput } from "../compose";

// ─── Shared rule injection ────────────────────────────────────────────────────

/**
 * Build the shared quality-rule block used by both `build()` (single mode)
 * and `buildDraft()` (pipeline mode). Centralizing prevents drift where one
 * prompt gets a new rule and the other doesn't.
 *
 * `specContent` controls whether SPEC_ANCHOR_RULES is injected — empty spec =
 * no anchor rules. `projectProfile` lets AC quality rules emit language- and
 * project-type-specific examples.
 */
function buildSharedQualityRules(specContent: string, projectProfile?: ProjectProfile): string {
  const specAnchorSection = specContent.trim() ? `\n\n${SPEC_ANCHOR_RULES}` : "";
  return `${GROUPING_RULES}

${DESCRIPTION_QUALITY_RULES}

${getAcQualityRules(projectProfile)}${specAnchorSection}

${COMPLEXITY_GUIDE}

${TEST_STRATEGY_GUIDE}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Revision finding from a verifier — passed to buildDraft when revising a rejected draft. */
export interface PlanDraftVerifierFinding {
  readonly checklistItem: string;
  readonly severity: string;
  readonly message?: string;
  [key: string]: unknown;
}

/** Input for PlanPromptBuilder.buildDraft(). */
export interface PlanDraftBuildInput {
  readonly manifestSection: string;
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly feature: string;
  readonly branchName: string;
  readonly citationThreshold: number;
  readonly revisionFindings?: readonly PlanDraftVerifierFinding[];
  /** Optional monorepo packages — when present, draft prompt injects monorepo hint + workdir field. */
  readonly packages?: readonly string[];
  /** Optional per-package tech-stack summaries (only used when packages is non-empty). */
  readonly packageDetails?: readonly PackageSummary[];
  /** Optional project profile for language- and project-type-aware AC examples. */
  readonly projectProfile?: ProjectProfile;
}

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

  /**
   * JSON repair prompt — instructs the agent to fix invalid JSON in the PRD.
   * Includes the parse error so the agent can understand what failed.
   */
  static jsonRepair(_attempt: number, parseError: string): string {
    return `Your previous response was not valid JSON and could not be parsed.

Parse error: ${parseError}

Please re-write the complete PRD JSON from scratch. The JSON must be valid and complete — do not truncate it.

Write the complete PRD JSON to the output file path specified in your instructions, then reply with a brief confirmation.`;
  }

  /**
   * Schema repair prompt — instructs the agent to fix a PRD that failed schema validation.
   */
  static schemaRepair(message: string): string {
    return `Your previous response was valid JSON but failed PRD schema validation.

Schema error: ${message}

Required field names (do not rename): \`userStories\` (array), each story must have \`description\` (not "story"), \`acceptanceCriteria\` (string array, not "ac"), and \`routing.complexity\` ("simple" | "medium" | "complex" | "expert").

Please re-write the complete PRD JSON from scratch conforming to the required schema. Output ONLY the JSON object. Do not include markdown fences or explanation.`;
  }

  /**
   * Citation repair prompt — instructs the agent to add citations from the manifest.
   */
  static citationRepair(message: string): string {
    return `Your previous response did not meet the citation requirement.

Citation issue: ${message}

Every concrete claim referencing existing code must cite a fact ID from the manifest using [F-NNN] or [S-NNN] notation. For example: "The authentication module [F-001] implements..." or "Users have email addresses [S-002]."

Please re-write the complete PRD JSON, ensuring every factual claim is cited with the appropriate manifest fact ID. Uncited claims will cause rejection.

Output ONLY the JSON object. Do not include markdown fences or explanation.`;
  }

  /**
   * Refine continuation prompt — second turn in refine mode.
   *
   * This prompt is intentionally adversarial and focuses the model on
   * observable ACs, negative-path coverage, and description/AC consistency.
   * The model must write the revised PRD to disk, then reply with a brief
   * confirmation only.
   */
  buildRefineContinuation(outputFilePath: string): string {
    return `You are in the second turn of a refine pass. Assume this draft has flaws, and audit it adversarially before you trust it.

Review the draft with a strict self-audit mindset. Re-read the codebase context and compare the PRD against it. Focus only on the issues below, then rewrite the PRD if needed.

#### ac-testable
For each acceptance criterion, ask whether the assertion is observable through a return value, exception, log output, file content, or state change. If any AC is not directly testable, rewrite it so it is observable.

#### failure-modes-considered
For each story, confirm there is at least one negative-path acceptance criterion. If a story has no failure case, add one.

#### description-ac-contradiction
Check whether any sentence in any description contradicts an acceptance criterion in the same story. If there is a contradiction, fix the description so it matches the ACs.

#### codebase-fit
For each story, verify that the proposed files, helpers, tests, dependencies, and implementation notes match the codebase context. Remove invented helpers, files, call sites, or dependencies unless the change clearly requires creating them.

#### dependency-minimization
Remove unnecessary dependencies between stories. A dependency should exist only if the downstream story truly cannot be implemented or validated first.

#### routing-realism
Re-check routing.complexity and routing.testStrategy against the current codebase shape. Prefer the lightest realistic routing. Do not mark stories as "complex" or choose a heavier test strategy unless the codebase evidence requires it.

#### regression-coverage
If a story changes existing behavior, extracts a shared helper, extends an existing function signature, or replaces a warning/stub path with real behavior, ensure there is at least one acceptance criterion protecting backward compatibility or proving the old placeholder behavior is gone.

#### scope-consistency
Check each story's title, description, scope, contextFiles, and acceptance criteria for internal consistency. If the story says a file or command is in scope anywhere else, do not list it as out of scope. If the title or acceptance criteria clearly include CLI, output, tests, or helper extraction work, the Scope section must reflect that accurately.

Write the revised PRD to this file path: ${outputFilePath}
Do not output the PRD in chat. After writing the file, reply with a brief text confirmation only.`;
  }

  build(
    specContent: string,
    codebaseContext: string,
    outputFilePath?: string,
    packages?: string[],
    packageDetails?: PackageSummary[],
    projectProfile?: ProjectProfile,
    proposers?: { fileReadAccess?: boolean; fileReadBudget?: number },
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

${buildFileReadInstruction(proposers)}

## Codebase Context

${codebaseContext}${monorepoHint}

## Step 3: Generate Implementation Stories

Based on your Step 2 analysis, create stories that produce CODE CHANGES.

${buildSharedQualityRules(specContent, projectProfile)}

For each story, set "contextFiles" to the key source files the agent should read before implementing (max 5 per story). Use your Step 2 analysis to identify the most relevant files. Leave empty for greenfield stories with no existing files to reference.

**\`contextFiles\` rule — existing files only.** Only list paths that already exist in the repo today. Files the story will CREATE belong in the description (under "Files touched" or "Approach"), never in contextFiles. The pipeline verifies every contextFiles entry against the filesystem; new-file paths placed here are treated as missing-context warnings and may block the plan.`;

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

  /**
   * Build the draft planning prompt for plan-draft op.
   * Includes spec content, manifest section, citation requirements, and
   * optional revision findings from a prior rejected draft.
   */
  buildDraft(input: PlanDraftBuildInput): ComposeInput {
    const role: ComposeInput["role"] = {
      id: "role",
      content:
        "You are a senior software architect generating a product requirements document (PRD) as JSON. Your intent is to produce a thorough, evidence-grounded plan.",
      overridable: false,
    };

    const revisionSection =
      input.revisionFindings && input.revisionFindings.length > 0
        ? `\n\n## Previous draft rejected for the following issues\n\n${input.revisionFindings
            .map((f) => `- [${f.severity.toUpperCase()}] ${f.checklistItem}: ${f.message ?? "(no detail)"}`)
            .join("\n")}\n\nFix all issues above before submitting the revised PRD.`
        : "";

    // Monorepo handling — mirror build() so cheap-pipeline gets the same context single mode has.
    const isMonorepo = input.packages && input.packages.length > 0;
    const packageDetailsArr = input.packageDetails && input.packageDetails.length > 0 ? [...input.packageDetails] : [];
    const packageDetailsSection = packageDetailsArr.length > 0 ? buildPackageDetailsSection(packageDetailsArr) : "";
    const monorepoHint =
      isMonorepo && input.packages
        ? `\n## Monorepo Context\n\nThis is a monorepo. Detected packages:\n${input.packages
            .map((p) => `- ${p}`)
            .join(
              "\n",
            )}\n${packageDetailsSection}\nFor each user story, set the "workdir" field to the relevant package path (e.g. "packages/api"). Stories that span the root should omit "workdir".`
        : "";

    const workdirField = isMonorepo
      ? `\n      "workdir": "string — optional, relative path to package (e.g. \\"packages/api\\"). Omit for root-level stories.",`
      : "";

    const suggestedCriteriaField = input.specContent.trim()
      ? `\n      "suggestedCriteria": ["string — optional. Behavioral edge cases or negative paths you identified that are NOT in the spec. Plain assertions only — observable outputs, return values, state changes, or error conditions. No implementation details or vague descriptions. Omit this field if empty."],`
      : "";

    const task: ComposeInput["task"] = {
      id: "task",
      content: `You are drafting a PRD for the following feature: **${input.feature}** (branch: ${input.branchName}). Your intent is to produce a thorough, evidence-grounded implementation plan.

## Spec

${input.specContent}

## Codebase Context

${input.codebaseContext}${monorepoHint}

## Manifest

${input.manifestSection}

## Citation Requirement

Every concrete claim referencing existing code must cite [F-NNN] or [S-NNN] from the manifest. The required citation rate is ${input.citationThreshold}. Uncited factual claims will cause rejection.${revisionSection}

## Story Generation Rules

${buildSharedQualityRules(input.specContent, input.projectProfile)}

For each story, set "contextFiles" to the key source files the implementer should read before starting (max 5 per story). Cite manifest factIds where relevant.

**\`contextFiles\` rule — existing files only.** Only list paths that already exist in the repo today (cited via manifest factIds where possible). Files the story will CREATE belong in the description (under "Files touched" or "Approach"), never in contextFiles. Uncited paths that do not exist on disk are flagged by the pipeline.

## Output Schema

Produce a JSON object with this exact structure. Field names are mandatory — do not rename them.

{
  "project": "string — project name",
  "feature": "string — feature name (copy from above)",
  "branchName": "string — git branch name",
  "userStories": [
    {
      "id": "string — e.g. US-001",
      "title": "string — concise story title",
      "description": "string — detailed description of what to implement",
      "acceptanceCriteria": ["string — behavioral criterion, format: 'When [X], then [Y]'. One assertion per item."],${suggestedCriteriaField}
      "contextFiles": ["string — relative paths the implementer should read (max 5)"],
      "tags": ["string"],
      "dependencies": ["string — story IDs this story depends on"],${workdirField}
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "reasoning": "string — brief classification rationale"
      }
    }
  ]
}

Output ONLY the JSON object. Do not include markdown fences or explanation.`,
      overridable: false,
    };

    return { role, task };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Build the file-read instruction block for the plan prompt.
 * When fileReadAccess is true, grants file-read permission with tool-access text.
 * Otherwise emits an empty string (tool access is already granted via the Source Roots section).
 */
function buildFileReadInstruction(proposers?: { fileReadAccess?: boolean; fileReadBudget?: number }): string {
  if (proposers?.fileReadAccess === true) {
    const budgetClause =
      proposers.fileReadBudget !== undefined ? ` You have up to ${proposers.fileReadBudget} file reads.` : "";
    return `**File Read Permission:** You may use file-read tools to verify spec claims against actual code.${budgetClause} Cite the resulting factId from the manifest, or include a verbatim excerpt with path:line-range for any claim derived from a file you read directly.`;
  }
  return "";
}

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
