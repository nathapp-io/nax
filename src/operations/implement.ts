import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { RunOperation } from "./types";

export interface ImplementerInput {
  readonly story: UserStory;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
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
  parse(_output, _input, _ctx): ImplementerOutput {
    return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  },
  async verify(parsed, _input, _ctx): Promise<ImplementerOutput | null> {
    // Signal to recover when parse produced no usable value (success=false).
    return parsed.success ? parsed : null;
  },
  async recover(_input, _ctx): Promise<ImplementerOutput | null> {
    // No standard disk artifact for implementer sessions; recovery deferred to caller.
    return null;
  },
};

/** Backward-compat alias — callers may use either name. */
export const implementTddOp = implementerOp;
