/**
 * Prompt builders for agent sessions
 *
 * Constructs prompts for single-session and batch execution modes.
 */

import type { UserStory } from "../prd";

/**
 * Build prompt for single-session (test-after) execution
 *
 * @param story - User story to execute
 * @param contextMarkdown - Optional context markdown from context builder
 * @returns Formatted prompt string
 */
export function buildSingleSessionPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Task: ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**Instructions:**
1. Implement the functionality described above
2. Write tests to verify all acceptance criteria are met
3. Ensure all tests pass
4. Follow existing code patterns and conventions
5. Commit your changes when done

Use test-after approach: implement first, then add tests to verify.`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/**
 * Build prompt for batched stories (multiple simple stories in one session)
 *
 * @param stories - Array of user stories to execute in batch
 * @param contextMarkdown - Optional context markdown from context builder
 * @returns Formatted prompt string
 */
export function buildBatchPrompt(stories: UserStory[], contextMarkdown?: string): string {
  const storyPrompts = stories
    .map((story, idx) => {
      return `## Story ${idx + 1}: ${story.id} — ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}`;
    })
    .join("\n\n");

  const basePrompt = `# Batch Task: ${stories.length} Stories

You are assigned ${stories.length} related stories to implement in sequence. Each story should be implemented, tested, and committed separately.

${storyPrompts}

**Instructions:**
1. Implement each story in order
2. Write tests to verify all acceptance criteria are met for each story
3. Ensure all tests pass for each story
4. **Commit each story separately** with a clear commit message referencing the story ID
5. Follow existing code patterns and conventions

Use test-after approach: implement first, then add tests to verify.`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}
