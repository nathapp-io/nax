/**
 * ReviewPromptBuilder — centralises semantic review prompt construction.
 *
 * Owns the prompt for `src/review/semantic.ts:runSemanticReview()`.
 * Extracted from the inline `buildPrompt()` function in semantic.ts.
 *
 * Imports types from src/review/types.ts (not src/review/semantic.ts) to
 * avoid a circular dependency: semantic.ts imports ReviewPromptBuilder from
 * src/prompts, so importing semantic.ts here would form a cycle.
 */

import type { SemanticReviewConfig, SemanticStory } from "../../review/types";
import { wrapJsonPrompt } from "../../utils/llm-json";

// ─── Constants ────────────────────────────────────────────────────────────────

const SEMANTIC_ROLE =
  "You are a semantic code reviewer with access to the repository files. Your job is to verify that the implementation satisfies the story's acceptance criteria (ACs). You are NOT a linter or style checker — lint, typecheck, and convention checks are handled separately.";

const SEMANTIC_INSTRUCTIONS = `## Instructions

For each acceptance criterion, verify the diff implements it correctly.

**Before reporting any finding as "error", you MUST verify it using your tools:**
- If you suspect a key, function, import, or variable is missing, READ the relevant file to confirm before flagging.
- If you suspect a code path is not wired in, GREP for its usage to confirm.
- Do NOT flag something as missing based solely on its absence from the diff — it may already exist in the codebase. Check the actual file first.
- If you cannot verify a claim even after checking, use "unverifiable" severity instead of "error".

Flag issues only when you have confirmed:
1. An AC is not implemented or partially implemented (verified by reading the actual files)
2. The implementation contradicts what the AC specifies
3. New code has dead paths that will never execute (stubs, noops, unreachable branches)
4. New code is not wired into callers/exports (verified by grepping for usage)

Do NOT flag: style issues, naming conventions, import ordering, file length, or anything lint handles.`;

const SEMANTIC_OUTPUT_SCHEMA = `Respond with JSON only — no explanation text before or after:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warn" | "info" | "unverifiable",
      "file": "path/to/file",
      "line": 42,
      "issue": "description of the issue",
      "suggestion": "how to fix it"
    }
  ]
}

If all ACs are correctly implemented, respond with { "passed": true, "findings": [] }.`;

// ─── Class ────────────────────────────────────────────────────────────────────

export class ReviewPromptBuilder {
  /**
   * Build the LLM prompt for a one-shot semantic review.
   *
   * Produces output byte-identical to the old inline `buildPrompt()` in
   * src/review/semantic.ts. The `_stat` parameter that existed there was
   * never used (diff already incorporates the stat preamble via truncateDiff).
   */
  buildSemanticReviewPrompt(story: SemanticStory, semanticConfig: SemanticReviewConfig, diff: string): string {
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const customRulesBlock =
      semanticConfig.rules.length > 0
        ? `\n## Additional Review Rules\n${semanticConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
        : "";

    const core = `${SEMANTIC_ROLE}

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}
${customRulesBlock}
## Git Diff (production code only — test files excluded)

\`\`\`diff
${diff}\`\`\`

${SEMANTIC_INSTRUCTIONS}
${SEMANTIC_OUTPUT_SCHEMA}`;

    return wrapJsonPrompt(core);
  }
}
