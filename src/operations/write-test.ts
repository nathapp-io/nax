import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { parseSessionJsonOutput } from "./_session-output";
import type { RunOperation } from "./types";

export interface TestWriterInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface TestWriterOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
}

export const testWriterOp: RunOperation<TestWriterInput, TestWriterOutput, TddConfig> = {
  kind: "run",
  name: "test-writer",
  stage: "run",
  session: { role: "test-writer", lifetime: "fresh" },
  config: tddConfigSelector,
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
        content: context || `Write tests for story: ${input.story.id}`,
        overridable: false,
      },
      ...(input.constitution ? { constitution: input.constitution } : {}),
    };
  },
  parse(output, _input, _ctx): TestWriterOutput {
    if (!output) return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    // buildHopCallback injects 'Agent "xxx" failed: ...' when all hops fail.
    if (output.startsWith('Agent "')) {
      return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output };
    }
    // Mirror implementerOp: the test-writer does not reliably emit the JSON
    // envelope (some agents reply in prose). Treat non-empty, non-error output
    // as success — downstream greenfieldGate / fullSuiteGate / verifier catch
    // the real failure modes (no tests written, tests don't fail in RED, etc.).
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
export const writeTddTestOp = testWriterOp;
