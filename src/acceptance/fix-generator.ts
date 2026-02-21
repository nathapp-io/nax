/**
 * Fix Story Generator
 *
 * Generates fix stories from failed acceptance criteria.
 * Maps failed ACs to related stories and creates targeted fix descriptions.
 */

import type { AgentAdapter } from "../agents/types";
import type { UserStory, PRD } from "../prd/types";
import type { ModelDef } from "../config/schema";
import { getLogger } from "../logger";

/**
 * A fix story generated from a failed acceptance criterion.
 *
 * Fix stories are appended to the PRD and executed through the normal pipeline.
 *
 * @example
 * ```ts
 * const fixStory: FixStory = {
 *   id: "US-FIX-001",
 *   title: "Fix: AC-2 TTL expiry timing",
 *   failedAC: "AC-2",
 *   testOutput: "Expected undefined, got 'value'",
 *   relatedStories: ["US-002"],
 *   description: "Update TTL implementation to properly expire entries...",
 * };
 * ```
 */
export interface FixStory {
  /** Story ID (e.g., "US-FIX-001") */
  id: string;
  /** Story title */
  title: string;
  /** Failed AC identifier (e.g., "AC-2") */
  failedAC: string;
  /** Test output showing actual vs expected */
  testOutput: string;
  /** Original stories that built this functionality */
  relatedStories: string[];
  /** LLM-generated fix description */
  description: string;
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
}

/**
 * Map failed ACs to related stories.
 *
 * Uses heuristics to find which stories likely implemented the failed AC:
 * 1. Stories with matching AC in acceptanceCriteria
 * 2. Stories with similar keywords in description
 * 3. Recently completed stories (if no better match)
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
  const passedStories = prd.userStories
    .filter((s) => s.status === "passed")
    .map((s) => s.id);

  return passedStories.slice(0, 5); // Limit to 5 most recent
}

/**
 * Build LLM prompt for generating a fix story.
 *
 * @param failedAC - Failed AC identifier
 * @param acText - Original AC text from spec
 * @param testOutput - Test failure output
 * @param relatedStories - Related story IDs
 * @param prd - Current PRD
 * @returns Formatted prompt string
 */
export function buildFixPrompt(
  failedAC: string,
  acText: string,
  testOutput: string,
  relatedStories: string[],
  prd: PRD,
): string {
  const relatedStoriesText = relatedStories
    .map((id) => {
      const story = prd.userStories.find((s) => s.id === id);
      if (!story) return "";
      return `${story.id}: ${story.title}\n  ${story.description}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `You are a debugging expert. A feature acceptance test has failed.

FAILED ACCEPTANCE CRITERION:
${failedAC}: ${acText}

TEST FAILURE OUTPUT:
${testOutput}

RELATED STORIES (implemented this functionality):
${relatedStoriesText}

Your task: Generate a fix story description that will make the acceptance test pass.

Requirements:
1. Analyze the test failure to understand the root cause
2. Identify what needs to change in the code
3. Write a clear, actionable fix description (2-4 sentences)
4. Focus on the specific issue, not general improvements
5. Reference the relevant story IDs if needed

Respond with ONLY the fix description (no JSON, no markdown, just the description text).`;
}

/**
 * Generate fix stories from failed acceptance criteria.
 *
 * For each failed AC:
 * 1. Find related stories
 * 2. Build LLM prompt with context
 * 3. Generate fix description
 * 4. Create FixStory object
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
 * });
 *
 * // Append to PRD
 * prd.userStories.push(...fixStories.map(convertToUserStory));
 * ```
 */
export async function generateFixStories(
  adapter: AgentAdapter,
  options: GenerateFixStoriesOptions,
): Promise<FixStory[]> {
  const { failedACs, testOutput, prd, specContent, workdir, modelDef } = options;

  const fixStories: FixStory[] = [];

  // Parse spec to get AC text
  const acTextMap = parseACTextFromSpec(specContent);

  const logger = getLogger();
  for (let i = 0; i < failedACs.length; i++) {
    const failedAC = failedACs[i];
    const acText = acTextMap[failedAC] || "No description available";

    logger.info("acceptance", "Generating fix for failed AC", { failedAC });

    // Find related stories
    const relatedStories = findRelatedStories(failedAC, prd);

    if (relatedStories.length === 0) {
      logger.warn("acceptance", "⚠ No related stories found for failed AC — skipping", { failedAC });
      continue;
    }

    // Build prompt
    const prompt = buildFixPrompt(
      failedAC,
      acText,
      testOutput,
      relatedStories,
      prd,
    );

    try {
      // Call agent to generate fix description
      const cmd = [
        adapter.binary,
        "--model",
        modelDef.model,
        "--dangerously-skip-permissions",
        "-p",
        prompt,
      ];

      const proc = Bun.spawn(cmd, {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...(modelDef.env || {}),
        },
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        logger.warn("acceptance", "⚠ Agent fix generation failed", { failedAC, stderr });
        // Use fallback description
        fixStories.push({
          id: `US-FIX-${String(i + 1).padStart(3, "0")}`,
          title: `Fix: ${failedAC}`,
          failedAC,
          testOutput,
          relatedStories,
          description: `Fix the implementation to make ${failedAC} pass. Related stories: ${relatedStories.join(", ")}.`,
        });
        continue;
      }

      // Extract fix description
      const fixDescription = stdout.trim();

      fixStories.push({
        id: `US-FIX-${String(i + 1).padStart(3, "0")}`,
        title: `Fix: ${failedAC} — ${acText.slice(0, 50)}`,
        failedAC,
        testOutput,
        relatedStories,
        description: fixDescription,
      });

      logger.info("acceptance", "✓ Generated fix story", { storyId: fixStories[fixStories.length - 1].id });
    } catch (error) {
      logger.warn("acceptance", "⚠ Error generating fix", {
        failedAC,
        error: (error as Error).message,
      });
      // Use fallback
      fixStories.push({
        id: `US-FIX-${String(i + 1).padStart(3, "0")}`,
        title: `Fix: ${failedAC}`,
        failedAC,
        testOutput,
        relatedStories,
        description: `Fix the implementation to make ${failedAC} pass. Related stories: ${relatedStories.join(", ")}.`,
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
 * @returns Map of AC ID to text (e.g., { "AC-2": "set(key, value, ttl)..." })
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
 * @param fixStory - Fix story to convert
 * @returns UserStory object ready for PRD
 *
 * @example
 * ```ts
 * const fixStory: FixStory = { id: "US-FIX-001", ... };
 * const userStory = convertFixStoryToUserStory(fixStory);
 * prd.userStories.push(userStory);
 * ```
 */
export function convertFixStoryToUserStory(fixStory: FixStory): UserStory {
  return {
    id: fixStory.id,
    title: fixStory.title,
    description: fixStory.description,
    acceptanceCriteria: [`Fix ${fixStory.failedAC}`],
    tags: ["fix", "acceptance-failure"],
    dependencies: fixStory.relatedStories,
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: [],
  };
}
