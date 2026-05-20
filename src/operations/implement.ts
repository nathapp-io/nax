import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { parseSessionJsonOutput } from "./_session-output";
import { shouldKeepSessionOpen } from "./execution-gates";
import type { RunOperation } from "./types";

export interface ImplementerInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
}

export const implementerOp: RunOperation<ImplementerInput, ImplementerOutput, TddConfig> = {
  kind: "run",
  name: "implementer",
  stage: "run",
  session: { role: "implementer", lifetime: "warm" },
  config: tddConfigSelector,
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "implementer"),
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
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
    if (!output) return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    // buildHopCallback injects 'Agent "xxx" failed: ...' when all hops fail — same
    // heuristic used by statefulDebaterOp to avoid masking agent failure as success.
    if (output.startsWith('Agent "')) {
      return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output };
    }
    // Non-empty, non-error output means the session exited 0. Treat as success;
    // extract filesChanged from the JSON envelope if present.
    const envelope = parseSessionJsonOutput(output);
    return {
      success: envelope.parsed ? envelope.success : true,
      filesChanged: envelope.filesChanged,
      estimatedCostUsd: 0,
      durationMs: 0,
      output: envelope.output,
    };
  },
};

/** Backward-compat alias — callers may use either name. */
export const implementTddOp = implementerOp;
