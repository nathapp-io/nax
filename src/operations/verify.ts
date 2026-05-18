import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { IsolationCheck } from "../tdd/types";
import type { RunOperation } from "./types";

export interface VerifierInput {
  readonly story: UserStory;
}

export interface VerifierOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  /** Isolation check result, populated when isolation was run. */
  readonly isolation?: IsolationCheck;
}

export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "run",
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, _ctx) {
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `Verify implementation for story: ${input.story.id}`,
        overridable: false,
      },
    };
  },
  parse(_output, _input, _ctx): VerifierOutput {
    return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  },
};

/** Backward-compat alias — callers may use either name. */
export const verifyTddOp = verifierOp;
