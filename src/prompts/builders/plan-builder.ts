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

import type { AgentRoutingProfile, ProjectProfile } from "@/config";
import {
  COMPLEXITY_GUIDE,
  DESCRIPTION_QUALITY_RULES,
  GROUPING_RULES,
  SPEC_ANCHOR_RULES,
  TEST_STRATEGY_GUIDE,
  getAcQualityRules,
} from "@/config";
import type { ComposeInput } from "../compose";
import { OneShotPromptBuilder } from "./one-shot-builder";

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

/**
 * Shared `contextFiles` (read) vs `expectedFiles` (create) rule. Both the main
 * `build()` and the cited `buildDraft()` prompts emit this so the read/create
 * split stays identical across plan modes. Created files route to
 * `expectedFiles` (a post-run asset gate), never to `contextFiles`.
 */
const CONTEXT_VS_EXPECTED_FILES_RULE = `**\`contextFiles\` rule — files readable when this story runs.** List paths that already exist in the repo today, PLUS any file an UPSTREAM dependency story creates (it does not exist now but will exist by the time this story runs, because dependencies execute first). The pipeline verifies every \`contextFiles\` entry against the filesystem; a path that exists neither on disk nor in an upstream dependency's outputs is treated as a missing-context warning.

**\`expectedFiles\` rule — files THIS story CREATES.** List every NEW file this story authors (relative paths). A file this story creates belongs here, NEVER in \`contextFiles\` — these are the story's outputs, not files to read first. A file created by an upstream dependency and only read/modified here belongs in \`contextFiles\`, NOT here (this story does not author it). A single path may appear in \`contextFiles\` (an existing sibling to mirror) AND \`expectedFiles\` (the new file itself), but the same path must never be in both.`;

