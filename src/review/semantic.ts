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
import { getSafeLogger } from "../logger";
import type { ReviewFinding } from "../plugins/types";
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
 */
function buildPrompt(story: SemanticStory, semanticConfig: SemanticReviewConfig, diff: string): string {
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  const customRulesSection =
    semanticConfig.rules.length > 0
      ? `\n## Additional Review Rules\n${semanticConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
      : "";

  return `You are a semantic code reviewer. Your job is to verify that the implementation satisfies the story's acceptance criteria (ACs). You are NOT a linter or style checker — lint, typecheck, and convention checks are handled separately.

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

For each acceptance criterion, verify the diff implements it correctly. Flag issues only when:
1. An AC is not implemented or partially implemented
2. The implementation contradicts what the AC specifies
3. New code has dead paths that will never execute (stubs, noops, unreachable branches)
4. New code is not wired into callers/exports (written but never used)

Do NOT flag: style issues, naming conventions, import ordering, file length, or anything lint handles.

Respond in JSON format:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warn" | "info",
      "file": "path/to/file",
      "line": 42,
      "issue": "description of the issue",
      "suggestion": "how to fix it"
    }
  ]
}

If all ACs are correctly implemented, respond with { "passed": true, "findings": [] }.`;
}

interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
}

interface LLMResponse {
  passed: boolean;
  findings: LLMFinding[];
}

/**
 * Parse and validate LLM JSON response.
 * Strips markdown fences if present (LLMs frequently add them despite instructions).
 * Returns null if truly unparseable.
 */
function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.passed !== "boolean") return null;
    if (!Array.isArray(obj.findings)) return null;
    return { passed: obj.passed, findings: obj.findings as LLMFinding[] };
  } catch {
    return null;
  }
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
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
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
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  // Early exit when no git ref
  if (!storyGitRef) {
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
  const rawDiff = await collectDiff(workdir, storyGitRef, semanticConfig.excludePatterns);

  // Truncate if over cap — collect stat summary (all files) when truncation needed
  const needsTruncation = rawDiff.length > DIFF_CAP_BYTES;
  const stat = needsTruncation ? await collectDiffStat(workdir, storyGitRef) : undefined;
  const diff = truncateDiff(rawDiff, stat);

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

  // Build prompt
  const prompt = buildPrompt(story, semanticConfig, diff);

  // Call LLM
  let rawResponse: string;
  try {
    rawResponse = await agent.complete(prompt, {
      sessionName: `nax-semantic-${story.id}`,
      workdir,
      timeoutMs: semanticConfig.timeoutMs,
      modelTier: semanticConfig.modelTier,
      config: naxConfig,
    });
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

  // Format findings and populate structured ReviewFinding[]
  if (!parsed.passed && parsed.findings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Semantic review failed: ${parsed.findings.length} findings`, {
      storyId: story.id,
      durationMs,
    });
    logger?.debug("review", "Semantic review findings", {
      storyId: story.id,
      findings: parsed.findings.map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        issue: f.issue,
        suggestion: f.suggestion,
      })),
    });
    const output = `Semantic review failed:\n\n${formatFindings(parsed.findings)}`;
    return {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output,
      durationMs,
      findings: toReviewFindings(parsed.findings),
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
