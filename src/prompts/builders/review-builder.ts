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

For each acceptance criterion, verify the current codebase implements it correctly. Use the diff to identify changed files and code paths, not as the only source of truth.

**Before reporting any finding as "error", you MUST verify it using your tools:**
- If you suspect a key, function, import, or variable is missing, READ the relevant file to confirm before flagging.
- If you suspect a code path is not wired in, GREP for its usage to confirm.
- Do NOT flag something as missing based solely on its absence from the diff — it may already exist in the codebase. Check the actual file first.
- If you cannot verify a claim even after checking, use "unverifiable" severity instead of "error".
- Every "error" finding must include verifiedBy evidence from the current codebase. If you cannot provide verifiedBy, downgrade the finding to "unverifiable".
- The \`verifiedBy.observed\` field MUST be a **verbatim** 1-3 line code excerpt copy-pasted from the file — not a description. Paste the actual source lines (or a substring of them) that prove your claim. A description like "function X does not check Y" is not a verifiable observation; quote the lines that demonstrate the omission instead. If you cannot quote an exact excerpt that proves your point, downgrade the finding to "unverifiable".

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
      "severity": "error" | "warning" | "info" | "unverifiable",
      "file": "path/to/file",
      "line": 42,
      "issue": "description of the issue",
      "suggestion": "how to fix it",
      "verifiedBy": {
        "command": "command used to inspect the current codebase",
        "file": "path/to/file",
        "line": 42,
        "observed": "verbatim 1-3 line code excerpt copy-pasted from the file (not a description)"
      }
    }
  ]
}

If all ACs are correctly implemented, respond with { "passed": true, "findings": [] }.`;

// ─── Options ──────────────────────────────────────────────────────────────────

/** Prior failure entry for attempt context */
export interface PriorFailure {
  stage: string;
  modelTier: string;
}

