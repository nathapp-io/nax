import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { parseSessionJsonOutput } from "./_session-output";
import type { RunOperation } from "./types";

export interface ImplementerInput {
  readonly story: UserStory;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
}

export const implementerOp: RunOperation<ImplementerInput, ImplementerOutput, TddConfig> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  session: { role: "implementer", lifetime: "warm" },
  config: tddConfigSelector,
  build(input, _ctx) {
    const context = [input.contextMarkdown, input.featureContextMarkdown].filter(Boolean).join("\n\n");
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: context || `Implement story: ${input.story.id}`,
        overridable: false,
      },
      ...(input.constitution ? { constitution: input.constitution } : {}),
    };
  },
  parse(output, _input, _ctx): ImplementerOutput {
    // Graceful degradation — parseSessionJsonOutput returns success=false on
    // empty/unparseable output, so callers always see a valid envelope without
    // requiring verify/recover.
    const envelope = parseSessionJsonOutput(output);
    return { ...envelope, estimatedCostUsd: 0, durationMs: 0 };
  },
};

/** Backward-compat alias — callers may use either name. */
export const implementTddOp = implementerOp;
