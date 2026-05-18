import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { RunOperation } from "./types";

export interface TestWriterInput {
  readonly story: UserStory;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export interface TestWriterOutput {
  readonly success: boolean;
  readonly filesChanged: string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
}

export const testWriterOp: RunOperation<TestWriterInput, TestWriterOutput, TddConfig> = {
  kind: "run",
  name: "test-writer",
  stage: "run",
  session: { role: "test-writer", lifetime: "fresh" },
  config: tddConfigSelector,
  build(input, _ctx) {
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
    try {
      if (output) {
        const v = JSON.parse(output) as Record<string, unknown>;
        if (v !== null && typeof v === "object" && typeof v.success === "boolean") {
          return {
            success: v.success as boolean,
            filesChanged: Array.isArray(v.filesChanged) ? (v.filesChanged as string[]) : [],
            estimatedCostUsd: 0,
            durationMs: 0,
          };
        }
      }
    } catch {
      // fall through to graceful degradation
    }
    return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  },
  async verify(parsed, _input, _ctx): Promise<TestWriterOutput | null> {
    // Signal to recover when parse produced no usable value (success=false).
    return parsed.success ? parsed : null;
  },
  async recover(_input, _ctx): Promise<TestWriterOutput | null> {
    // No standard disk artifact for test-writer sessions; recovery deferred to caller.
    return null;
  },
};

/** Backward-compat alias — callers may use either name. */
export const writeTddTestOp = testWriterOp;
