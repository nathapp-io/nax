import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { FailureCategory, IsolationCheck } from "../tdd/types";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "../tdd/verdict";
import { parseSessionJsonOutput } from "./_session-output";
import type { RunOperation } from "./types";

export interface VerifierInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
}

export interface VerifierOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Isolation check result, populated when isolation was run. */
  readonly isolation?: IsolationCheck;
  /** Failure category from verifier verdict categorization. */
  readonly failureCategory?: FailureCategory;
  /** Human-readable reason for rejection from the verifier verdict. */
  readonly reviewReason?: string;
}

export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `Verify implementation for story: ${input.story.id}`,
        overridable: false,
      },
    };
  },
  parse(output, _input, _ctx): VerifierOutput {
    const envelope = parseSessionJsonOutput(output);
    return { ...envelope, estimatedCostUsd: 0, durationMs: 0 };
  },
  async verify(parsed, _input, _ctx): Promise<VerifierOutput | null> {
    // Signal to recover when parse produced no usable value (success=false).
    return parsed.success ? parsed : null;
  },
  async recover(_input, verifyCtx): Promise<VerifierOutput | null> {
    // Derive outcome from the verdict file the verifier agent writes to disk (AC-5).
    // Use try/finally to ensure verdict cleanup on every code path.
    const packageDir = verifyCtx.packageView.packageDir;
    try {
      const verdict = await readVerdict(packageDir);
      if (!verdict) return null;
      const testsAllPassing = verdict.tests.allPassing === true;
      const categorization = categorizeVerdict(verdict, testsAllPassing);
      return {
        success: categorization.success,
        filesChanged: [],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
        ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
        ...(categorization.reviewReason && { reviewReason: categorization.reviewReason }),
      };
    } finally {
      await cleanupVerdict(packageDir);
    }
  },
};

/** Backward-compat alias — callers may use either name. */
export const verifyTddOp = verifierOp;
