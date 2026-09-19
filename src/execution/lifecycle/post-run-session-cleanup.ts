/**
 * Wrapper-level session teardown on failure (extracted from post-run.ts).
 *
 * Complements rollback (spec §3 wrapper side-effect): when the wrapper decides
 * to fail or escalate a story, any legacy ctx.sessionId tied to upstream
 * resources must be closed. Per-phase sessions opened inside the plan are
 * closed by their own SessionKeeper.finally — this is for the wrapper-owned
 * session handle only.
 *
 * Consolidated into one site (was two — see US-005 review H2) so the
 * sessionManager reach is contained. Extracted into a sibling module to keep
 * post-run.ts within the 600-line gate as US-002 lands (AC12).
 *
 * No imports from `post-run.ts` — the `failAndClose` callable is passed in
 * by the caller, avoiding a runtime import cycle entirely.
 */

import type { PipelineContext } from "@/pipeline";
import type { ISessionManager } from "@/session";

type AgentGetFn = (name: string) => import("@/agents").AgentAdapter | undefined;

/** `failAndClose` signature — mirrors `_postRunDeps.failAndClose`. */
export type SessionFailAndClose = (
  sessionManager: ISessionManager,
  sessionId: string,
  agentGetFn?: AgentGetFn,
) => Promise<void>;

/**
 * Close the wrapper-owned session handle when the wrapper has decided to
 * fail or escalate. Returns silently when no session is attached (the
 * common path on stories without a legacy `ctx.sessionId`).
 *
 * `failAndClose` is passed in by the caller so this module never imports
 * `post-run.ts` — production wiring binds `_postRunDeps.failAndClose`,
 * tests can substitute a stub without going through `_postRunDeps`.
 */
export async function cleanupSessionOnFailure(ctx: PipelineContext, failAndClose: SessionFailAndClose): Promise<void> {
  if (!ctx.sessionManager || !ctx.sessionId) return;
  await failAndClose(ctx.sessionManager, ctx.sessionId, ctx.agentGetFn);
}
