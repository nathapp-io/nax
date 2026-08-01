/**
 * Readers over an acpx `FlowNodeContext` — the flow graph's view of its own
 * state.
 *
 * Split out of `nax-finish.flow.ts` (600-line source cap). These are all pure
 * functions of `ctx.input` / `ctx.outputs` / `ctx.state.steps`; anything that
 * shells out lives under `./steps/`.
 *
 * The recurring constraint they exist to work around: acpx keeps only the
 * **latest** output per node id. In a graph whose whole shape is loops, that
 * means a node's own previous-round output is gone by the time it runs again,
 * and `ctx.state.steps` — the ordered history — is the only record of what
 * happened when.
 */
import type { AcceptanceGroup, Finding, FinishInput, FinishPhase, ReviewVerdict } from "./types";

/** Minimal shapes so each reader takes only the part of the context it reads. */
export interface StepsCtx {
  state: { steps: { nodeId: string }[] };
}
export interface OutputsCtx {
  outputs: unknown;
}

export const inputOf = (ctx: { input: unknown }) => ctx.input as FinishInput;

/** What `load_ctx` resolves once, for every downstream node to read. */
export interface LoadCtxOutput {
  base?: string;
  specPath?: string;
  groups?: AcceptanceGroup[];
  /** `nax features resolve`'s acceptance status: "ok" | "disabled" | "no-prd". */
  acceptanceStatus?: string;
  /** Test-file regex sources from `nax features resolve`; empty = cannot classify. */
  testFileRegex?: string[];
  route?: string;
}

export function fixAttemptCount(ctx: StepsCtx, fixNodeId: string): number {
  return (ctx.state.steps ?? []).filter((s) => s.nodeId === fixNodeId).length;
}

export function loadCtxOf(ctx: OutputsCtx): LoadCtxOutput {
  return ((ctx.outputs as Record<string, LoadCtxOutput | undefined>).load_ctx ?? {}) as LoadCtxOutput;
}

export function gateOutputs(ctx: OutputsCtx): { failing?: string[] } {
  return ((ctx.outputs as Record<string, { failing?: string[] } | undefined>).quality_gates ?? {}) as {
    failing?: string[];
  };
}

/** The findings the `fix_<phase>` node was asked to resolve; empty for non-review phases. */
export function findingsOf(ctx: OutputsCtx, phase: FinishPhase): Finding[] {
  if (phase !== "spec" && phase !== "quality") return [];
  return (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`]?.findings ?? [];
}

/**
 * The ref a re-review should diff from, or null to review the whole branch.
 *
 * A reviewer node re-reads the spec in full and the entire `git diff
 * base...HEAD` on every round. Reviews were 58% of the wall clock on
 * rs-stock/pipeline-run-outcome (7 calls, 1306s of 2232s), and round 3 re-read
 * everything rounds 1–2 had already cleared. When exactly one `commit_*` ran
 * since this phase last reviewed, that commit's `shaBefore` *is* the tree the
 * previous review passed on, so the new work is `shaBefore..HEAD` and the round
 * can be scoped to it.
 *
 * Returns null — a full review — whenever that identity does not hold:
 *   - no prior review of this phase (round 1)
 *   - no commit since it, so there is nothing new to look at anyway
 *   - two or more commit nodes since it. `ctx.outputs` keeps only the latest
 *     output per node id, so the *earliest* commit's `shaBefore` in that window
 *     may already be lost; guessing would silently under-scope the review.
 *     (Happens when the acceptance loop commits between a spec fix and its
 *     re-review.)
 */
export function incrementalSince(ctx: OutputsCtx & StepsCtx, phase: "spec" | "quality"): string | null {
  const steps = ctx.state.steps ?? [];
  const lastReview = steps.map((s) => s.nodeId).lastIndexOf(`review_${phase}`);
  if (lastReview < 0) return null;
  const commitsSince = steps.slice(lastReview + 1).filter((s) => s.nodeId.startsWith("commit_"));
  if (commitsSince.length !== 1) return null;
  const out = (ctx.outputs as Record<string, { shaBefore?: string | null } | undefined>)[commitsSince[0].nodeId];
  return out?.shaBefore ?? null;
}
