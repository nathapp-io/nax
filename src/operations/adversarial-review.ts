import { reviewConfigSelector } from "../config";
import { AdversarialReviewPromptBuilder } from "../prompts";
import type { PriorFailure, TestInventory } from "../prompts";
import type { AdversarialReviewConfig, SemanticStory } from "../review/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { LlmReviewFinding, RunOperation } from "./types";

export type { AdversarialReviewConfig, PriorFailure, SemanticStory, TestInventory };

export interface AdversarialReviewInput {
  story: SemanticStory;
  adversarialConfig: AdversarialReviewConfig;
  mode: "embedded" | "ref";
  diff?: string;
  storyGitRef?: string;
  stat?: string;
  priorFailures?: PriorFailure[];
  testInventory?: TestInventory;
  excludePatterns?: string[];
}

export interface AdversarialReviewOutput {
  passed: boolean;
  findings: LlmReviewFinding[];
  failOpen?: boolean;
}

type ReviewConfig = ReturnType<typeof reviewConfigSelector.select>;

const FAIL_OPEN: AdversarialReviewOutput = { passed: true, findings: [], failOpen: true };

function parseLLMShape(raw: unknown): AdversarialReviewOutput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as LlmReviewFinding[] };
}

export const adversarialReviewOp: RunOperation<AdversarialReviewInput, AdversarialReviewOutput, ReviewConfig> = {
  kind: "run",
  name: "adversarial-review",
  stage: "review",
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  config: reviewConfigSelector,
  build(input, _ctx) {
    const prompt = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(
      input.story,
      input.adversarialConfig,
      {
        mode: input.mode,
        diff: input.diff,
        storyGitRef: input.storyGitRef,
        stat: input.stat,
        priorFailures: input.priorFailures,
        testInventory: input.testInventory,
        excludePatterns: input.excludePatterns,
      },
    );
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