/** Options for buildSemanticReviewPrompt */
export interface SemanticReviewPromptOptions {
  /** Diff mode: embedded includes diff in prompt, ref includes git ref + stat */
  mode: "embedded" | "ref";
  /** Pre-collected diff (used when mode = "embedded") */
  diff?: string;
  /** Git baseline ref (used when mode = "ref") */
  storyGitRef?: string;
  /** Git diff --stat output (used when mode = "ref") */
  stat?: string;
  /** Prior failure context for attempt awareness */
  priorFailures?: PriorFailure[];
  /** Exclude patterns for the self-serve diff command (mode = "ref") */
  excludePatterns?: string[];
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class ReviewPromptBuilder {
  /**
   * Build the LLM prompt for a one-shot semantic review.
   *
   * Supports two modes:
   * - "embedded": diff is embedded in the prompt (truncated at DIFF_CAP_BYTES in semantic.ts)
   * - "ref": stat summary + storyGitRef + self-serve diff commands; reviewer fetches full diff via tools
   *
   * Both modes include an attempt context section when priorFailures is non-empty.
   */
  buildSemanticReviewPrompt(
    story: SemanticStory,
    semanticConfig: SemanticReviewConfig,
    options: SemanticReviewPromptOptions,
  ): string {
    const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
    const customRulesBlock =
      semanticConfig.rules.length > 0
        ? `\n## Additional Review Rules\n${semanticConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
        : "";
    const attemptContextBlock = buildAttemptContextBlock(options.priorFailures);

    let diffSection: string;
    if (options.mode === "ref") {
      diffSection = buildRefDiffSection(options.storyGitRef ?? "", options.stat ?? "", options.excludePatterns ?? []);
    } else {
      diffSection = buildEmbeddedDiffSection(options.diff ?? "");
    }

    const core = `${SEMANTIC_ROLE}

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}
${customRulesBlock}${attemptContextBlock}${diffSection}
${SEMANTIC_INSTRUCTIONS}
${SEMANTIC_OUTPUT_SCHEMA}`;

    return wrapJsonPrompt(core);
  }

  /**
   * Follow-up prompt sent in the same session when the first response could not
   * be parsed as valid JSON. The LLM still has the full review context — this
   * turn only asks it to re-emit the result in the correct format.
   */
  static jsonRetry(): string {
    return (
      "Your previous response could not be parsed as valid JSON.\n" +
      "Output ONLY the JSON object from your review — no markdown fences, no explanation.\n" +
      "The object must start with { and end with }."
    );
  }

  /**
   * Follow-up prompt when the previous response was truncated mid-JSON.
   * Asking the same question again produces the same long output; instead
   * ask for a severity-aware condensed summary so blocking findings are
   * never dropped — only advisory (below-threshold) findings are capped.
   *
   * - `blockingThreshold` matches the project review config; findings at or
   *   above it must be reported in full.
   * - `advisoryCap` bounds findings strictly below the threshold (default 3).
   */
  static jsonRetryCondensed(opts?: {
    blockingThreshold?: "error" | "warning" | "info";
    advisoryCap?: number;
  }): string {
    const threshold = opts?.blockingThreshold ?? "error";
    const advisoryCap = opts?.advisoryCap ?? 3;
    const blockingList =
      threshold === "error"
        ? '"error"'
        : threshold === "warning"
          ? '"error" and "warning"'
          : '"error", "warning", and "info"';
    const blockingClause =
      threshold === "info"
        ? "Include ALL findings — do not drop any by severity."
        : `Include ALL findings with severity ${blockingList} (these are blocking — do not drop them).`;
    const advisoryClause =
      threshold === "info"
        ? "If your response would still exceed limits, prioritize the highest-severity findings first."
        : `Below that, include at most ${advisoryCap} additional findings (highest severity first).`;
    return `Your previous response was truncated and could not be parsed as valid JSON.\nRespond with a condensed summary:\n- ${blockingClause}\n- ${advisoryClause}\nOutput ONLY a complete, valid JSON object. It must start with { and end with }.\nSchema: {"passed": boolean, "findings": [{"severity": string, "category": string, "file": string, "line": number, "issue": string, "suggestion": string}]}`;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Build the attempt context section.
 * Emitted only when priorFailures is non-empty.
 */
export function buildAttemptContextBlock(priorFailures?: PriorFailure[]): string {
  if (!priorFailures || priorFailures.length === 0) return "";

  const attemptNumber = priorFailures.length + 1;
  const stages = priorFailures.map((f) => f.stage).join(", ");

  return `## Attempt Context
This is escalation attempt ${attemptNumber}. Prior attempts failed at stages: ${stages}.
The diff shows the NET result of all changes since story start — verify against the current codebase state.

`;
}

/**
 * Build the diff section for "embedded" mode.
 */
function buildEmbeddedDiffSection(diff: string): string {
  return `## Git Diff (production code only — test files excluded)

\`\`\`diff
${diff}\`\`\`

`;
}

/**
 * Build the diff section for "ref" mode.
 * Includes stat summary, git baseline ref, and pre-built self-serve commands.
 */
function buildRefDiffSection(storyGitRef: string, stat: string, excludePatterns: string[]): string {
  const merged = [...new Set([...excludePatterns, ":!.nax/", ":!.nax-pids"])];
  const excludeArgs = merged.map((p) => `'${p}'`).join(" ");
  const productionDiffCmd = `git diff --unified=3 ${storyGitRef}..HEAD -- . ${excludeArgs}`;
  const fullDiffCmd = `git diff --unified=3 ${storyGitRef}..HEAD`;
  const logCmd = `git log --oneline ${storyGitRef}..HEAD`;

  return `## Changed Files
\`\`\`
${stat}
\`\`\`

## Git Baseline: \`${storyGitRef}\`

To inspect the implementation:
- Full production diff: \`${productionDiffCmd}\`
- Full diff (including tests): \`${fullDiffCmd}\`
- Commit history: \`${logCmd}\`

Use these commands to inspect the code. Do NOT rely solely on the file list above — read the actual diff and files to verify each AC.

`;
}
