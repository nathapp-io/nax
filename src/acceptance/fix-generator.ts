/**
 * Fix Story Generator
 *
 * Generates fix stories from failed acceptance criteria.
 * Groups related failures into batched fix stories (D1),
 * inherits workdir from related stories (D4),
 * and enriches descriptions with test context (P1-A).
 */

import type { AgentAdapter } from "../agents/types";
import type { ModelDef, NaxConfig } from "../config/schema";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd/types";

const MAX_FIX_STORIES = 8;

/**
 * A fix story generated from one or more failed acceptance criteria.
 *
 * Fix stories are appended to the PRD and executed through the normal pipeline.
 *
 * @example
 * ```ts
 * const fixStory: FixStory = {
 *   id: "US-FIX-001",
 *   title: "Fix: AC-2, AC-5 — TTL expiry timing",
 *   failedAC: "AC-2",
 *   batchedACs: ["AC-2", "AC-5"],
 *   testOutput: "Expected undefined, got 'value'",
 *   relatedStories: ["US-002"],
 *   description: "Update TTL implementation to properly expire entries...",
 *   testFilePath: "/repo/nax/features/cache/acceptance.test.ts",
 * };
 * ```
 */
export interface FixStory {
  /** Story ID (e.g., "US-FIX-001") */
  id: string;
  /** Story title */
  title: string;
  /** Primary AC (first in batch — kept for backward compat) */
  failedAC: string;
  /** All ACs included in this fix story batch (D1) */
  batchedACs: string[];
  /** Test output showing actual vs expected */
  testOutput: string;
  /** Original stories that built this functionality */
  relatedStories: string[];
  /** LLM-generated fix description */
  description: string;
  /** Path to acceptance test file (P1-A) */
  testFilePath?: string;
  /** Workdir inherited from related story (D4) */
  workdir?: string;
}

/**
 * Options for generating fix stories.
 *
 * @example
 * ```ts
 * const options: GenerateFixStoriesOptions = {
 *   failedACs: ["AC-2", "AC-5"],
 *   testOutput: "...",
 *   prd: loadedPRD,
 *   specContent: "# Feature...",
 *   workdir: "/project",
 *   modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
 *   testFilePath: "/project/nax/features/cache/acceptance.test.ts",
 * };
 * ```
 */
export interface GenerateFixStoriesOptions {
  /** Failed AC identifiers */
  failedACs: string[];
  /** Full test output from bun test */
  testOutput: string;
  /** Current PRD with all stories */
  prd: PRD;
  /** Original spec.md content */
  specContent: string;
  /** Working directory */
  workdir: string;
  /** Model definition for LLM call */
  modelDef: ModelDef;
  /** Global config */
  config: NaxConfig;
  /** Path to acceptance test file for agent context (P1-A) */
  testFilePath?: string;
}

/**
 * Map failed ACs to related stories.
 *
 * Uses heuristics to find which stories likely implemented the failed AC:
 * 1. Stories with matching AC in acceptanceCriteria
 * 2. Recently completed stories (if no better match)
 *
 * @param failedAC - Failed AC identifier (e.g., "AC-2")
 * @param prd - Current PRD
 * @returns Array of related story IDs
 *
 * @example
 * ```ts
 * const related = findRelatedStories("AC-2", prd);
 * // Returns: ["US-002", "US-005"]
 * ```
 */
export function findRelatedStories(failedAC: string, prd: PRD): string[] {
  const relatedStoryIds: string[] = [];

  // Strategy 1: Find stories with this AC in their acceptanceCriteria
  for (const story of prd.userStories) {
    for (const ac of story.acceptanceCriteria) {
      if (ac.includes(failedAC)) {
        relatedStoryIds.push(story.id);
        break;
      }
    }
  }

  // If we found stories with matching AC, return those
  if (relatedStoryIds.length > 0) {
    return relatedStoryIds;
  }

  // Strategy 2: Return all passed stories (fallback)
  // The LLM will figure out which code is relevant
  const passedStories = prd.userStories.filter((s) => s.status === "passed").map((s) => s.id);

  return passedStories.slice(0, 5); // Limit to 5 most recent
}

/**
 * Group failed ACs by their related stories (D1: batching).
 *
 * ACs sharing the same related story set are merged into one fix story.
 * Hard cap: max 8 groups — smallest groups are merged when exceeded.
 *
 * @param failedACs - Array of failed AC identifiers
 * @param prd - Current PRD
 * @returns Array of groups, each with ACs and their shared related stories
 *
 * @example
 * ```ts
 * const groups = groupACsByRelatedStories(["AC-1", "AC-2", "AC-8"], prd);
 * // Returns: [{ acs: ["AC-1", "AC-2"], relatedStories: ["US-003"] }, ...]
 * ```
 */
