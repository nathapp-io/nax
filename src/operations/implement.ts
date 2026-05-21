import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { _isolationDeps, verifyImplementerIsolation } from "../tdd/isolation";
import type { IsolationCheck } from "../tdd/types";
import { parseSessionJsonOutput } from "./_session-output";
import { shouldKeepSessionOpen } from "./execution-gates";
import type { RunOperation } from "./types";

void _isolationDeps; // re-export to keep test mocks pointed at the same singleton

export interface ImplementerInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
  /**
   * Git ref captured by the orchestrator just before this phase dispatches.
   * When present, the op's `verify` hook runs implementer isolation against this ref.
   * Absent in legacy / ad-hoc callers — isolation is then skipped.
   */
  readonly beforeRef?: string;
}

export interface ImplementerOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Populated by `verify` when input.beforeRef was supplied. */
  readonly isolation?: IsolationCheck;
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
  async verify(parsed, input, ctx): Promise<ImplementerOutput | null> {
    if (!input.beforeRef) return parsed;
    const testFilePatterns =
      typeof ctx.packageView.config.execution?.smartTestRunner === "object" &&
      ctx.packageView.config.execution.smartTestRunner !== null
        ? ctx.packageView.config.execution.smartTestRunner.testFilePatterns
        : undefined;
    const isolation = await verifyImplementerIsolation(ctx.packageView.packageDir, input.beforeRef, testFilePatterns);
    return { ...parsed, isolation };
  },
};

/** Backward-compat alias — callers may use either name. */
export const implementTddOp = implementerOp;
