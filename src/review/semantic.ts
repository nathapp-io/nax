/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 * Validates behavior — checks that the implementation satisfies the
 * story's acceptance criteria. Code quality (lint, style, conventions)
 * is handled by lint/typecheck, not semantic review.
 */

import { spawn } from "bun";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import type { ModelTier } from "../config/schema-types";
import { DebateSession } from "../debate";
import type { DebateSessionOptions } from "../debate";
import { getSafeLogger } from "../logger";
import type { ReviewFinding } from "../plugins/types";
import { getMergeBase, isGitRefValid } from "../utils/git";
import { extractJsonFromMarkdown, extractJsonObject, stripTrailingCommas, wrapJsonPrompt } from "../utils/llm-json";
import type { ReviewCheckResult, SemanticReviewConfig } from "./types";

/** Story fields required for semantic review */
export interface SemanticStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

/** Function that resolves an AgentAdapter for a given model tier */
export type ModelResolver = (tier: ModelTier) => AgentAdapter | null | undefined;

/** Injectable dependencies for semantic.ts — allows tests to mock spawn without mock.module() */
export const _semanticDeps = {
  spawn: spawn as typeof spawn,
  isGitRefValid,
  getMergeBase,
  createDebateSession: (opts: DebateSessionOptions): DebateSession => new DebateSession(opts),
};

/**
 * Maximum diff size in bytes before truncation.
 * 50KB keeps the prompt well within LLM context and reduces output truncation risk.
 * Test files are excluded from the diff, so the budget goes entirely to production code.
 */
const DIFF_CAP_BYTES = 51_200;

/**
 * Collect git diff for the story range (production code only).
 * Excludes test files via configurable pathspec patterns — semantic review
 * validates behavior against ACs, not test style or conventions.
 */
