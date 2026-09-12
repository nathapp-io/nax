/**
 * Normalizes one hop's raw turn output before it reaches the retry probe or
 * `op.parse` — extracted from `callOp`'s `sendWithFileOutput` closure
 * (`src/operations/call.ts`) so that file is under its 600-line hard limit.
 *
 * Two responsibilities, in order:
 *   - `op.fileOutput`: when the op names a path the agent wrote to instead of
 *     replying in text, swap the turn's `output` for that file's content
 *     before anything downstream inspects it.
 *   - Failure classification: an empty/whitespace turn, or ordinary-looking
 *     output that is actually a provider refusal, is attached as an
 *     `AdapterFailure` so manager-tier retry/swap (spec §B1) handles it
 *     uniformly instead of it reaching `op.parse` as a verdict.
 */

import type { TurnResult } from "../agents/types";
import { getSafeLogger } from "../logger";
import { classifyEmptyOutputFailure, classifyProviderRefusalFailure } from "./turn-failure-classification";

export interface HopOutputContext {
  readonly storyId: string | undefined;
  readonly opName: string;
  readonly dispatchAgent: string;
  readonly fileOutputPath: string | undefined;
  readonly readFileOutput: (path: string) => Promise<string | null>;
}

export async function normalizeHopOutput(
  send: (p: string) => Promise<TurnResult>,
  promptText: string,
  ctx: HopOutputContext,
): Promise<TurnResult> {
  const turn = await send(promptText);
  let effective = turn;
  if (ctx.fileOutputPath) {
    const fileContent = await ctx.readFileOutput(ctx.fileOutputPath);
    if (fileContent !== null) {
      effective = { ...turn, output: fileContent };
    }
  }
  // Checked before the output branches: a spun turn almost always HAS prose
  // (the model narrating the re-runs), so an output-first check would classify
  // it as a clean success — the same defect that hid truncated turns. A
  // producer's own failure still wins, matching classifyEmptyOutputFailure.
  if (effective.spinStopped === true && effective.adapterFailure === undefined) {
    getSafeLogger()?.warn("callop", "Spin breaker ended the turn", {
      storyId: ctx.storyId,
      opName: ctx.opName,
      agentName: ctx.dispatchAgent,
    });
    return {
      ...effective,
      adapterFailure: {
        category: "quality",
        outcome: "fail-spin",
        retriable: true,
        message: "[callOp] spin breaker ended the turn: repeated tool calls with no progress",
        reason: "spin-breaker",
      },
    };
  }
  if (!effective.output?.trim()) {
    const failure = classifyEmptyOutputFailure(effective);
    if (failure) return { ...effective, adapterFailure: failure };
  } else if (!effective.adapterFailure) {
    const refusal = classifyProviderRefusalFailure(effective.output);
    if (refusal) {
      getSafeLogger()?.warn("callop", "Provider refusal classified as infra failure", {
        storyId: ctx.storyId,
        opName: ctx.opName,
        agentName: ctx.dispatchAgent,
        outcome: refusal.outcome,
      });
      return { ...effective, adapterFailure: refusal };
    }
  }
  return effective;
}
