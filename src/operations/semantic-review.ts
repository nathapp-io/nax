import { reviewConfigSelector } from "../config";
import { ReviewPromptBuilder } from "../prompts";
import type { PriorFailure } from "../prompts";
import type { SemanticReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { LlmReviewFinding, RunOperation } from "./types";

export type { PriorFailure, SemanticReviewConfig, SemanticStory };

export interface SemanticReviewInput {
  story: SemanticStory;
  semanticConfig: SemanticReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorFailures?: PriorFailure[];
  excludePatterns?: string[];
}

export interface SemanticReviewOutput {
  passed: boolean;
  findings: LlmReviewFinding[];
  failOpen?: boolean;
}

type ReviewConfig = ReturnType<typeof reviewConfigSelector.select>;

const FAIL_OPEN: SemanticReviewOutput = { passed: true, findings: [], failOpen: true };

function parseLLMShape(raw: unknown): SemanticReviewOutput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as LlmReviewFinding[] };
}

export const semanticReviewOp: RunOperation<SemanticReviewInput, SemanticReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "semantic-review",
  stage: "review",
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  config: reviewConfigSelector,
  build(input, _ctx) {
    const prompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(input.story, input.semanticConfig, {
      mode: input.mode,
      diff: input.diff,
      storyGitRef: input.storyGitRef,
      stat: input.stat,
      priorFailures: input.priorFailures,
      excludePatterns: input.excludePatterns,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    return parseLLMShape(raw) ?? FAIL_OPEN;
  },
};
