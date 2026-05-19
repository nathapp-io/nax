import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { IsolationCheck } from "../tdd/types";
import { parseSessionJsonOutput } from "./_session-output";
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
  stage: "verify",
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
    const verdictPath = `${verifyCtx.packageView.packageDir}/.nax-verifier-verdict.json`;
    const content = await verifyCtx.readFile(verdictPath);
    if (!content) return null;
    try {
      const v = JSON.parse(content) as Record<string, unknown>;
      if (typeof v.approved !== "boolean") return null;
      const testsAllPassing =
        v.tests !== null && typeof v.tests === "object" && (v.tests as Record<string, unknown>).allPassing === true;
      return {
        success: v.approved === true && testsAllPassing,
        filesChanged: [],
        estimatedCostUsd: 0,
        durationMs: 0,
      };
    } catch {
      return null;
    }
  },
};

/** Backward-compat alias — callers may use either name. */
export const verifyTddOp = verifierOp;