async function collectDiff(workdir: string, storyGitRef: string, excludePatterns: string[]): Promise<string> {
  const cmd = ["git", "diff", "--unified=3", `${storyGitRef}..HEAD`];
  if (excludePatterns.length > 0) {
    cmd.push("--", ".", ...excludePatterns);
  }
  const proc = _semanticDeps.spawn({
    cmd,
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return "";
  }

  return stdout;
}

/**
 * Collect git diff --stat summary (all files including tests — for context).
 * Used as a preamble when the full diff is truncated so the reviewer
 * always knows which files changed even if the content is cut off.
 */
async function collectDiffStat(workdir: string, storyGitRef: string): Promise<string> {
  const proc = _semanticDeps.spawn({
    cmd: ["git", "diff", "--stat", `${storyGitRef}..HEAD`],
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return exitCode === 0 ? stdout.trim() : "";
}

/**
 * Truncate diff to stay within token budget.
 * When truncated, prepends a --stat summary so the reviewer knows all changed files.
 */
function truncateDiff(diff: string, stat?: string): string {
  if (diff.length <= DIFF_CAP_BYTES) {
    return diff;
  }

  const truncated = diff.slice(0, DIFF_CAP_BYTES);
  // Count files visible vs total
  const visibleFiles = (truncated.match(/^diff --git/gm) ?? []).length;
  const totalFiles = (diff.match(/^diff --git/gm) ?? []).length;

  const statPreamble = stat
    ? `## File Summary (all changed files)\n${stat}\n\n## Diff (truncated — ${visibleFiles}/${totalFiles} files shown)\n`
    : "";

  return `${statPreamble}${truncated}\n... (truncated at ${DIFF_CAP_BYTES} bytes, showing ${visibleFiles}/${totalFiles} files)`;
}

/**
 * Build the LLM prompt for semantic review.
 * @param stat - Optional git diff --stat output (all files, including tests). Always included
 *               as context so the LLM knows which test files were modified even when their
 *               content is excluded from the diff.
 */
function buildPrompt(story: SemanticStory, semanticConfig: SemanticReviewConfig, diff: string, stat?: string): string {
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  const customRulesSection =
    semanticConfig.rules.length > 0
      ? `\n## Additional Review Rules\n${semanticConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
      : "";

  const core = `You are a semantic code reviewer with access to the repository files. Your job is to verify that the implementation satisfies the story's acceptance criteria (ACs). You are NOT a linter or style checker — lint, typecheck, and convention checks are handled separately.

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}
${customRulesSection}
## Git Diff (production code only — test files excluded)

\`\`\`diff
${diff}\`\`\`

## Instructions

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

Do NOT flag: style issues, naming conventions, import ordering, file length, or anything lint handles.

Respond with JSON only — no explanation text before or after:
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

  return wrapJsonPrompt(core);
}

interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acId?: string;
}

interface LLMResponse {
  passed: boolean;
  findings: LLMFinding[];
}

/**
 * Validate parsed JSON matches the expected LLM response shape.
 */
function validateLLMShape(parsed: unknown): LLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as LLMFinding[] };
}

/**
 * Parse and validate LLM JSON response using multi-tier extraction.
 *
 * Tier 1: Direct JSON.parse (clean responses)
 * Tier 2: Markdown fence extraction — non-anchored, handles preamble text before fence
 * Tier 3: Bare JSON object extraction — handles JSON embedded in narration
 *
 * Returns null only when all tiers fail.
 */
function parseLLMResponse(raw: string): LLMResponse | null {
  const text = raw.trim();

  // Tier 1: direct parse
  try {
    return validateLLMShape(JSON.parse(text));
  } catch {
    /* not raw JSON */
  }

  // Tier 2: extract from markdown fences (non-anchored — handles preamble)
  const fromFence = extractJsonFromMarkdown(text);
  if (fromFence !== text) {
    try {
      return validateLLMShape(JSON.parse(stripTrailingCommas(fromFence)));
    } catch {
      /* fence content not valid JSON */
    }
  }

  // Tier 3: extract bare JSON object from narration
  const bareJson = extractJsonObject(text);
  if (bareJson) {
    try {
      return validateLLMShape(JSON.parse(stripTrailingCommas(bareJson)));
    } catch {
      /* extracted text not valid JSON */
    }
  }

  return null;
}

/**
 * Format findings into readable text output.
 */
function formatFindings(findings: LLMFinding[]): string {
  return findings
    .map((f) => `[${f.severity}] ${f.file}:${f.line} — ${f.issue}\n  Suggestion: ${f.suggestion}`)
    .join("\n");
}

/** Normalize LLM severity values to ReviewFinding severity union. */
function normalizeSeverity(sev: string): ReviewFinding["severity"] {
  if (sev === "warn") return "warning";
  if (sev === "unverifiable") return "info";
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
}

/** Check whether a finding severity is blocking (counts toward pass/fail). */
function isBlockingSeverity(sev: string): boolean {
  return sev !== "unverifiable";
}

/** Convert LLMFinding[] to ReviewFinding[] with semantic-review metadata. */
function toReviewFindings(findings: LLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "semantic",
    severity: normalizeSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: f.issue,
    source: "semantic-review",
  }));
}

/**
 * Run a semantic review using an LLM against the story diff.
 */
export async function runSemanticReview(
  workdir: string,
  storyGitRef: string | undefined,
  story: SemanticStory,
  semanticConfig: SemanticReviewConfig,
  modelResolver: ModelResolver,
  naxConfig?: NaxConfig,
  featureName?: string,
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  // BUG-114: Resolve effective git ref for the diff range.
  // Priority 1: use the supplied ref if valid (persisted from story start).
  // Priority 2: fall back to merge-base with the default remote branch so that
  //   the semantic reviewer always sees the full story diff even after a restart.
  // Priority 3: skip review when no ref can be resolved (non-git workdir, etc.).
  let effectiveRef: string | undefined;
  if (storyGitRef && (await _semanticDeps.isGitRefValid(workdir, storyGitRef))) {
    effectiveRef = storyGitRef;
  } else {
    const fallback = await _semanticDeps.getMergeBase(workdir);
    if (fallback) {
      logger?.info("review", "storyGitRef missing or invalid — using merge-base fallback", {
        storyId: story.id,
        storyGitRef,
        fallback,
      });
      effectiveRef = fallback;
    }
  }

  if (!effectiveRef) {
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no git ref",
      durationMs: Date.now() - startTime,
    };
  }

  logger?.info("review", "Running semantic check", {
    storyId: story.id,
    modelTier: semanticConfig.modelTier,
    configProvided: !!naxConfig,
  });

  // Collect production-only diff (test files excluded at git level via configurable patterns)
  // Collect stat summary (all files including tests) unconditionally so the LLM can verify
  // test-related ACs even though test file content is excluded from the diff.
  const [rawDiff, stat] = await Promise.all([
    collectDiff(workdir, effectiveRef, semanticConfig.excludePatterns),
    collectDiffStat(workdir, effectiveRef),
  ]);

  // Truncate diff if over cap — stat summary is always included for context
  const diff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined);

  if (!diff) {
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no production code changes",
      durationMs: Date.now() - startTime,
    };
  }

  // Resolve agent
  const agent = modelResolver(semanticConfig.modelTier);
  if (!agent) {
    logger?.warn("semantic", "No agent available for semantic review — skipping", {
      modelTier: semanticConfig.modelTier,
    });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "skipped: no agent available for model tier",
      durationMs: Date.now() - startTime,
    };
  }

  // Build prompt — pass stat so LLM can see which test files changed even though
  // test file content is excluded from the diff (satisfies test-only AC verification)
  const prompt = buildPrompt(story, semanticConfig, diff, stat || undefined);

  // Debate path: when debate is enabled for review stage, use DebateSession instead of agent.complete()
  const reviewDebateEnabled = naxConfig?.debate?.enabled && naxConfig?.debate?.stages?.review?.enabled;
  if (reviewDebateEnabled) {
    // Safe: reviewDebateEnabled guard confirms naxConfig.debate.stages.review is defined
    const reviewStageConfig = naxConfig?.debate?.stages.review as import("../debate").DebateStageConfig;
    const debateSession = _semanticDeps.createDebateSession({
      storyId: story.id,
      stage: "review",
      stageConfig: reviewStageConfig,
      config: naxConfig,
      workdir,
      featureName: story.id,
      timeoutSeconds: naxConfig?.execution?.sessionTimeoutSeconds,
    });
    const debateResult = await debateSession.run(prompt);

    // Compute majority vote and merge findings from all proposals
    let passCount = 0;
    let failCount = 0;
    const allFindings: LLMFinding[] = [];
    for (const p of debateResult.proposals) {
      const parsed = parseLLMResponse(p.output);
      if (parsed) {
        if (parsed.passed) passCount++;
        else failCount++;
        allFindings.push(...parsed.findings);
      } else {
        failCount++; // unparseable — fail-closed
      }
    }
    const majorityPassed = passCount > failCount;

    // Deduplicate findings by AC id (primary) or file:line (fallback)
    const seen = new Set<string>();
    const deduped: LLMFinding[] = [];
    for (const f of allFindings) {
      const key = f.acId ?? `${f.file}:${f.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(f);
      }
    }

    // Filter non-blocking findings from debate results
    const debateBlocking = deduped.filter((f) => isBlockingSeverity(f.severity));

    const durationMs = Date.now() - startTime;
    if (!majorityPassed) {
      if (debateBlocking.length > 0) {
        logger?.warn("review", `Semantic review failed (debate): ${debateBlocking.length} findings`, {
          storyId: story.id,
          durationMs,
        });
        return {
          check: "semantic",
          success: false,
          command: "",
          exitCode: 1,
          output: `Semantic review failed:\n\n${formatFindings(debateBlocking)}`,
          durationMs,
          findings: toReviewFindings(debateBlocking),
        };
      }
      // All findings were non-blocking — override to pass
      logger?.info("review", "Semantic review passed (debate, all findings non-blocking)", {
        storyId: story.id,
        durationMs,
      });
      return {
        check: "semantic",
        success: true,
        command: "",
        exitCode: 0,
        output: "Semantic review passed (debate, all findings were unverifiable or informational)",
        durationMs,
      };
    }
    logger?.info("review", "Semantic review passed (debate)", { storyId: story.id, durationMs });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed",
      durationMs,
    };
  }

  // Call LLM
  let rawResponse: string;
  try {
    const completeResult = await agent.complete(prompt, {
      sessionName: `nax-semantic-${story.id}`,
      workdir,
      timeoutMs: semanticConfig.timeoutMs,
      modelTier: semanticConfig.modelTier,
      config: naxConfig,
    });
    rawResponse = typeof completeResult === "string" ? completeResult : completeResult.output;
  } catch (err) {
    logger?.warn("semantic", "LLM call failed — fail-open", { cause: String(err) });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: `skipped: LLM call failed — ${String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse response — fail-closed when LLM clearly intended to fail,
  // fail-open only when response is truly unparseable with no signal.
  const parsed = parseLLMResponse(rawResponse);
  if (!parsed) {
    // Check if truncated response contains "passed": false — LLM intended to fail
    // but output was cut off mid-response. Treating this as a pass is incorrect (#105).
    const looksLikeFail = /"passed"\s*:\s*false/.test(rawResponse);
    if (looksLikeFail) {
      logger?.warn("semantic", "LLM returned truncated JSON with passed:false — treating as failure", {
        rawResponse: rawResponse.slice(0, 200),
      });
      return {
        check: "semantic",
        success: false,
        command: "",
        exitCode: 1,
        output:
          "semantic review: LLM response truncated but indicated failure (passed:false found in partial response)",
        durationMs: Date.now() - startTime,
      };
    }

    logger?.warn("semantic", "LLM returned invalid JSON — fail-open", { rawResponse: rawResponse.slice(0, 200) });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "semantic review: could not parse LLM response (fail-open)",
      durationMs: Date.now() - startTime,
    };
  }

  // Split findings into blocking (error/warn) and non-blocking (unverifiable/info)
  const blockingFindings = parsed.findings.filter((f) => isBlockingSeverity(f.severity));
  const nonBlockingFindings = parsed.findings.filter((f) => !isBlockingSeverity(f.severity));

  if (nonBlockingFindings.length > 0) {
    logger?.debug(
      "review",
      `Semantic review: ${nonBlockingFindings.length} non-blocking findings (unverifiable/info)`,
      {
        storyId: story.id,
        findings: nonBlockingFindings.map((f) => ({ severity: f.severity, file: f.file, issue: f.issue })),
      },
    );
  }

  // Format findings and populate structured ReviewFinding[]
  if (!parsed.passed && blockingFindings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Semantic review failed: ${blockingFindings.length} findings`, {
      storyId: story.id,
      durationMs,
    });
    logger?.debug("review", "Semantic review findings", {
      storyId: story.id,
      findings: blockingFindings.map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        issue: f.issue,
        suggestion: f.suggestion,
      })),
    });
    const output = `Semantic review failed:\n\n${formatFindings(blockingFindings)}`;
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output,
      durationMs,
      findings: toReviewFindings(blockingFindings),
    };
  }

  // If LLM said failed but all findings are non-blocking, override to pass
  if (!parsed.passed && blockingFindings.length === 0) {
    const durationMs = Date.now() - startTime;
    logger?.info("review", "Semantic review passed (all findings non-blocking)", { storyId: story.id, durationMs });
    return {
      check: "semantic",
      success: true,
      command: "",
      exitCode: 0,
      output: "Semantic review passed (all findings were unverifiable or informational)",
      durationMs,
    };
  }

  const durationMs = Date.now() - startTime;
  if (parsed.passed) {
    logger?.info("review", "Semantic review passed", { storyId: story.id, durationMs });
  }
  return {
    check: "semantic",
    success: parsed.passed,
    command: "",
    exitCode: parsed.passed ? 0 : 1,
    output: parsed.passed ? "Semantic review passed" : "Semantic review failed (no findings)",
    durationMs,
  };
}