export function groupACsByRelatedStories(
  failedACs: string[],
  prd: PRD,
): Array<{ acs: string[]; relatedStories: string[] }> {
  // Map each AC to its related stories key (sorted, joined for grouping)
  const groups = new Map<string, { acs: string[]; relatedStories: string[] }>();

  for (const ac of failedACs) {
    const related = findRelatedStories(ac, prd);
    const key = [...related].sort().join(",");
    if (!groups.has(key)) {
      groups.set(key, { acs: [], relatedStories: related });
    }
    groups.get(key)?.acs.push(ac);
  }

  const result = Array.from(groups.values());

  // Hard cap: merge smallest groups until at most MAX_FIX_STORIES remain
  while (result.length > MAX_FIX_STORIES) {
    result.sort((a, b) => a.acs.length - b.acs.length);
    const smallest = result.shift();
    if (!smallest) break;
    result[0].acs.push(...smallest.acs);
    for (const s of smallest.relatedStories) {
      if (!result[0].relatedStories.includes(s)) {
        result[0].relatedStories.push(s);
      }
    }
  }

  return result;
}

/**
 * Build LLM prompt for generating a batched fix story.
 *
 * @param batchedACs - Batch of failed AC identifiers
 * @param acTextMap - Map of AC ID to text from spec
 * @param testOutput - Test failure output
 * @param relatedStories - Related story IDs
 * @param prd - Current PRD
 * @param testFilePath - Path to acceptance test file (P1-A)
 * @returns Formatted prompt string
 */
