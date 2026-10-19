/**
 * Context session allocation — shared by the v2 context stage and the workflow
 * context stage (US-004).
 *
 * `ctx.sessionId`, `ctx.sessionScratchDir` and `ctx.contextToolRunCounter` used
 * to be allocated inline at the top of `runV2Path` (context.ts). The workflow
 * pipeline needs the same three fields — `sessionScratchDir` is consumed by the
 * workflow gates (`workflow/gates.ts`) and the run counter by
 * `metrics/tracker.ts` — but must not boot the v2 orchestrator to get them, so
 * the block moved here and both stages call it. There is exactly one allocation
 * policy: this function.
 *
 * Ownership is unchanged: `ctx.sessionId` is still a UUID pre-allocated by the
 * context stage (not the execution stage), and the session role is still
 * "implementer".
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { featureDir } from "@/config";
import { createRunCallCounter } from "@/context/engine";
import type { PipelineContext } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _contextSessionDeps = {
  /** UUID factory for the scratch dir of a context with no SessionManager. */
  uuid: (): string => randomUUID(),
};

/**
 * Allocate this story's session identity on the pipeline context.
 *
 * Idempotent: when `ctx.sessionScratchDir` is already set (a resumed run, or a
 * second context stage in the same pipeline pass) nothing is re-created and
 * `ctx.sessionId` is left exactly as it was. Only the run call counter is
 * filled in when absent, so a re-entrant stage never resets a partly consumed
 * pull-tool budget.
 *
 * Two allocation paths, both preserved from `runV2Path`:
 * - a SessionManager (the run has one) registers the session and owns the
 *   scratch dir it reports;
 * - otherwise the scratch dir is derived from `sessionId` under the feature's
 *   `sessions/` dir, with `_unattached` standing in when the run has no feature
 *   (e.g. a no-story session).
 */
export function allocateStorySession(ctx: PipelineContext): void {
  if (!ctx.sessionScratchDir) {
    if (ctx.sessionManager && ctx.prd.feature) {
      const session = ctx.sessionManager.create({
        role: "implementer",
        agent: ctx.routing.agent ?? ctx.agentManager?.getDefault() ?? "claude",
        workdir: ctx.workdir,
        projectDir: ctx.projectDir,
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
      });
      ctx.sessionId = session.id;
      ctx.sessionScratchDir = session.scratchDir;
    } else {
      const sessionId = ctx.sessionId ?? _contextSessionDeps.uuid();
      if (!ctx.sessionId) ctx.sessionId = sessionId;
      const featureId = ctx.featureDir?.replace(/\/$/, "").split("/").pop() ?? "_unattached";
      ctx.sessionScratchDir = join(featureDir(ctx.projectDir, featureId), "sessions", sessionId);
    }
  }
  if (!ctx.contextToolRunCounter) {
    ctx.contextToolRunCounter = createRunCallCounter();
  }
}
