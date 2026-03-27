/**
 * Semantic Review Runner
 *
 * Runs an LLM-based semantic review against the git diff for a story.
 */

import { spawn } from "bun";
import type { AgentAdapter } from "../agents/types";
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

/** Maximum diff size in bytes before truncation */
const DIFF_CAP_BYTES = 12_288;

/** Default review rules applied to every semantic check */
const DEFAULT_RULES = [
  "No stubs or noops left in production code paths",
  "No placeholder values (TODO, FIXME, hardcoded dummy data)",
  "No unrelated changes outside the story scope",
  "All new code is properly wired into callers and exports",
  "No silent error swallowing (catch blocks that discard errors without logging)",
];

/**
 * Collect git diff for the story range.
 */
async function collectDiff(workdir: string, storyGitRef: string): Promise<string> {
  const proc = _semanticDeps.spawn({
    cmd: ["git", "diff", "--unified=3", `${storyGitRef}..HEAD`],
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
 * Truncate diff to stay within token budget.
 */
function truncateDiff(diff: string): string {
  if (diff.length <= DIFF_CAP_BYTES) {
    return diff;
  }

  const truncated = diff.slice(0, DIFF_CAP_BYTES);
  // Count approximate file count from diff headers
  const fileCount = (truncated.match(/^diff --git/gm) ?? []).length;
  return `${truncated}\n... (truncated, showing first ${fileCount} files)`;
}

/**
 * Build the LLM prompt for semantic review.
 */
function buildPrompt(story: SemanticStory, semanticConfig: SemanticReviewConfig, diff: string): string {
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  const defaultRulesText = DEFAULT_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const customRulesSection =
    semanticConfig.rules.length > 0
      ? `\n## Custom Rules\n${semanticConfig.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n`
      : "";

  return `You are a code reviewer. Review the following git diff against the story requirements and rules.

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}

## Review Rules

### Default Rules
${defaultRulesText}
${customRulesSection}
## Git Diff

\`\`\`diff
${diff}\`\`\`

## Instructions

Respond with JSON only. No markdown fences around the JSON response itself.
Format:
{
  "passed": boolean,
  "findings": [
    {
      "severity": "error" | "warn" | "info",
      "file": "path/to/file.ts",
      "line": 42,
      "issue": "description of the issue",
      "suggestion": "how to fix it"
    }
  ]
}

If the implementation looks correct, respond with { "passed": true, "findings": [] }.`;
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
 * Returns null if invalid.
 */
function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
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
): Promise<ReviewCheckResult> {
  const startTime = Date.now();
  const logger = getSafeLogger();

  // AC-4: Early exit when no git ref
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

  logger?.info("review", "Running semantic check", { storyId: story.id, modelTier: semanticConfig.modelTier });

  // AC-2: Collect git diff
  const rawDiff = await collectDiff(workdir, storyGitRef);

  // AC-3: Truncate if over cap
  const diff = truncateDiff(rawDiff);

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

  // AC-5: Build prompt
  const prompt = buildPrompt(story, semanticConfig, diff);

  // Call LLM
  let rawResponse: string;
  try {
    rawResponse = await agent.complete(prompt, {
      sessionName: `nax-semantic-${story.id}`,
      workdir,
      timeoutMs: semanticConfig.timeoutMs,
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

  // AC-6 + AC-8: Parse response, fail-open on invalid JSON
  const parsed = parseLLMResponse(rawResponse);
  if (!parsed) {
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

  // AC-7: Format findings and populate structured ReviewFinding[] (US-003 AC-2)
  if (!parsed.passed && parsed.findings.length > 0) {
    const durationMs = Date.now() - startTime;
    logger?.warn("review", `Semantic review failed: ${parsed.findings.length} findings`, {
      storyId: story.id,
      durationMs,
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