/** Output-schema line for the `expectedFiles` field, shared by both prompts. */
const EXPECTED_FILES_SCHEMA_FIELD = `"expectedFiles": ["string — NEW files this story creates (relative paths, omit if none)"],`;

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
  /** Optional agent routing profiles — when present, injects capability cards and agentProfileId schema field. */
  readonly profiles?: AgentRoutingProfile[];
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
  buildRefineContinuation(outputFilePath: string, specGuard = false): string {
    const specGuardItems = specGuard
      ? `
#### orphan-acs
Every acceptance criterion in the PRD must trace back to a requirement stated in the spec. An AC that introduces scope the spec never mentions — new enum values, new status codes, new config keys, extra validation rules, invented helper behaviour — is scope bleed from candidate-PRD merging. Delete it, or reduce it to exactly what the spec says. **\`suggestedCriteria\` entries are exempt from this rule** — they are intentionally out-of-spec edge cases and must be preserved unchanged.

#### no-behavior-degradation
No acceptance criterion may use a deprecated verification tag (\`[grep]\`, \`[file]\`, \`[verbatim]\`) or contain a shell-command pattern (\`grep -\`, \`wc\`, \`|\` inside a backtick span). These signal a file-content check that the agent cannot implement as a runtime test. Rewrite any such AC as a behavioural assertion: what the function returns, throws, or emits — not what the source file contains.`
      : "";

    return `You are in the second turn of a refine pass. Assume this draft has flaws, and audit it adversarially before you trust it.

Review the draft with a strict self-audit mindset. Re-read the codebase context and compare the PRD against it. Focus only on the issues below, then rewrite the PRD if needed.

#### spec-ac-preservation
Enumerate every acceptance criterion the spec states. Confirm each one appears in some story's acceptanceCriteria — never drop a spec AC during this audit. If an AC looks unsupported by the current codebase, keep it: the story may be adding that capability. Any AC the spec tags \`[verbatim]\` MUST appear character-for-character in an acceptanceCriteria entry — preserve every backtick-quoted command, file path, regex, and count exactly. If a \`[verbatim]\` AC is missing or altered, restore it verbatim.

#### ac-testable
For each acceptance criterion, ask whether the assertion is observable through a return value, exception, log output, file content, or state change. If any AC is not directly testable, rewrite it so it is observable.

#### failure-modes-considered
For each story, confirm there is at least one negative-path acceptance criterion. If a story has no failure case, add one.

#### description-ac-contradiction
Check whether any sentence in any description contradicts an acceptance criterion in the same story. If there is a contradiction, fix the description so it matches the ACs.

#### codebase-fit
For each story, verify:
1. Proposed files, helpers, tests, dependencies, and implementation notes match the codebase context. Remove invented helpers, files, call sites, or dependencies unless the change clearly requires creating them.
2. Each acceptance criterion's semantic meaning matches the spec's actual interface and data flow. Criteria that assert incorrect parameter semantics, wrong data flow, or behavior that contradicts the spec must be corrected. Never delete an AC that restates a spec AC — correct its wording to match the spec instead. Cross-check each AC against the spec's interface definitions, pseudocode, and design notes.

#### contextfiles-spec-alignment
For each story, compare contextFiles against files the spec explicitly lists as context (e.g., in "Context Files" sections). Ensure the most critical spec-recommended files are included, up to the 5-file limit. If a spec-recommended file is absent, add it (removing the least critical one if already at 5). Files the story will CREATE must not appear here.

#### dependency-minimization
Remove unnecessary dependencies between stories. A dependency should exist only if the downstream story truly cannot be implemented or validated first. Also verify that every story ID referenced in any "dependencies" array exists in this PRD — remove references to non-existent story IDs.

#### routing-realism
Re-check routing.complexity and routing.testStrategy against the current codebase shape. Prefer the lightest realistic routing. Do not mark stories as "complex" or choose a heavier test strategy unless the codebase evidence requires it. Also verify routing.reasoning is substantive — a generic value like "validated from LLM output" must be replaced with one sentence explaining why this specific complexity and strategy were chosen for this story.

#### regression-coverage
If a story changes existing behavior, extracts a shared helper, extends an existing function signature, or replaces a warning/stub path with real behavior, ensure there is at least one acceptance criterion protecting backward compatibility or proving the old placeholder behavior is gone.

#### scope-consistency
Check each story's title, description, scope, contextFiles, and acceptance criteria for internal consistency. If the story says a file or command is in scope anywhere else, do not list it as out of scope. If the title or acceptance criteria clearly include CLI, output, tests, or helper extraction work, the Scope section must reflect that accurately.${specGuardItems}

Write the revised PRD to this file path: ${outputFilePath}
Do not output the PRD in chat. After writing the file, reply with a brief text confirmation only.`;
  }

  /**
   * Spec-drift repair prompt — conditional fourth turn in refine mode (specGuard only).
   *
   * Fired when the deterministic spec-drift check finds PRD ACs with deprecated
   * tags or shell-command patterns. Instructs the model to rewrite each flagged
   * AC as a runtime-testable behavioural assertion. `planRefineOp.verify` emits
   * the residual warning if violations remain after this turn.
   */
  buildSpecDriftRepair(
    violations: ReadonlyArray<{ storyId: string; acIndex: number; ac: string; reason: string }>,
    outputFilePath: string,
  ): string {
    const list = violations.map((v) => `- ${v.storyId} AC[${v.acIndex}] (${v.reason}): ${v.ac}`).join("\n");
    return `Your PRD contains acceptance criteria that cannot be implemented as runtime tests — they use deprecated verification tags or shell-command patterns that describe file-content checks rather than observable behaviour. These must be rewritten.

Flagged acceptance criteria:

${list}

For each one:
- Replace the AC with a behavioural assertion: what the function, method, or CLI command returns, throws, logs, or emits — not what the source file contains.
- Remove any deprecated tags (\`[grep]\`, \`[file]\`, \`[verbatim]\`) from the leading tag group. Replace with \`[unit]\`, \`[integration]\`, or \`[cli]\` as appropriate.
- Remove any shell-command patterns (\`grep -\`, \`wc\`, pipe \`|\` inside backticks). Express the same invariant as an assertion on the runtime value.
- Do not remove or weaken acceptance criteria that are already correct.

Write the corrected PRD to this file path: ${outputFilePath}
Do not output the PRD in chat. After writing the file, reply with a brief text confirmation only.`;
  }

  /**
   * Verbatim-repair prompt — conditional third turn in refine mode.
   *
   * Fired only when the deterministic `[verbatim]` fidelity check finds spec ACs
   * the rewritten PRD dropped or altered. Instructs the model to restore each
   * one character-for-character into the most relevant story's acceptance
   * criteria. This is the same-session self-heal; `planRefineOp.verify` emits the
   * residual-drift warning if the repair still misses (the plan still continues).
   */
  buildVerbatimRepair(missingAcs: readonly string[], outputFilePath: string): string {
    const list = missingAcs.map((ac) => `- ${ac}`).join("\n");
    return `Your revised PRD dropped or altered acceptance criteria the spec marked \`[verbatim]\`. These are load-bearing executable checks (greps, file-existence checks, regex/count assertions, or architectural invariants) and MUST survive character-for-character — paraphrasing destroys the verification mechanism.

The following \`[verbatim]\` spec acceptance criteria are missing or altered in the PRD:

${list}

For each one:
- Add it to the \`acceptanceCriteria\` array of the single most relevant user story.
- Preserve every backtick-quoted command, file path, regex, and count exactly as written in the spec. Do not paraphrase, retag, split, or move them into a description.
- Do not remove or weaken any acceptance criteria that are already correct.

Write the corrected PRD to this file path: ${outputFilePath}
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
    profiles?: AgentRoutingProfile[],
  ): PlanningPromptParts {
    const cards = OneShotPromptBuilder.agentCapabilityCards(profiles ?? []);
    const agentProfilesSection =
      cards.length > 0 ? `\n\n${cards}\n\n${OneShotPromptBuilder.agentProfileInstruction()}` : "";

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

For each story, set "contextFiles" to the key source files the agent should read before implementing (max 5 per story). Use your Step 2 analysis to identify the most relevant files. Leave empty for greenfield stories with no existing files to reference. Set "expectedFiles" to the NEW files the story creates.

${CONTEXT_VS_EXPECTED_FILES_RULE}${agentProfilesSection}`;

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
      "contextFiles": ["string — EXISTING source files the agent should read (max 5, relative paths)"],
      ${EXPECTED_FILES_SCHEMA_FIELD}
      "tags": ["string — routing tags, e.g. feature, security, api"],
      "dependencies": ["string — story IDs this story depends on"],${workdirField}
      "status": "pending",
      "passes": false,
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "noTestJustification": "string — REQUIRED when testStrategy is no-test, explains why tests are unnecessary",
        "reasoning": "string — brief classification rationale"${cards.length > 0 ? `,\n        "agentProfileId": "string — optional, the id of the best-matching profile from the Agent Profiles table above; omit if none fits"` : ""}
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

    const cards = OneShotPromptBuilder.agentCapabilityCards(input.profiles ?? []);
    const agentProfilesSection =
      cards.length > 0 ? `\n\n${cards}\n\n${OneShotPromptBuilder.agentProfileInstruction()}` : "";

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

For each story, set "contextFiles" to the key source files the implementer should read before starting (max 5 per story). Cite manifest factIds where relevant. Set "expectedFiles" to the NEW files the story creates.

${CONTEXT_VS_EXPECTED_FILES_RULE}${agentProfilesSection}

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
      "contextFiles": ["string — EXISTING relative paths the implementer should read (max 5)"],
      ${EXPECTED_FILES_SCHEMA_FIELD}
      "tags": ["string"],
      "dependencies": ["string — story IDs this story depends on"],${workdirField}
      "routing": {
        "complexity": "simple | medium | complex | expert",
        "testStrategy": "no-test | tdd-simple | three-session-tdd-lite | three-session-tdd | test-after",
        "reasoning": "string — brief classification rationale"${cards.length > 0 ? `,\n        "agentProfileId": "string — optional, the id of the best-matching profile from the Agent Profiles table above; omit if none fits"` : ""}
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
