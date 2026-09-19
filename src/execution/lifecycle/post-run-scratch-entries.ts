/**
 * Post-run scratch-entry writes (extracted from post-run.ts).
 *
 * Writes three kinds of entries to the session scratch dir:
 *   - `self-verification` for the implementer output (lint / typecheck verdict)
 *   - `tdd-session` for the test-writer and verifier outputs (three-session
 *     coverage the legacy TDD strategy used to provide directly)
 *
 * Every write is wrapped in its own try/catch so a scratch-write failure
 * (disk full, permission denied, etc.) never fails the story. This is the
 * same posture the run-start baseline capture uses — these writes are
 * observability, not tripwires.
 *
 * Extracted from post-run.ts (US-002 follow-up) to keep that file within
 * the 600-line hard limit. No imports from post-run.ts — the logger and
 * context are passed in by the caller, avoiding a runtime import cycle.
 */

import type { StoryOrchestratorResult } from "@/execution/story-orchestrator";
import { getSafeLogger } from "@/logger";
import { testWriterOp, verifierOp } from "@/operations";
import type { PipelineContext } from "@/pipeline";
import { appendScratchEntry } from "@/session";
import { errorMessage } from "@/utils/errors";

/** Subset of the post-run InspectionOptions the scratch writes actually read. */
export interface ScratchEntryOptions {
  readonly capturedTokenUsage?: import("@/agents/cost").TokenUsage;
  readonly capturedResponse: string;
  readonly capturedCostUsd: number;
  /** Null when this is not a TDD strategy; otherwise carries TDD-specific opts. */
  readonly tddMode: { readonly isLite: boolean; readonly rollbackEnabled: boolean } | null;
  readonly initialRef: string | null;
  readonly untrackedBefore: string[] | null;
}

export async function writePostRunScratchEntries(
  ctx: PipelineContext,
  planResult: StoryOrchestratorResult,
  opts: ScratchEntryOptions,
): Promise<void> {
  const logger = getSafeLogger();
  const isTdd = opts.tddMode !== null;

  if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir && ctx.selfVerification) {
    try {
      await appendScratchEntry(ctx.sessionScratchDir, {
        kind: "self-verification",
        timestamp: new Date().toISOString(),
        storyId: ctx.story.id,
        stage: "execution",
        role: "implementer",
        selfVerification: ctx.selfVerification,
        writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
      });
    } catch (scratchErr) {
      logger?.warn("execution", "Failed to write self-verification scratch entry — continuing", {
        storyId: ctx.story.id,
        error: errorMessage(scratchErr),
      });
    }
  }

  if (!isTdd || !ctx.config.context?.v2?.enabled || !ctx.sessionScratchDir) return;

  // Write per-role tdd-session scratch entries for test-writer and verifier.
  // The implementer's self-verification entry was written above; these restore
  // the per-role context coverage that the three-session strategy previously provided.
  const writtenByAgent =
    (ctx.routing as { agent?: string } | undefined)?.agent ?? ctx.agentManager?.getDefault() ?? "claude";
  const writerOut = planResult.phaseOutputs[testWriterOp.name] as
    | { success?: boolean; filesChanged?: string[]; output?: string }
    | undefined;
  if (writerOut) {
    try {
      await appendScratchEntry(ctx.sessionScratchDir, {
        kind: "tdd-session",
        timestamp: new Date().toISOString(),
        storyId: ctx.story.id,
        stage: "execution",
        role: "test-writer",
        success: writerOut.success === true,
        filesChanged: writerOut.filesChanged ?? [],
        outputTail: (writerOut.output ?? "").slice(-500),
        writtenByAgent,
      });
    } catch (err) {
      logger?.warn("execution", "Failed to write test-writer scratch entry", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }
  }

  const verifierOut = planResult.phaseOutputs[verifierOp.name] as
    | { success?: boolean; filesChanged?: string[]; output?: string }
    | undefined;
  if (verifierOut) {
    try {
      await appendScratchEntry(ctx.sessionScratchDir, {
        kind: "tdd-session",
        timestamp: new Date().toISOString(),
        storyId: ctx.story.id,
        stage: "execution",
        role: "verifier",
        success: verifierOut.success === true,
        filesChanged: verifierOut.filesChanged ?? [],
        outputTail: (verifierOut.output ?? "").slice(-500),
        writtenByAgent,
      });
    } catch (err) {
      logger?.warn("execution", "Failed to write verifier scratch entry", {
        storyId: ctx.story.id,
        error: errorMessage(err),
      });
    }
  }
}