export function buildFixPrompt(
  batchedACs: string[],
  acTextMap: Record<string, string>,
  testOutput: string,
  relatedStories: string[],
  prd: PRD,
  testFilePath?: string,
): string {
  const acList = batchedACs.map((ac) => `${ac}: ${acTextMap[ac] || "No description available"}`).join("\n");

  const relatedStoriesText = relatedStories
    .map((id) => {
      const story = prd.userStories.find((s) => s.id === id);
      if (!story) return "";
      return `${story.id}: ${story.title}\n  ${story.description}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const testFileSection = testFilePath
    ? `\nACCEPTANCE TEST FILE: ${testFilePath}\n(Read this file first to understand what each test expects)\n`
    : "";

  return `You are a debugging expert. Feature acceptance tests have failed.${testFileSection}
FAILED ACCEPTANCE CRITERIA (${batchedACs.length} total):
${acList}

TEST FAILURE OUTPUT:
${testOutput.slice(0, 2000)}

RELATED STORIES (implemented this functionality):
${relatedStoriesText}

Your task: Generate a fix description that will make these acceptance tests pass.

Requirements:
1. Read the acceptance test file first to understand what each failing test expects
2. Identify the root cause based on the test failure output
3. Find and fix the relevant implementation code (do NOT modify the test file)
4. Write a clear, actionable fix description (2-4 sentences)
5. Reference the relevant story IDs if needed

Respond with ONLY the fix description (no JSON, no markdown, just the description text).`;
}

/**
 * Generate fix stories from failed acceptance criteria.
 *
 * Groups ACs by related stories (D1), generates one fix story per group,
 * and caps at MAX_FIX_STORIES to prevent runaway cost.
 *
 * @param adapter - Agent adapter for LLM calls
 * @param options - Generation options
 * @returns Array of generated fix stories
 *
 * @example
 * ```ts
 * const adapter = new ClaudeCodeAdapter();
 * const fixStories = await generateFixStories(adapter, {
 *   failedACs: ["AC-2", "AC-5"],
 *   testOutput: "...",
 *   prd: loadedPRD,
 *   specContent: "...",
 *   workdir: "/project",
 *   modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
 *   testFilePath: "/project/nax/features/cache/acceptance.test.ts",
 * });
 * ```
 */
export async function generateFixStories(
  adapter: AgentAdapter,
  options: GenerateFixStoriesOptions,
): Promise<FixStory[]> {
  const { failedACs, testOutput, prd, specContent, modelDef, testFilePath } = options;
  const logger = getLogger();

  const acTextMap = parseACTextFromSpec(specContent);

  // D1: Group ACs by related stories — batch related failures into one fix story
  const groups = groupACsByRelatedStories(failedACs, prd);
  const fixStories: FixStory[] = [];

  for (let i = 0; i < groups.length; i++) {
    const { acs: batchedACs, relatedStories } = groups[i];

    if (relatedStories.length === 0) {
      logger.warn("acceptance", "[WARN] No related stories found for AC group — skipping", { batchedACs });
      continue;
    }

    logger.info("acceptance", "Generating fix for AC group", { batchedACs });

    const prompt = buildFixPrompt(batchedACs, acTextMap, testOutput, relatedStories, prd, testFilePath);

    // D4: inherit workdir from first related story that has one set
    const relatedStory = prd.userStories.find((s) => relatedStories.includes(s.id) && s.workdir);
    const workdir = relatedStory?.workdir;

    try {
      const fixDescription = await adapter.complete(prompt, {
        model: modelDef.model,
        config: options.config,
        featureName: options.prd.feature,
        workdir: options.workdir,
        sessionRole: "fix-gen",
      });

      fixStories.push({
        id: `US-FIX-${String(i + 1).padStart(3, "0")}`,
        title: `Fix: ${batchedACs.join(", ")} — ${(acTextMap[batchedACs[0]] || "").slice(0, 40)}`,
        failedAC: batchedACs[0],
        batchedACs,
        testOutput,
        relatedStories,
        description: fixDescription,
        testFilePath,
        workdir,
      });

      logger.info("acceptance", "[OK] Generated fix story", { storyId: fixStories[fixStories.length - 1].id });
    } catch (error) {
      logger.warn("acceptance", "[WARN] Error generating fix", {
        batchedACs,
        error: (error as Error).message,
      });
      fixStories.push({
        id: `US-FIX-${String(i + 1).padStart(3, "0")}`,
        title: `Fix: ${batchedACs.join(", ")}`,
        failedAC: batchedACs[0],
        batchedACs,
        testOutput,
        relatedStories,
        description: `Fix the implementation to make ${batchedACs.join(", ")} pass. Related stories: ${relatedStories.join(", ")}.`,
        testFilePath,
        workdir,
      });
    }
  }

  return fixStories;
}

/**
 * Parse AC text from spec.md content.
 *
 * Extracts AC-N lines and maps them to their text descriptions.
 *
 * @param specContent - Full spec.md content
 * @returns Map of AC ID to text (e.g., { "AC-2": "TTL expiry" })
 *
 * @example
 * ```ts
 * const spec = "- AC-1: handles empty input\n- AC-2: TTL expiry";
 * const map = parseACTextFromSpec(spec);
 * // Returns: { "AC-1": "handles empty input", "AC-2": "TTL expiry" }
 * ```
 */
export function parseACTextFromSpec(specContent: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = specContent.split("\n");

  for (const line of lines) {
    const acMatch = line.match(/^\s*-?\s*(?:\[.\])?\s*(AC-\d+):\s*(.+)$/i);
    if (acMatch) {
      const id = acMatch[1].toUpperCase();
      const text = acMatch[2].trim();
      map[id] = text;
    }
  }

  return map;
}

/**
 * Convert a FixStory to a UserStory for PRD insertion.
 *
 * Enriches the description with acceptance test context (P1-A):
 * - Test file path
 * - Batched AC list
 * - Truncated failure output
 * - Instructions to fix implementation, not the test
 *
 * Inherits workdir from the fix story (D4).
 *
 * @param fixStory - Fix story to convert
 * @returns UserStory object ready for PRD
 *
 * @example
 * ```ts
 * const fixStory: FixStory = { id: "US-FIX-001", batchedACs: ["AC-2"], ... };
 * const userStory = convertFixStoryToUserStory(fixStory);
 * prd.userStories.push(userStory);
 * ```
 */
export function convertFixStoryToUserStory(fixStory: FixStory): UserStory {
  const batchedACs = fixStory.batchedACs ?? [fixStory.failedAC];
  const acList = batchedACs.join(", ");
  const truncatedOutput = fixStory.testOutput.slice(0, 1000);
  const testFilePath = fixStory.testFilePath ?? "acceptance.test.ts";

  const enrichedDescription = [
    fixStory.description,
    "",
    `ACCEPTANCE TEST FILE: ${testFilePath}`,
    `FAILED ACCEPTANCE CRITERIA: ${acList}`,
    "",
    "TEST FAILURE OUTPUT:",
    truncatedOutput,
    "",
    "Instructions: Read the acceptance test file first to understand what each failing test expects.",
    "Then find the relevant source code and fix the implementation.",
    "Do NOT modify the test file.",
  ].join("\n");

  return {
    id: fixStory.id,
    title: fixStory.title,
    description: enrichedDescription,
    acceptanceCriteria: batchedACs.map((ac) => `Fix ${ac}`),
    tags: ["fix", "acceptance-failure"],
    dependencies: fixStory.relatedStories,
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: [],
    workdir: fixStory.workdir,
  };
}
